'use strict';

// Bộ lọc dùng chung cho trình duyệt và test (node). Không phụ thuộc DOM.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Filters = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FIELDS = ['q', 'st', 'region_v2', 'area_v2', 'ward', 'price', 'size', 'furnishing_rent', 'f', 'sort'];

  const DEFAULTS = { q: '', st: 'u', region_v2: '', area_v2: '', ward: '', price: '', size: '', furnishing_rent: [], f: '', sort: '' };

  // Sắp xếp phía máy chủ Chợ Tốt (tham số sp). Kết quả đã tải luôn được sắp xếp lại
  // phía trình duyệt, nên "Tải tất cả" cho thứ tự đúng kể cả khi sp bị bỏ qua.
  const SORT_TO_SP = { price_asc: '1', price_desc: '2' };

  function emptyState() {
    return { ...DEFAULTS, furnishing_rent: [] };
  }

  // "1000000-3000000" → { min: 1000000, max: 3000000 }; "-15" → { min: null, max: 15 }
  function parseRange(s) {
    const m = /^\s*(\d*(?:\.\d+)?)\s*-\s*(\d*(?:\.\d+)?)\s*$/.exec(String(s || ''));
    if (!m) return { min: null, max: null };
    const min = m[1] === '' ? null : Number(m[1]);
    const max = m[2] === '' ? null : Number(m[2]);
    return { min, max };
  }

  function formatRange(min, max) {
    const a = Number.isFinite(min) && min > 0 ? String(Math.round(min)) : '';
    const b = Number.isFinite(max) && max > 0 ? String(Math.round(max)) : '';
    if (!a && !b) return '';
    return `${a}-${b}`;
  }

  function trimNum(n) {
    return String(Math.round(n * 100) / 100).replace('.', ',');
  }

  function formatMoney(v) {
    if (!Number.isFinite(v)) return '';
    if (v >= 1e9) return trimNum(v / 1e9) + ' tỷ';
    if (v >= 1e6) return trimNum(v / 1e6) + ' triệu';
    if (v >= 1e3) return trimNum(v / 1e3) + ' nghìn';
    return String(v) + ' đ';
  }

  function rangeLabel(s, unit) {
    const { min, max } = parseRange(s);
    const fmt = unit === 'm2' ? (v) => trimNum(v) + ' m²' : formatMoney;
    if (min != null && max != null) return `${fmt(min)} – ${fmt(max)}`;
    if (min != null) return `Trên ${fmt(min)}`;
    if (max != null) return `Dưới ${fmt(max)}`;
    return '';
  }

  // Bỏ dấu tiếng Việt để tìm "phong tro quan 7" khớp "Phòng trọ Quận 7".
  function fold(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase();
  }

  function stateFromSearch(search) {
    const p = new URLSearchParams(search);
    const s = emptyState();
    for (const k of FIELDS) {
      if (!p.has(k)) continue;
      if (k === 'furnishing_rent') s[k] = p.get(k).split(',').filter((x) => /^\d+$/.test(x));
      else s[k] = p.get(k);
    }
    if (!['u', 'h', 'u,h'].includes(s.st)) s.st = DEFAULTS.st;
    if (!['', 'p', 'c'].includes(s.f)) s.f = '';
    return s;
  }

  function stateToSearch(state) {
    const p = new URLSearchParams();
    for (const k of FIELDS) {
      const v = k === 'furnishing_rent' ? (state[k] || []).join(',') : state[k];
      if (v && v !== DEFAULTS[k]) p.set(k, v);
    }
    const s = p.toString();
    return s ? '?' + s : '';
  }

  // Tham số gửi lên /api/ads (cùng tên với tham số trên URL nhatot.com).
  function toApiParams(state, offset, limit) {
    const p = new URLSearchParams();
    for (const k of ['q', 'st', 'region_v2', 'area_v2', 'ward', 'price', 'size', 'f']) {
      if (state[k]) p.set(k, state[k]);
    }
    if (state.furnishing_rent && state.furnishing_rent.length) p.set('furnishing_rent', state.furnishing_rent.join(','));
    if (SORT_TO_SP[state.sort]) p.set('sp', SORT_TO_SP[state.sort]);
    p.set('o', String(offset || 0));
    p.set('limit', String(limit || 50));
    return p;
  }

  function inRange(v, s) {
    const { min, max } = parseRange(s);
    if (min == null && max == null) return true;
    if (v == null) return false;
    return (min == null || v >= min) && (max == null || v <= max);
  }

  // Lọc lại phía trình duyệt, phòng khi API bỏ qua một tham số. Trường nào tin
  // không có thì không loại tin đó (trừ giá / diện tích khi đã đặt khoảng).
  function matches(ad, state) {
    if (!inRange(ad.price, state.price)) return false;
    if (!inRange(ad.size, state.size)) return false;
    if (state.region_v2 && ad.regionId != null && String(ad.regionId) !== String(state.region_v2)) return false;
    if (state.area_v2 && ad.areaId != null && String(ad.areaId) !== String(state.area_v2)) return false;
    if (state.ward && ad.wardId != null && String(ad.wardId) !== String(state.ward)) return false;
    if (state.f === 'p' && ad.isCompany) return false;
    if (state.f === 'c' && !ad.isCompany) return false;
    if (state.st && state.st !== 'u,h' && ad.type && ad.type !== state.st) return false;
    const furn = state.furnishing_rent || [];
    if (furn.length && ad.furnishing != null && !furn.includes(String(ad.furnishing))) return false;
    if (state.q) {
      const hay = fold([ad.title, ad.body, ad.address].join(' '));
      const words = fold(state.q).split(/\s+/).filter(Boolean);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function sortAds(ads, sort) {
    const list = ads.slice();
    const byNum = (get, dir) => (a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return dir * (x - y);
    };
    const ppm = (a) => (a.price != null && a.size ? a.price / a.size : null);
    if (sort === 'price_asc') list.sort(byNum((a) => a.price, 1));
    else if (sort === 'price_desc') list.sort(byNum((a) => a.price, -1));
    else if (sort === 'size_desc') list.sort(byNum((a) => a.size, -1));
    else if (sort === 'ppm_asc') list.sort(byNum(ppm, 1));
    else list.sort(byNum((a) => a.time, -1));
    return list;
  }

  // Các câu truy vấn geocode cho tin không có toạ độ, từ chi tiết (phường) tới thô (quận).
  function geoQueries(ad) {
    const out = [];
    if (ad.ward && ad.area) out.push([ad.ward, ad.area, ad.region].filter(Boolean).join(', '));
    if (ad.area) out.push([ad.area, ad.region].filter(Boolean).join(', '));
    else if (ad.region) out.push(ad.region);
    return out.map((q) => q + ', Việt Nam');
  }

  return {
    FIELDS, DEFAULTS, SORT_TO_SP, emptyState, parseRange, formatRange, formatMoney, rangeLabel, fold,
    stateFromSearch, stateToSearch, toApiParams, matches, sortAds, geoQueries,
  };
});
