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
// Nhận dạng giọng nói chạy trong trình duyệt (transformers.js + ONNX Runtime Web), phục vụ ngay trên máy.
const TRANSFORMERS_DIR = path.resolve(process.env.TRANSFORMERS_DIR || path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'dist'));
const ORT_DIR = path.resolve(process.env.ORT_DIR || path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist'));
// Mô hình Whisper tải từ Hugging Face một lần rồi lưu trên đĩa (dùng offline về sau).
const hfEndpoint = () => (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const ASR_MODELS = ['onnx-community/whisper-base', 'onnx-community/whisper-small', 'onnx-community/whisper-large-v3-turbo'];
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
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
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
const DEFAULT_SETTINGS = { language: 'en', eyeTrackingEnabled: true, showCamera: false, storageDir: '', asrModel: 'onnx-community/whisper-small' };
const LANGUAGES = ['en', 'vi'];

/** Cài đặt gửi cho trình duyệt: không bao giờ trả lại API key, chỉ cho biết đã có key hay chưa. */
function publicSettings(s = getSettings()) {
  const { anthropicApiKey, ...rest } = s;
  const fromEnv = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return {
    ...rest,
    aiKey: anthropicApiKey ? 'settings' : fromEnv ? 'env' : '',
    aiKeyHint: anthropicApiKey ? '…' + anthropicApiKey.slice(-4) : '',
    storagePath: storageDir(),
    defaultStoragePath: DEFAULT_ROOT,
  };
}
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

// ---------- thư mục lưu trữ: <gốc>/<Kịch bản>/<Người tham gia>/ ----------
//
// Mỗi phiên là một thư mục đặt theo tên người tham gia, nằm trong thư mục của kịch bản
// (phiên chưa thuộc kịch bản nằm trong "No scenario"). Trong đó có:
//   session.json, events.csv          bản xuất đầy đủ, tự cập nhật
//   screen-recording-N.mp4, audio-recording-N.m4a, transcript.json
//   .session.json, .events.ndjson     file làm việc của app (ẩn), ghi trực tiếp khi đang ghi phiên
// Mã phiên (id) nằm trong .session.json; app tìm thư mục của phiên qua bảng chỉ mục quét từ ổ đĩa,
// nên đổi tên / chuyển thư mục bằng Finder vẫn không mất phiên.

const DEFAULT_ROOT = path.join(DATA_DIR, 'sessions');
const UNASSIGNED_FOLDER = 'No scenario';
const META_FILE = '.session.json';
const EVENTS_FILE = '.events.ndjson';
const SCENARIOS_FILE = '.scenarios.json';
const EXPORT_JSON = 'session.json';
const EXPORT_CSV = 'events.csv';
const TRANSCRIPT_FILE = 'transcript.json';
const EXPORT_DELAY_MS = 3000;

/** Thư mục gốc chứa các thư mục kịch bản (tuyệt đối). */
function storageDir() {
  const dir = getSettings().storageDir;
  return dir ? path.resolve(dir) : DEFAULT_ROOT;
}

/** Tên thư mục an toàn trên macOS/Windows từ tên người dùng nhập. */
function safeName(name, fallback) {
  let s = String(name || '').normalize('NFC')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .replace(/[. ]+$/, '')
    .trim();
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = fallback;
  return s;
}

/** Đường dẫn chưa dùng: "User 1", "User 1 (2)", … (so sánh không phân biệt hoa thường như macOS). */
function uniquePath(parent, base, taken = []) {
  const used = new Set(taken.map((x) => x.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    const full = path.join(parent, name);
    if (!used.has(name.toLowerCase()) && !fs.existsSync(full)) return full;
  }
}

function sessionFolderName(meta) {
  const d = new Date(meta.createdAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  return safeName(meta.participant, `Session ${stamp}`);
}

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---- chỉ mục id → thư mục phiên ----

let sessionIndex = null;
let indexRoot = null;

function scanSessions(root) {
  const map = new Map();
  const dirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => path.join(dir, d.name));
    } catch {
      return [];
    }
  };
  for (const group of dirs(root)) {
    for (const dir of dirs(group)) {
      const meta = readJsonSync(path.join(dir, META_FILE), null);
      if (meta && isValidSessionId(meta.id) && !map.has(meta.id)) map.set(meta.id, dir);
    }
  }
  return map;
}

function rebuildIndex() {
  indexRoot = storageDir();
  sessionIndex = scanSessions(indexRoot);
  return sessionIndex;
}

/** Thư mục của phiên, hoặc null nếu không có. Quét lại ổ đĩa khi thư mục bị đổi tên / di chuyển. */
function sessionDir(id) {
  if (!isValidSessionId(id)) return null;
  if (!sessionIndex || indexRoot !== storageDir()) rebuildIndex();
  let dir = sessionIndex.get(id);
  if (!dir || !fs.existsSync(path.join(dir, META_FILE))) dir = rebuildIndex().get(id);
  return dir || null;
}

function sessionFile(id, name) {
  const dir = sessionDir(id);
  if (!dir) throw Object.assign(new Error('Session not found'), { status: 404 });
  return path.join(dir, name);
}

/** Thư mục của kịch bản (hoặc "No scenario"). */
function scenarioDirSync(scenarioId, list = readJsonSync(scenariosPath(), [])) {
  const sc = scenarioId && list.find((x) => x.id === scenarioId);
  return path.join(storageDir(), sc ? sc.folder || safeName(sc.name, 'Scenario') : UNASSIGNED_FOLDER);
}

/** Tên thư mục chưa trùng cho một kịch bản (khác "No scenario" và các kịch bản khác). */
function scenarioFolderName(name, list, selfId) {
  const taken = [UNASSIGNED_FOLDER, ...list.filter((x) => x.id !== selfId && x.folder).map((x) => x.folder)];
  return path.basename(uniquePath(storageDir(), safeName(name, 'Scenario'), taken));
}

async function moveDir(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err; // khác ổ đĩa → copy rồi xoá
    await fsp.cp(from, to, { recursive: true, errorOnExist: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/** Xoá thư mục nếu rỗng (bỏ qua file ẩn của hệ thống như .DS_Store). */
async function removeIfEmpty(dir) {
  try {
    const left = (await fsp.readdir(dir)).filter((f) => f !== '.DS_Store');
    if (left.length) return;
    await fsp.rm(dir, { recursive: true, force: true });
  } catch { /* không sao */ }
}

/** Chuyển thư mục phiên sang thư mục của kịch bản khác. Gọi khi đang giữ khoá của phiên. */
async function relocateSession(meta) {
  const from = sessionDir(meta.id);
  if (!from) return;
  const parent = scenarioDirSync(meta.scenarioId, await loadScenarios());
  if (path.dirname(from) === parent) return;
  const to = uniquePath(parent, sessionFolderName(meta));
  await moveDir(from, to);
  sessionIndex.set(meta.id, to);
  await removeIfEmpty(path.join(storageDir(), UNASSIGNED_FOLDER));
}

// ---- chuyển dữ liệu từ cách lưu cũ (mọi file nằm chung trong sessions/<id>.*) ----

function nextMediaName(media, kind, ext, dir) {
  const prefix = kind === 'screen' ? 'screen-recording' : 'audio-recording';
  const taken = new Set((media || []).map((m) => m.file));
  for (let n = (media || []).filter((m) => m.kind === kind).length + 1; ; n++) {
    const name = `${prefix}-${n}.${ext}`;
    if (!taken.has(name) && !(dir && fs.existsSync(path.join(dir, name)))) return name;
  }
}

function migrateLegacySession(legacyDir, id, scenarios) {
  const from = (suffix) => path.join(legacyDir, id + suffix);
  const meta = readJsonSync(from('.json'), null);
  if (!meta || meta.id !== id) return false;
  const dir = uniquePath(scenarioDirSync(meta.scenarioId, scenarios), sessionFolderName(meta));
  fs.mkdirSync(dir, { recursive: true });
  const move = (src, name) => { if (fs.existsSync(src)) fs.renameSync(src, path.join(dir, name)); };
  move(from('.ndjson'), EVENTS_FILE);
  move(from('.transcript.json'), TRANSCRIPT_FILE);
  const media = [];
  for (const m of meta.media || []) {
    const ext = path.extname(m.file).slice(1) || 'bin';
    const name = nextMediaName(media, m.kind, ext, dir);
    move(path.join(legacyDir, m.file), name);
    media.push({ ...m, file: name });
  }
  if (meta.media) meta.media = media;
  if (!fs.existsSync(path.join(dir, EVENTS_FILE))) fs.writeFileSync(path.join(dir, EVENTS_FILE), '');
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2));
  fs.rmSync(from('.json'), { force: true });
  for (const f of fs.readdirSync(legacyDir)) if (f.startsWith(id + '.')) fs.rmSync(path.join(legacyDir, f), { force: true });
  return true;
}

/**
 * Chuẩn bị thư mục lưu trữ: chuyển dữ liệu kiểu cũ sang thư mục kịch bản / phiên, đặt tên thư mục
 * cho kịch bản, tạo thư mục kịch bản, dựng chỉ mục và bổ sung file xuất còn thiếu.
 */
function prepareStorage() {
  const root = storageDir();
  fs.mkdirSync(root, { recursive: true });
  const custom = root !== DEFAULT_ROOT;
  const legacyScenarios = custom ? path.join(root, 'scenarios.json') : path.join(DATA_DIR, 'scenarios.json');
  if (fs.existsSync(legacyScenarios)) {
    if (!fs.existsSync(scenariosPath())) fs.renameSync(legacyScenarios, scenariosPath());
    else {
      // cả hai cùng có (ví dụ vừa chuyển dữ liệu vào thư mục cũ) → gộp
      const cur = readJsonSync(scenariosPath(), []);
      const ids = new Set(cur.map((x) => x.id));
      fs.writeFileSync(scenariosPath(), JSON.stringify([...cur, ...readJsonSync(legacyScenarios, []).filter((x) => !ids.has(x.id))], null, 2));
      fs.rmSync(legacyScenarios, { force: true });
    }
  }

  const scenarios = readJsonSync(scenariosPath(), []);
  let changed = false;
  for (const sc of scenarios) {
    if (!sc.folder) {
      sc.folder = scenarioFolderName(sc.name, scenarios, sc.id);
      changed = true;
    }
    fs.mkdirSync(path.join(root, sc.folder), { recursive: true });
  }
  if (changed) fs.writeFileSync(scenariosPath(), JSON.stringify(scenarios, null, 2));

  const legacyDir = custom ? path.join(root, 'sessions') : root;
  let files = [];
  try {
    files = fs.readdirSync(legacyDir).filter((f) => /^[a-f0-9]{16}\.json$/.test(f));
  } catch { /* chưa có dữ liệu cũ */ }
  for (const f of files) {
    try {
      migrateLegacySession(legacyDir, f.slice(0, 16), scenarios);
    } catch (err) {
      console.error('migrate session', f, err);
    }
  }
  if (custom && files.length) {
    try {
      const left = fs.readdirSync(legacyDir).filter((f) => f !== '.DS_Store');
      if (!left.length) fs.rmSync(legacyDir, { recursive: true, force: true });
    } catch { /* không sao */ }
  }

  rebuildIndex();
  // file xuất thiếu hoặc cũ hơn dữ liệu (ví dụ app bị tắt trước khi kịp ghi) → ghi lại
  for (const [id, dir] of sessionIndex) {
    const mtime = (f) => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } };
    const latest = Math.max(mtime(META_FILE), mtime(EVENTS_FILE));
    if (Math.min(mtime(EXPORT_JSON), mtime(EXPORT_CSV)) < latest) scheduleExport(id, 0);
  }
}

/**
 * Đổi thư mục lưu trữ: kiểm tra ghi được, rồi chuyển các thư mục kịch bản / phiên và danh sách kịch bản sang.
 * Trả về số phiên đã chuyển. Ném lỗi (status 400) nếu đường dẫn không dùng được.
 */
async function moveStorage(fromRoot, toRoot) {
  if (path.resolve(fromRoot) === path.resolve(toRoot)) return 0;
  try {
    await fsp.mkdir(toRoot, { recursive: true });
    const probe = path.join(toRoot, '.heatmap-write-test');
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
  } catch (err) {
    throw Object.assign(new Error(st('storage_unwritable', { msg: err.message })), { status: 400, code: 'storage_unwritable' });
  }
  if (path.resolve(toRoot).startsWith(path.resolve(fromRoot) + path.sep)) {
    throw Object.assign(new Error(st('storage_unwritable', { msg: 'inside the current folder' })), { status: 400, code: 'storage_unwritable' });
  }
  let moved = 0;
  // chỉ chuyển thư mục của app: thư mục kịch bản đã biết, "No scenario", hoặc thư mục có chứa phiên
  const sessions = scanSessions(fromRoot);
  const scenarios = readJsonSync(path.join(fromRoot, SCENARIOS_FILE), []);
  const groups = new Set([UNASSIGNED_FOLDER, ...scenarios.map((x) => x.folder).filter(Boolean)].map((g) => path.join(fromRoot, g)));
  for (const dir of sessions.values()) groups.add(path.dirname(dir));
  for (const group of groups) {
    if (!fs.existsSync(group)) continue;
    const dest = path.join(toRoot, path.basename(group));
    if (!fs.existsSync(dest)) {
      moved += [...sessions.values()].filter((d) => path.dirname(d) === group).length;
      await moveDir(group, dest);
      continue;
    }
    // đã có thư mục cùng tên ở nơi mới → gộp từng phiên, đổi tên nếu trùng
    for (const dir of [...sessions.values()].filter((d) => path.dirname(d) === group)) {
      await moveDir(dir, uniquePath(dest, path.basename(dir)));
      moved++;
    }
    await removeIfEmpty(group);
  }
  const fromScenarios = path.join(fromRoot, SCENARIOS_FILE);
  const toScenarios = path.join(toRoot, SCENARIOS_FILE);
  if (fs.existsSync(fromScenarios)) {
    if (!fs.existsSync(toScenarios)) await moveDir(fromScenarios, toScenarios);
    else {
      // gộp danh sách kịch bản của hai nơi
      const b = readJsonSync(toScenarios, []);
      const ids = new Set(b.map((x) => x.id));
      await fsp.writeFile(toScenarios, JSON.stringify([...b, ...scenarios.filter((x) => !ids.has(x.id))], null, 2));
      await fsp.rm(fromScenarios, { force: true });
    }
  }
  return moved;
}

async function updateSettings(patch) {
  const next = getSettings();
  if (patch && LANGUAGES.includes(patch.language)) next.language = patch.language;
  if (patch && typeof patch.eyeTrackingEnabled === 'boolean') next.eyeTrackingEnabled = patch.eyeTrackingEnabled;
  if (patch && typeof patch.showCamera === 'boolean') next.showCamera = patch.showCamera;
  if (patch && ASR_MODELS.includes(patch.asrModel)) next.asrModel = patch.asrModel;
  if (patch && typeof patch.anthropicApiKey === 'string') next.anthropicApiKey = patch.anthropicApiKey.trim().slice(0, 300);
  if (patch && typeof patch.storageDir === 'string') {
    let dir = patch.storageDir.trim();
    if (dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(2));
    if (dir && !path.isAbsolute(dir)) throw Object.assign(new Error(st('storage_absolute')), { status: 400, code: 'storage_absolute' });
    const target = dir ? path.resolve(dir) : DEFAULT_ROOT;
    await withGlobalLock(() => moveStorage(storageDir(), target));
    next.storageDir = target === DEFAULT_ROOT ? '' : target;
  }
  await fsp.writeFile(SETTINGS_PATH + '.tmp', JSON.stringify(next, null, 2));
  await fsp.rename(SETTINGS_PATH + '.tmp', SETTINGS_PATH);
  const storageChanged = settingsCache && settingsCache.storageDir !== next.storageDir;
  settingsCache = next;
  if (storageChanged) prepareStorage();
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
    no_transcript: 'Transcribe the audio first.',
    ai_no_key: 'Add your Anthropic API key in Settings to use AI summaries.',
    ai_auth: 'The Anthropic API key was rejected. Check it in Settings.',
    ai_rate: 'Claude is busy or the rate limit was reached. Try again in a minute.',
    ai_network: "Couldn't reach the Claude API. Check the internet connection.",
    ai_refused: 'Claude declined to summarize this transcript.',
    ai_failed: 'AI summary failed: {msg}',
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
    no_transcript: 'Hãy chuyển âm thanh thành chữ trước.',
    ai_no_key: 'Nhập Anthropic API key trong Cài đặt để dùng tóm tắt AI.',
    ai_auth: 'Anthropic API key không hợp lệ. Kiểm tra lại trong Cài đặt.',
    ai_rate: 'Claude đang bận hoặc đã chạm giới hạn. Thử lại sau một phút.',
    ai_network: 'Không kết nối được Claude API. Kiểm tra kết nối internet.',
    ai_refused: 'Claude từ chối tóm tắt transcript này.',
    ai_failed: 'Tóm tắt AI bị lỗi: {msg}',
  },
};

/** Chuỗi phía server theo ngôn ngữ đang chọn. */
function st(key, vars = {}) {
  const lang = getSettings().language;
  const text = (SERVER_TEXT[lang] && SERVER_TEXT[lang][key]) || SERVER_TEXT.en[key] || key;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function apiError(res, status, code, vars) {
  return sendJson(res, status, { error: st(code, vars), code });
}

// ---------- session storage ----------

function metaPath(id) {
  return sessionFile(id, META_FILE);
}

function eventsPath(id) {
  return sessionFile(id, EVENTS_FILE);
}

async function loadMeta(id) {
  try {
    return JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

const NOTE_MAX = 100000; // ký tự HTML, ghi chú của một phiên
const NOTE_TAGS = new Set(['b', 'i', 'u', 's', 'p', 'br', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a', 'code']);

/**
 * Ghi chú có định dạng: chỉ giữ thẻ trong NOTE_TAGS, bỏ mọi thuộc tính (trừ href http/https/mailto của link),
 * mọi "<" ">" còn lại thành chữ. Trang soạn thảo cũng tự làm sạch khi hiện ra; đây là lớp bảo vệ thứ hai.
 */
function sanitizeNoteHtml(html) {
  return String(html).replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/(<\/?[a-z][a-z0-9]*\b[^>]*>)/i).map((part, i) => {
    if (i % 2 === 0) return part.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const [, close, name, attrs] = /^<(\/?)([a-z][a-z0-9]*)\b([^>]*)>$/i.exec(part);
    const tag = name.toLowerCase();
    if (!NOTE_TAGS.has(tag)) return '';
    if (close) return tag === 'br' ? '' : `</${tag}>`;
    if (tag !== 'a') return `<${tag}>`;
    const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    const href = m ? (m[1] ?? m[2] ?? m[3]).replace(/&amp;/g, '&').trim() : '';
    if (!/^(https?:|mailto:)/i.test(href)) return '<a>';
    return `<a href="${href.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}" target="_blank" rel="noopener noreferrer">`;
  }).join('');
}

/** HTML của ghi chú → chữ thường (session.json, xem nhanh trong danh sách phiên). */
function noteToText(html) {
  return String(html)
    .replace(/<br>/g, '\n')
    .replace(/<li>/g, '• ')
    .replace(/<\/(p|h3|blockquote|li)>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function saveMeta(meta) {
  const file = metaPath(meta.id);
  await fsp.writeFile(file + '.tmp', JSON.stringify(meta, null, 2));
  await fsp.rename(file + '.tmp', file);
  scheduleExport(meta.id);
}

// ---- session.json + events.csv trong thư mục phiên: ghi lại vài giây sau lần thay đổi cuối ----

const exportTimers = new Map();

function scheduleExport(id, delay = EXPORT_DELAY_MS) {
  clearTimeout(exportTimers.get(id));
  const timer = setTimeout(() => {
    exportTimers.delete(id);
    withSessionLock(id, () => writeExports(id)).catch(() => {});
  }, delay);
  timer.unref();
  exportTimers.set(id, timer);
}

/** Ghi file xuất của phiên ngay. Gọi khi đang giữ khoá của phiên (hoặc khi không có ai ghi). */
async function writeExports(id) {
  const dir = sessionDir(id);
  if (!dir) return;
  for (const [format, name] of [['json', EXPORT_JSON], ['csv', EXPORT_CSV]]) {
    const out = await exportSession(id, format);
    if (!out) return;
    await fsp.writeFile(path.join(dir, name + '.tmp'), out.body);
    await fsp.rename(path.join(dir, name + '.tmp'), path.join(dir, name));
  }
}

/** Ghi file xuất ngay (ví dụ trước khi mở thư mục phiên trong Finder). */
function flushExports(id) {
  clearTimeout(exportTimers.get(id));
  exportTimers.delete(id);
  return withSessionLock(id, () => writeExports(id));
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
  return path.join(storageDir(), SCENARIOS_FILE);
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
  // quét lại mỗi lần để thấy cả thay đổi làm bằng Finder
  const ids = [...rebuildIndex().keys()];
  const metas = (await Promise.all(ids.map((id) => loadMeta(id)))).filter(Boolean);
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
      const sc = await withGlobalLock(async () => {
        const list = await loadScenarios();
        const item = { id: crypto.randomBytes(6).toString('hex'), name, folder: scenarioFolderName(name, list), createdAt: new Date().toISOString() };
        await fsp.mkdir(path.join(storageDir(), item.folder), { recursive: true });
        await saveScenarios([...list, item]);
        return item;
      });
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
      // đổi tên thư mục kịch bản theo tên mới
      const folder = scenarioFolderName(name, list, id);
      const from = path.join(storageDir(), sc.folder || safeName(sc.name, 'Scenario'));
      const to = path.join(storageDir(), folder);
      if (from.toLowerCase() !== to.toLowerCase() && fs.existsSync(from)) await moveDir(from, to);
      else if (from !== to && fs.existsSync(from)) await fsp.rename(from, to); // chỉ đổi hoa/thường
      else await fsp.mkdir(to, { recursive: true });
      sc.name = name;
      sc.folder = folder;
      await saveScenarios(list);
      rebuildIndex();
      return sc;
    });
    return updated ? sendJson(res, 200, updated) : apiError(res, 404, 'scenario_not_found');
  }
  if (req.method === 'DELETE') {
    // Xoá kịch bản không xoá phiên: các phiên chỉ được bỏ khỏi kịch bản.
    const ok = await withGlobalLock(async () => {
      const list = await loadScenarios();
      const sc = list.find((x) => x.id === id);
      if (!sc) return false;
      await saveScenarios(list.filter((x) => x.id !== id));
      // các phiên chuyển sang "No scenario"; thư mục kịch bản bị xoá nếu không còn gì
      for (const m of await listSessions()) {
        if (m.scenarioId === id) await withSessionLock(m.id, async () => {
          const fresh = await loadMeta(m.id);
          if (!fresh) return;
          delete fresh.scenarioId;
          await relocateSession(fresh);
          await saveMeta(fresh);
        });
      }
      if (sc.folder) await removeIfEmpty(path.join(storageDir(), sc.folder));
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

// ---------- ghi màn hình / ghi âm của phiên ----------
//
// Trình duyệt gửi từng đoạn MediaRecorder (mỗi vài giây) lên POST …/media/<mediaId>; các đoạn
// được nối vào một file, nên app bị tắt giữa chừng vẫn giữ phần đã ghi. meta.media lưu danh sách.

const MEDIA_KINDS = new Set(['screen', 'audio']);
const MEDIA_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4GB mỗi file
const MEDIA_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/webm': 'weba', 'audio/ogg': 'ogg' };
const MEDIA_MIME = { mp4: 'video/mp4', webm: 'video/webm', m4a: 'audio/mp4', weba: 'audio/webm', ogg: 'audio/ogg' };

function mediaFilePath(id, file) {
  return sessionFile(id, path.basename(file));
}

function updateMeta(id, fn) {
  return withSessionLock(id, async () => {
    const fresh = await loadMeta(id);
    if (!fresh) return null;
    await fn(fresh);
    await saveMeta(fresh);
    return fresh;
  });
}

async function handleMedia(req, res, url, meta, mediaId, action) {
  if (!mediaId) {
    if (req.method === 'GET') return sendJson(res, 200, meta.media || []);
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (!/^[a-z0-9-]{1,40}$/.test(mediaId)) return sendJson(res, 400, { error: 'Invalid media id' });
  const id = meta.id;
  const entry = (meta.media || []).find((m) => m.id === mediaId);

  // nhận thêm một đoạn dữ liệu
  if (req.method === 'POST' && !action) {
    let item = entry;
    if (!item) {
      const kind = url.searchParams.get('kind');
      const mime = String(url.searchParams.get('mime') || '').split(';')[0].trim().toLowerCase();
      const ext = MEDIA_EXT[mime];
      if (!MEDIA_KINDS.has(kind) || !ext) return sendJson(res, 400, { error: 'Unsupported media type' });
      const startT = Number(url.searchParams.get('t')) || 0;
      item = { id: mediaId, kind, mime: url.searchParams.get('mime').slice(0, 80), file: '', startT, endT: null, size: 0, createdAt: new Date().toISOString() };
      // tên file dễ đọc trong thư mục phiên: screen-recording-1.mp4, audio-recording-1.m4a…
      await updateMeta(id, (m) => {
        const others = (m.media || []).filter((x) => x.id !== mediaId);
        item.file = nextMediaName(others, kind, ext, sessionDir(id));
        m.media = [...others, item];
      });
    }
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024 * 1024) return sendJson(res, 413, { error: 'Chunk too large' });
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    const updated = await withSessionLock(id, async () => {
      const fresh = await loadMeta(id);
      const cur = fresh && (fresh.media || []).find((x) => x.id === mediaId);
      if (!cur) return null;
      if (cur.size + buf.length > MEDIA_MAX_BYTES) throw Object.assign(new Error('Media file too large'), { status: 413 });
      await fsp.appendFile(mediaFilePath(id, cur.file), buf);
      cur.size += buf.length;
      await saveMeta(fresh);
      return cur;
    });
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'Media not found' });
  }

  if (!entry) return sendJson(res, 404, { error: 'Media not found' });

  // kết thúc một bản ghi: lưu mốc thời gian kết thúc & thời lượng thực (đã trừ lúc tạm dừng)
  if (req.method === 'POST' && action === 'finish') {
    const body = await readJson(req);
    const updated = await updateMeta(id, (m) => {
      const cur = (m.media || []).find((x) => x.id === mediaId);
      if (!cur) return;
      cur.endT = num(body.endT) ?? null;
      cur.durationMs = num(body.durationMs) ?? null;
    });
    return sendJson(res, 200, (updated.media || []).find((x) => x.id === mediaId));
  }

  if (req.method === 'DELETE' && !action) {
    await fsp.rm(mediaFilePath(id, entry.file), { force: true });
    await updateMeta(id, (m) => { m.media = (m.media || []).filter((x) => x.id !== mediaId); });
    return sendJson(res, 200, { ok: true });
  }

  // phát lại / tải về (hỗ trợ Range để tua video)
  if (req.method === 'GET' && !action) {
    const file = mediaFilePath(id, entry.file);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return sendJson(res, 404, { error: 'Media file missing' });
    }
    const ext = entry.file.split('.').pop();
    const headers = { 'Content-Type': MEDIA_MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (url.searchParams.get('download')) headers['Content-Disposition'] = `attachment; filename="heatmap-${id}-${mediaId}.${ext}"`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && stat.size > 0) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      start = Math.max(0, start);
      end = Math.min(stat.size - 1, end);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    return fs.createReadStream(file).pipe(res);
  }
  return sendJson(res, 405, { error: 'Method not allowed' });
}

// ---------- transcript (nhận dạng giọng nói chạy trong trình duyệt, lưu kết quả ở đây) ----------

function transcriptPath(id) {
  return sessionFile(id, TRANSCRIPT_FILE);
}

async function loadTranscript(id) {
  try {
    return JSON.parse(await fsp.readFile(transcriptPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function sanitizeSegments(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20000).map((seg) => ({
    start: num(seg && seg.start) ?? 0,
    end: num(seg && seg.end) ?? null,
    text: str(seg && seg.text, 4000) || '',
  }));
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const DOC_TEXT = {
  en: { title: 'Session transcript', link: 'Link', participant: 'Participant', recorded: 'Recorded', language: 'Language', model: 'Speech model', summary: 'AI summary', transcript: 'Transcript', anon: 'anonymous', vietnamese: 'Vietnamese', english: 'English', auto: 'Auto-detect' },
  vi: { title: 'Transcript phiên', link: 'Link', participant: 'Người tham gia', recorded: 'Thời điểm ghi', language: 'Ngôn ngữ', model: 'Mô hình giọng nói', summary: 'Tóm tắt bằng AI', transcript: 'Transcript', anon: 'ẩn danh', vietnamese: 'Tiếng Việt', english: 'Tiếng Anh', auto: 'Tự nhận diện' },
};

/** File Word (.docx) gồm thông tin phiên, tóm tắt AI (nếu có) và transcript có mốc thời gian. */
async function transcriptDocx(meta, tr) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require(process.env.DOCX_MODULE || 'docx');
  const L = DOC_TEXT[getSettings().language] || DOC_TEXT.en;
  const info = (k, v) => new Paragraph({ children: [new TextRun({ text: `${k}: `, bold: true }), new TextRun(String(v))] });
  const children = [
    new Paragraph({ text: `Heatmap — ${L.title}`, heading: HeadingLevel.TITLE }),
    info(L.link, meta.url),
    info(L.participant, meta.participant || L.anon),
    info(L.recorded, new Date(meta.createdAt).toLocaleString(getSettings().language === 'vi' ? 'vi-VN' : 'en-US')),
    info(L.language, L[tr.language] || tr.language || '—'),
    info(L.model, tr.model || '—'),
  ];
  if (tr.summary && tr.summary.text) {
    children.push(new Paragraph({ text: L.summary, heading: HeadingLevel.HEADING_1 }));
    for (const line of tr.summary.text.split(/\n/)) {
      const bullet = /^\s*[-*•]\s+/.test(line);
      const heading = /^#{1,3}\s+/.test(line);
      const clean = line.replace(/^\s*[-*•]\s+/, '').replace(/^#{1,4}\s+/, '');
      if (!clean.trim()) continue;
      // **đậm** → chữ in đậm trong Word
      const runs = clean.split(/\*\*(.+?)\*\*/g).map((part, i) => new TextRun({ text: part, bold: i % 2 === 1 }));
      children.push(heading
        ? new Paragraph({ text: clean.replace(/\*\*(.+?)\*\*/g, '$1'), heading: HeadingLevel.HEADING_2 })
        : new Paragraph({ children: runs, bullet: bullet ? { level: 0 } : undefined }));
    }
  }
  children.push(new Paragraph({ text: L.transcript, heading: HeadingLevel.HEADING_1 }));
  for (const seg of tr.segments || []) {
    children.push(new Paragraph({ children: [new TextRun({ text: `[${fmtTime(seg.start)}] `, color: '667085' }), new TextRun(seg.text.trim())] }));
  }
  return Packer.toBuffer(new Document({ creator: 'Heatmap', title: `${L.title} ${meta.id}`, sections: [{ children }] }));
}

function transcriptText(meta, tr) {
  const when = new Date(meta.createdAt).toLocaleString(getSettings().language === 'vi' ? 'vi-VN' : 'en-US');
  const lines = [`Heatmap — ${meta.url}`, `${meta.participant || ''} ${when}`.trim(), ''];
  if (tr.summary && tr.summary.text) lines.push(tr.summary.text.trim(), '', '---', '');
  for (const seg of tr.segments || []) lines.push(`[${fmtTime(seg.start)}] ${seg.text.trim()}`);
  return lines.join('\n') + '\n';
}

async function handleTranscript(req, res, url, meta) {
  const id = meta.id;
  if (req.method === 'GET') {
    const tr = await loadTranscript(id);
    const format = url.searchParams.get('format');
    if (!format) return sendJson(res, 200, tr);
    if (!tr) return sendJson(res, 404, { error: 'No transcript yet' });
    if (format === 'docx') {
      const buf = await transcriptDocx(meta, tr);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="heatmap-transcript-${id}.docx"`,
        'Content-Length': buf.length,
      });
      return res.end(buf);
    }
    if (format === 'txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="heatmap-transcript-${id}.txt"` });
      return res.end(transcriptText(meta, tr));
    }
    return sendJson(res, 400, { error: 'Unknown format' });
  }
  if (req.method === 'PUT') {
    const body = await readJson(req);
    const saved = await withSessionLock(id, async () => {
      const prev = (await loadTranscript(id)) || {};
      const next = {
        ...prev,
        audioId: str(body.audioId, 40) || prev.audioId || null,
        language: ['vietnamese', 'english', 'auto'].includes(body.language) ? body.language : prev.language || 'auto',
        model: str(body.model, 120) || prev.model || '',
        segments: 'segments' in body ? sanitizeSegments(body.segments) : prev.segments || [],
        updatedAt: new Date().toISOString(),
        createdAt: prev.createdAt || new Date().toISOString(),
      };
      // giữ tóm tắt AI; nếu client gửi tóm tắt đã chỉnh sửa thì cập nhật nội dung
      if (body.summary && typeof body.summary.text === 'string' && next.summary) next.summary = { ...next.summary, text: body.summary.text.slice(0, 50000), edited: true };
      await fsp.writeFile(transcriptPath(id), JSON.stringify(next, null, 2));
      await updateMetaUnlocked(id, (m) => { m.hasTranscript = next.segments.length > 0; });
      return next;
    });
    return sendJson(res, 200, saved);
  }
  return sendJson(res, 405, { error: 'Method not allowed' });
}

// ---------- tóm tắt bằng AI (Claude) ----------

const SUMMARY_MODEL = 'claude-opus-5-5';
const SUMMARY_LANG = { vi: 'Vietnamese', en: 'English' };

const SUMMARY_SYSTEM = `You are a UX researcher reviewing one moderated usability-test session of a website or prototype.
You get the speech transcript of the participant (and possibly a moderator), recognised automatically, so expect misheard words; infer the intended meaning when it is clear and never invent statements.
You also get the participant's interaction timeline (pages opened and elements clicked) on the same clock, so you can connect what they said with what they were doing.

Write a concise summary for the product team, in Markdown, with exactly these sections:
## Overview — 2-3 sentences: what the participant did and the overall impression.
## Pain points — bullets, most severe first; name the page or element when the timeline shows it.
## What worked well — bullets.
## Suggestions — concrete, actionable bullets that follow from the evidence.
## Notable quotes — up to 5 short quotes with their [mm:ss] timestamps, quoted as spoken.

Use "-" bullets, no tables, no extra sections. If the transcript is too short or empty of feedback, say so in the Overview and keep the other sections brief.`;

/** Dòng thời gian gộp: lời nói (theo đồng hồ của phiên) + trang đã mở + phần tử đã bấm. */
function summaryTimeline(meta, tr, events) {
  const audio = (meta.media || []).find((m) => m.id === tr.audioId);
  const offset = audio ? (audio.startT || 0) / 1000 : 0;
  const rows = [];
  for (const seg of tr.segments || []) if (seg.text.trim()) rows.push([offset + seg.start, `SAYS: ${seg.text.trim()}`]);
  let actions = 0;
  for (const e of events) {
    if (actions >= 400) break;
    if (e.type === 'pageview' && e.page) {
      rows.push([e.t / 1000, `OPENS PAGE: ${e.title ? `"${e.title}" ` : ''}${e.page}`]);
      actions++;
    } else if (e.type === 'click') {
      const el = e.el || {};
      const label = (el.text || '').trim() || el.id || el.selector || el.tag || 'element';
      rows.push([e.t / 1000, `CLICKS: ${el.tag || ''} "${label.slice(0, 80)}"${el.href ? ` → ${el.href.slice(0, 200)}` : ''}`]);
      actions++;
    }
  }
  return rows.sort((a, b) => a[0] - b[0]).map(([t, text]) => `[${fmtTime(t)}] ${text}`).join('\n');
}

let anthropicSdk = null;
function anthropic() {
  if (!anthropicSdk) anthropicSdk = require(process.env.ANTHROPIC_SDK_MODULE || '@anthropic-ai/sdk');
  return anthropicSdk;
}

async function handleSummary(req, res, meta) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  const body = await readJson(req);
  const tr = await loadTranscript(meta.id);
  if (!tr || !(tr.segments || []).some((s) => s.text.trim())) return apiError(res, 400, 'no_transcript');
  const lang = SUMMARY_LANG[body.language] ? body.language : getSettings().language;
  const events = await loadEvents(meta.id);
  const stats = sessionStats(meta, events);

  const Anthropic = anthropic();
  const key = getSettings().anthropicApiKey;
  // key trong Cài đặt; nếu trống thì SDK tự lấy ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / profile
  const client = new Anthropic(key ? { apiKey: key } : {});
  const prompt = `Session facts:
- Tested link: ${meta.url}
- Participant: ${meta.participant || 'anonymous'}
- Duration: ${fmtTime(stats.durationMs / 1000)}, pages viewed: ${stats.pages}, clicks: ${stats.clicks}, max scroll depth: ${Math.round(stats.maxDepth)}%

<timeline>
${summaryTimeline(meta, tr, events)}
</timeline>

Write the summary in ${SUMMARY_LANG[lang]}.`;

  let message;
  try {
    const stream = client.beta.messages.stream({
      model: SUMMARY_MODEL,
      max_tokens: 8000,
      output_config: { effort: 'medium' },
      // nếu bộ lọc an toàn của mô hình từ chối, API tự chạy lại trên mô hình dự phòng được khuyến nghị
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return apiError(res, 401, 'ai_auth');
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return apiError(res, 503, 'ai_rate');
    if (err instanceof Anthropic.APIConnectionError) return apiError(res, 502, 'ai_network');
    if (err instanceof Anthropic.APIError) return apiError(res, 502, 'ai_failed', { msg: err.message });
    if (err instanceof Anthropic.AnthropicError) return apiError(res, 400, 'ai_no_key'); // chưa có cách xác thực nào
    throw err;
  }
  if (message.stop_reason === 'refusal') return apiError(res, 422, 'ai_refused');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) return apiError(res, 502, 'ai_failed', { msg: message.stop_reason || 'empty' });

  const summary = {
    text,
    model: message.model,
    language: lang,
    truncated: message.stop_reason === 'max_tokens',
    createdAt: new Date().toISOString(),
  };
  const saved = await withSessionLock(meta.id, async () => {
    const fresh = (await loadTranscript(meta.id)) || tr;
    const next = { ...fresh, summary };
    await fsp.writeFile(transcriptPath(meta.id), JSON.stringify(next, null, 2));
    return next;
  });
  return sendJson(res, 200, saved);
}

/** Sửa meta khi đang giữ khoá của phiên (không lấy khoá lần nữa). */
async function updateMetaUnlocked(id, fn) {
  const fresh = await loadMeta(id);
  if (!fresh) return null;
  await fn(fresh);
  await saveMeta(fresh);
  return fresh;
}

// ---------- mô hình Whisper: proxy + lưu đệm trên đĩa ----------
// transformers.js tải {model}/resolve/{revision}/{file} từ đây thay vì trực tiếp từ Hugging Face.

const modelDownloads = new Map();

async function handleModelFile(req, res, rel) {
  const m = /^\/models\/([\w.-]+\/[\w.-]+)\/resolve\/([\w.-]+)\/([\w./-]+)$/.exec(rel);
  if (!m || !ASR_MODELS.includes(m[1]) || m[3].includes('..')) return sendText(res, 404, 'Not found');
  const [, model, revision, file] = m;
  const local = path.join(DATA_DIR, 'models', model, revision, file);
  if (!fs.existsSync(local)) {
    // nhiều request cùng file → chỉ tải một lần
    if (!modelDownloads.has(local)) {
      modelDownloads.set(local, (async () => {
        const upstream = await fetch(`${hfEndpoint()}/${model}/resolve/${revision}/${file}`, { redirect: 'follow' });
        if (upstream.status === 404) throw Object.assign(new Error('Not found'), { status: 404 });
        if (!upstream.ok || !upstream.body) throw Object.assign(new Error('Model download failed: HTTP ' + upstream.status), { status: 502 });
        await fsp.mkdir(path.dirname(local), { recursive: true });
        const tmp = local + '.part';
        await require('node:stream/promises').pipeline(Readable.fromWeb(upstream.body), fs.createWriteStream(tmp));
        await fsp.rename(tmp, local);
      })().finally(() => modelDownloads.delete(local)));
    }
    try {
      await modelDownloads.get(local);
    } catch (err) {
      return sendText(res, err.status || 502, err.message);
    }
  }
  const stat = await fsp.stat(local);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(local).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  fs.createReadStream(local).pipe(res);
}

// ---------- xuất dữ liệu một phiên ----------

/**
 * Content-Disposition cho tên file có dấu (tên người tham gia, ví dụ "Nguyễn Thu Hà.csv"): header HTTP chỉ
 * nhận ASCII, nên gửi kèm tên ASCII dự phòng (bỏ dấu) và tên UTF-8 đầy đủ theo RFC 5987.
 */
function attachmentHeader(filename) {
  const ascii = String(filename).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Nội dung file xuất của một phiên: { filename, contentType, body }. Dùng cho tải về và "Save as". */
async function exportSession(id, format = 'json') {
  const meta = await loadMeta(id);
  if (!meta) return null;
  const events = await loadEvents(id);
  if (format === 'csv') {
    const cols = ['t', 'type', 'page', 'x', 'y', 'vx', 'vy', 'vw', 'vh', 'dw', 'dh', 'sx', 'sy', 'el_tag', 'el_selector', 'el_text', 'el_href'];
    const q = (v) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const rows = events.map((e) => cols.map((c) => q(c.startsWith('el_') ? e.el && e.el[c.slice(3)] : e[c])).join(','));
    return { filename: `${sessionFolderName(meta)}.csv`, contentType: 'text/csv; charset=utf-8', body: [cols.join(','), ...rows].join('\n') };
  }
  return { filename: `${sessionFolderName(meta)}.json`, contentType: MIME['.json'], body: JSON.stringify({ ...meta, events }, null, 2) };
}

/** Thư mục và các file chính của phiên trên ổ đĩa (để mở trong Finder). */
function sessionFilePaths(id) {
  const dir = sessionDir(id);
  if (!dir) return null;
  return { dir, json: path.join(dir, EXPORT_JSON), csv: path.join(dir, EXPORT_CSV), meta: path.join(dir, META_FILE), events: path.join(dir, EVENTS_FILE) };
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sessions', id?, sub?]

  if (parts[1] === 'settings' && parts.length === 2) {
    if (req.method === 'GET') return sendJson(res, 200, publicSettings());
    if (req.method === 'PUT') {
      try {
        return sendJson(res, 200, publicSettings(await updateSettings(await readJson(req))));
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
        // ghi âm micro: chỉ khi phiên bật webcam
        recordAudio: !!body.recordAudio && !!body.eyeTracking && getSettings().eyeTrackingEnabled,
        createdAt: new Date().toISOString(),
        endedAt: null,
        calibration: null,
        userAgent: str(req.headers['user-agent'], 300) || '',
        eventCount: 0,
        durationMs: 0,
      };
      const scenarios = await loadScenarios();
      if (typeof body.scenarioId === 'string' && scenarios.some((x) => x.id === body.scenarioId)) {
        meta.scenarioId = body.scenarioId;
      }
      // thư mục riêng: <kịch bản>/<người tham gia>/
      await withGlobalLock(async () => {
        const dir = uniquePath(scenarioDirSync(meta.scenarioId, scenarios), sessionFolderName(meta));
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, EVENTS_FILE), '');
        await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(meta, null, 2));
        if (!sessionIndex || indexRoot !== storageDir()) rebuildIndex();
        sessionIndex.set(meta.id, dir);
      });
      scheduleExport(meta.id);
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
          await relocateSession(fresh); // chuyển thư mục phiên sang thư mục kịch bản mới
        }
        if (body.calibration && typeof body.calibration === 'object') {
          fresh.calibration = {
            accuracy: num(body.calibration.accuracy),
            meanErrorPx: num(body.calibration.meanErrorPx),
            at: new Date().toISOString(),
          };
        }
        // ghi chú của người xem báo cáo (nhận xét, vấn đề phát hiện…), dạng HTML có định dạng
        // (noteFormat 'html') hoặc chữ thường; không còn chữ nào = xoá
        if (typeof body.note === 'string') {
          const html = body.noteFormat === 'html';
          const note = html ? sanitizeNoteHtml(body.note.slice(0, NOTE_MAX)) : body.note.slice(0, NOTE_MAX);
          const text = html ? noteToText(note) : note;
          delete fresh.noteBy; // bản desktop không có tài khoản người viết
          const empty = !(html ? note.replace(/<[^>]*>|&nbsp;/g, '') : note).trim();
          if (!empty) {
            fresh.note = note;
            fresh.noteText = text;
            if (html) fresh.noteFormat = 'html';
            else delete fresh.noteFormat;
            fresh.noteUpdatedAt = new Date().toISOString();
          } else {
            for (const k of ['note', 'noteText', 'noteFormat', 'noteUpdatedAt']) delete fresh[k];
          }
        }
        await saveMeta(fresh);
        if (body.ended) await writeExports(id); // kết thúc phiên → session.json / events.csv đầy đủ ngay
        return fresh;
      });
      return updated ? sendJson(res, 200, updated) : apiError(res, 404, 'not_found');
    }
    if (req.method === 'DELETE') {
      await withSessionLock(id, async () => {
        clearTimeout(exportTimers.get(id));
        exportTimers.delete(id);
        const dir = sessionDir(id);
        if (!dir) return;
        await fsp.rm(dir, { recursive: true, force: true });
        sessionIndex.delete(id);
        await removeIfEmpty(path.join(storageDir(), UNASSIGNED_FOLDER));
      });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (sub === 'media') return handleMedia(req, res, url, meta, parts[4], parts[5]);
  if (sub === 'transcript' && parts[4] === 'summary') return handleSummary(req, res, meta);
  if (sub === 'transcript') return handleTranscript(req, res, url, meta);

  if (sub === 'events' && req.method === 'POST') {
    const body = await readJson(req);
    const list = Array.isArray(body.events) ? body.events : [];
    const clean = list.slice(0, 20000).map(sanitizeEvent).filter(Boolean);
    if (clean.length) await appendEvents(id, clean);
    return sendJson(res, 200, { accepted: clean.length });
  }

  if (sub === 'export' && req.method === 'GET') {
    const out = await exportSession(id, url.searchParams.get('format') === 'csv' ? 'csv' : 'json');
    res.writeHead(200, { 'Content-Type': out.contentType, 'Content-Disposition': attachmentHeader(out.filename) });
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

// Trang transcript bật cross-origin isolation để ONNX Runtime chạy đa luồng (nhanh hơn nhiều).
const ISOLATION_HEADERS = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
const ISOLATED_PAGES = new Set(['transcript.html', 'transcript.js', 'asr-worker.js', 'i18n.js', 'style.css', 'logo.svg', 'media.js']);

async function serveStatic(res, root, rel, extraHeaders) {
  const filePath = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!filePath.startsWith(root + path.sep) && filePath !== root) return sendText(res, 403, 'Forbidden');
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (stat.isDirectory()) return serveStatic(res, root, path.posix.join(rel, 'index.html'));
  const isolated = root === PUBLIC_DIR && ISOLATED_PAGES.has(path.basename(filePath));
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    ...(isolated ? ISOLATION_HEADERS : {}),
    ...(extraHeaders || {}),
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
    if (rel === '/vendor/transformers/transformers.min.js') return await serveStatic(res, TRANSFORMERS_DIR, 'transformers.min.js', ISOLATION_HEADERS);
    if (/^\/vendor\/ort\/ort-wasm-simd-threaded\.(asyncify|jsep)\.(mjs|wasm)$/.test(rel)) {
      return await serveStatic(res, ORT_DIR, rel.slice('/vendor/ort/'.length), ISOLATION_HEADERS);
    }
    if (rel.startsWith('/models/')) return await handleModelFile(req, res, rel);
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
  sessionIndex = null;
  prepareStorage();
  return http.createServer(handler);
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Eye tracking tool đang chạy tại http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${TOOL_PREFIX}/`);
  });
}

module.exports = { createServer, ASR_MODELS, exportSession, sessionFilePaths, flushExports, storageDir, normalizeTargetUrl, normalizeSessionUrl, normalizeFigmaUrl, getSettings, updateSettings, settingsEvents, rewriteHtml, isPrivateAddress, sanitizeEvent, sanitizeNoteHtml, noteToText, toProxyUrl, TOOL_PREFIX };
