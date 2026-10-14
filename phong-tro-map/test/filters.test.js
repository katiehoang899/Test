'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../public/filters');

test('parseRange / formatRange / rangeLabel', () => {
  assert.deepEqual(F.parseRange('1000000-3000000'), { min: 1000000, max: 3000000 });
  assert.deepEqual(F.parseRange('-15'), { min: null, max: 15 });
  assert.deepEqual(F.parseRange('50-'), { min: 50, max: null });
  assert.deepEqual(F.parseRange('abc'), { min: null, max: null });
  assert.equal(F.formatRange(1500000, NaN), '1500000-');
  assert.equal(F.formatRange(NaN, NaN), '');
  assert.equal(F.rangeLabel('2000000-3000000'), '2 triệu – 3 triệu');
  assert.equal(F.rangeLabel('-1000000'), 'Dưới 1 triệu');
  assert.equal(F.rangeLabel('50-', 'm2'), 'Trên 50 m²');
});

test('URL state round-trips and rejects junk', () => {
  const s = F.stateFromSearch('?q=gác&region_v2=13000&price=1000000-2000000&furnishing_rent=1,x,2&f=zz&st=bad&sort=price_asc');
  assert.equal(s.q, 'gác');
  assert.deepEqual(s.furnishing_rent, ['1', '2']);
  assert.equal(s.f, '');
  assert.equal(s.st, 'u');
  assert.deepEqual(F.stateFromSearch(F.stateToSearch(s)), s);
  assert.equal(F.stateToSearch(F.emptyState()), '');
});

test('toApiParams maps filters to Nhà Tốt params', () => {
  const s = { ...F.emptyState(), region_v2: '13000', price: '1000000-', furnishing_rent: ['2'], sort: 'price_asc' };
  const p = F.toApiParams(s, 100, 50);
  assert.equal(p.get('region_v2'), '13000');
  assert.equal(p.get('price'), '1000000-');
  assert.equal(p.get('furnishing_rent'), '2');
  assert.equal(p.get('sp'), '1');
  assert.equal(p.get('st'), 'u');
  assert.equal(p.get('o'), '100');
  assert.equal(p.has('sort'), false);
});

test('matches filters loaded ads client-side', () => {
  const ad = { title: 'Phòng trọ Quận 7 có gác', body: '', address: '', price: 3000000, size: 20, regionId: 13000, areaId: 13102, isCompany: false, furnishing: 2, type: 'u' };
  const s = (patch) => ({ ...F.emptyState(), ...patch });
  assert.ok(F.matches(ad, s({})));
  assert.ok(F.matches(ad, s({ q: 'phong tro gac' })), 'accent-insensitive');
  assert.ok(!F.matches(ad, s({ q: 'máy lạnh' })));
  assert.ok(F.matches(ad, s({ price: '2000000-3000000' })));
  assert.ok(!F.matches(ad, s({ price: '-2000000' })));
  assert.ok(!F.matches(ad, s({ size: '25-' })));
  assert.ok(!F.matches(ad, s({ area_v2: ['13096'] })));
  assert.ok(F.matches(ad, s({ area_v2: ['13096', '13102'] })), 'nhiều quận');
  assert.ok(!F.matches(ad, s({ f: 'c' })));
  assert.ok(!F.matches(ad, s({ st: 'h' })));
  assert.ok(F.matches(ad, s({ st: 'u,h' })));
  assert.ok(!F.matches(ad, s({ furnishing_rent: ['3'] })));
  assert.ok(F.matches({ ...ad, furnishing: null }, s({ furnishing_rent: ['3'] })), 'missing field is not excluded');
});

test('sortAds', () => {
  const ads = [
    { id: 'a', price: 3e6, size: 30, time: 1 },
    { id: 'b', price: null, size: 10, time: 3 },
    { id: 'c', price: 2e6, size: 10, time: 2 },
  ];
  const ids = (s) => F.sortAds(ads, s).map((a) => a.id).join('');
  assert.equal(ids(''), 'bca');
  assert.equal(ids('price_asc'), 'cab');
  assert.equal(ids('price_desc'), 'acb');
  assert.equal(ids('size_desc'), 'abc');
  assert.equal(ids('ppm_asc'), 'acb');
});

test('geoQueries goes from ward to district', () => {
  assert.deepEqual(F.geoQueries({ ward: 'Phường 1', area: 'Quận 3', region: 'Tp Hồ Chí Minh' }), [
    'Phường 1, Quận 3, Tp Hồ Chí Minh, Việt Nam',
    'Quận 3, Tp Hồ Chí Minh, Việt Nam',
  ]);
  assert.deepEqual(F.geoQueries({}), []);
});

test('splitKeywords / joinKeywords / excludedKeyword', () => {
  assert.deepEqual(F.splitKeywords('Giá từ 5,  sale ;ở ghép,,GIÁ TỪ 5'), ['gia tu 5', 'sale', 'o ghep']);
  assert.equal(F.joinKeywords(['Giá từ 5', ' ở  ghép ', '']), 'Giá từ 5, ở ghép');
  const ad = { title: 'Phòng trọ Q7', body: 'Giá   từ 5tr5, có gác' };
  assert.equal(F.excludedKeyword(ad, 'Giá từ 5'), 'gia tu 5');
  assert.equal(F.excludedKeyword(ad, 'gia tu 5'), 'gia tu 5', 'không dấu cũng khớp');
  assert.equal(F.excludedKeyword(ad, 'ở ghép, máy giặt'), null);
  assert.equal(F.excludedKeyword(ad, ''), null);
});

test('saleReasons flags "sale trọ" ads, not normal ones', () => {
  const sale = (body) => F.saleReasons({ title: '', body });
  assert.deepEqual(sale('Phòng trọ Quận 7 giá từ 3tr'), ['có "giá từ"']);
  assert.deepEqual(sale('Chỉ từ 2,5tr/tháng'), ['có "giá từ"']);
  assert.deepEqual(sale('Cho thuê phòng 3tr5 - 5tr gần ĐH'), ['khoảng giá 3,5 – 5 triệu']);
  assert.deepEqual(sale('Giá 3 - 5 triệu tuỳ phòng'), ['khoảng giá 3 – 5 triệu']);
  assert.deepEqual(sale('Từ 3 đến 5 triệu'), ['khoảng giá 3 – 5 triệu']);
  assert.deepEqual(sale('phòng 3.500.000 - 5.000.000đ'), ['khoảng giá 3,5 – 5 triệu']);
  assert.ok(sale('Hệ thống phòng trọ khắp Q7, còn nhiều phòng trống').length);
  assert.ok(sale('Mình chuyên sale phòng, hỗ trợ tìm phòng miễn phí').length);

  assert.deepEqual(sale('Phòng 25m2, giá 3tr5/tháng, điện 3.5k, nước 100k/người, cọc 1 tháng'), []);
  assert.deepEqual(sale('Rộng 3 - 4m, giờ giấc 5h - 23h, ở 2 - 3 người, giá 4 triệu'), []);
  assert.deepEqual(sale('Phòng có tủ 2 cánh, tủ lạnh, giá 3tr'), []);
  assert.deepEqual(sale('Diện tích 20 - 25m2, giá 4tr'), []);
});

test('hiddenReason combines keyword and sale filters', () => {
  const ad = { title: 'Phòng Q7', body: 'Giá từ 3tr, ở ghép được' };
  const s = (patch) => ({ ...F.emptyState(), ...patch });
  assert.equal(F.hiddenReason(ad, s({})), null);
  assert.equal(F.hiddenReason(ad, s({ nq: 'ở ghép' })).kind, 'keyword');
  assert.equal(F.hiddenReason(ad, s({ nosale: '1' })).kind, 'sale');
  assert.match(F.hiddenReason(ad, s({ nosale: '1' })).text, /giá từ/);
  assert.equal(F.hiddenReason({ title: 'Phòng Q7', body: 'giá 3tr' }, s({ nosale: '1' })), null);
  const st = F.stateFromSearch('?nq=Gi%C3%A1+t%E1%BB%AB+5%2C+sale&nosale=1');
  assert.equal(st.nq, 'Giá từ 5, sale');
  assert.equal(st.nosale, '1');
  assert.equal(F.stateFromSearch('?nosale=yes').nosale, '');
});

test('từ khoá bắt buộc (Thêm từ khoá): tất cả hoặc một trong các từ', () => {
  const ad = { title: 'Phòng Tân Phú có gác', body: 'Máy lạnh, ban công, giờ tự do' };
  const s = (patch) => ({ ...F.emptyState(), ...patch });
  assert.equal(F.hiddenReason(ad, s({ kw: 'may lanh, BAN CÔNG' })), null, 'không phân biệt dấu / hoa thường');
  const r = F.hiddenReason(ad, s({ kw: 'máy lạnh, thang máy' }));
  assert.equal(r.kind, 'include');
  assert.match(r.text, /thang may/);
  assert.equal(F.hiddenReason(ad, s({ kw: 'thang máy, gác', kwmode: 'any' })), null);
  assert.equal(F.hiddenReason(ad, s({ kw: 'thang máy, hầm xe', kwmode: 'any' })).kind, 'include');
  assert.equal(F.hiddenReason(ad, s({ kw: 'gác', nq: 'giờ tự do' })).kind, 'keyword', 'có từ bắt buộc nhưng dính từ loại trừ');
  const st = F.stateFromSearch('?kw=m%C3%A1y+l%E1%BA%A1nh%2C+g%C3%A1c&kwmode=any');
  assert.equal(st.kw, 'máy lạnh, gác');
  assert.equal(st.kwmode, 'any');
  assert.equal(F.stateFromSearch('?kwmode=xyz').kwmode, '');
  assert.equal(F.stateToSearch(s({ kw: 'gác' })), '?kw=g%C3%A1c');
});

test('multi-select districts / wards', () => {
  const st = F.stateFromSearch('?region_v2=13000&area_v2=13102,13096,x,13102&ward=13102:9001,13102:9002,13000:5,9001');
  assert.deepEqual(st.area_v2, ['13102', '13096']);
  assert.deepEqual(st.ward, ['13102:9001', '13102:9002'], 'phường phải thuộc quận đang chọn');
  assert.deepEqual(F.stateFromSearch(F.stateToSearch(st)), st);
  assert.deepEqual(F.stateFromSearch('?area_v2=13102').area_v2, [], 'không có tỉnh thì bỏ quận');

  assert.deepEqual(F.wardsOfArea(st, 13102), ['9001', '9002']);
  assert.deepEqual(F.locationSources(st), [
    { area_v2: '13102', ward: '9001' },
    { area_v2: '13102', ward: '9002' },
    { area_v2: '13096' },
  ]);
  assert.deepEqual(F.locationSources(F.emptyState()), [{}]);

  const p = F.toApiParams(st, 0, 50, { area_v2: '13102', ward: '9001' });
  assert.equal(p.get('region_v2'), '13000');
  assert.equal(p.get('area_v2'), '13102');
  assert.equal(p.get('ward'), '9001');
  assert.equal(F.toApiParams(st, 0, 50).has('area_v2'), false);

  const ad = (areaId, wardId) => ({ title: '', price: 1, size: 1, areaId, wardId });
  assert.ok(F.matches(ad(13102, 9001), st));
  assert.ok(!F.matches(ad(13102, 9003), st), 'phường khác trong quận đã chọn phường');
  assert.ok(F.matches(ad(13096, 1234), st), 'quận không chọn phường → cả quận');
  assert.ok(!F.matches(ad(13104, 1), st));
});

test('Google Maps / Street View links', () => {
  assert.equal(F.googleMapsUrl(10.73, 106.7), 'https://www.google.com/maps/search/?api=1&query=10.73%2C106.7');
  assert.equal(F.googleMapsUrl(null, null, 'Phường 1, Quận 3'), 'https://www.google.com/maps/search/?api=1&query=Ph%C6%B0%E1%BB%9Dng%201%2C%20Qu%E1%BA%ADn%203');
  assert.equal(F.googleMapsUrl(10.810488259088473, 106.70604992971748), 'https://www.google.com/maps/search/?api=1&query=10.810488%2C106.70605');
  assert.equal(F.streetViewUrl(10.73, 106.7), 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=10.73,106.7');
});

test('hide ads marked "không phù hợp" unless turned off', () => {
  const ad = { title: 'Phòng', body: '' };
  const s = (patch) => ({ ...F.emptyState(), ...patch });
  assert.equal(F.hiddenReason(ad, s({}), [], true).kind, 'marked');
  assert.equal(F.hiddenReason(ad, s({ hidemarked: '0' }), [], true), null);
  assert.equal(F.hiddenReason(ad, s({}), [], false), null);
  assert.equal(F.stateFromSearch('?hidemarked=0').hidemarked, '0');
  assert.equal(F.stateFromSearch('?hidemarked=x').hidemarked, '1');
  assert.equal(F.stateToSearch(F.emptyState()), '', 'mặc định không ghi lên URL');
});

test('distance helpers', () => {
  assert.ok(Math.abs(F.meters([10.7, 106.7], [10.71, 106.7]) - 1112) < 5);
  assert.equal(F.pathLength([[10.7, 106.7]]), 0);
  assert.ok(Math.abs(F.pathLength([[10.7, 106.7], [10.71, 106.7], [10.72, 106.7]]) - 2224) < 10);
  assert.equal(F.formatDistance(345.6), '346 m');
  assert.equal(F.formatDistance(2224), '2,2 km');
});

test('posted time filter: hours, days, date range', () => {
  const now = new Date(2026, 9, 12, 12, 0).getTime(); // 12/10/2026 12:00 giờ máy
  const H = 3600 * 1000;
  const r = (p) => F.postedRange(p, now);
  assert.deepEqual(r('h4'), { from: now - 4 * H, to: now });
  assert.deepEqual(r('h2-6'), { from: now - 6 * H, to: now - 2 * H });
  assert.deepEqual(r('h6-2'), r('h2-6'), 'đảo ngược vẫn đúng');
  assert.deepEqual(r('d2'), { from: now - 48 * H, to: now });
  const days = r('2026-10-05~2026-10-01');
  assert.equal(days.from, new Date(2026, 9, 1).getTime(), 'từ 0:00 ngày sớm hơn');
  assert.equal(days.to, new Date(2026, 9, 6).getTime() - 1, 'tới hết ngày muộn hơn');
  for (const bad of ['', 'h0', 'd0', 'x', '2026-02-31~2026-03-01', '2026-13-01~2026-10-01']) assert.equal(r(bad), null, bad);

  assert.equal(F.postedLabel('h4'), 'Trong 4 giờ');
  assert.equal(F.postedLabel('h2-6'), '2–6 giờ trước');
  assert.equal(F.postedLabel('d1'), 'Trong 1 ngày');
  assert.equal(F.postedLabel('2025-12-30~2026-01-02'), '30/12/2025 – 2/1/2026');
  assert.equal(F.postedLabel('2026-02-31~2026-03-01'), '');

  const st = F.stateFromSearch('?posted=h8');
  assert.equal(st.posted, 'h8');
  assert.equal(F.stateToSearch(st), '?posted=h8');
  assert.equal(F.stateFromSearch('?posted=yesterday').posted, '');
  assert.equal(F.toApiParams(st, 0, 50).has('posted'), false, 'API Nhà Tốt không có tham số này');

  const ad = (hoursAgo) => ({ title: '', price: 1, size: 1, time: Date.now() - hoursAgo * H });
  const s = (posted) => ({ ...F.emptyState(), posted });
  assert.ok(F.matches(ad(3), s('h4')));
  assert.ok(!F.matches(ad(5), s('h4')));
  assert.ok(F.matches(ad(3), s('h2-6')));
  assert.ok(!F.matches(ad(1), s('h2-6')));
  assert.ok(F.matches(ad(30), s('d2')));
  assert.ok(!F.matches(ad(50), s('d2')));
  assert.ok(!F.matches({ title: '', price: 1, size: 1, time: null }, s('d2')), 'không rõ giờ đăng');
  assert.ok(F.matches({ title: '', price: 1, size: 1, time: null }, s('')));
});

test('vùng vẽ trên bản đồ: đọc / ghi URL, điểm trong vùng', () => {
  const sq = [[10.70, 106.60], [10.70, 106.70], [10.80, 106.70], [10.80, 106.60]];
  const tri = [[10.0, 106.0], [10.0, 106.2], [10.2, 106.1]];
  const str = F.formatZones([sq, tri]);
  assert.equal(str, '10.7,106.6;10.7,106.7;10.8,106.7;10.8,106.6|10,106;10,106.2;10.2,106.1');
  assert.deepEqual(F.parseZones(str), [sq, tri]);
  assert.equal(F.formatZones([[[10.123456789, 106.987654321], [1, 2], [3, 4]]]), '10.12346,106.98765;1,2;3,4', 'làm tròn 5 chữ số');
  assert.deepEqual(F.parseZones('1,2;3,4|x;y;z|10,106;10,107;11,106;abc'), [[[10, 106], [10, 107], [11, 106]]], 'bỏ vùng < 3 điểm và điểm sai');
  assert.ok(F.inZones(10.75, 106.65, [sq, tri]));
  assert.ok(F.inZones(10.05, 106.1, [sq, tri]));
  assert.ok(!F.inZones(10.75, 106.75, [sq, tri]));
  assert.ok(!F.inZones(10.19, 106.01, [sq, tri]), 'ngoài cạnh xiên của tam giác');
  // Đa giác lõm (hình chữ L): điểm trong phần khuyết là ngoài vùng.
  const L = [[0, 0], [0, 2], [1, 2], [1, 1], [2, 1], [2, 0]];
  assert.ok(F.inPolygon(0.5, 1.5, L));
  assert.ok(!F.inPolygon(1.5, 1.5, L));
  const st = F.stateFromSearch('?zone=' + encodeURIComponent('10.7,106.6;10.7,106.7;10.8,106.7;bad|1,1'));
  assert.equal(st.zone, '10.7,106.6;10.7,106.7;10.8,106.7');
  assert.equal(F.stateToSearch({ ...F.emptyState(), zone: st.zone }), '?zone=' + encodeURIComponent(st.zone).replace(/%20/g, '+'));
  assert.equal(F.parseZones(Array.from({ length: 12 }, () => '1,1;1,2;2,2').join('|')).length, F.MAX_ZONES);
});
