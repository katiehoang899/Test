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
  if (u.pathname === '/v1/public/profile/777') return res.end(JSON.stringify({ data: { display_name: 'Anh Minh', joined_date: '2020-01-15' } }));
  if (u.pathname === '/v1/public/profile/oidLan123') {
    return res.end(JSON.stringify({
      account_oid: 'oidLan123', full_name: 'Chị Lan', avatar: 'https://cdn/lan.jpg', create_time: Math.floor(Date.now() / 1000) - 8 * 365 * 86400,
    }));
  }
  if (u.pathname === '/v1/public/ad-listing') {
    return res.end(JSON.stringify({
      total: 2,
      ads: [
        {
          list_id: 111, subject: 'Phòng trọ Quận 7 có gác', body: 'Gần Lotte', price: 3500000, price_string: '3,5 triệu/tháng',
          size: 25, region_v2: 13000, region_name: 'Tp Hồ Chí Minh', area_v2: 13102, area_name: 'Quận 7',
          ward: 9001, ward_name: 'Phường Tân Phong', latitude: 10.73, longitude: 106.7, image: 'https://img/1.jpg',
          list_time: 1700000000000, date: '2 giờ trước', company_ad: false, furnishing_rent: 2, type: 'u',
          account_name: 'Chị Lan', account_oid: 'oidLan123', account_id: 42,
        },
        { list_id: 222, subject: 'Phòng không toạ độ', price: 2000000, size: 15, latitude: 0, longitude: 0, company_ad: true },
      ],
    }));
  }
  if (u.pathname === '/v1/public/ad-listing/555') {
    return res.end(JSON.stringify({ ad: { body: 'Phòng rộng\nCó gác, máy lạnh', images: ['https://cdn/1.jpg', 'https://cdn/2.jpg', 'https://cdn/1.jpg', 'http://insecure/3.jpg', { url: 'https://cdn/4.jpg' }] } }));
  }
  if (u.pathname === '/v1/public/ad-listing/666') {
    return res.end(JSON.stringify({ ad: { subject: 'Phòng', body: 'dài', account_oid: 'oidLan123', account_id: 42, account_name: 'Chị Lan', price: 1 } }));
  }
  if (u.pathname === '/v1/public/ad-listing/444') return res.end(JSON.stringify({ ad: { subject: 'Phòng', body: 'Không ảnh' } }));
  if (u.pathname.startsWith('/route/v1/driving/')) {
    // "lng,lat;lng,lat": ví dụ 106.7,10.70;106.71,10.71 → đường gấp khúc qua một góc phố.
    const [[lng1, lat1], [lng2, lat2]] = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
    if (lat1 > 11) return res.end(JSON.stringify({ code: 'NoRoute', routes: [] }));
    return res.end(JSON.stringify({ code: 'Ok', routes: [{ geometry: { coordinates: [[lng1, lat1], [lng1, lat2], [lng2, lat2]] } }] }));
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
  if (u.pathname === '/interpreter' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const query = decodeURIComponent(body.replace(/^data=/, ''));
      hits.push({ overpass: query });
      if (query.includes('(11,')) { // ô 220,2133 (từ vĩ độ 11): giả lập Overpass bận
        res.statusCode = 504;
        return res.end('{}');
      }
      res.end(JSON.stringify({ elements: [
        { type: 'node', id: 1, lat: 10.7612, lon: 106.6801, tags: { amenity: 'hospital', name: 'Bệnh viện Chợ Rẫy' } },
        { type: 'way', id: 2, center: { lat: 10.762, lon: 106.681 }, tags: { shop: 'supermarket', name: 'Co.opmart' } },
        { type: 'node', id: 3, lat: 10.763, lon: 106.682, tags: { highway: 'bus_stop' } },
        { type: 'node', id: 4, lat: 10.764, lon: 106.683, tags: { amenity: 'bench' } },
        { type: 'node', id: 1, lat: 10.7612, lon: 106.6801, tags: { amenity: 'hospital' } },
      ] }));
    });
    return;
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
  process.env.OSRM_URL = up;
  process.env.OVERPASS_URL = `${up}/interpreter`;
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
  assert.match(await home.text(), /RentMAPs/);
  const evil = await fetch(`${base}/..%2fserver.js`);
  assert.notEqual(evil.status, 200);
});

test('distance', () => {
  const { distance } = require('../server');
  const a = { lat: 10.7, lng: 106.7 };
  assert.ok(Math.abs(distance(a, { lat: 10.71, lng: 106.7 }) - 1112) < 5);
});

test('/api/saved: favorites and hidden ads with sanitized snapshots', async () => {
  const post = (body, type = 'application/json') => fetch(`${base}/api/saved`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) });
  assert.deepEqual(await (await fetch(`${base}/api/saved`)).json(), { fav: {}, hidden: {} });
  assert.equal((await post({ kind: 'fav', op: 'add', id: '111' }, 'text/plain')).status, 415);
  assert.equal((await post({ kind: 'evil', op: 'add', id: '111' })).status, 400);
  assert.equal((await post({ kind: 'fav', op: 'add', id: '../x' })).status, 400);

  const ad = {
    title: 'Phòng Q7', price: 3500000, lat: 10.73, lng: 106.7, url: 'javascript:alert(1)', thumb: 'http://x/a.jpg',
    extra: 'bỏ đi', approxAt: { lat: 99, lng: 1 },
  };
  let data = await (await post({ kind: 'fav', op: 'add', id: '111', ad })).json();
  const snap = data.fav['111'].ad;
  assert.equal(snap.title, 'Phòng Q7');
  assert.equal(snap.price, 3500000);
  assert.equal(snap.url, 'https://www.nhatot.com/111.htm', 'link lạ bị thay bằng link Nhà Tốt');
  assert.equal(snap.thumb, null, 'chỉ nhận ảnh https');
  assert.equal(snap.approxAt, null);
  assert.equal('extra' in snap, false);
  assert.ok(data.fav['111'].at > 0);

  await post({ kind: 'hidden', op: 'add', id: '222', ad: { title: 'Không ưng' } });
  await post({ kind: 'hidden', op: 'add', id: '444' });
  data = await (await fetch(`${base}/api/saved`)).json();
  assert.deepEqual(Object.keys(data.hidden).sort(), ['222', '444']);
  const file = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'saved.json'), 'utf8'));
  assert.deepEqual(Object.keys(file.fav), ['111'], 'lưu ra file');

  data = await (await post({ kind: 'hidden', op: 'remove', id: '222' })).json();
  assert.deepEqual(Object.keys(data.hidden), ['444']);
  data = await (await post({ kind: 'hidden', op: 'clear' })).json();
  assert.deepEqual(data.hidden, {});
  assert.deepEqual(Object.keys(data.fav), ['111'], 'xoá tin đã ẩn không đụng tới yêu thích');
});

test('/api/route follows streets, falls back to a straight line', async () => {
  const get = async (q) => { const r = await fetch(`${base}/api/route?${q}`); return [r.status, await r.json()]; };
  const [st, r] = await get('from=10.7,106.7&to=10.71,106.71');
  assert.equal(st, 200);
  assert.equal(r.routed, true);
  assert.deepEqual(r.path, [[10.7, 106.7], [10.7, 106.7], [10.71, 106.7], [10.71, 106.71], [10.71, 106.71]]);
  const [, flat] = await get('from=11.5,106.7&to=11.51,106.7');
  assert.deepEqual(flat, { path: [[11.5, 106.7], [11.51, 106.7]], routed: false });
  assert.equal((await get('from=1,2&to=10.7,106.7'))[0], 400);
  assert.equal((await get('from=10.7,106.7&to=21.0,105.8'))[0], 400, 'quá xa');
});

test('/api/floods: add points and A–B segments, update, remove', async () => {
  const post = (body, type = 'application/json') => fetch(`${base}/api/floods`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) });
  assert.deepEqual(await (await fetch(`${base}/api/floods`)).json(), { floods: [] });
  assert.equal((await post({ op: 'add', type: 'point', coords: [10.7, 106.7] }, 'text/plain')).status, 415);
  assert.equal((await post({ op: 'add', type: 'point', coords: [1, 2] })).status, 400);
  assert.equal((await post({ op: 'add', type: 'line', path: [[10.7, 106.7]] })).status, 400);
  assert.equal((await post({ op: 'nuke' })).status, 400);

  let { floods } = await (await post({ op: 'add', type: 'point', coords: [10.7123456789, 106.7], level: 'frequent', note: 'Ngập 30 cm' })).json();
  assert.equal(floods.length, 1);
  assert.deepEqual(floods[0].coords, [10.712346, 106.7]);
  assert.equal(floods[0].level, 'frequent');
  assert.equal(floods[0].note, 'Ngập 30 cm');
  ({ floods } = await (await post({ op: 'add', type: 'line', path: [[10.7, 106.7], [10.71, 106.7], [10.71, 106.71]], routed: true, level: 'weird' })).json());
  const line = floods[1];
  assert.equal(line.type, 'line');
  assert.equal(line.level, 'unknown', 'mức độ lạ → chưa phân loại');
  assert.equal(line.path.length, 3);

  ({ floods } = await (await post({ op: 'update', id: line.id, level: 'light', note: 'Nhẹ thôi' })).json());
  assert.equal(floods[1].level, 'light');
  assert.equal(floods[1].note, 'Nhẹ thôi');
  assert.equal((await post({ op: 'update', id: 'nope', level: 'light' })).status, 404);
  ({ floods } = await (await post({ op: 'remove', id: floods[0].id })).json());
  assert.deepEqual(floods.map((f) => f.id), [line.id]);
  const file = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'floods.json'), 'utf8'));
  assert.equal(file.length, 1, 'lưu ra file');
});

test('/api/floods import: mở file sao lưu, gộp hoặc thay thế', async () => {
  const post = (body) => fetch(`${base}/api/floods`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const before = (await (await fetch(`${base}/api/floods`)).json()).floods;
  assert.equal(before.length, 1);
  const keep = before[0];

  // Gộp: điểm cùng id được cập nhật theo file, điểm mới được thêm, điểm sai bị bỏ qua.
  let r = await (await post({ op: 'import', mode: 'merge', items: [
    { ...keep, note: 'Sửa từ file' },
    { id: 'imported-0001', type: 'point', coords: [10.8, 106.6], level: 'medium', note: 'Từ file', at: 1700000000000 },
    { type: 'point', coords: [999, 1] },
    'rác',
  ] })).json();
  assert.equal(r.floods.length, 2);
  assert.equal(r.floods.find((f) => f.id === keep.id).note, 'Sửa từ file');
  assert.deepEqual([r.imported, r.skipped], [2, 2]);
  assert.equal(r.floods.find((f) => f.id === 'imported-0001').at, 1700000000000, 'giữ thời gian tạo trong file');

  // Mở lại cùng file: không bị nhân đôi.
  r = await (await post({ op: 'import', mode: 'merge', items: [{ id: 'imported-0001', type: 'point', coords: [10.8, 106.6] }] })).json();
  assert.equal(r.floods.length, 2);

  // Thay thế toàn bộ.
  r = await (await post({ op: 'import', mode: 'replace', items: [{ type: 'line', path: [[10.7, 106.7], [10.71, 106.71]], level: 'light' }] })).json();
  assert.equal(r.floods.length, 1);
  assert.equal(r.floods[0].type, 'line');
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'floods.json'), 'utf8')).length, 1, 'lưu ra file');

  assert.equal((await post({ op: 'import', mode: 'merge', items: [{ type: 'point', coords: [1, 2, 3] }, {}] })).status, 400, 'file không có điểm hợp lệ');
  assert.equal((await post({ op: 'import', items: 'x' })).status, 400);
  assert.equal((await (await fetch(`${base}/api/floods`)).json()).floods.length, 1, 'lỗi thì giữ nguyên danh sách');
});

test('/api/parking: separate layer with its own types', async () => {
  const post = (body) => fetch(`${base}/api/parking`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const floodsBefore = (await (await fetch(`${base}/api/floods`)).json()).floods.length;
  assert.deepEqual(await (await fetch(`${base}/api/parking`)).json(), { parking: [] });
  let { parking } = await (await post({ op: 'add', type: 'point', coords: [10.75, 106.66], level: 'paid', note: '30k/lượt' })).json();
  assert.equal(parking[0].level, 'paid');
  ({ parking } = await (await post({ op: 'add', type: 'line', path: [[10.75, 106.66], [10.751, 106.661]], level: 'frequent' })).json());
  assert.equal(parking[1].level, 'unknown', 'mức độ ngập không phải loại chỗ đỗ');
  ({ parking } = await (await post({ op: 'update', id: parking[1].id, level: 'limited' })).json());
  assert.equal(parking[1].level, 'limited');
  assert.equal((await post({ op: 'update', id: 'nope' })).status, 404);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'parking.json'), 'utf8')).length, 2);
  assert.equal((await (await fetch(`${base}/api/floods`)).json()).floods.length, floodsBefore, 'không đụng lớp điểm ngập');
  assert.equal((await fetch(`${base}/api/other`)).status, 404);
  assert.equal((await fetch(`${base}/api/config`)).status, 404, 'đã bỏ API key Street View');
});

test('static files: always revalidated, 304 when unchanged', async () => {
  const first = await fetch(`${base}/style.css`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await fetch(`${base}/style.css`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  const ico = await fetch(`${base}/favicon.ico?v=blue`);
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get('content-type'), 'image/x-icon');
  assert.equal((await fetch(`${base}/vendor`)).status, 404, 'thư mục không phải file');
});

test('/api/pois: công trình OSM theo ô bản đồ, có cache', async () => {
  const before = hits.filter((h) => h.overpass).length;
  const res = await fetch(`${base}/api/pois?cell=215,2133`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.cell, '215,2133');
  assert.deepEqual(data.pois.map((p) => [p.id, p.cat, p.name]), [
    ['n1', 'hospital', 'Bệnh viện Chợ Rẫy'],
    ['w2', 'market', 'Co.opmart'],
    ['n3', 'bus', ''],
  ]);
  assert.deepEqual([data.pois[1].lat, data.pois[1].lng], [10.762, 106.681]);
  const q = hits.filter((h) => h.overpass).at(-1).overpass;
  assert.match(q, /\(10\.75,106\.65,10\.8,106\.7\)/);
  assert.match(q, /"amenity"~"\^\(hospital\|clinic/);
  await fetch(`${base}/api/pois?cell=215,2133`);
  assert.equal(hits.filter((h) => h.overpass).length, before + 1, 'lần hai lấy từ cache');

  assert.equal((await fetch(`${base}/api/pois?cell=abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/pois?cell=9999,1`)).status, 400);
  const busy = await fetch(`${base}/api/pois?cell=220,2133`);
  assert.equal(busy.status, 502);
  assert.match((await busy.json()).error, /Overpass/);
});

test('/api/seller: hồ sơ người đăng (tên, ảnh đại diện, thời gian trên Nhà Tốt)', async () => {
  const ads = await (await fetch(`${base}/api/ads?region_v2=13000`)).json();
  const ad = ads.ads.find((a) => a.id === '111');
  assert.equal(ad.seller, 'Chị Lan');
  assert.equal(ad.sellerOid, 'oidLan123');
  assert.equal(ad.sellerId, '42');

  const s = await (await fetch(`${base}/api/seller?oid=oidLan123`)).json();
  assert.equal(s.name, 'Chị Lan');
  assert.equal(s.avatar, 'https://cdn/lan.jpg');
  assert.ok(Math.abs((Date.now() - s.joinedAt) / (365 * 86400000) - 8) < 0.01, 'create_time tính bằng giây');
  assert.equal(s.url, 'https://www.chotot.com/user/oidLan123');
  assert.deepEqual(Object.keys(s).sort(), ['avatar', 'joinedAt', 'name', 'url']);

  const byId = await (await fetch(`${base}/api/seller?id=777`)).json();
  assert.deepEqual([byId.name, new Date(byId.joinedAt).getFullYear(), byId.url], ['Anh Minh', 2020, null], 'không có account_oid: hỏi theo account_id, tên trường khác');

  assert.equal((await fetch(`${base}/api/seller?oid=nobody99`)).status, 502);
  assert.equal((await fetch(`${base}/api/seller?oid=../x`)).status, 400);
  assert.equal((await fetch(`${base}/api/seller`)).status, 400);
});

test('/api/debug/seller: dữ liệu gốc về người đăng của một tin', async () => {
  const d = await (await fetch(`${base}/api/debug/seller?ad=666`)).json();
  assert.equal(d.detail.status, 200);
  assert.equal(d.detail.seller.account_oid, 'oidLan123');
  assert.ok(!('body' in d.detail.seller), 'chỉ các trường liên quan người đăng');
  assert.deepEqual(d.probes.map((p) => [p.url, p.status]), [['/v1/public/profile/oidLan123', 200], ['/v1/public/profile/42', 404]]);
  assert.match(d.probes[0].body, /Chị Lan/);
  assert.equal((await fetch(`${base}/api/debug/seller?ad=x`)).status, 400);
});

test('/api/detail: đủ ảnh và mô tả đầy đủ của tin', async () => {
  const d = await (await fetch(`${base}/api/detail?id=555`)).json();
  assert.deepEqual(d.images, ['https://cdn/1.jpg', 'https://cdn/2.jpg', 'https://cdn/4.jpg']);
  assert.equal(d.body, 'Phòng rộng\nCó gác, máy lạnh');
  assert.deepEqual(await (await fetch(`${base}/api/detail?id=444`)).json(), { images: [], body: 'Không ảnh' });
  assert.equal((await fetch(`${base}/api/detail?id=abc`)).status, 400);
});
