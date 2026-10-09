'use strict';

// Bản online: đăng nhập, quyền admin / guest, giới hạn domain của proxy.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heatmap-online-test-'));
process.env.ALLOW_PRIVATE = '1';
process.env.ADMIN_PASSWORD = 'admin-secret-1';
const { createServer } = require('../server');
const { hashPassword, verifyPassword, slug } = require('../auth');

let server;
let site;
let base;
let siteBase;
let admin;

const json = (cookie, body) => ({
  headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function call(method, p, cookie, body) {
  const res = await fetch(base + p, { method, redirect: 'manual', ...json(cookie, body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data, headers: res.headers };
}

async function login(username, password) {
  const res = await call('POST', '/__et/api/login', null, { username, password });
  return { ...res, cookie: res.status === 200 ? res.headers.get('set-cookie').split(';')[0] : null };
}

before(async () => {
  site = http.createServer((req, res) => {
    if (req.url === '/steal') {
      // site đích cố ghi đè cookie đăng nhập của công cụ
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': ['hm_auth=evil; Path=/', 'own=1; Path=/'] });
      return res.end('ok');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body>${req.headers.cookie || ''}</body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteBase = `http://127.0.0.1:${site.address().port}`;
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await login('admin', 'admin-secret-1')).cookie;
});

after(() => {
  server.close();
  site.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('mật khẩu băm scrypt, tên đăng nhập không dấu', () => {
  const h = hashPassword('abc12345');
  assert.match(h, /^scrypt\$/);
  assert.ok(verifyPassword('abc12345', h));
  assert.ok(!verifyPassword('abc12346', h));
  assert.equal(slug('Nguyễn Văn Đức'), 'nguyenvanduc');
});

test('chưa đăng nhập: trang về /login, API 401, proxy bị chặn, file công khai vẫn mở', async () => {
  const home = await fetch(base + '/__et/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.match(home.headers.get('location'), /^\/__et\/login\.html\?next=/);
  assert.equal((await fetch(base + '/__et/report.html', { redirect: 'manual' })).status, 302);
  assert.equal((await call('GET', '/__et/api/sessions')).status, 401);
  assert.equal((await call('GET', '/__et/api/users')).status, 401);
  assert.equal((await fetch(base + '/__et/vendor/webgazer/webgazer.js')).status, 401);
  for (const f of ['login.html', 'login.js', 'i18n.js', 'style.css', 'logo.svg']) {
    assert.equal((await fetch(`${base}/__et/${f}`)).status, 200, f);
  }
  const proxied = await fetch(base + '/page', { headers: { cookie: '__et_target=' + encodeURIComponent(siteBase), 'sec-fetch-dest': 'iframe' } });
  assert.equal(proxied.status, 401);
  // cài đặt công khai chỉ có ngôn ngữ
  const st = (await call('GET', '/__et/api/settings')).body;
  assert.deepEqual(Object.keys(st).sort(), ['eyeTrackingEnabled', 'language', 'showCamera']);
});

test('đăng nhập sai bị giới hạn số lần; cookie HttpOnly', async () => {
  const ok = await login('admin', 'admin-secret-1');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal(ok.body.user.role, 'admin');
  assert.equal((await call('GET', '/__et/api/me', ok.cookie)).body.user.username, 'admin');
  for (let i = 0; i < 8; i++) assert.equal((await login('nobody', 'x')).status, 401);
  assert.equal((await login('nobody', 'x')).status, 429);
  // đăng xuất → cookie hết hiệu lực
  await call('POST', '/__et/api/logout', ok.cookie);
  assert.equal((await call('GET', '/__et/api/me', ok.cookie)).status, 401);
});

test('admin tạo kịch bản + guest; guest chỉ làm được kịch bản của mình', async () => {
  const sc = (await call('POST', '/__et/api/scenarios', admin, { name: 'Droppii Mall', url: siteBase + '/shop', instructions: 'Mua 1 sản phẩm', eyeTracking: false })).body;
  assert.equal(sc.url, siteBase + '/shop');
  const other = (await call('POST', '/__et/api/scenarios', admin, { name: 'Khác', url: 'https://other.test/' })).body;
  assert.equal((await call('PATCH', `/__et/api/scenarios/${sc.id}`, admin, { url: 'ftp://x' })).status, 400);

  const created = (await call('POST', '/__et/api/users', admin, { names: ['User 1', 'User 2'], scenarioId: sc.id })).body;
  assert.equal(created.length, 2);
  const [u1, u2] = created;
  assert.match(u1.user.username, /^user1\d{4}$/);
  assert.equal(u1.password.length, 10);
  assert.ok(!JSON.stringify((await call('GET', '/__et/api/users', admin)).body).includes('passwordHash'));

  const g1 = (await login(u1.user.username, u1.password)).cookie;
  const g2 = (await login(u2.user.username, u2.password)).cookie;
  // trang: guest bị đưa về guest.html, không mở được trang admin
  for (const page of ['/__et/', '/__et/report.html', '/__et/participants.html', '/__et/index.js']) {
    const res = await fetch(base + page, { redirect: 'manual', headers: { cookie: g1 } });
    assert.ok(res.status === 302 || res.status === 403, page);
  }
  assert.equal((await fetch(base + '/__et/guest.html', { headers: { cookie: g1 } })).status, 200);
  assert.equal((await fetch(base + '/__et/track.html', { headers: { cookie: g1 } })).status, 200);
  // API: không xem danh sách phiên, kịch bản, người dùng, cài đặt đầy đủ
  for (const p of ['/__et/api/sessions', '/__et/api/scenarios', '/__et/api/users', '/__et/api/summary']) {
    assert.equal((await call('GET', p, g1)).status, 403, p);
  }
  assert.equal((await call('GET', '/__et/api/settings', g1)).body.storagePath, undefined);

  const mine = (await call('GET', '/__et/api/guest/scenarios', g1)).body;
  assert.deepEqual(mine.map((x) => x.name), ['Droppii Mall']);
  assert.equal((await call('POST', '/__et/api/guest/sessions', g1, { scenarioId: other.id, consent: true })).status, 403);
  assert.equal((await call('POST', '/__et/api/guest/sessions', g1, { scenarioId: sc.id })).body.code, 'consent_required');
  const s1 = (await call('POST', '/__et/api/guest/sessions', g1, { scenarioId: sc.id, consent: true })).body;
  assert.equal(s1.participant, 'User 1');
  assert.equal(s1.url, siteBase + '/shop');
  assert.equal(s1.eyeTracking, false);
  assert.ok(s1.consentAt);

  // ghi vào phiên của mình
  assert.equal((await call('POST', `/__et/api/sessions/${s1.id}/events`, g1, { events: [{ type: 'click', t: 5, x: 1, y: 2 }] })).status, 200);
  assert.equal((await call('GET', `/__et/api/sessions/${s1.id}`, g1)).body.events.length, 1);
  const up = await fetch(`${base}/__et/api/sessions/${s1.id}/media/screen-1?kind=screen&mime=video%2Fmp4&t=0`, { method: 'POST', body: 'v', headers: { cookie: g1 } });
  assert.equal(up.status, 200);
  // không được đổi kịch bản, xoá, xem transcript / xuất dữ liệu / xem video
  const patched = (await call('PATCH', `/__et/api/sessions/${s1.id}`, g1, { ended: true, scenarioId: other.id })).body;
  assert.equal(patched.scenarioId, sc.id);
  assert.ok(patched.endedAt);
  assert.equal((await call('DELETE', `/__et/api/sessions/${s1.id}`, g1)).status, 403);
  assert.equal((await call('GET', `/__et/api/sessions/${s1.id}/export`, g1)).status, 403);
  assert.equal((await call('GET', `/__et/api/sessions/${s1.id}/transcript`, g1)).status, 403);
  assert.equal((await call('GET', `/__et/api/sessions/${s1.id}/media/screen-1`, g1)).status, 403);
  // guest khác không thấy phiên này
  assert.equal((await call('GET', `/__et/api/sessions/${s1.id}`, g2)).status, 404);
  assert.equal((await call('POST', `/__et/api/sessions/${s1.id}/events`, g2, { events: [] })).status, 404);

  // admin thấy trạng thái
  const users = (await call('GET', '/__et/api/users', admin)).body;
  const st1 = users.find((u) => u.id === u1.user.id);
  assert.equal(st1.doneCount, 1);
  assert.equal(st1.latestSessionId, s1.id);
  assert.equal((await call('GET', `/__et/api/sessions/${s1.id}/media/screen-1`, admin)).status, 200);

  // proxy: chỉ domain của kịch bản
  const go = await fetch(`${base}/__et/go?url=${encodeURIComponent(siteBase + '/a')}`, { redirect: 'manual', headers: { cookie: g1 } });
  assert.equal(go.status, 302);
  const goOther = await fetch(`${base}/__et/go?url=${encodeURIComponent('https://other.test/')}`, { redirect: 'manual', headers: { cookie: g1 } });
  assert.equal(goOther.status, 403);
  const forged = await fetch(`${base}/x`, { headers: { cookie: `${g1}; __et_target=${encodeURIComponent('https://other.test')}`, 'sec-fetch-dest': 'empty' } });
  assert.equal(forged.status, 403);
  // trang đích không nhận cookie đăng nhập và không ghi đè được nó
  const page = await fetch(`${base}/page`, { headers: { cookie: `${g1}; __et_target=${encodeURIComponent(siteBase)}`, 'sec-fetch-dest': 'iframe' } });
  assert.doesNotMatch(await page.text(), /hm_auth/);
  const steal = await fetch(`${base}/steal`, { headers: { cookie: `${g1}; __et_target=${encodeURIComponent(siteBase)}`, 'sec-fetch-dest': 'empty' } });
  assert.equal(steal.headers.get('set-cookie'), 'own=1; Path=/');

  // khoá tài khoản → đăng xuất ngay, không đăng nhập lại được
  await call('PATCH', `/__et/api/users/${u2.user.id}`, admin, { disabled: true });
  assert.equal((await call('GET', '/__et/api/me', g2)).status, 401);
  assert.equal((await login(u2.user.username, u2.password)).status, 401);
  // cấp mật khẩu mới → mật khẩu cũ và phiên cũ hết hiệu lực
  const reset = (await call('POST', `/__et/api/users/${u1.user.id}/reset-password`, admin)).body;
  assert.equal((await call('GET', '/__et/api/me', g1)).status, 401);
  assert.equal((await login(u1.user.username, u1.password)).status, 401);
  const g1b = (await login(u1.user.username, reset.password)).cookie;
  // xoá kịch bản → guest không còn thấy
  await call('DELETE', `/__et/api/scenarios/${sc.id}`, admin);
  assert.deepEqual((await call('GET', '/__et/api/guest/scenarios', g1b)).body, []);
  // guest không xoá / sửa được người khác
  assert.equal((await call('DELETE', `/__et/api/users/${u2.user.id}`, g1b)).status, 403);
  assert.equal((await call('DELETE', `/__et/api/users/${u2.user.id}`, admin)).status, 200);
});

test('đổi mật khẩu, thông báo theo ngôn ngữ của người dùng', async () => {
  assert.equal((await call('POST', '/__et/api/account/password', admin, { current: 'wrong', next: 'abcdefgh' })).body.code, 'wrong_password');
  assert.equal((await call('POST', '/__et/api/account/password', admin, { current: 'admin-secret-1', next: 'short' })).body.code, 'weak_password');
  assert.equal((await call('POST', '/__et/api/account/password', admin, { current: 'admin-secret-1', next: 'new-admin-pass' })).status, 200);
  assert.equal((await login('admin', 'admin-secret-1')).status, 401);
  const again = await login('admin', 'new-admin-pass');
  assert.equal(again.status, 200);
  const vi = await call('GET', '/__et/api/users', null);
  assert.match(vi.body.error, /sign in/i);
  const res = await fetch(base + '/__et/api/users', { headers: { cookie: 'hm_lang=vi' } });
  assert.match((await res.json()).error, /đăng nhập/);
});

test('mã khôi phục: tạo (cần mật khẩu), dùng một lần, tạo lại thì mã cũ hết hiệu lực', async () => {
  const { normalizeRecoveryCode, randomRecoveryCode } = require('../auth');
  assert.match(randomRecoveryCode(), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(normalizeRecoveryCode(' abcd efgh '), 'ABCDEFGH');

  // admin riêng cho test này
  const { getAuth } = require('../server');
  const a = getAuth();
  const created = a.createGuest({ name: 'Tmp' }); // guest không có mã khôi phục
  const gc = (await login(created.user.username, created.password)).cookie;
  assert.equal((await call('POST', '/__et/api/account/recovery-codes', gc, { password: created.password })).status, 403);

  const pw = 'new-admin-pass'; // từ test trước
  const ac = (await login('admin', pw)).cookie;
  assert.equal((await call('POST', '/__et/api/account/recovery-codes', ac, { password: 'wrong' })).body.code, 'wrong_password');
  const first = (await call('POST', '/__et/api/account/recovery-codes', ac, { password: pw })).body.codes;
  assert.equal(first.length, 10);
  assert.equal(new Set(first).size, 10);
  assert.equal((await call('GET', '/__et/api/me', ac)).body.user.recoveryCodesLeft, 10);
  // không lưu mã gốc
  const usersFile = fs.readFileSync(path.join(process.env.DATA_DIR, 'users.json'), 'utf8');
  for (const c of first) assert.ok(!usersFile.includes(c) && !usersFile.includes(c.replace('-', '')));

  // tạo lại → bộ cũ hết hiệu lực
  const codes = (await call('POST', '/__et/api/account/recovery-codes', ac, { password: pw })).body.codes;
  assert.equal((await call('POST', '/__et/api/recover', null, { username: 'admin', code: first[0], password: 'reset-pass-1' })).body.code, 'bad_recovery');

  // mật khẩu mới quá ngắn
  assert.equal((await call('POST', '/__et/api/recover', null, { username: 'admin', code: codes[0], password: 'short' })).body.code, 'weak_password');
  // dùng mã (chữ thường, không gạch vẫn được) → đăng nhập luôn, phiên cũ bị huỷ
  const ok = await call('POST', '/__et/api/recover', null, { username: 'Admin', code: codes[0].toLowerCase().replace('-', ''), password: 'reset-pass-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.remaining, 9);
  const nc = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/__et/api/me', nc)).body.user.role, 'admin');
  assert.equal((await call('GET', '/__et/api/me', ac)).status, 401);
  assert.equal((await login('admin', pw)).status, 401);
  assert.equal((await login('admin', 'reset-pass-1')).status, 200);
  // mã đã dùng không dùng lại được
  assert.equal((await call('POST', '/__et/api/recover', null, { username: 'admin', code: codes[0], password: 'reset-pass-2' })).body.code, 'bad_recovery');
  // đoán mã liên tục → bị chặn
  for (let i = 0; i < 7; i++) await call('POST', '/__et/api/recover', null, { username: 'admin', code: 'AAAA-AAAA', password: 'whatever-123' });
  assert.equal((await call('POST', '/__et/api/recover', null, { username: 'admin', code: codes[1], password: 'reset-pass-2' })).status, 429);
});

test('lệnh reset-admin: mật khẩu mới ngẫu nhiên, server đang chạy vẫn nhận ra', async () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'reset-admin.js')], { env: { ...process.env }, encoding: 'utf8' });
  const password = /Mật khẩu mới:\s+(\S+)/.exec(out)[1];
  assert.equal(password.length, 14);
  assert.equal((await login('admin', 'reset-pass-1')).status, 401);
  const res = await login('admin', password);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.recoveryCodesLeft, 9); // mã khôi phục còn nguyên
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'reset-admin.js'), 'nobody'], { env: { ...process.env }, stdio: 'pipe' }));
});

test('Mod: quản lý guest, xem báo cáo, tạo / đổi tên kịch bản, chuyển phiên; không xoá dữ liệu, không sửa cài đặt', async () => {
  const { getAuth } = require('../server');
  const adminPw = getAuth().resetAdmin('admin').password;
  const ac = (await login('admin', adminPw)).cookie;

  // admin tạo mod
  assert.equal((await call('POST', '/__et/api/users', ac, { role: 'mod', name: '' })).body.code, 'mod_name');
  assert.equal((await call('POST', '/__et/api/users', ac, { role: 'mod', name: 'Lan', username: 'a b' })).body.code, 'bad_username');
  const mod = (await call('POST', '/__et/api/users', ac, { role: 'mod', name: 'Lan', username: 'lan.mod' })).body;
  assert.equal(mod.user.role, 'mod');
  assert.equal(mod.user.username, 'lan.mod');
  assert.equal(mod.password.length, 14);
  assert.equal((await call('POST', '/__et/api/users', ac, { role: 'mod', name: 'Lan 2', username: 'lan.mod' })).body.code, 'username_taken');
  const mc = (await login('lan.mod', mod.password)).cookie;
  assert.equal((await call('GET', '/__et/api/me', mc)).body.user.role, 'mod');

  // trang: dùng được trang quản trị, trừ trang Nhóm quản lý
  for (const page of ['/__et/', '/__et/scenarios.html', '/__et/participants.html', '/__et/report.html', '/__et/overview.html']) {
    assert.equal((await fetch(base + page, { redirect: 'manual', headers: { cookie: mc } })).status, 200, page);
  }
  const team = await fetch(base + '/__et/team.html', { redirect: 'manual', headers: { cookie: mc } });
  assert.equal(team.status, 302);
  assert.equal((await fetch(base + '/__et/team.html', { headers: { cookie: ac } })).status, 200);

  // cài đặt: chỉ đọc, không thấy đường dẫn lưu trữ
  const st = (await call('GET', '/__et/api/settings', mc)).body;
  assert.equal(st.storagePath, undefined);
  assert.equal(st.language !== undefined, true);
  assert.equal((await call('PUT', '/__et/api/settings', mc, { language: 'vi' })).status, 403);

  // kịch bản: tạo, đổi tên, cấu hình; không xoá
  const sc = (await call('POST', '/__et/api/scenarios', mc, { name: 'Mod scenario', url: siteBase + '/' })).body;
  assert.equal((await call('PATCH', `/__et/api/scenarios/${sc.id}`, mc, { name: 'Mod scenario v2', instructions: 'Làm thử' })).body.name, 'Mod scenario v2');
  const sc2 = (await call('POST', '/__et/api/scenarios', mc, { name: 'Khác của mod' })).body;
  assert.equal((await call('DELETE', `/__et/api/scenarios/${sc.id}`, mc)).status, 403);

  // guest: tạo, cấp mật khẩu mới, khoá, xoá; chỉ thấy guest
  const g = (await call('POST', '/__et/api/users', mc, { names: ['Khách A'], scenarioId: sc.id })).body[0];
  assert.equal(g.user.role, 'guest');
  const seen = (await call('GET', '/__et/api/users', mc)).body;
  assert.ok(seen.every((u) => u.role === 'guest'));
  assert.equal((await call('POST', `/__et/api/users/${g.user.id}/reset-password`, mc)).status, 200);
  assert.equal((await call('PATCH', `/__et/api/users/${g.user.id}`, mc, { disabled: true })).body.disabled, true);
  // không đụng được admin / mod, không tạo được mod
  const adminId = (await call('GET', '/__et/api/me', ac)).body.user.id;
  assert.equal((await call('POST', `/__et/api/users/${adminId}/reset-password`, mc)).status, 403);
  assert.equal((await call('POST', `/__et/api/users/${mod.user.id}/reset-password`, mc)).status, 403);
  assert.equal((await call('POST', '/__et/api/users', mc, { role: 'mod', name: 'X' })).status, 403);
  // admin cũng không reset admin qua API người dùng
  assert.equal((await call('POST', `/__et/api/users/${adminId}/reset-password`, ac)).status, 403);

  // phiên: xem, tải, chuyển kịch bản, sửa transcript; không xoá phiên / bản ghi
  const s = (await call('POST', '/__et/api/sessions', mc, { url: siteBase + '/', participant: 'Khách A', scenarioId: sc.id })).body;
  await fetch(`${base}/__et/api/sessions/${s.id}/media/audio-1?kind=audio&mime=audio%2Fmp4&t=0`, { method: 'POST', body: 'a', headers: { cookie: mc } });
  assert.equal((await call('GET', `/__et/api/sessions/${s.id}`, mc)).status, 200);
  assert.equal((await call('GET', `/__et/api/sessions/${s.id}/export?format=csv`, mc)).status, 200);
  assert.equal((await call('GET', `/__et/api/sessions/${s.id}/media/audio-1`, mc)).status, 200);
  assert.equal((await call('PATCH', `/__et/api/sessions/${s.id}`, mc, { scenarioId: sc2.id })).body.scenarioId, sc2.id);
  assert.equal((await call('PUT', `/__et/api/sessions/${s.id}/transcript`, mc, { language: 'vietnamese', segments: [{ start: 0, text: 'Chào' }] })).status, 200);
  assert.equal((await call('DELETE', `/__et/api/sessions/${s.id}/media/audio-1`, mc)).status, 403);
  assert.equal((await call('DELETE', `/__et/api/sessions/${s.id}`, mc)).status, 403);
  assert.equal((await call('GET', `/__et/api/sessions/${s.id}`, ac)).status, 200); // vẫn còn
  // mod có mã khôi phục như admin
  assert.equal((await call('POST', '/__et/api/account/recovery-codes', mc, { password: mod.password })).body.codes.length, 10);

  // admin khoá mod → mod bị đăng xuất; xoá mod
  await call('PATCH', `/__et/api/users/${mod.user.id}`, ac, { disabled: true });
  assert.equal((await call('GET', '/__et/api/me', mc)).status, 401);
  assert.equal((await call('DELETE', `/__et/api/users/${mod.user.id}`, ac)).status, 200);
  assert.equal((await call('DELETE', `/__et/api/sessions/${s.id}`, ac)).status, 200);
});
