'use strict';

// Tài khoản cho bản online: admin (quản trị toàn bộ Heatmap) và guest (người tham gia, chỉ vào
// được kịch bản được giao). Lưu trong DATA_DIR/users.json; mật khẩu băm bằng scrypt, không lưu
// mật khẩu gốc. Phiên đăng nhập là token ngẫu nhiên trong cookie HttpOnly; server chỉ lưu bản băm.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const COOKIE = 'hm_auth';
const TTL_MS = { admin: 7 * 24 * 3600e3, mod: 7 * 24 * 3600e3, guest: 3 * 24 * 3600e3 };
const STAFF = new Set(['admin', 'mod']); // admin + mod (người quản lý): có mã khôi phục, mật khẩu dài hơn
const LOGIN_WINDOW_MS = 15 * 60e3;
const LOGIN_MAX_FAILS = 8;
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bỏ ký tự dễ nhầm (0/O, 1/l/I)

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

function randomPassword(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Mã khôi phục: 10 mã, mỗi mã 8 ký tự (khoảng 40 bit ngẫu nhiên), hiển thị dạng ABCD-EFGH, dùng một lần.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_COUNT = 10;

function randomRecoveryCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Người dùng gõ có thể thiếu gạch, có dấu cách, chữ thường → "ABCDEFGH". */
const normalizeRecoveryCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "Nguyễn Văn Đức" → "nguyenvanduc" (tên đăng nhập chỉ gồm a-z0-9). */
function slug(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 16);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Trang chạy sau HTTPS (trực tiếp hoặc qua reverse proxy như Caddy/Nginx/Render) → cookie Secure. */
function isSecure(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (process.env.COOKIE_SECURE === '0') return false;
  return !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function createAuth({ dataDir, log = console.log }) {
  const usersFile = path.join(dataDir, 'users.json');
  const sessionsFile = path.join(dataDir, 'auth-sessions.json');
  let users = [];
  let sessions = new Map(); // sha256(token) → { userId, expiresAt }
  const fails = new Map(); // `${ip}|${username}` → [thời điểm sai]
  let saveTimer = null;
  let loadedMtime = 0; // để nhận ra khi file bị sửa từ ngoài (lệnh reset-admin lúc server đang chạy)

  const mtimeOf = (file) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  };

  function load() {
    try {
      users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      if (!Array.isArray(users)) users = [];
    } catch {
      users = [];
    }
    try {
      const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      sessions = new Map(Object.entries(raw).filter(([, s]) => s.expiresAt > Date.now()));
    } catch {
      sessions = new Map();
    }
    loadedMtime = mtimeOf(usersFile);
  }

  function refreshIfChanged() {
    if (mtimeOf(usersFile) === loadedMtime) return;
    load();
    // người quản lý máy chủ vừa sửa tài khoản (reset-admin) → gỡ khoá tạm vì đăng nhập sai
    fails.clear();
  }

  function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }

  const saveUsers = () => {
    writeAtomic(usersFile, users);
    loadedMtime = mtimeOf(usersFile);
  };

  function saveSessionsSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeAtomic(sessionsFile, Object.fromEntries(sessions)), 500);
    saveTimer.unref();
  }

  /** Lần chạy đầu: tạo admin từ ADMIN_USERNAME / ADMIN_PASSWORD, hoặc mật khẩu ngẫu nhiên in ra log. */
  function ensureAdmin() {
    if (users.some((u) => u.role === 'admin')) return null;
    const username = slug(process.env.ADMIN_USERNAME || 'admin') || 'admin';
    const password = process.env.ADMIN_PASSWORD || randomPassword(14);
    users.push({ id: crypto.randomBytes(8).toString('hex'), role: 'admin', username, name: 'Admin', passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
    saveUsers();
    if (!process.env.ADMIN_PASSWORD) log(`[heatmap] Tài khoản admin đầu tiên: ${username} / ${password}  (đổi mật khẩu sau khi đăng nhập)`);
    return { username, password };
  }

  const publicUser = (u) => u && {
    id: u.id,
    role: u.role,
    username: u.username,
    name: u.name,
    scenarioIds: u.scenarioIds || [],
    disabled: !!u.disabled,
    recoveryCodesLeft: (u.recoveryCodes || []).length,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
  };

  function uniqueUsername(name) {
    const base = slug(name) || 'guest';
    for (;;) {
      const candidate = `${base}${crypto.randomInt(1000, 10000)}`;
      if (!users.some((u) => u.username === candidate)) return candidate;
    }
  }

  function createGuest({ name, scenarioIds = [] }) {
    const password = randomPassword();
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      role: 'guest',
      username: uniqueUsername(name),
      name: String(name).trim().slice(0, 100),
      scenarioIds: [...new Set(scenarioIds)],
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    saveUsers();
    return { user: publicUser(user), password };
  }

  /**
   * Tài khoản Mod (người quản lý người tham gia), do admin tạo. Tên đăng nhập tự chọn (a-z, 0-9, . _ -)
   * hoặc để trống để tự sinh. Trả về { user, password } hoặc { error }.
   */
  function createMod({ name, username }) {
    const display = String(name || '').trim().slice(0, 100);
    if (!display) return { error: 'mod_name' };
    let login = String(username || '').trim().toLowerCase();
    if (login) {
      if (!/^[a-z0-9._-]{3,32}$/.test(login)) return { error: 'bad_username' };
      if (users.some((u) => u.username === login)) return { error: 'username_taken' };
    } else {
      login = uniqueUsername(display);
    }
    const password = randomPassword(14);
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      role: 'mod',
      username: login,
      name: display,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    saveUsers();
    return { user: publicUser(user), password };
  }

  function revokeSessions(userId) {
    for (const [k, s] of sessions) if (s.userId === userId) sessions.delete(k);
    saveSessionsSoon();
  }

  function resetPassword(id) {
    const user = users.find((u) => u.id === id);
    if (!user) return null;
    const password = randomPassword(STAFF.has(user.role) ? 14 : 10);
    user.passwordHash = hashPassword(password);
    saveUsers();
    revokeSessions(id);
    return { user: publicUser(user), password };
  }

  function changePassword(id, current, next) {
    const user = users.find((u) => u.id === id);
    if (!user || !verifyPassword(current, user.passwordHash)) return 'wrong_password';
    if (String(next || '').length < 8) return 'weak_password';
    user.passwordHash = hashPassword(next);
    saveUsers();
    return null;
  }

  /**
   * Tạo bộ mã khôi phục mới cho admin (cần nhập đúng mật khẩu hiện tại). Bộ mã cũ hết hiệu lực.
   * Trả về { codes } (chỉ hiện một lần) hoặc { error }.
   */
  function generateRecoveryCodes(id, password) {
    const user = users.find((u) => u.id === id);
    if (!user || !STAFF.has(user.role)) return { error: 'forbidden' };
    if (!verifyPassword(password, user.passwordHash)) return { error: 'wrong_password' };
    const codes = Array.from({ length: RECOVERY_COUNT }, randomRecoveryCode);
    user.recoveryCodes = codes.map((c) => hashPassword(normalizeRecoveryCode(c)));
    user.recoveryCodesAt = new Date().toISOString();
    saveUsers();
    return { codes };
  }

  /**
   * Quên mật khẩu: tên đăng nhập + một mã khôi phục → đặt mật khẩu mới, mã đó bị xoá,
   * mọi phiên đăng nhập cũ bị huỷ và đăng nhập luôn. Bị giới hạn số lần thử như đăng nhập.
   */
  function recover(username, code, nextPassword, ip) {
    refreshIfChanged();
    const name = String(username || '').trim().toLowerCase();
    const key = `${ip}|${name}`;
    const now = Date.now();
    const recent = (fails.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_FAILS) return { error: 'rate_limited' };
    if (String(nextPassword || '').length < 8) return { error: 'weak_password' };
    const user = users.find((u) => u.username === name);
    const normalized = normalizeRecoveryCode(code);
    const index = user && !user.disabled && normalized.length === 8
      ? (user.recoveryCodes || []).findIndex((h) => verifyPassword(normalized, h))
      : -1;
    if (index < 0) {
      recent.push(now);
      fails.set(key, recent);
      return { error: 'bad_recovery' };
    }
    fails.delete(key);
    user.recoveryCodes.splice(index, 1);
    user.passwordHash = hashPassword(nextPassword);
    for (const [k, sess] of sessions) if (sess.userId === user.id) sessions.delete(k);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(sha256(token), { userId: user.id, expiresAt: now + TTL_MS[user.role] });
    user.lastLoginAt = new Date().toISOString();
    saveUsers();
    saveSessionsSoon();
    return { token, user: publicUser(user), remaining: user.recoveryCodes.length };
  }

  /** Dự phòng cuối (lệnh reset-admin trên máy chủ): mật khẩu mới ngẫu nhiên cho một admin. */
  function resetAdmin(username) {
    const admins = users.filter((u) => u.role === 'admin');
    const user = username ? admins.find((u) => u.username === String(username).toLowerCase()) : admins[0];
    if (!user) return null;
    const password = randomPassword(14);
    user.passwordHash = hashPassword(password);
    user.disabled = false;
    saveUsers();
    for (const [k, sess] of sessions) if (sess.userId === user.id) sessions.delete(k);
    writeAtomic(sessionsFile, Object.fromEntries(sessions));
    return { username: user.username, password };
  }

  function updateUser(id, patch) {
    const user = users.find((u) => u.id === id);
    if (!user) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) user.name = patch.name.trim().slice(0, 100);
    if (Array.isArray(patch.scenarioIds) && user.role === 'guest') user.scenarioIds = [...new Set(patch.scenarioIds.filter((x) => typeof x === 'string'))];
    if (typeof patch.disabled === 'boolean' && user.role !== 'admin') {
      user.disabled = patch.disabled;
      if (patch.disabled) revokeSessions(id);
    }
    saveUsers();
    return publicUser(user);
  }

  function deleteUser(id) {
    const i = users.findIndex((u) => u.id === id && u.role !== 'admin'); // không xoá được admin
    if (i < 0) return false;
    users.splice(i, 1);
    saveUsers();
    revokeSessions(id);
    return true;
  }

  /** Bỏ kịch bản đã xoá khỏi mọi guest. */
  function removeScenario(scenarioId) {
    let changed = false;
    for (const u of users) {
      if (u.scenarioIds && u.scenarioIds.includes(scenarioId)) {
        u.scenarioIds = u.scenarioIds.filter((x) => x !== scenarioId);
        changed = true;
      }
    }
    if (changed) saveUsers();
  }

  /** Kiểm tra đăng nhập; trả về { token, user } hoặc { error: 'rate_limited' | 'bad_login' }. */
  function login(username, password, ip) {
    refreshIfChanged();
    const key = `${ip}|${String(username || '').toLowerCase()}`;
    const now = Date.now();
    const recent = (fails.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_FAILS) return { error: 'rate_limited' };
    const user = users.find((u) => u.username === String(username || '').trim().toLowerCase());
    // vẫn băm khi không có tài khoản để thời gian trả lời như nhau
    const ok = user ? verifyPassword(password, user.passwordHash) : (verifyPassword(password, hashPassword('x')), false);
    if (!ok || user.disabled) {
      recent.push(now);
      fails.set(key, recent);
      return { error: 'bad_login' };
    }
    fails.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(sha256(token), { userId: user.id, expiresAt: now + TTL_MS[user.role] });
    user.lastLoginAt = new Date().toISOString();
    saveUsers();
    saveSessionsSoon();
    return { token, user: publicUser(user) };
  }

  function logout(req) {
    const token = parseCookies(req)[COOKIE];
    if (token && sessions.delete(sha256(token))) saveSessionsSoon();
  }

  /** Người dùng của request (đối tượng đầy đủ, chỉ dùng trong server), hoặc null. */
  function userFromRequest(req) {
    refreshIfChanged();
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const s = sessions.get(sha256(token));
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      sessions.delete(sha256(token));
      return null;
    }
    const user = users.find((u) => u.id === s.userId);
    return user && !user.disabled ? user : null;
  }

  function cookieHeader(req, token, role) {
    const secure = isSecure(req) ? '; Secure' : '';
    if (!token) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL_MS[role] / 1000)}${secure}`;
  }

  load();
  return {
    ensureAdmin,
    createGuest,
    createMod,
    resetPassword,
    changePassword,
    generateRecoveryCodes,
    recover,
    resetAdmin,
    updateUser,
    deleteUser,
    removeScenario,
    login,
    logout,
    userFromRequest,
    cookieHeader,
    publicUser,
    listUsers: () => users.map(publicUser),
    getUser: (id) => publicUser(users.find((u) => u.id === id)),
    reload: load,
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, randomPassword, randomRecoveryCode, normalizeRecoveryCode, slug, COOKIE };
