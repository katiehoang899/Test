'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hits = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.push(u);
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/v1/public/ad-listing') {
    return res.end(JSON.stringify({
      total: 2,
      ads: [
        {
          list_id: 111, subject: 'Phòng trọ Quận 7 có gác', body: 'Gần Lotte', price: 3500000, price_string: '3,5 triệu/tháng',
          size: 25, region_v2: 13000, region_name: 'Tp Hồ Chí Minh', area_v2: 13102, area_name: 'Quận 7',
          ward: 9001, ward_name: 'Phường Tân Phong', latitude: 10.73, longitude: 106.7, image: 'https://img/1.jpg',
          list_time: 1700000000000, date: '2 giờ trước', company_ad: false, furnishing_rent: 2, type: 'u',
        },
        { list_id: 222, subject: 'Phòng không toạ độ', price: 2000000, size: 15, latitude: 0, longitude: 0, company_ad: true },
      ],
    }));
  }
  if (u.pathname === '/v2/public/chapy-pro/regions') {
    return res.end(JSON.stringify({
      regionFollowId: { entities: { regions: {
        13000: { id: 13000, name: 'Tp Hồ Chí Minh', area: { 13102: { id: 13102, name: 'Quận 7' } } },
        12000: { id: 12000, name: 'Hà Nội', area: { 12010: { id: 12010, name: 'Quận Cầu Giấy' } } },
      } } },
    }));
  }
  if (u.pathname === '/v2/public/chapy-pro/wards') return res.end(JSON.stringify({ wards: [{ id: 9001, name: 'Phường Tân Phong' }] }));
  if (u.pathname === '/search') return res.end(JSON.stringify([{ lat: '10.75', lon: '106.66' }]));
  if (u.pathname === '/maps/api/streetview/metadata') {
    if (u.searchParams.get('key') !== 'AIzaTestKey_1234567890abcdef') return res.end(JSON.stringify({ status: 'REQUEST_DENIED' }));
    if (u.searchParams.get('location').startsWith('11.')) return res.end(JSON.stringify({ status: 'ZERO_RESULTS' }));
    // Ảnh đường phố nằm ngay phía nam vị trí tin ~22 m → camera phải quay về hướng bắc.
    const [lat, lng] = u.searchParams.get('location').split(',').map(Number);
    return res.end(JSON.stringify({ status: 'OK', date: '2023-04', pano_id: 'PanoAbc123_xyz', location: { lat: lat - 0.0002, lng } }));
  }
  if (u.pathname === '/maps/api/streetview') {
    res.setHeader('Content-Type', 'image/jpeg');
    return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  res.statusCode = 404;
  res.end('{}');
});

let server;
let base;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${upstream.address().port}`;
  process.env.CHOTOT_GATEWAY = up;
  process.env.NOMINATIM_URL = up;
  process.env.GOOGLE_MAPS_URL = up;
  delete process.env.GOOGLE_MAPS_API_KEY;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phongtro-test-'));
  const { createServer } = require('../server');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  upstream.close();
});

test('/api/ads forwards Nhà Tốt filters and normalizes ads', async () => {
  const q = 'region_v2=13000&area_v2=13102&ward=9001&price=1000000-5000000&size=20-30&furnishing_rent=1,2&f=p&st=u&sp=1&q=g%C3%A1c&o=50&limit=50&evil=1';
  const data = await (await fetch(`${base}/api/ads?${q}`)).json();
  const sent = hits.find((h) => h.pathname === '/v1/public/ad-listing').searchParams;
  assert.equal(sent.get('cg'), '1050');
  for (const [k, v] of [['region_v2', '13000'], ['area_v2', '13102'], ['ward', '9001'], ['price', '1000000-5000000'],
    ['size', '20-30'], ['furnishing_rent', '1,2'], ['f', 'p'], ['st', 'u'], ['sp', '1'], ['q', 'gác'], ['o', '50'], ['limit', '50'], ['page', '2']]) {
    assert.equal(sent.get(k), v, k);
  }
  assert.equal(sent.has('evil'), false);

  assert.equal(data.total, 2);
  const [a, b] = data.ads;
  assert.equal(a.id, '111');
  assert.equal(a.url, 'https://www.nhatot.com/111.htm');
  assert.equal(a.lat, 10.73);
  assert.equal(a.furnishingText, 'Nội thất đầy đủ');
  assert.equal(a.address, 'Phường Tân Phong, Quận 7, Tp Hồ Chí Minh');
  assert.equal(b.lat, null, '0,0 is not a real location');
  assert.equal(b.isCompany, true);
});

test('/api/ads caps limit and defaults to rentals', async () => {
  hits.length = 0;
  await fetch(`${base}/api/ads?limit=999`);
  const sent = hits[0].searchParams;
  assert.equal(sent.get('limit'), '50');
  assert.equal(sent.get('st'), 'u,h');
});

test('/api/regions and /api/wards', async () => {
  const { regions } = await (await fetch(`${base}/api/regions`)).json();
  assert.deepEqual(regions.map((r) => r.name), ['Hà Nội', 'Tp Hồ Chí Minh']);
  assert.deepEqual(regions[1].areas, [{ id: '13102', name: 'Quận 7' }]);
  const { wards } = await (await fetch(`${base}/api/wards?area=13102`)).json();
  assert.deepEqual(wards, [{ id: '9001', name: 'Phường Tân Phong' }]);
  const bad = await (await fetch(`${base}/api/wards?area=../x`)).json();
  assert.deepEqual(bad.wards, []);
});

test('/api/geocode caches results', async () => {
  hits.length = 0;
  const r1 = await (await fetch(`${base}/api/geocode?q=Quận 7, Việt Nam`)).json();
  const r2 = await (await fetch(`${base}/api/geocode?q=quận 7, việt nam`)).json();
  assert.deepEqual(r1.result, { lat: 10.75, lng: 106.66 });
  assert.deepEqual(r2.result, r1.result);
  assert.equal(hits.filter((h) => h.pathname === '/search').length, 1);
});

test('static files, no path traversal', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Phòng trọ Map/);
  const evil = await fetch(`${base}/..%2fserver.js`);
  assert.notEqual(evil.status, 200);
});

test('Street View: key config, metadata and cached image proxy', async () => {
  const get = async (q) => (await fetch(base + q)).json();
  assert.deepEqual(await get('/api/config'), { streetView: false, fromEnv: false });
  assert.deepEqual(await get('/api/streetview/meta?lat=10.73&lng=106.7'), { status: 'NO_KEY' });
  assert.equal((await fetch(`${base}/api/streetview/meta?lat=1&lng=2`)).status, 400, 'ngoài Việt Nam');

  const post = (body, type = 'application/json') => fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': type }, body });
  assert.equal((await post('googleMapsKey=x', 'text/plain')).status, 415, 'form / text từ trang khác bị chặn');
  assert.equal((await post(JSON.stringify({ googleMapsKey: 'bad key!' }))).status, 400);
  assert.equal((await post(JSON.stringify({ googleMapsKey: 'AIzaWrongKey_000000000000' }))).status, 200);
  assert.equal((await get('/api/streetview/meta?lat=10.73&lng=106.7')).status, 'REQUEST_DENIED');
  const ok = await post(JSON.stringify({ googleMapsKey: 'AIzaTestKey_1234567890abcdef' }));
  assert.deepEqual(await ok.json(), { streetView: true });
  const cfgFile = path.join(process.env.DATA_DIR, 'config.json');
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).googleMapsKey, 'AIzaTestKey_1234567890abcdef');
  if (process.platform !== 'win32') assert.equal(fs.statSync(cfgFile).mode & 0o077, 0, 'chỉ chủ máy đọc được');

  hits.length = 0;
  const meta = await get('/api/streetview/meta?lat=10.73&lng=106.7');
  assert.equal(meta.status, 'OK');
  assert.equal(meta.pano, 'PanoAbc123_xyz');
  assert.equal(meta.date, '2023-04');
  assert.equal(meta.heading, 0);
  assert.ok(meta.distance >= 20 && meta.distance <= 25, String(meta.distance));
  assert.equal(JSON.stringify(meta).includes('AIza'), false, 'không lộ key');
  const sent = hits.find((h) => h.pathname === '/maps/api/streetview/metadata').searchParams;
  assert.equal(sent.get('radius'), '80');
  assert.equal(sent.get('source'), 'outdoor');
  assert.equal((await get('/api/streetview/meta?lat=11.5&lng=106.7')).status, 'ZERO_RESULTS');

  hits.length = 0;
  for (let i = 0; i < 2; i++) {
    const img = await fetch(`${base}/api/streetview/image?pano=PanoAbc123_xyz&heading=0`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await img.arrayBuffer()).byteLength, 4);
  }
  const imgHits = hits.filter((h) => h.pathname === '/maps/api/streetview');
  assert.equal(imgHits.length, 1, 'lần sau lấy từ cache');
  assert.equal(imgHits[0].searchParams.get('heading'), '0');
  assert.equal((await fetch(`${base}/api/streetview/image?pano=../../x`)).status, 400);
  assert.equal((await fetch(`${base}/api/streetview/image?pano=PanoAbc123_xyz&heading=999`)).status, 400);

  assert.equal((await post(JSON.stringify({ googleMapsKey: '' }))).status, 200);
  assert.deepEqual(await get('/api/config'), { streetView: false, fromEnv: false });
});

test('bearing / distance', () => {
  const { bearing, distance } = require('../server');
  const a = { lat: 10.7, lng: 106.7 };
  assert.equal(Math.round(bearing(a, { lat: 10.71, lng: 106.7 })), 0);
  assert.equal(Math.round(bearing(a, { lat: 10.7, lng: 106.71 })), 90);
  assert.equal(Math.round(bearing(a, { lat: 10.69, lng: 106.7 })), 180);
  assert.ok(Math.abs(distance(a, { lat: 10.71, lng: 106.7 }) - 1112) < 5);
});
