'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');
const WEBGAZER_DIR = path.join(__dirname, 'node_modules', 'webgazer', 'dist');
// Mặc định chặn proxy tới mạng nội bộ (chống SSRF). Đặt ALLOW_PRIVATE=1 để test site chạy local.
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const MAX_BODY = 5 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 20000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.binarypb': 'application/octet-stream',
};

const EVENT_TYPES = new Set(['pageview', 'gaze', 'move', 'click', 'scroll', 'resize', 'focus', 'visibility', 'leave']);

// ---------- helpers ----------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body quá lớn'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('JSON không hợp lệ'), { status: 400 });
  }
}

function isValidSessionId(id) {
  return typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeTargetUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  return u.toString();
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

async function assertPublicHost(hostname) {
  if (ALLOW_PRIVATE) return;
  const host = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw Object.assign(new Error('Không cho phép truy cập địa chỉ mạng nội bộ (đặt ALLOW_PRIVATE=1 để bật).'), { status: 403 });
  }
}

// ---------- session storage ----------

function metaPath(id) {
  return path.join(SESSIONS_DIR, id + '.json');
}

function eventsPath(id) {
  return path.join(SESSIONS_DIR, id + '.ndjson');
}

async function loadMeta(id) {
  try {
    return JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

async function saveMeta(meta) {
  const tmp = metaPath(meta.id) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
  await fsp.rename(tmp, metaPath(meta.id));
}

async function loadEvents(id) {
  let raw;
  try {
    raw = await fsp.readFile(eventsPath(id), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // bỏ qua dòng hỏng (ví dụ server tắt giữa chừng khi đang ghi)
    }
  }
  // Các lô có thể đến lệch thứ tự (gửi lại sau lỗi mạng) → sắp xếp theo thời gian.
  return out.sort((a, b) => a.t - b.t);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined;
}

function str(v, max = 300) {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function sanitizeEvent(e) {
  if (!e || typeof e !== 'object' || !EVENT_TYPES.has(e.type)) return null;
  const out = { type: e.type, t: num(e.t) ?? 0 };
  for (const k of ['x', 'y', 'vx', 'vy', 'vw', 'vh', 'dw', 'dh', 'sx', 'sy']) {
    const v = num(e[k]);
    if (v !== undefined) out[k] = v;
  }
  const page = str(e.page, 2000);
  if (page) out.page = page;
  if (e.type === 'pageview') {
    const title = str(e.title);
    if (title) out.title = title;
  }
  if ((e.type === 'click' || e.type === 'focus') && e.el && typeof e.el === 'object') {
    out.el = {
      tag: str(e.el.tag, 40),
      id: str(e.el.id, 100),
      cls: str(e.el.cls, 200),
      text: str(e.el.text, 120),
      href: str(e.el.href, 2000),
      selector: str(e.el.selector, 500),
    };
  }
  if (e.type === 'visibility') out.hidden = !!e.hidden;
  return out;
}

const sessionLocks = new Map();

// Chạy tuần tự các thao tác ghi của cùng một session: tránh xen lẫn dòng NDJSON
// và tránh ghi đè meta khi nhiều request (events, PATCH) đến cùng lúc.
function withSessionLock(id, fn) {
  const prev = sessionLocks.get(id) || Promise.resolve();
  const next = prev.then(fn);
  const settled = next.catch(() => {});
  sessionLocks.set(id, settled);
  settled.then(() => {
    if (sessionLocks.get(id) === settled) sessionLocks.delete(id);
  });
  return next;
}

function appendEvents(id, events) {
  return withSessionLock(id, async () => {
    await fsp.appendFile(eventsPath(id), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const meta = await loadMeta(id);
    if (meta) {
      meta.eventCount = (meta.eventCount || 0) + events.length;
      await saveMeta(meta);
    }
  });
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sessions', id?, sub?]

  if (parts[1] !== 'sessions') return sendJson(res, 404, { error: 'Not found' });

  if (parts.length === 2) {
    if (req.method === 'GET') {
      const files = (await fsp.readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.json'));
      const metas = (await Promise.all(files.map((f) => loadMeta(f.slice(0, -5))))).filter(Boolean);
      metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return sendJson(res, 200, metas);
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const target = normalizeTargetUrl(body.url);
      if (!target) return sendJson(res, 400, { error: 'URL không hợp lệ (chỉ hỗ trợ http/https).' });
      const meta = {
        id: crypto.randomBytes(8).toString('hex'),
        url: target,
        participant: str(body.participant, 100) || '',
        eyeTracking: !!body.eyeTracking,
        createdAt: new Date().toISOString(),
        endedAt: null,
        calibration: null,
        userAgent: str(req.headers['user-agent'], 300) || '',
        eventCount: 0,
      };
      await saveMeta(meta);
      await fsp.writeFile(eventsPath(meta.id), '');
      return sendJson(res, 201, meta);
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const id = parts[2];
  if (!isValidSessionId(id)) return sendJson(res, 400, { error: 'Session id không hợp lệ' });
  const meta = await loadMeta(id);
  if (!meta) return sendJson(res, 404, { error: 'Không tìm thấy session' });
  const sub = parts[3];

  if (!sub) {
    if (req.method === 'GET') return sendJson(res, 200, { ...meta, events: await loadEvents(id) });
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const updated = await withSessionLock(id, async () => {
        const fresh = await loadMeta(id);
        if (!fresh) return null;
        if (body.ended) fresh.endedAt = new Date().toISOString();
        if (body.calibration && typeof body.calibration === 'object') {
          fresh.calibration = {
            accuracy: num(body.calibration.accuracy),
            meanErrorPx: num(body.calibration.meanErrorPx),
            at: new Date().toISOString(),
          };
        }
        await saveMeta(fresh);
        return fresh;
      });
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'Không tìm thấy session' });
    }
    if (req.method === 'DELETE') {
      await Promise.all([fsp.rm(metaPath(id), { force: true }), fsp.rm(eventsPath(id), { force: true })]);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (sub === 'events' && req.method === 'POST') {
    const body = await readJson(req);
    const list = Array.isArray(body.events) ? body.events : [];
    const clean = list.slice(0, 20000).map(sanitizeEvent).filter(Boolean);
    if (clean.length) await appendEvents(id, clean);
    return sendJson(res, 200, { accepted: clean.length });
  }

  if (sub === 'export' && req.method === 'GET') {
    const events = await loadEvents(id);
    if (url.searchParams.get('format') === 'csv') {
      const cols = ['t', 'type', 'page', 'x', 'y', 'vx', 'vy', 'vw', 'vh', 'dw', 'dh', 'sx', 'sy', 'el_tag', 'el_selector', 'el_text', 'el_href'];
      const q = (v) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
      const rows = events.map((e) =>
        cols.map((c) => q(c.startsWith('el_') ? e.el && e.el[c.slice(3)] : e[c])).join(',')
      );
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="session-${id}.csv"`,
      });
      return res.end([cols.join(','), ...rows].join('\n'));
    }
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Content-Disposition': `attachment; filename="session-${id}.json"`,
    });
    return res.end(JSON.stringify({ ...meta, events }, null, 2));
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------- proxy ----------

function detectCharset(contentType, buf) {
  const m = /charset=([^;]+)/i.exec(contentType || '');
  if (m) return m[1].trim().replace(/["']/g, '');
  const head = buf.subarray(0, 2048).toString('latin1');
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return meta ? meta[1] : 'utf-8';
}

function decode(buf, charset) {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/**
 * Chuẩn bị HTML của trang đích để hiển thị trong iframe cùng origin:
 * - chèn <base> để mọi tài nguyên tương đối (ảnh, css, js) tải thẳng từ site gốc
 * - bỏ meta CSP / refresh có thể chặn hiển thị hoặc tự chuyển trang
 */
function rewriteHtml(html, finalUrl) {
  let baseHref = finalUrl;
  const existingBase = /<base\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(html);
  if (existingBase) {
    try {
      baseHref = new URL(existingBase[1], finalUrl).toString();
    } catch {
      // giữ finalUrl
    }
  }
  let out = html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(content-security-policy|refresh)["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  const inject = `<base href="${escapeHtml(baseHref)}">` +
    `<meta name="eyetrack-original-url" content="${escapeHtml(finalUrl)}">`;
  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => m + inject);
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(/<html\b[^>]*>/i, (m) => m + '<head>' + inject + '</head>');
  } else {
    out = inject + out;
  }
  return out;
}

function proxyErrorPage(res, status, message, target) {
  res.writeHead(status, { 'Content-Type': MIME['.html'] });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:32px;color:#333">
<h2>Không tải được trang</h2><p>${escapeHtml(message)}</p>
${target ? `<p><a href="${escapeHtml(target)}" target="_blank" rel="noopener">Mở trực tiếp trong tab mới</a></p>` : ''}
</body>`);
}

async function handleProxy(req, res, url) {
  const target = normalizeTargetUrl(url.searchParams.get('url'));
  if (!target) return proxyErrorPage(res, 400, 'URL không hợp lệ.');

  let current = target;
  let upstream;
  try {
    // Tự theo redirect để kiểm tra từng host đích (tránh redirect vào mạng nội bộ).
    for (let hop = 0; hop < 6; hop++) {
      await assertPublicHost(new URL(current).hostname);
      upstream = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        headers: {
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 EyeTrackingTool',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': req.headers['accept-language'] || 'vi,en;q=0.8',
        },
      });
      const loc = upstream.headers.get('location');
      if (upstream.status >= 300 && upstream.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      break;
    }
  } catch (err) {
    return proxyErrorPage(res, err.status || 502, err.status ? err.message : `Lỗi khi tải ${current}: ${err.message}`, target);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return proxyErrorPage(res, 508, 'Quá nhiều lần chuyển hướng.', target);
  }

  const contentType = upstream.headers.get('content-type') || '';
  const buf = Buffer.from(await upstream.arrayBuffer());

  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    // Không phải HTML (ảnh, PDF…) → chuyển hẳn sang URL gốc.
    res.writeHead(302, { Location: current });
    return res.end();
  }

  const html = rewriteHtml(decode(buf, detectCharset(contentType, buf)), current);
  res.writeHead(upstream.status, {
    'Content-Type': MIME['.html'],
    'Cache-Control': 'no-store',
    'X-Final-Url': encodeURI(current),
  });
  res.end(html);
}

// ---------- static ----------

async function serveStatic(res, root, rel) {
  const filePath = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!filePath.startsWith(root + path.sep) && filePath !== root) return sendText(res, 403, 'Forbidden');
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (stat.isDirectory()) return serveStatic(res, root, path.posix.join(rel, 'index.html'));
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- server ----------

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/proxy') return await handleProxy(req, res, url);
    if (url.pathname.startsWith('/vendor/webgazer/')) {
      return await serveStatic(res, WEBGAZER_DIR, decodeURIComponent(url.pathname.slice('/vendor/webgazer/'.length)));
    }
    return await serveStatic(res, PUBLIC_DIR, decodeURIComponent(url.pathname));
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    else res.destroy();
    if (!err.status) console.error(err);
  }
}

function createServer() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  return http.createServer(handler);
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Eye tracking tool đang chạy tại http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}

module.exports = { createServer, normalizeTargetUrl, rewriteHtml, isPrivateAddress, sanitizeEvent };
