'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { Readable } = require('node:stream');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
// DATA_DIR: nơi lưu settings.json (cố định). Dữ liệu phiên & kịch bản nằm ở thư mục lưu trữ,
// mặc định = DATA_DIR, người dùng đổi được trong Cài đặt (storageDir).
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const WEBGAZER_DIR = path.resolve(process.env.WEBGAZER_DIR || path.join(__dirname, 'node_modules', 'webgazer', 'dist'));
// Mặc định chặn proxy tới mạng nội bộ (chống SSRF). Đặt ALLOW_PRIVATE=1 để test site chạy local.
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const MAX_BODY = 5 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30000;
// Mọi trang của công cụ nằm dưới tiền tố này; các đường dẫn còn lại được proxy tới site đích.
const TOOL_PREFIX = '/__et';
const TARGET_COOKIE = '__et_target';

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
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
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
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
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

/**
 * URL của một phiên: http/https như normalizeTargetUrl, hoặc file trên máy
 * (file:///Users/a/trang.html, /Users/a/trang.html, ~/Downloads/trang.html).
 * File trên máy chỉ mở được trong app desktop; server không bao giờ đọc/proxy file.
 */
function normalizeSessionUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let s = input.trim();
  if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  if (s.startsWith('/') || /^[a-z]:[\\/]/i.test(s)) s = pathToFileURL(s).href;
  if (/^file:/i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== 'file:' || u.pathname === '/' || u.pathname === '') return null;
      u.hash = '';
      return u.href;
    } catch {
      return null;
    }
  }
  return normalizeTargetUrl(s);
}

/**
 * Link prototype Figma → link /proto/ chuẩn. Chấp nhận cả link /design/ hoặc /file/
 * (chuyển sang chế độ prototype). Mặc định ẩn thanh công cụ Figma và co trang cho vừa khung.
 */
function normalizeFigmaUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^(www\.)?figma\.com$/i.test(u.hostname)) return null;
  const m = /^\/(proto|design|file)\/([A-Za-z0-9]+)(\/[^?#]*)?$/.exec(u.pathname);
  if (!m) return null;
  u.hostname = 'www.figma.com';
  u.pathname = `/proto/${m[2]}${m[3] || ''}`;
  u.hash = '';
  if (!u.searchParams.has('hide-ui')) u.searchParams.set('hide-ui', '1');
  if (!u.searchParams.has('scaling')) u.searchParams.set('scaling', 'scale-down-width');
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
    throw Object.assign(new Error(st('private_host')), { status: 403 });
  }
}

// ---------- cài đặt (ngôn ngữ, bật/tắt eye tracking) ----------
// Lưu ra file chứ không dùng localStorage: app desktop chạy server trên cổng ngẫu nhiên
// nên origin (và localStorage) đổi sau mỗi lần mở app.

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = { language: 'en', eyeTrackingEnabled: true, showCamera: false, storageDir: '' };
const LANGUAGES = ['en', 'vi'];
const settingsEvents = new EventEmitter();
let settingsCache = null;

function getSettings() {
  if (!settingsCache) {
    try {
      settingsCache = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
    } catch {
      settingsCache = { ...DEFAULT_SETTINGS };
    }
  }
  return { ...settingsCache };
}

/** Thư mục lưu trữ dữ liệu phiên hiện tại (tuyệt đối). */
function storageDir() {
  const dir = getSettings().storageDir;
  return dir ? path.resolve(dir) : DATA_DIR;
}

function sessionsDir() {
  return path.join(storageDir(), 'sessions');
}

/**
 * Đổi thư mục lưu trữ: tạo thư mục, kiểm tra ghi được, rồi chuyển toàn bộ phiên + kịch bản sang.
 * Trả về số file đã chuyển. Ném lỗi (status 400) nếu đường dẫn không dùng được.
 */
async function moveStorage(fromRoot, toRoot) {
  if (path.resolve(fromRoot) === path.resolve(toRoot)) return 0;
  const toSessions = path.join(toRoot, 'sessions');
  try {
    await fsp.mkdir(toSessions, { recursive: true });
    const probe = path.join(toRoot, '.heatmap-write-test');
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
  } catch (err) {
    throw Object.assign(new Error(st('storage_unwritable', { msg: err.message })), { status: 400, code: 'storage_unwritable' });
  }
  const fromSessions = path.join(fromRoot, 'sessions');
  let moved = 0;
  const files = await fsp.readdir(fromSessions).catch(() => []);
  for (const f of files) {
    if (!/^[a-f0-9]{16}\.(json|ndjson)$/.test(f)) continue;
    const dest = path.join(toSessions, f);
    if (fs.existsSync(dest)) continue; // không ghi đè dữ liệu đã có ở thư mục mới
    await moveFile(path.join(fromSessions, f), dest);
    moved++;
  }
  const fromScenarios = path.join(fromRoot, 'scenarios.json');
  const toScenarios = path.join(toRoot, 'scenarios.json');
  if (fs.existsSync(fromScenarios)) {
    if (!fs.existsSync(toScenarios)) await moveFile(fromScenarios, toScenarios);
    else {
      // gộp danh sách kịch bản của hai nơi
      const a = JSON.parse(await fsp.readFile(fromScenarios, 'utf8').catch(() => '[]'));
      const b = JSON.parse(await fsp.readFile(toScenarios, 'utf8').catch(() => '[]'));
      const ids = new Set(b.map((x) => x.id));
      await fsp.writeFile(toScenarios, JSON.stringify([...b, ...a.filter((x) => !ids.has(x.id))], null, 2));
      await fsp.rm(fromScenarios, { force: true });
    }
  }
  return moved;
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err; // khác ổ đĩa → copy rồi xoá
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

async function updateSettings(patch) {
  const next = getSettings();
  if (patch && LANGUAGES.includes(patch.language)) next.language = patch.language;
  if (patch && typeof patch.eyeTrackingEnabled === 'boolean') next.eyeTrackingEnabled = patch.eyeTrackingEnabled;
  if (patch && typeof patch.showCamera === 'boolean') next.showCamera = patch.showCamera;
  if (patch && typeof patch.storageDir === 'string') {
    let dir = patch.storageDir.trim();
    if (dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(2));
    if (dir && !path.isAbsolute(dir)) throw Object.assign(new Error(st('storage_absolute')), { status: 400, code: 'storage_absolute' });
    const target = dir ? path.resolve(dir) : DATA_DIR;
    await withGlobalLock(() => moveStorage(storageDir(), target));
    next.storageDir = target === DATA_DIR ? '' : target;
  }
  await fsp.writeFile(SETTINGS_PATH + '.tmp', JSON.stringify(next, null, 2));
  await fsp.rename(SETTINGS_PATH + '.tmp', SETTINGS_PATH);
  settingsCache = next;
  settingsEvents.emit('change', { ...next });
  return { ...next };
}

const SERVER_TEXT = {
  en: {
    invalid_url: 'Invalid link (http, https or a local file).',
    invalid_figma_url: 'Not a Figma prototype link. Expected https://www.figma.com/proto/…',
    private_host: 'Local network addresses are blocked (set ALLOW_PRIVATE=1 to allow).',
    not_found: 'Session not found.',
    invalid_id: 'Invalid session id.',
    page_failed: "Couldn't load the page",
    fetch_failed: 'Error loading {url}: {msg}',
    open_new_tab: 'Open directly in a new tab',
    storage_absolute: 'The storage folder must be a full path (for example /Users/you/Documents/Heatmap).',
    storage_unwritable: "Can't write to that folder: {msg}",
    scenario_not_found: 'Scenario not found.',
    scenario_name: 'Scenario name is required.',
  },
  vi: {
    invalid_url: 'Link không hợp lệ (http, https hoặc file trên máy).',
    invalid_figma_url: 'Không phải link prototype Figma. Cần dạng https://www.figma.com/proto/…',
    private_host: 'Không cho phép truy cập địa chỉ mạng nội bộ (đặt ALLOW_PRIVATE=1 để bật).',
    not_found: 'Không tìm thấy phiên.',
    invalid_id: 'Mã phiên không hợp lệ.',
    page_failed: 'Không tải được trang',
    fetch_failed: 'Lỗi khi tải {url}: {msg}',
    open_new_tab: 'Mở trực tiếp trong tab mới',
    storage_absolute: 'Thư mục lưu trữ phải là đường dẫn đầy đủ (ví dụ /Users/ban/Documents/Heatmap).',
    storage_unwritable: 'Không ghi được vào thư mục đó: {msg}',
    scenario_not_found: 'Không tìm thấy kịch bản.',
    scenario_name: 'Cần nhập tên kịch bản.',
  },
};

/** Chuỗi phía server theo ngôn ngữ đang chọn. */
function st(key, vars = {}) {
  const lang = getSettings().language;
  const text = (SERVER_TEXT[lang] && SERVER_TEXT[lang][key]) || SERVER_TEXT.en[key] || key;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function apiError(res, status, code) {
  return sendJson(res, status, { error: st(code), code });
}

// ---------- session storage ----------

function metaPath(id) {
  return path.join(sessionsDir(), id + '.json');
}

function eventsPath(id) {
  return path.join(sessionsDir(), id + '.ndjson');
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
      // thời lượng đã ghi = mốc thời gian lớn nhất của sự kiện (ms từ lúc bắt đầu)
      meta.durationMs = Math.max(meta.durationMs || 0, ...events.map((e) => e.t || 0));
      await saveMeta(meta);
    }
  });
}

// Thao tác ảnh hưởng nhiều file (đổi thư mục lưu trữ, sửa kịch bản) chạy tuần tự.
let globalLock = Promise.resolve();
function withGlobalLock(fn) {
  const next = globalLock.then(fn);
  globalLock = next.catch(() => {});
  return next;
}

// ---------- kịch bản (nhóm nhiều phiên) ----------

function scenariosPath() {
  return path.join(storageDir(), 'scenarios.json');
}

async function loadScenarios() {
  try {
    const list = JSON.parse(await fsp.readFile(scenariosPath(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveScenarios(list) {
  await fsp.mkdir(storageDir(), { recursive: true });
  await fsp.writeFile(scenariosPath() + '.tmp', JSON.stringify(list, null, 2));
  await fsp.rename(scenariosPath() + '.tmp', scenariosPath());
}

async function listSessions() {
  const files = (await fsp.readdir(sessionsDir()).catch(() => [])).filter((f) => /^[a-f0-9]{16}\.json$/.test(f));
  const metas = (await Promise.all(files.map((f) => loadMeta(f.slice(0, -5))))).filter(Boolean);
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Lọc theo kịch bản: id, 'none' (chưa thuộc kịch bản nào), hoặc rỗng (tất cả). */
function filterByScenario(metas, scenario) {
  if (!scenario) return metas;
  if (scenario === 'none') return metas.filter((m) => !m.scenarioId);
  return metas.filter((m) => m.scenarioId === scenario);
}

async function handleScenarios(req, res, parts) {
  const id = parts[2];
  if (!id) {
    if (req.method === 'GET') {
      const [list, sessions] = await Promise.all([loadScenarios(), listSessions()]);
      return sendJson(res, 200, list.map((sc) => ({ ...sc, sessionCount: sessions.filter((m) => m.scenarioId === sc.id).length })));
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const name = str(body.name, 120)?.trim();
      if (!name) return apiError(res, 400, 'scenario_name');
      const sc = { id: crypto.randomBytes(6).toString('hex'), name, createdAt: new Date().toISOString() };
      await withGlobalLock(async () => saveScenarios([...(await loadScenarios()), sc]));
      return sendJson(res, 201, { ...sc, sessionCount: 0 });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (!/^[a-f0-9]{12}$/.test(id)) return apiError(res, 404, 'scenario_not_found');
  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const name = str(body.name, 120)?.trim();
    if (!name) return apiError(res, 400, 'scenario_name');
    const updated = await withGlobalLock(async () => {
      const list = await loadScenarios();
      const sc = list.find((x) => x.id === id);
      if (!sc) return null;
      sc.name = name;
      await saveScenarios(list);
      return sc;
    });
    return updated ? sendJson(res, 200, updated) : apiError(res, 404, 'scenario_not_found');
  }
  if (req.method === 'DELETE') {
    // Xoá kịch bản không xoá phiên: các phiên chỉ được bỏ khỏi kịch bản.
    const ok = await withGlobalLock(async () => {
      const list = await loadScenarios();
      if (!list.some((x) => x.id === id)) return false;
      await saveScenarios(list.filter((x) => x.id !== id));
      for (const m of await listSessions()) {
        if (m.scenarioId === id) await withSessionLock(m.id, async () => {
          const fresh = await loadMeta(m.id);
          if (fresh) { delete fresh.scenarioId; await saveMeta(fresh); }
        });
      }
      return true;
    });
    return ok ? sendJson(res, 200, { ok: true }) : apiError(res, 404, 'scenario_not_found');
  }
  return sendJson(res, 405, { error: 'Method not allowed' });
}

// ---------- báo cáo tổng hợp theo link ----------

function sessionStats(meta, events) {
  let clicks = 0;
  let gaze = 0;
  let maxDepth = 0;
  const pages = new Set();
  for (const e of events) {
    if (e.type === 'click') clicks++;
    else if (e.type === 'gaze') gaze++;
    if (e.type === 'pageview' && e.page) pages.add(e.page);
    if (e.dh && 'sy' in e) maxDepth = Math.max(maxDepth, Math.min(100, (((e.sy || 0) + (e.vh || 0)) / e.dh) * 100));
  }
  const durationMs = events.length ? events[events.length - 1].t : meta.durationMs || 0;
  return { durationMs, clicks, gaze, pages: pages.size, maxDepth };
}

async function buildSummary(scenario) {
  const metas = filterByScenario(await listSessions(), scenario);
  const groups = new Map();
  for (const meta of metas) {
    const st = sessionStats(meta, await loadEvents(meta.id));
    const g = groups.get(meta.url) || {
      url: meta.url, kind: meta.kind || 'web', sessions: 0, participants: new Set(),
      totalMs: 0, clicks: 0, gaze: 0, depthSum: 0, eyeSessions: 0, lastAt: '', latestId: '', accuracySum: 0, accuracyN: 0,
    };
    g.sessions++;
    if (meta.participant) g.participants.add(meta.participant);
    g.totalMs += st.durationMs;
    g.clicks += st.clicks;
    g.gaze += st.gaze;
    g.depthSum += st.maxDepth;
    if (meta.eyeTracking) g.eyeSessions++;
    if (meta.calibration && typeof meta.calibration.accuracy === 'number') {
      g.accuracySum += meta.calibration.accuracy;
      g.accuracyN++;
    }
    if (meta.createdAt > g.lastAt) { g.lastAt = meta.createdAt; g.latestId = meta.id; }
    groups.set(meta.url, g);
  }
  return [...groups.values()]
    .map((g) => ({
      url: g.url,
      kind: g.kind,
      sessions: g.sessions,
      participants: g.participants.size,
      totalMs: g.totalMs,
      avgMs: g.sessions ? g.totalMs / g.sessions : 0,
      clicks: g.clicks,
      avgClicks: g.sessions ? g.clicks / g.sessions : 0,
      gaze: g.gaze,
      eyeSessions: g.eyeSessions,
      avgDepth: g.sessions ? g.depthSum / g.sessions : 0,
      avgAccuracy: g.accuracyN ? g.accuracySum / g.accuracyN : null,
      lastAt: g.lastAt,
      latestId: g.latestId,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.lastAt.localeCompare(a.lastAt));
}

// ---------- xuất dữ liệu một phiên ----------

/** Nội dung file xuất của một phiên: { filename, contentType, body }. Dùng cho tải về và "Save as". */
async function exportSession(id, format = 'json') {
  const meta = await loadMeta(id);
  if (!meta) return null;
  const events = await loadEvents(id);
  if (format === 'csv') {
    const cols = ['t', 'type', 'page', 'x', 'y', 'vx', 'vy', 'vw', 'vh', 'dw', 'dh', 'sx', 'sy', 'el_tag', 'el_selector', 'el_text', 'el_href'];
    const q = (v) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const rows = events.map((e) => cols.map((c) => q(c.startsWith('el_') ? e.el && e.el[c.slice(3)] : e[c])).join(','));
    return { filename: `heatmap-session-${id}.csv`, contentType: 'text/csv; charset=utf-8', body: [cols.join(','), ...rows].join('\n') };
  }
  return { filename: `heatmap-session-${id}.json`, contentType: MIME['.json'], body: JSON.stringify({ ...meta, events }, null, 2) };
}

/** Đường dẫn các file gốc của phiên trên ổ đĩa (để mở trong Finder). */
function sessionFilePaths(id) {
  if (!isValidSessionId(id)) return null;
  return { meta: metaPath(id), events: eventsPath(id) };
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sessions', id?, sub?]

  if (parts[1] === 'settings' && parts.length === 2) {
    if (req.method === 'GET') return sendJson(res, 200, { ...getSettings(), storagePath: storageDir(), defaultStoragePath: DATA_DIR });
    if (req.method === 'PUT') {
      try {
        const next = await updateSettings(await readJson(req));
        return sendJson(res, 200, { ...next, storagePath: storageDir(), defaultStoragePath: DATA_DIR });
      } catch (err) {
        if (err.code) return sendJson(res, err.status || 400, { error: err.message, code: err.code });
        throw err;
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (parts[1] === 'scenarios') return handleScenarios(req, res, parts);
  if (parts[1] === 'summary' && req.method === 'GET') return sendJson(res, 200, await buildSummary(url.searchParams.get('scenario') || ''));
  if (parts[1] !== 'sessions') return sendJson(res, 404, { error: 'Not found' });

  if (parts.length === 2) {
    if (req.method === 'GET') {
      return sendJson(res, 200, filterByScenario(await listSessions(), url.searchParams.get('scenario') || ''));
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const kind = body.kind === 'figma' ? 'figma' : 'web';
      const target = kind === 'figma' ? normalizeFigmaUrl(body.url) : normalizeSessionUrl(body.url);
      if (!target) return apiError(res, 400, kind === 'figma' ? 'invalid_figma_url' : 'invalid_url');
      const meta = {
        id: crypto.randomBytes(8).toString('hex'),
        kind,
        url: target,
        participant: str(body.participant, 100) || '',
        // tắt hẳn trong Cài đặt → không phiên nào bật webcam
        eyeTracking: !!body.eyeTracking && getSettings().eyeTrackingEnabled,
        createdAt: new Date().toISOString(),
        endedAt: null,
        calibration: null,
        userAgent: str(req.headers['user-agent'], 300) || '',
        eventCount: 0,
        durationMs: 0,
      };
      if (typeof body.scenarioId === 'string' && (await loadScenarios()).some((x) => x.id === body.scenarioId)) {
        meta.scenarioId = body.scenarioId;
      }
      await fsp.mkdir(sessionsDir(), { recursive: true });
      await saveMeta(meta);
      await fsp.writeFile(eventsPath(meta.id), '');
      return sendJson(res, 201, meta);
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const id = parts[2];
  if (!isValidSessionId(id)) return apiError(res, 400, 'invalid_id');
  const meta = await loadMeta(id);
  if (!meta) return apiError(res, 404, 'not_found');
  const sub = parts[3];

  if (!sub) {
    if (req.method === 'GET') return sendJson(res, 200, { ...meta, events: await loadEvents(id) });
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const updated = await withSessionLock(id, async () => {
        const fresh = await loadMeta(id);
        if (!fresh) return null;
        if (body.ended) fresh.endedAt = new Date().toISOString();
        // gán / bỏ phiên khỏi kịch bản
        if ('scenarioId' in body) {
          if (body.scenarioId === null || body.scenarioId === '') delete fresh.scenarioId;
          else if ((await loadScenarios()).some((x) => x.id === body.scenarioId)) fresh.scenarioId = body.scenarioId;
        }
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
      return updated ? sendJson(res, 200, updated) : apiError(res, 404, 'not_found');
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
    const out = await exportSession(id, url.searchParams.get('format') === 'csv' ? 'csv' : 'json');
    res.writeHead(200, { 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"` });
    return res.end(out.body);
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------- reverse proxy ----------
//
// Trang đích được phục vụ dưới CÙNG origin với công cụ và GIỮ NGUYÊN đường dẫn gốc
// (https://site.com/en/abc → http://localhost:3000/en/abc). Nhờ vậy:
//  - trang theo dõi đọc được sự kiện trong iframe (cùng origin)
//  - SPA (Next.js, Nuxt, React Router…) thấy location.pathname đúng nên định tuyến bình thường
//  - fetch/XHR tương đối của trang đi qua proxy tới đúng server gốc
// Mọi đường dẫn của công cụ nằm dưới TOOL_PREFIX; origin đích hiện tại lưu trong cookie.

function getCookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

function targetCookie(origin) {
  return `${TARGET_COOKIE}=${encodeURIComponent(origin)}; Path=/; HttpOnly; SameSite=Lax`;
}

const hostCheckCache = new Map();
async function assertPublicHostCached(hostname) {
  const hit = hostCheckCache.get(hostname);
  if (hit && hit.until > Date.now()) {
    if (hit.error) throw hit.error;
    return;
  }
  try {
    await assertPublicHost(hostname);
    hostCheckCache.set(hostname, { until: Date.now() + 60000 });
  } catch (error) {
    hostCheckCache.set(hostname, { until: Date.now() + 60000, error });
    throw error;
  }
}

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

// Chặn service worker của trang đích: nếu đăng ký được, nó sẽ chiếm cả origin của công cụ.
const INJECT_SCRIPT = '<script>(function(){try{var sw=navigator.serviceWorker;if(sw){sw.register=function(){return Promise.reject(new Error("Service worker bị tắt trong chế độ theo dõi"))};' +
  'sw.getRegistrations&&sw.getRegistrations().then(function(r){r.forEach(function(x){x.unregister()})})}}catch(e){}})();</script>';

/**
 * Chuẩn bị HTML của trang đích: ghi chú URL gốc, bỏ meta CSP/refresh, chặn service worker.
 */
function rewriteHtml(html, originalUrl) {
  let out = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(content-security-policy|refresh)["']?[^>]*>/gi, '');
  const inject = `<meta name="eyetrack-original-url" content="${escapeHtml(originalUrl)}">` + INJECT_SCRIPT;
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
  res.writeHead(status, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:32px;color:#333">
<h2>${escapeHtml(st('page_failed'))}</h2><p>${escapeHtml(message)}</p>
${target ? `<p><a href="${escapeHtml(target)}" target="_blank" rel="noopener">${escapeHtml(st('open_new_tab'))}</a></p>` : ''}
</body>`);
}

/** Đổi URL của site đích sang URL đi qua proxy. */
function toProxyUrl(absUrl, targetOrigin) {
  const u = new URL(absUrl);
  if (u.origin === targetOrigin) return u.pathname + u.search + u.hash;
  return `${TOOL_PREFIX}/go?url=${encodeURIComponent(u.toString())}`;
}

// GET /__et/go?url=…  → chọn origin đích rồi chuyển iframe sang đúng đường dẫn.
async function handleGo(req, res, url) {
  const target = normalizeTargetUrl(url.searchParams.get('url'));
  if (!target) return proxyErrorPage(res, 400, st('invalid_url'));
  const u = new URL(target);
  try {
    await assertPublicHostCached(u.hostname);
  } catch (err) {
    return proxyErrorPage(res, err.status || 502, err.message, target);
  }
  res.writeHead(302, {
    'Set-Cookie': targetCookie(u.origin),
    Location: u.pathname + u.search,
    'Cache-Control': 'no-store',
  });
  res.end();
}

const HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'accept-encoding', 'content-length', 'origin', 'referer', 'cookie', 'expect',
]);
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'set-cookie', 'location', 'alt-svc', 'clear-site-data',
]);

function forwardCookies(req) {
  return (req.headers.cookie || '')
    .split(/;\s*/)
    .filter((c) => c && !c.startsWith(TARGET_COOKIE + '='))
    .join('; ');
}

function rewriteSetCookie(c) {
  // Cookie của site đích được gắn vào origin của công cụ: bỏ Domain để trình duyệt chấp nhận.
  return c.replace(/;\s*domain=[^;]*/gi, '');
}

async function handleReverseProxy(req, res, url) {
  const targetOrigin = getCookie(req, TARGET_COOKIE);
  const dest = req.headers['sec-fetch-dest'];
  // Mở trực tiếp trên tab (không phải trong iframe) hoặc chưa chọn site → về trang chủ công cụ.
  if (!targetOrigin || dest === 'document') {
    res.writeHead(302, { Location: TOOL_PREFIX + '/' });
    return res.end();
  }
  let origin;
  try {
    origin = new URL(targetOrigin).origin;
  } catch {
    res.writeHead(302, { Location: TOOL_PREFIX + '/' });
    return res.end();
  }
  const upstreamUrl = origin + url.pathname + url.search;
  const isNavigation = dest === 'iframe' || dest === 'frame';

  let upstream;
  try {
    await assertPublicHostCached(new URL(origin).hostname);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_HEADERS.has(k) && !k.startsWith('sec-') && !k.startsWith('x-forwarded')) headers[k] = v;
    }
    const cookies = forwardCookies(req);
    if (cookies) headers.cookie = cookies;
    if (req.headers.referer) {
      try {
        const r = new URL(req.headers.referer);
        headers.referer = origin + r.pathname + r.search;
      } catch { /* bỏ qua */ }
    }
    if (req.headers.origin) headers.origin = origin;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (err) {
    if (isNavigation) {
      return proxyErrorPage(res, err.status || 502, err.status ? err.message : st('fetch_failed', { url: upstreamUrl, msg: err.message }), upstreamUrl);
    }
    return sendText(res, err.status || 502, err.message);
  }

  const outHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!DROP_RESPONSE_HEADERS.has(k)) outHeaders[k] = v;
  });
  const setCookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
  if (setCookies.length) outHeaders['set-cookie'] = setCookies.map(rewriteSetCookie);
  const loc = upstream.headers.get('location');
  if (loc) {
    try {
      outHeaders.location = toProxyUrl(new URL(loc, upstreamUrl).toString(), origin);
    } catch { /* bỏ Location hỏng */ }
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (isNavigation && req.method === 'GET' && /text\/html|application\/xhtml/i.test(contentType)) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    const html = rewriteHtml(decode(buf, detectCharset(contentType, buf)), upstreamUrl);
    outHeaders['content-type'] = MIME['.html'];
    outHeaders['cache-control'] = 'no-store';
    res.writeHead(upstream.status, outHeaders);
    return res.end(html);
  }

  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
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
    if (url.pathname !== TOOL_PREFIX && !url.pathname.startsWith(TOOL_PREFIX + '/')) {
      return await handleReverseProxy(req, res, url);
    }
    const rel = url.pathname.slice(TOOL_PREFIX.length) || '/';
    if (rel.startsWith('/api/')) return await handleApi(req, res, new URL(rel + url.search, 'http://localhost'));
    if (rel === '/go') return await handleGo(req, res, url);
    if (rel.startsWith('/vendor/webgazer/')) {
      return await serveStatic(res, WEBGAZER_DIR, decodeURIComponent(rel.slice('/vendor/webgazer/'.length)));
    }
    if (url.pathname === TOOL_PREFIX) {
      res.writeHead(302, { Location: TOOL_PREFIX + '/' });
      return res.end();
    }
    return await serveStatic(res, PUBLIC_DIR, decodeURIComponent(rel));
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    else res.destroy();
    if (!err.status) console.error(err);
  }
}

function createServer() {
  settingsCache = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(sessionsDir(), { recursive: true });
  return http.createServer(handler);
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Eye tracking tool đang chạy tại http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${TOOL_PREFIX}/`);
  });
}

module.exports = { createServer, exportSession, sessionFilePaths, storageDir, normalizeTargetUrl, normalizeSessionUrl, normalizeFigmaUrl, getSettings, updateSettings, settingsEvents, rewriteHtml, isPrivateAddress, sanitizeEvent, toProxyUrl, TOOL_PREFIX };
