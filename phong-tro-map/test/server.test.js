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
