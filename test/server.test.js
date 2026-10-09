'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eyetrack-test-'));
process.env.ALLOW_PRIVATE = '1';
const { createServer, sessionFilePaths, normalizeTargetUrl, normalizeSessionUrl, normalizeFigmaUrl, rewriteHtml, isPrivateAddress, sanitizeEvent, toProxyUrl } = require('../server');

const hfHits = [];
let server;
let target;
let base;
let targetBase;

before(async () => {
  target = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/page' });
      return res.end();
    }
    if (req.url === '/away') {
      res.writeHead(301, { Location: 'https://other.example/x?y=1' });
      return res.end();
    }
    if (req.url === '/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=abc; Domain=127.0.0.1; Path=/' });
        res.end(JSON.stringify({ method: req.method, body, cookie: req.headers.cookie || '', referer: req.headers.referer || '' }));
      });
      return;
    }
    if (req.url.startsWith('/onnx-community/whisper-small/resolve/main/')) {
      hfHits.push(req.url);
      if (req.url.endsWith('/missing.json')) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"model_type":"whisper"}');
    }
    if (req.url === '/image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end('png');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
    res.end('<html><head><meta http-equiv="Content-Security-Policy" content="default-src none"><title>Hi</title></head><body><a href="/x">x</a></body></html>');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  targetBase = `http://127.0.0.1:${target.address().port}`;

  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  target.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('normalizeTargetUrl', () => {
  assert.equal(normalizeTargetUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeTargetUrl('http://a.com/p#frag'), 'http://a.com/p');
  assert.equal(normalizeTargetUrl('javascript:alert(1)'), null);
  assert.equal(normalizeTargetUrl('file:///etc/passwd'), null);
  assert.equal(normalizeTargetUrl(''), null);
});

test('normalizeSessionUrl nhận thêm file trên máy', () => {
  assert.equal(normalizeSessionUrl('file:///Users/admin/Downloads/example.html#x'), 'file:///Users/admin/Downloads/example.html');
  assert.equal(normalizeSessionUrl('/Users/admin/My Site/index.html'), 'file:///Users/admin/My%20Site/index.html');
  assert.equal(normalizeSessionUrl('~/a.html'), 'file://' + require('node:url').pathToFileURL(require('node:os').homedir() + '/a.html').pathname);
  assert.equal(normalizeSessionUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeSessionUrl('file:///'), null);
  assert.equal(normalizeSessionUrl('javascript:alert(1)'), null);
  // proxy / go vẫn chỉ nhận http(s): server không đọc file trên máy
  assert.equal(normalizeTargetUrl('file:///etc/passwd'), null);
});

test('normalizeFigmaUrl chuẩn hoá link prototype Figma', () => {
  const u = new URL(normalizeFigmaUrl('https://www.figma.com/proto/AbC123/My-App?node-id=1-2&starting-point-node-id=1%3A2#x'));
  assert.equal(u.origin + u.pathname, 'https://www.figma.com/proto/AbC123/My-App');
  assert.equal(u.searchParams.get('node-id'), '1-2');
  assert.equal(u.searchParams.get('hide-ui'), '1');
  assert.equal(u.searchParams.get('scaling'), 'scale-down-width');
  assert.equal(u.hash, '');
  // link /design/ → /proto/, thiếu https, thiếu www
  assert.match(normalizeFigmaUrl('figma.com/design/XyZ9/Flow'), /^https:\/\/www\.figma\.com\/proto\/XyZ9\/Flow\?/);
  // giữ tham số người dùng đã chọn
  assert.equal(new URL(normalizeFigmaUrl('https://www.figma.com/proto/K/x?scaling=contain')).searchParams.get('scaling'), 'contain');
  for (const bad of ['https://evil.com/proto/K/x', 'https://www.figma.com/community/file/1', 'http://www.figma.com/proto/K', 'javascript:1']) {
    assert.equal(normalizeFigmaUrl(bad), null, bad);
  }
});

test('isPrivateAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('rewriteHtml ghi URL gốc, bỏ CSP/refresh, chặn service worker', () => {
  const out = rewriteHtml('<html><head><meta http-equiv="refresh" content="0;url=/x"><meta http-equiv="Content-Security-Policy" content="x"></head><body></body></html>', 'https://a.com/p');
  assert.match(out, /eyetrack-original-url" content="https:\/\/a\.com\/p"/);
  assert.match(out, /serviceWorker/);
  assert.doesNotMatch(out, /refresh|Content-Security-Policy/);
  assert.match(rewriteHtml('<p>no head</p>', 'https://a.com/'), /^<meta name="eyetrack-original-url"/);
});

test('toProxyUrl giữ đường dẫn cho cùng site, đi qua /__et/go cho site khác', () => {
  assert.equal(toProxyUrl('https://a.com/x/y?q=1#h', 'https://a.com'), '/x/y?q=1#h');
  assert.equal(toProxyUrl('https://b.com/z', 'https://a.com'), '/__et/go?url=' + encodeURIComponent('https://b.com/z'));
});

test('sanitizeEvent bỏ loại lạ và field ngoài danh sách', () => {
  assert.equal(sanitizeEvent({ type: 'evil' }), null);
  const e = sanitizeEvent({ type: 'click', t: 5, x: 1.234, secret: 'x', el: { tag: 'a', value: 'pw' } });
  assert.deepEqual(e, { type: 'click', t: 5, x: 1.2, el: { tag: 'a', id: undefined, cls: undefined, text: undefined, href: undefined, selector: undefined } });
});

async function api(method, p, body) {
  const res = await fetch(base + '/__et' + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

test('vòng đời session: tạo, gửi sự kiện, đọc, export, xoá', async () => {
  const created = await api('POST', '/api/sessions', { url: 'example.com', participant: 'u1', eyeTracking: true });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.match(id, /^[a-f0-9]{16}$/);
  assert.equal(created.body.url, 'https://example.com/');

  const bad = await api('POST', '/api/sessions', { url: 'ftp://x' });
  assert.equal(bad.status, 400);
  const local = await api('POST', '/api/sessions', { url: 'file:///Users/admin/Downloads/example.html' });
  assert.equal(local.status, 201);
  assert.equal(local.body.url, 'file:///Users/admin/Downloads/example.html');
  const go = await fetch(`${base}/__et/go?url=${encodeURIComponent('file:///etc/passwd')}`, { redirect: 'manual' });
  assert.equal(go.status, 400);

  // gửi song song để kiểm tra bộ đếm không bị mất
  await Promise.all([
    api('POST', `/api/sessions/${id}/events`, { events: [{ type: 'pageview', t: 0, page: 'https://example.com/', vw: 1000, vh: 700, dh: 3000 }, { type: 'bogus' }] }),
    api('POST', `/api/sessions/${id}/events`, { events: [{ type: 'gaze', t: 20, x: 10, y: 20, page: 'https://example.com/' }] }),
    api('POST', `/api/sessions/${id}/events`, { events: [{ type: 'click', t: 10, x: 5, y: 6, page: 'https://example.com/', el: { tag: 'a', text: 'Mua, ngay "now"' } }] }),
    api('PATCH', `/api/sessions/${id}`, { calibration: { accuracy: 82.345, meanErrorPx: 61 } }),
  ]);

  const got = await api('GET', `/api/sessions/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.eventCount, 3);
  assert.equal(got.body.calibration.accuracy, 82.3);
  assert.deepEqual(got.body.events.map((e) => e.type), ['pageview', 'click', 'gaze']);

  const csv = await fetch(`${base}/__et/api/sessions/${id}/export?format=csv`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = (await csv.text()).split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[2], /"Mua, ngay ""now"""/);

  const list = await api('GET', '/api/sessions');
  assert.ok(list.body.some((s) => s.id === id));

  assert.equal((await api('DELETE', `/api/sessions/${id}`)).status, 200);
  assert.equal((await api('GET', `/api/sessions/${id}`)).status, 404);
  assert.equal((await api('GET', '/api/sessions/../../etc')).status, 404);
  assert.equal((await api('GET', '/api/sessions/zzz')).status, 400);
});

function frameReq(p, opts = {}) {
  return fetch(base + p, {
    redirect: 'manual',
    ...opts,
    headers: { 'sec-fetch-dest': 'iframe', cookie: '__et_target=' + encodeURIComponent(targetBase), ...(opts.headers || {}) },
  });
}

test('cài đặt: mặc định English, lưu ngôn ngữ và tắt eye tracking', async () => {
  const def = (await api('GET', '/api/settings')).body;
  assert.equal(def.language, 'en');
  assert.equal(def.eyeTrackingEnabled, true);
  assert.equal(def.showCamera, false); // cột camera mặc định ẩn
  assert.equal(def.storagePath, path.join(process.env.DATA_DIR, 'sessions'));
  const bad = await api('POST', '/api/sessions', { url: 'ftp://x' });
  assert.equal(bad.body.code, 'invalid_url');
  assert.match(bad.body.error, /Invalid link/);
  const vi = await api('PUT', '/api/settings', { language: 'vi', eyeTrackingEnabled: false, junk: 1 });
  assert.equal(vi.body.language, 'vi');
  assert.equal(vi.body.eyeTrackingEnabled, false);
  assert.equal(vi.body.junk, undefined);
  assert.match((await api('POST', '/api/sessions', { url: 'ftp://x' })).body.error, /không hợp lệ/);
  // eye tracking bị tắt trong cài đặt → phiên mới luôn tắt webcam
  const s1 = await api('POST', '/api/sessions', { url: 'example.com', eyeTracking: true });
  assert.equal(s1.body.eyeTracking, false);
  assert.equal((await api('PUT', '/api/settings', { language: 'xx' })).body.language, 'vi');
  await api('PUT', '/api/settings', { language: 'en', eyeTrackingEnabled: true });
});

test('kịch bản, thời lượng ghi và báo cáo tổng hợp theo link', async () => {
  const sc = await api('POST', '/api/scenarios', { name: 'Checkout flow' });
  assert.equal(sc.status, 201);
  assert.equal((await api('POST', '/api/scenarios', { name: '  ' })).status, 400);
  const a = (await api('POST', '/api/sessions', { url: 'https://shop.test/', scenarioId: sc.body.id, participant: 'p1' })).body;
  const b = (await api('POST', '/api/sessions', { url: 'https://shop.test/', participant: 'p2' })).body;
  const c = (await api('POST', '/api/sessions', { url: 'https://other.test/' })).body;
  assert.equal(a.scenarioId, sc.body.id);
  await api('POST', `/api/sessions/${a.id}/events`, { events: [
    { type: 'pageview', t: 0, page: 'https://shop.test/', vw: 1000, vh: 500, dh: 1000, sy: 0 },
    { type: 'click', t: 1200, page: 'https://shop.test/' },
    { type: 'scroll', t: 4000, page: 'https://shop.test/', vh: 500, dh: 1000, sy: 500 },
  ] });
  await api('POST', `/api/sessions/${b.id}/events`, { events: [{ type: 'click', t: 2000, page: 'https://shop.test/' }] });
  assert.equal((await api('GET', `/api/sessions/${a.id}`)).body.durationMs, 4000);

  // gán phiên b vào kịch bản, rồi lọc
  assert.equal((await api('PATCH', `/api/sessions/${b.id}`, { scenarioId: sc.body.id })).body.scenarioId, sc.body.id);
  const inSc = (await api('GET', `/api/sessions?scenario=${sc.body.id}`)).body.map((m) => m.id).sort();
  assert.deepEqual(inSc, [a.id, b.id].sort());
  assert.ok((await api('GET', '/api/sessions?scenario=none')).body.some((m) => m.id === c.id));
  assert.equal((await api('GET', '/api/scenarios')).body.find((x) => x.id === sc.body.id).sessionCount, 2);

  const sum = (await api('GET', `/api/summary?scenario=${sc.body.id}`)).body;
  assert.equal(sum.length, 1);
  assert.equal(sum[0].url, 'https://shop.test/');
  assert.equal(sum[0].sessions, 2);
  assert.equal(sum[0].participants, 2);
  assert.equal(sum[0].clicks, 2);
  assert.equal(sum[0].avgDepth, 50); // phiên a cuộn tới 100%, phiên b không cuộn
  assert.ok((await api('GET', '/api/summary')).body.length >= 2);

  // đổi tên, bỏ phiên khỏi kịch bản, xoá kịch bản (phiên vẫn còn)
  assert.equal((await api('PATCH', `/api/scenarios/${sc.body.id}`, { name: 'Checkout v2' })).body.name, 'Checkout v2');
  assert.equal((await api('PATCH', `/api/sessions/${b.id}`, { scenarioId: null })).body.scenarioId, undefined);
  assert.equal((await api('DELETE', `/api/scenarios/${sc.body.id}`)).status, 200);
  assert.equal((await api('GET', `/api/sessions/${a.id}`)).body.scenarioId, undefined);
});

test('đổi thư mục lưu trữ chuyển toàn bộ dữ liệu sang thư mục mới', async () => {
  const s1 = (await api('POST', '/api/sessions', { url: 'https://move.test/' })).body;
  const sc = (await api('POST', '/api/scenarios', { name: 'Moved' })).body;
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'heatmap-store-'));
  assert.equal((await api('PUT', '/api/settings', { storageDir: 'relative/path' })).status, 400);
  const res = await api('PUT', '/api/settings', { storageDir: target });
  assert.equal(res.status, 200);
  assert.equal(res.body.storagePath, target);
  assert.ok(fs.existsSync(path.join(target, 'Moved')));
  const moved = fs.readdirSync(path.join(target, 'No scenario')).find((d) => {
    try { return JSON.parse(fs.readFileSync(path.join(target, 'No scenario', d, '.session.json'), 'utf8')).id === s1.id; } catch { return false; }
  });
  assert.ok(moved);
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'sessions', 'Moved')));
  assert.ok((await api('GET', '/api/scenarios')).body.some((x) => x.id === sc.id));
  assert.equal((await api('GET', `/api/sessions/${s1.id}`)).status, 200);
  // về lại thư mục mặc định
  const back = await api('PUT', '/api/settings', { storageDir: '' });
  assert.equal(back.body.storagePath, path.join(process.env.DATA_DIR, 'sessions'));
  assert.equal((await api('GET', `/api/sessions/${s1.id}`)).status, 200);
  fs.rmSync(target, { recursive: true, force: true });
});

const localStamp = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
};

test('lưu file: thư mục kịch bản / người tham gia, chuyển, đổi tên, xoá và chuyển dữ liệu kiểu cũ', async () => {
  const root = path.join(process.env.DATA_DIR, 'sessions');
  const ls = (...p) => fs.readdirSync(path.join(root, ...p)).filter((f) => f !== '.DS_Store').sort();
  const sc = (await api('POST', '/api/scenarios', { name: 'Droppii Mall' })).body;
  assert.equal(sc.folder, 'Droppii Mall');
  assert.ok(fs.statSync(path.join(root, 'Droppii Mall')).isDirectory());
  // tên trùng / ký tự không hợp lệ
  const sc2 = (await api('POST', '/api/scenarios', { name: 'droppii mall' })).body;
  assert.equal(sc2.folder, 'droppii mall (2)');
  const sc3 = (await api('POST', '/api/scenarios', { name: 'A/B: test?' })).body;
  assert.equal(sc3.folder, 'A B test');

  const u1 = (await api('POST', '/api/sessions', { url: 'https://mall.test/', participant: 'User 1', scenarioId: sc.id })).body;
  const u1b = (await api('POST', '/api/sessions', { url: 'https://mall.test/', participant: 'User 1', scenarioId: sc.id })).body;
  await api('POST', `/api/sessions/${u1.id}/events`, { events: [{ type: 'pageview', t: 0, page: 'https://mall.test/' }, { type: 'click', t: 900, page: 'https://mall.test/', x: 1, y: 2, el: { tag: 'a', text: 'Mua' } }] });
  await fetch(`${base}/__et/api/sessions/${u1.id}/media/screen-1?kind=screen&mime=video%2Fmp4&t=0`, { method: 'POST', body: Buffer.from('v') });
  await fetch(`${base}/__et/api/sessions/${u1.id}/media/audio-1?kind=audio&mime=audio%2Fmp4&t=0`, { method: 'POST', body: Buffer.from('a') });
  await fetch(`${base}/__et/api/sessions/${u1.id}/media/audio-2?kind=audio&mime=audio%2Fwebm&t=0`, { method: 'POST', body: Buffer.from('b') });
  await api('PUT', `/api/sessions/${u1.id}/transcript`, { language: 'vietnamese', segments: [{ start: 0, text: 'Xin chào' }] });
  await api('PATCH', `/api/sessions/${u1.id}`, { ended: true }); // kết thúc → ghi session.json / events.csv ngay

  assert.deepEqual(ls('Droppii Mall'), ['User 1', 'User 1 (2)']);
  assert.deepEqual(ls('Droppii Mall', 'User 1'), ['.events.ndjson', '.session.json', 'audio-recording-1.m4a', 'audio-recording-2.weba', 'events.csv', 'screen-recording-1.mp4', 'session.json', 'transcript.json']);
  const exported = JSON.parse(fs.readFileSync(path.join(root, 'Droppii Mall', 'User 1', 'session.json'), 'utf8'));
  assert.equal(exported.id, u1.id);
  assert.equal(exported.events.length, 2);
  assert.match(fs.readFileSync(path.join(root, 'Droppii Mall', 'User 1', 'events.csv'), 'utf8'), /^t,type,page[\s\S]*click/);

  // chuyển sang kịch bản khác → chuyển thư mục; về "chưa thuộc kịch bản" → "No scenario"
  await api('PATCH', `/api/sessions/${u1b.id}`, { scenarioId: sc3.id });
  assert.deepEqual(ls('A B test'), ['User 1']);
  await api('PATCH', `/api/sessions/${u1b.id}`, { scenarioId: null });
  assert.ok(ls('No scenario').includes('User 1'));
  await api('PATCH', `/api/sessions/${u1b.id}`, { scenarioId: sc.id });
  assert.deepEqual(ls('Droppii Mall'), ['User 1', 'User 1 (2)']);

  // đổi tên kịch bản → đổi tên thư mục, phiên vẫn mở được
  const ren = await api('PATCH', `/api/scenarios/${sc.id}`, { name: 'Droppii Mall v2' });
  assert.equal(ren.body.folder, 'Droppii Mall v2');
  assert.ok(!fs.existsSync(path.join(root, 'Droppii Mall')));
  assert.equal((await api('GET', `/api/sessions/${u1.id}`)).body.events.length, 2);
  assert.equal((await fetch(`${base}/__et/api/sessions/${u1.id}/media/screen-1`)).status, 200);

  // người dùng đổi tên thư mục phiên trong Finder → app vẫn tìm thấy
  fs.renameSync(path.join(root, 'Droppii Mall v2', 'User 1'), path.join(root, 'Droppii Mall v2', 'Lan'));
  assert.equal((await api('GET', `/api/sessions/${u1.id}`)).status, 200);
  assert.ok((await api('GET', '/api/sessions')).body.some((m) => m.id === u1.id));

  // xoá kịch bản → các phiên sang "No scenario", thư mục kịch bản bị xoá
  await api('DELETE', `/api/scenarios/${sc.id}`);
  assert.ok(!fs.existsSync(path.join(root, 'Droppii Mall v2')));
  assert.ok(ls('No scenario').includes('User 1 (2)') || ls('No scenario').includes('User 1'));
  assert.equal((await api('GET', `/api/sessions/${u1.id}`)).body.scenarioId, undefined);
  for (const x of [u1, u1b]) await api('DELETE', `/api/sessions/${x.id}`);
  for (const x of [sc2, sc3]) await api('DELETE', `/api/scenarios/${x.id}`);

  // dữ liệu kiểu cũ (mọi file chung trong <thư mục>/sessions/<id>.*) → tự chuyển sang thư mục mới
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'heatmap-legacy-'));
  fs.mkdirSync(path.join(legacy, 'sessions'));
  const oldId = 'abcdef0123456789';
  fs.writeFileSync(path.join(legacy, 'scenarios.json'), JSON.stringify([{ id: 'aaaaaaaaaaaa', name: 'Cũ', createdAt: new Date().toISOString() }]));
  fs.writeFileSync(path.join(legacy, 'sessions', oldId + '.json'), JSON.stringify({ id: oldId, url: 'https://old.test/', participant: 'Bà Tư', scenarioId: 'aaaaaaaaaaaa', createdAt: new Date().toISOString(), eventCount: 1, media: [{ id: 'screen-x', kind: 'screen', file: `${oldId}.screen-x.mp4`, size: 3 }] }));
  fs.writeFileSync(path.join(legacy, 'sessions', oldId + '.ndjson'), '{"type":"pageview","t":0,"page":"https://old.test/"}\n');
  fs.writeFileSync(path.join(legacy, 'sessions', `${oldId}.screen-x.mp4`), 'mp4');
  fs.writeFileSync(path.join(legacy, 'sessions', `${oldId}.transcript.json`), '{"segments":[]}');
  assert.equal((await api('PUT', '/api/settings', { storageDir: legacy })).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(legacy, 'Cũ', 'Bà Tư')).sort(), ['.events.ndjson', '.session.json', 'screen-recording-1.mp4', 'transcript.json']);
  assert.ok(!fs.existsSync(path.join(legacy, 'sessions')));
  assert.ok(!fs.existsSync(path.join(legacy, 'scenarios.json')));
  const old = (await api('GET', `/api/sessions/${oldId}`)).body;
  assert.equal(old.events.length, 1);
  assert.equal(old.media[0].file, 'screen-recording-1.mp4');
  assert.equal(await (await fetch(`${base}/__et/api/sessions/${oldId}/media/screen-x`)).text(), 'mp4');
  // quay về thư mục mặc định: kịch bản và phiên đi theo
  await api('PUT', '/api/settings', { storageDir: '' });
  assert.ok(fs.existsSync(path.join(root, 'Cũ', 'Bà Tư', '.session.json')));
  await api('DELETE', `/api/sessions/${oldId}`);
  await api('DELETE', '/api/scenarios/aaaaaaaaaaaa');
  fs.rmSync(legacy, { recursive: true, force: true });
});

test('ghi màn hình/âm thanh: nối từng đoạn, tua (Range), xoá cùng phiên', async () => {
  const s1 = (await api('POST', '/api/sessions', { url: 'https://media.test/' })).body;
  const up = (buf, qs = '') => fetch(`${base}/__et/api/sessions/${s1.id}/media/screen-1${qs}`, { method: 'POST', body: buf });
  assert.equal((await up(Buffer.from('aaa'), '?kind=nope&mime=video/mp4')).status, 400);
  assert.equal((await up(Buffer.from('hello '), '?kind=screen&mime=video%2Fmp4%3Bcodecs%3Davc1&t=1500')).status, 200);
  assert.equal((await up(Buffer.from('world'))).status, 200); // đoạn sau không cần kind/mime
  const fin = await api('POST', `/api/sessions/${s1.id}/media/screen-1/finish`, { endT: 9500, durationMs: 7000 });
  assert.equal(fin.body.size, 11);
  assert.equal(fin.body.startT, 1500);
  assert.equal(fin.body.durationMs, 7000);
  const meta = (await api('GET', `/api/sessions/${s1.id}`)).body;
  assert.equal(meta.media[0].file, 'screen-recording-1.mp4');
  const full = await fetch(`${base}/__et/api/sessions/${s1.id}/media/screen-1`);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(await full.text(), 'hello world');
  const part = await fetch(`${base}/__et/api/sessions/${s1.id}/media/screen-1`, { headers: { Range: 'bytes=6-' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'world');
  const dl = await fetch(`${base}/__et/api/sessions/${s1.id}/media/screen-1?download=1`);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="heatmap-.*-screen-1\.mp4"/);
  assert.equal((await fetch(`${base}/__et/api/sessions/${s1.id}/media/..%2Fx`)).status, 400);
  // xoá phiên → xoá luôn file video
  const dir = sessionFilePaths(s1.id).dir;
  assert.match(path.basename(dir), new RegExp('^Session ' + localStamp(s1.createdAt).replace('.', '\\.')));
  assert.equal(path.basename(path.dirname(dir)), 'No scenario');
  const file = path.join(dir, 'screen-recording-1.mp4');
  assert.ok(fs.existsSync(file));
  await api('DELETE', `/api/sessions/${s1.id}`);
  assert.ok(!fs.existsSync(path.dirname(file)));
});

test('transcript: lưu, sửa, xuất Word (.docx) và .txt', async () => {
  const s1 = (await api('POST', '/api/sessions', { url: 'https://talk.test/', participant: 'Lan' })).body;
  assert.equal((await api('GET', `/api/sessions/${s1.id}/transcript`)).body, null);
  const put = await api('PUT', `/api/sessions/${s1.id}/transcript`, {
    audioId: 'audio-1', language: 'vietnamese', model: 'onnx-community/whisper-small',
    segments: [{ start: 0, end: 4.2, text: 'Xin chào, tôi đang tìm nút thanh toán.' }, { start: 65, end: 70, text: 'Ở đây có mã giảm giá không?' }],
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.segments.length, 2);
  assert.equal((await api('GET', `/api/sessions/${s1.id}`)).body.hasTranscript, true);
  // sửa một đoạn
  const edited = await api('PUT', `/api/sessions/${s1.id}/transcript`, { segments: [{ start: 0, text: 'Xin chào!' }] });
  assert.equal(edited.body.language, 'vietnamese'); // giữ thông tin cũ
  assert.equal(edited.body.segments[0].text, 'Xin chào!');
  const txt = await fetch(`${base}/__et/api/sessions/${s1.id}/transcript?format=txt`);
  assert.match(await txt.text(), /\[00:00\] Xin chào!/);
  const docx = await fetch(`${base}/__et/api/sessions/${s1.id}/transcript?format=docx`);
  assert.equal(docx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const buf = Buffer.from(await docx.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK'); // .docx là file zip
  assert.ok(buf.length > 3000);
});

test('tóm tắt AI: gọi Claude API (mock), lưu vào transcript, xử lý lỗi; không lộ API key', async () => {
  const calls = [];
  let mode = 'ok';
  const sse = (events) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
  const claude = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      if (mode === 'auth') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }
      const stop = mode === 'refusal' ? 'refusal' : 'end_turn';
      const text = mode === 'refusal' ? '' : '## Overview\n- Người dùng **khó tìm** nút thanh toán [00:00]';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse([
        ['message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }],
        ['message_stop', {}],
      ]));
    });
  });
  await new Promise((r) => claude.listen(0, '127.0.0.1', r));
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const s1 = (await api('POST', '/api/sessions', { url: 'https://shop.test/' })).body;
    // chưa có transcript
    assert.equal((await api('POST', `/api/sessions/${s1.id}/transcript/summary`, {})).body.code, 'no_transcript');
    await api('POST', `/api/sessions/${s1.id}/events`, { events: [{ type: 'pageview', t: 0, page: 'https://shop.test/', title: 'Shop' }, { type: 'click', t: 3000, page: 'https://shop.test/', el: { tag: 'button', text: 'Thanh toán' } }] });
    await api('PUT', `/api/sessions/${s1.id}/transcript`, { language: 'vietnamese', segments: [{ start: 0, text: 'Nút thanh toán ở đâu nhỉ?' }] });
    // chưa có key
    const noKey = await api('POST', `/api/sessions/${s1.id}/transcript/summary`, {});
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.code, 'ai_no_key');
    assert.equal(calls.length, 0);

    // lưu key: trang chỉ thấy 4 ký tự cuối
    const set = await api('PUT', '/api/settings', { anthropicApiKey: ' sk-ant-test-1234 ' });
    assert.equal(set.body.aiKey, 'settings');
    assert.equal(set.body.aiKeyHint, '…1234');
    assert.ok(!JSON.stringify(set.body).includes('sk-ant'));
    assert.ok(!JSON.stringify((await api('GET', '/api/settings')).body).includes('sk-ant'));

    const ok = await api('POST', `/api/sessions/${s1.id}/transcript/summary`, { language: 'vi' });
    assert.equal(ok.status, 200);
    assert.match(ok.body.summary.text, /khó tìm/);
    assert.equal(ok.body.summary.model, 'claude-opus-5-5');
    assert.equal(ok.body.summary.language, 'vi');
    assert.equal(ok.body.segments.length, 1);
    const call = calls[0];
    assert.equal(call.url, '/v1/messages?beta=true');
    assert.equal(call.headers['x-api-key'], 'sk-ant-test-1234');
    assert.match(call.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(call.body.model, 'claude-opus-5-5');
    assert.equal(call.body.fallbacks, 'default');
    assert.equal(call.body.stream, true);
    assert.deepEqual(call.body.output_config, { effort: 'medium' });
    const prompt = call.body.messages[0].content;
    assert.match(prompt, /\[00:00\] SAYS: Nút thanh toán ở đâu nhỉ\?/);
    assert.match(prompt, /\[00:03\] CLICKS: button "Thanh toán"/);
    assert.match(prompt, /in Vietnamese\.$/);

    // sửa tóm tắt, rồi xuất Word có phần tóm tắt
    const edited = await api('PUT', `/api/sessions/${s1.id}/transcript`, { summary: { text: '## Tổng quan\n- Đã sửa' } });
    assert.equal(edited.body.summary.edited, true);
    assert.equal(edited.body.summary.model, 'claude-opus-5-5');
    assert.match(await (await fetch(`${base}/__et/api/sessions/${s1.id}/transcript?format=txt`)).text(), /Đã sửa/);

    mode = 'refusal';
    assert.equal((await api('POST', `/api/sessions/${s1.id}/transcript/summary`, {})).body.code, 'ai_refused');
    mode = 'auth';
    const bad = await api('POST', `/api/sessions/${s1.id}/transcript/summary`, {});
    assert.equal(bad.status, 401);
    assert.equal(bad.body.code, 'ai_auth');
    // tóm tắt cũ không bị mất khi lỗi
    assert.match((await api('GET', `/api/sessions/${s1.id}/transcript`)).body.summary.text, /Đã sửa/);

    assert.equal((await api('PUT', '/api/settings', { anthropicApiKey: '' })).body.aiKey, '');
  } finally {
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
    claude.close();
  }
});

test('mô hình Whisper: tải qua proxy một lần, lưu đệm trên đĩa, chỉ cho phép mô hình trong danh sách', async () => {
  process.env.HF_ENDPOINT = targetBase;
  const url = `${base}/__et/models/onnx-community/whisper-small/resolve/main/config.json`;
  const a = await fetch(url);
  assert.equal(a.status, 200);
  assert.equal(await a.text(), '{"model_type":"whisper"}');
  const b = await fetch(url);
  assert.equal(await b.text(), '{"model_type":"whisper"}');
  assert.equal(hfHits.filter((h) => h.endsWith('/config.json')).length, 1); // lần 2 lấy từ đĩa
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'models', 'onnx-community', 'whisper-small', 'main', 'config.json')));
  assert.equal((await fetch(`${base}/__et/models/onnx-community/whisper-small/resolve/main/missing.json`)).status, 404);
  assert.equal((await fetch(`${base}/__et/models/evil/model/resolve/main/x.onnx`)).status, 404);
  assert.equal((await fetch(`${base}/__et/models/onnx-community/whisper-small/resolve/main/..%2F..%2Fx`)).status, 404);
  // thư viện chạy mô hình phục vụ ngay trên máy, có header cross-origin isolation
  const lib = await fetch(`${base}/__et/vendor/transformers/transformers.min.js`);
  assert.equal(lib.status, 200);
  assert.equal(lib.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal((await fetch(`${base}/__et/vendor/ort/ort-wasm-simd-threaded.jsep.wasm`, { method: 'HEAD' })).headers.get('content-type'), 'application/wasm');
  const asyncify = await fetch(`${base}/__et/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs`, { method: 'HEAD' });
  assert.equal(asyncify.status, 200);
  assert.equal((await fetch(`${base}/__et/vendor/ort/ort-wasm.wasm`, { method: 'HEAD' })).status, 404);
  const page = await fetch(`${base}/__et/transcript.html`, { method: 'HEAD' });
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  delete process.env.HF_ENDPOINT;
});

test('phiên Figma', async () => {
  const ok = await api('POST', '/api/sessions', { kind: 'figma', url: 'https://www.figma.com/proto/AbC/Demo?node-id=1-2' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.kind, 'figma');
  assert.match(ok.body.url, /^https:\/\/www\.figma\.com\/proto\/AbC\/Demo\?/);
  const web = await api('POST', '/api/sessions', { url: 'example.com' });
  assert.equal(web.body.kind, 'web');
  const bad = await api('POST', '/api/sessions', { kind: 'figma', url: 'https://example.com' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_figma_url');
});

test('/__et/go đặt site đích và chuyển sang đường dẫn gốc', async () => {
  const res = await fetch(`${base}/__et/go?url=${encodeURIComponent(targetBase + '/page?a=1')}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/page?a=1');
  assert.match(res.headers.get('set-cookie'), /__et_target=http%3A%2F%2F127\.0\.0\.1%3A\d+;/);
});

test('reverse proxy: HTML giữ đường dẫn, bỏ X-Frame-Options/CSP', async () => {
  const res = await frameReq('/page');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), null);
  const html = await res.text();
  assert.match(html, new RegExp(`eyetrack-original-url" content="${targetBase}/page"`));
  assert.doesNotMatch(html, /Content-Security-Policy/);
});

test('reverse proxy: viết lại redirect cùng site và khác site', async () => {
  const same = await frameReq('/redirect');
  assert.equal(same.status, 302);
  assert.equal(same.headers.get('location'), '/page');
  const away = await frameReq('/away');
  assert.equal(away.headers.get('location'), '/__et/go?url=' + encodeURIComponent('https://other.example/x?y=1'));
});

test('reverse proxy: chuyển tiếp POST, cookie, referer và tài nguyên nhị phân', async () => {
  const res = await frameReq('/echo', {
    method: 'POST',
    body: 'hello',
    headers: { 'sec-fetch-dest': 'empty', cookie: `__et_target=${encodeURIComponent(targetBase)}; sid=1`, referer: base + '/page' },
  });
  const data = await res.json();
  assert.deepEqual(data, { method: 'POST', body: 'hello', cookie: 'sid=1', referer: targetBase + '/page' });
  assert.equal(res.headers.get('set-cookie'), 'sid=abc; Path=/');
  const img = await frameReq('/image.png', { headers: { 'sec-fetch-dest': 'image' } });
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(await img.text(), 'png');
});

test('mở trực tiếp trên tab hoặc chưa chọn site → về trang chủ công cụ', async () => {
  const top = await frameReq('/page', { headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(top.headers.get('location'), '/__et/');
  const none = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(none.headers.get('location'), '/__et/');
});

test('static: phục vụ trang và WebGazer, chặn path traversal', async () => {
  assert.equal((await fetch(base + '/__et/')).status, 200);
  assert.equal((await fetch(base + '/__et/vendor/webgazer/webgazer.js')).status, 200);
  for (const p of ['/__et/%2e%2e/server.js', '/__et/vendor/webgazer/..%2f..%2f..%2fserver.js', '/__et/..%2fserver.js']) {
    const res = await fetch(base + p, { redirect: 'manual' });
    assert.doesNotMatch(await res.text(), /createServer/, p);
  }
});

test('tải JSON / CSV khi tên người tham gia có dấu (Content-Disposition)', async () => {
  const s = (await api('POST', '/api/sessions', { url: 'https://dau.test/', participant: 'Nguyễn Thu Hà "Đức"' })).body;
  for (const format of ['json', 'csv']) {
    const res = await fetch(`${base}/__et/api/sessions/${s.id}/export?format=${format}`);
    assert.equal(res.status, 200);
    const cd = res.headers.get('content-disposition');
    assert.match(cd, new RegExp(`^attachment; filename="Nguyen Thu Ha Duc\\.${format}"; filename\\*=UTF-8''`));
    assert.equal(decodeURIComponent(cd.split("UTF-8''")[1]), `Nguyễn Thu Hà Đức.${format}`);
  }
  await api('DELETE', `/api/sessions/${s.id}`);
});

test('ghi chú của phiên: lưu, xoá, có trong session.json', async () => {
  const s = (await api('POST', '/api/sessions', { url: 'https://note.test/', participant: 'User 1' })).body;
  const saved = (await api('PATCH', `/api/sessions/${s.id}`, { note: 'Không tìm thấy nút thanh toán' })).body;
  assert.equal(saved.note, 'Không tìm thấy nút thanh toán');
  assert.ok(saved.noteUpdatedAt);
  const list = (await api('GET', '/api/sessions')).body;
  assert.equal(list.find((x) => x.id === s.id).note, 'Không tìm thấy nút thanh toán');
  const exported = await (await fetch(`${base}/__et/api/sessions/${s.id}/export?format=json`)).json();
  assert.equal(exported.note, 'Không tìm thấy nút thanh toán');
  assert.equal((await api('PATCH', `/api/sessions/${s.id}`, { note: 'x'.repeat(30000) })).body.note.length, 20000);
  const cleared = (await api('PATCH', `/api/sessions/${s.id}`, { note: '   ' })).body;
  assert.equal(cleared.note, undefined);
  assert.equal(cleared.noteUpdatedAt, undefined);
  await api('DELETE', `/api/sessions/${s.id}`);
});
