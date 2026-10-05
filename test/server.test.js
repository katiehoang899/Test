'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eyetrack-test-'));
process.env.ALLOW_PRIVATE = '1';
const { createServer, normalizeTargetUrl, rewriteHtml, isPrivateAddress, sanitizeEvent } = require('../server');

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

test('isPrivateAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('rewriteHtml chèn <base>, bỏ CSP và meta refresh', () => {
  const out = rewriteHtml('<html><head><meta http-equiv="refresh" content="0;url=/x"><base href="/sub/"></head><body></body></html>', 'https://a.com/p');
  assert.match(out, /<base href="https:\/\/a\.com\/sub\/">/);
  assert.match(out, /eyetrack-original-url" content="https:\/\/a\.com\/p"/);
  assert.doesNotMatch(out, /refresh/);
  assert.equal(out.match(/<base/g).length, 1);
  assert.match(rewriteHtml('<p>no head</p>', 'https://a.com/'), /^<base href/);
});

test('sanitizeEvent bỏ loại lạ và field ngoài danh sách', () => {
  assert.equal(sanitizeEvent({ type: 'evil' }), null);
  const e = sanitizeEvent({ type: 'click', t: 5, x: 1.234, secret: 'x', el: { tag: 'a', value: 'pw' } });
  assert.deepEqual(e, { type: 'click', t: 5, x: 1.2, el: { tag: 'a', id: undefined, cls: undefined, text: undefined, href: undefined, selector: undefined } });
});

async function api(method, p, body) {
  const res = await fetch(base + p, {
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

  const csv = await fetch(`${base}/api/sessions/${id}/export?format=csv`);
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

test('proxy trả HTML đã viết lại và theo redirect', async () => {
  const res = await fetch(`${base}/proxy?url=${encodeURIComponent(targetBase + '/redirect')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), null);
  const html = await res.text();
  assert.match(html, new RegExp(`<base href="${targetBase}/page">`));
  assert.doesNotMatch(html, /Content-Security-Policy/);
});

test('proxy chuyển hướng tài nguyên không phải HTML về URL gốc', async () => {
  const res = await fetch(`${base}/proxy?url=${encodeURIComponent(targetBase + '/image.png')}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), targetBase + '/image.png');
});

test('static: phục vụ trang và WebGazer, chặn path traversal', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/vendor/webgazer/webgazer.js')).status, 200);
  const trav = await fetch(base + '/%2e%2e/server.js');
  assert.notEqual(trav.status, 200);
});
