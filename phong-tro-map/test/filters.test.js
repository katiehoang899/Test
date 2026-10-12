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
  assert.ok(!F.matches(ad, s({ area_v2: '13096' })));
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
