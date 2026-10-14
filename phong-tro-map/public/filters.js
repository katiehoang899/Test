'use strict';

// Bộ lọc dùng chung cho trình duyệt và test (node). Không phụ thuộc DOM.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Filters = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FIELDS = ['q', 'st', 'region_v2', 'area_v2', 'ward', 'price', 'size', 'posted', 'furnishing_rent', 'f', 'sort', 'kw', 'kwmode', 'nq', 'nosale', 'hidemarked', 'zone'];

  // area_v2: danh sách mã quận / huyện (chọn nhiều).
  // ward: danh sách "mãQuận:mãPhường" (chọn nhiều, nhớ phường thuộc quận nào).
  // kw: từ khoá phải có trong tiêu đề / nội dung (cách nhau bằng dấu phẩy); kwmode = 'any': chỉ cần
  // một trong các từ, mặc định phải có đủ tất cả.
  // nq: từ khoá loại trừ (cách nhau bằng dấu phẩy), nosale = '1': ẩn tin sale trọ.
  // posted: thời gian đăng, xem postedRange (h4 = trong 4 giờ, h2-6 = 2–6 giờ trước,
  // d1 = trong 1 ngày, 2026-10-01~2026-10-05 = từ ngày đến ngày).
  // hidemarked = '1': ẩn tin bạn đã đánh dấu "không phù hợp" ('0' để hiện lại).
  // zone: các vùng vẽ trên bản đồ, chỉ hiện tin nằm trong vùng: "lat,lng;lat,lng;…|vùng 2…" (xem parseZones).
  // Các bộ lọc kw / nq / nosale / hidemarked / zone chỉ chạy trên trình duyệt vì API Nhà Tốt không hỗ trợ.
  const DEFAULTS = { q: '', st: 'u', region_v2: '', area_v2: [], ward: [], price: '', size: '', posted: '', furnishing_rent: [], f: '', sort: '', kw: '', kwmode: '', nq: '', nosale: '', hidemarked: '1', zone: '' };
  const LIST_FIELDS = ['area_v2', 'ward', 'furnishing_rent'];
  const LIST_RE = { area_v2: /^\d{1,10}$/, ward: /^\d{1,10}:\d{1,10}$/, furnishing_rent: /^\d+$/ };

  // Sắp xếp phía máy chủ Chợ Tốt (tham số sp). Kết quả đã tải luôn được sắp xếp lại
  // phía trình duyệt, nên "Tải tất cả" cho thứ tự đúng kể cả khi sp bị bỏ qua.
  const SORT_TO_SP = { price_asc: '1', price_desc: '2' };

  function emptyState() {
    return { ...DEFAULTS, area_v2: [], ward: [], furnishing_rent: [] };
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
      if (LIST_FIELDS.includes(k)) s[k] = [...new Set(p.get(k).split(',').filter((x) => LIST_RE[k].test(x)))];
      else s[k] = p.get(k);
    }
    // Phường phải thuộc một quận đang chọn.
    s.ward = s.ward.filter((w) => s.area_v2.includes(w.split(':')[0]));
    if (!s.region_v2) {
      s.area_v2 = [];
      s.ward = [];
    }
    if (!['u', 'h', 'u,h'].includes(s.st)) s.st = DEFAULTS.st;
    if (s.kwmode !== 'any') s.kwmode = '';
    s.zone = formatZones(parseZones(s.zone)); // bỏ vùng sai, làm tròn toạ độ
    if (!['', 'p', 'c'].includes(s.f)) s.f = '';
    s.nosale = s.nosale === '1' ? '1' : '';
    s.hidemarked = s.hidemarked === '0' ? '0' : '1';
    if (!postedRange(s.posted)) s.posted = '';
    return s;
  }

  function stateToSearch(state) {
    const p = new URLSearchParams();
    for (const k of FIELDS) {
      const v = LIST_FIELDS.includes(k) ? (state[k] || []).join(',') : state[k];
      if (v && v !== DEFAULTS[k]) p.set(k, v);
    }
    const s = p.toString();
    return s ? '?' + s : '';
  }

  // ---------- vùng vẽ trên bản đồ ----------

  const MAX_ZONES = 10;
  const MAX_ZONE_POINTS = 100;

  // "10.7,106.6;10.71,106.62;10.69,106.63|…" → [[[10.7, 106.6], …], …]. Bỏ điểm / vùng sai,
  // vùng phải có ít nhất 3 điểm.
  function parseZones(str) {
    const zones = [];
    for (const part of String(str || '').split('|')) {
      const pts = [];
      for (const p of part.split(';')) {
        const [lat, lng] = p.split(',').map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180) pts.push([lat, lng]);
        if (pts.length >= MAX_ZONE_POINTS) break;
      }
      if (pts.length >= 3) zones.push(pts);
      if (zones.length >= MAX_ZONES) break;
    }
    return zones;
  }

  // Toạ độ làm tròn 5 chữ số (~1 m) cho URL ngắn.
  function formatZones(zones) {
    const r = (v) => Number(Number(v).toFixed(5));
    return zones.filter((z) => z.length >= 3).map((z) => z.map(([lat, lng]) => `${r(lat)},${r(lng)}`).join(';')).join('|');
  }

  // Điểm có nằm trong đa giác không (tia ngang, đủ chính xác cho vùng cỡ thành phố).
  function inPolygon(lat, lng, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i];
      const [yj, xj] = poly[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  const inZones = (lat, lng, zones) => zones.some((z) => inPolygon(lat, lng, z));

  // Mã phường đang chọn của một quận.
  function wardsOfArea(state, area) {
    const prefix = String(area) + ':';
    return (state.ward || []).filter((w) => w.startsWith(prefix)).map((w) => w.slice(prefix.length));
  }

  // API Nhà Tốt chỉ nhận một quận và một phường mỗi lần, nên mỗi nơi được chọn là một
  // "nguồn" tải riêng: quận không chọn phường nào → cả quận, có chọn phường → từng phường.
  function locationSources(state) {
    const areas = state.area_v2 || [];
    if (!areas.length) return [{}];
    const out = [];
    for (const a of areas) {
      const ws = wardsOfArea(state, a);
      if (!ws.length) out.push({ area_v2: a });
      else for (const w of ws) out.push({ area_v2: a, ward: w });
    }
    return out;
  }

  // Tham số gửi lên /api/ads (cùng tên với tham số trên URL nhatot.com) cho một nguồn.
  function toApiParams(state, offset, limit, source = {}) {
    const p = new URLSearchParams();
    for (const k of ['q', 'st', 'region_v2', 'price', 'size', 'f']) { // posted lọc trên trình duyệt
      if (state[k]) p.set(k, state[k]);
    }
    if (source.area_v2) p.set('area_v2', source.area_v2);
    if (source.ward) p.set('ward', source.ward);
    if (state.furnishing_rent && state.furnishing_rent.length) p.set('furnishing_rent', state.furnishing_rent.join(','));
    if (SORT_TO_SP[state.sort]) p.set('sp', SORT_TO_SP[state.sort]);
    p.set('o', String(offset || 0));
    p.set('limit', String(limit || 50));
    return p;
  }

  // ---------- thời gian đăng ----------

  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const POSTED_RE = /^(?:h(\d{1,3})(?:-(\d{1,3}))?|d(\d{1,2})|(\d{4})-(\d{2})-(\d{2})~(\d{4})-(\d{2})-(\d{2}))$/;

  // Khoảng thời gian đăng { from, to } (ms) của bộ lọc, hoặc null nếu không lọc / sai định dạng.
  function postedRange(posted, now = Date.now()) {
    const m = POSTED_RE.exec(String(posted || ''));
    if (!m) return null;
    if (m[1]) {
      const a = Number(m[1]);
      if (m[2] == null) return a > 0 ? { from: now - a * HOUR, to: now } : null;
      const lo = Math.min(a, Number(m[2]));
      const hi = Math.max(a, Number(m[2]));
      return hi > 0 ? { from: now - hi * HOUR, to: now - lo * HOUR } : null;
    }
    if (m[3]) return Number(m[3]) > 0 ? { from: now - Number(m[3]) * DAY, to: now } : null;
    // Theo ngày (giờ máy): từ 0:00 ngày sớm hơn tới hết ngày muộn hơn.
    const days = postedDays(m);
    if (!days) return null;
    const [a, b] = days;
    return { from: a.getTime(), to: new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1).getTime() - 1 };
  }

  // Ngày hợp lệ (vd. không có 31/2), hoặc null.
  function localDate(y, mo, d) {
    const t = new Date(y, mo - 1, d);
    return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d ? t : null;
  }

  // Hai ngày của khoảng "từ ngày đến ngày", ngày sớm hơn đứng trước.
  function postedDays(m) {
    const a = localDate(+m[4], +m[5], +m[6]);
    const b = localDate(+m[7], +m[8], +m[9]);
    if (!a || !b) return null;
    return a <= b ? [a, b] : [b, a];
  }

  function ddmm(t, withYear) {
    return `${t.getDate()}/${t.getMonth() + 1}${withYear ? '/' + t.getFullYear() : ''}`;
  }

  function postedLabel(posted) {
    const m = POSTED_RE.exec(String(posted || ''));
    if (!m || !postedRange(posted)) return '';
    if (m[1] && m[2] == null) return `Trong ${Number(m[1])} giờ`;
    if (m[1]) {
      const [lo, hi] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      return lo === 0 ? `Trong ${hi} giờ` : `${lo}–${hi} giờ trước`;
    }
    if (m[3]) return `Trong ${Number(m[3])} ngày`;
    const [a, b] = postedDays(m);
    const thisYear = new Date().getFullYear();
    const withYear = a.getFullYear() !== thisYear || b.getFullYear() !== thisYear;
    return a.getTime() === b.getTime() ? ddmm(a, withYear) : `${ddmm(a, withYear)} – ${ddmm(b, withYear)}`;
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
    const posted = postedRange(state.posted);
    if (posted && (ad.time == null || ad.time < posted.from || ad.time > posted.to)) return false;
    if (state.region_v2 && ad.regionId != null && String(ad.regionId) !== String(state.region_v2)) return false;
    const areas = state.area_v2 || [];
    if (areas.length && ad.areaId != null && !areas.includes(String(ad.areaId))) return false;
    if (ad.areaId != null && ad.wardId != null) {
      const ws = wardsOfArea(state, ad.areaId);
      if (ws.length && !ws.includes(String(ad.wardId))) return false;
    }
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

  // ---------- loại trừ từ khoá & tin sale trọ ----------

  const textCache = new WeakMap();
  function adText(ad) {
    let t = textCache.get(ad);
    if (t == null) {
      t = fold([ad.title, ad.body].join('\n')).replace(/\s+/g, ' ');
      textCache.set(ad, t);
    }
    return t;
  }

  // "Giá từ 5, sale; ở ghép" → ['gia tu 5', 'sale', 'o ghep']
  function splitKeywords(nq) {
    const seen = new Set();
    for (const part of String(nq || '').split(/[,;\n]+/)) {
      const k = fold(part).replace(/\s+/g, ' ').trim();
      if (k) seen.add(k);
    }
    return [...seen];
  }

  // Nhập lại danh sách từ khoá (giữ nguyên chữ người dùng gõ) thành chuỗi lưu trên URL.
  function joinKeywords(list) {
    return list.map((k) => String(k).replace(/[,;\n]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
  }

  // Từ khoá bắt buộc: trả về chữ mô tả từ còn thiếu, null nếu tin đạt.
  // mode 'any': có ít nhất một từ là đạt; mặc định phải có đủ tất cả.
  function missingKeyword(ad, kw, mode) {
    const words = splitKeywords(kw);
    if (!words.length) return null;
    const text = adText(ad);
    if (mode === 'any') return words.some((w) => text.includes(w)) ? null : words.join('", "');
    return words.find((w) => !text.includes(w)) || null;
  }

  function excludedKeyword(ad, nq) {
    const words = splitKeywords(nq);
    if (!words.length) return null;
    const text = adText(ad);
    return words.find((w) => text.includes(w)) || null;
  }

  // Số tiền "3", "3.5", "3tr5", "3 trieu 500" → triệu đồng.
  function millions(numStr, tail) {
    const base = parseFloat(numStr.replace(',', '.'));
    if (!Number.isFinite(base)) return null;
    const t = /^\d+$/.test(tail || '') ? parseFloat('0.' + tail) : 0;
    return base + t;
  }

  // Đơn vị triệu: "triệu", "tr", "củ". Không tính "m" vì dễ nhầm với mét ("rộng 3 - 4m").
  const UNIT = '(?:trieu|tr|cu)(?![a-z])';
  const AMOUNT = `(\\d{1,3}(?:[.,]\\d{1,2})?)\\s*(?:${UNIT}\\s*(\\d{1,3})?)?`;
  // 3tr - 5tr, 3 - 5 triệu, 2tr5 ~ 4tr, từ 3 đến 5 triệu, 3->5tr
  const RANGE_RE = new RegExp(`(?:^|[^\\d.,])${AMOUNT}\\s*(?:-|–|—|~|den|toi|->|=>)\\s*(\\d{1,3}(?:[.,]\\d{1,2})?)\\s*${UNIT}\\s*(\\d{1,3})?`, 'g');
  // 3.500.000 - 5.000.000đ
  const RANGE_VND_RE = /(\d{1,3}(?:[.,]\d{3}){2})\s*(?:d|vnd|dong)?\s*(?:-|–|—|~|den|toi)\s*(\d{1,3}(?:[.,]\d{3}){2})/g;
  const SALE_PHRASES = [
    [/\bgia\s*(?:chi\s*)?tu\b|\bgia\s*dao\s*dong\b|\bdao\s*dong\s*tu\b|\bchi\s*tu\s*\d|\btu\s*\d{1,3}(?:[.,]\d{1,2})?\s*(?:trieu|tr|cu)(?![a-z])/, 'có "giá từ"'],
    [/\bnhieu\s*(?:phong|can|loai\s*phong|khu\s*vuc|quan|muc\s*gia|dien\s*tich|chi\s*nhanh|co\s*so|toa)\b|\bcon\s*nhieu\s*phong\b|\bda\s*dang\s*(?:phong|loai\s*phong|muc\s*gia|gia|dien\s*tich)\b/, 'nhiều phòng / nhiều khu vực'],
    [/\bhe\s*thong\s*(?:phong|can\s*ho|chdv|nha\s*tro|toa\s*nha|ccmn)\b|\bchuoi\s*(?:phong|can\s*ho|chdv)\b/, 'hệ thống / chuỗi phòng'],
    [/\bho\s*tro\s*(?:tim|xem|dan\s*di\s*xem)\s*phong\b|\bdan\s*(?:di\s*)?xem\s*phong\b|\b(?:tim|xem)\s*phong\s*(?:mien\s*phi|free)\b|\bfree\s*(?:tim|xem)\s*phong\b|\blist\s*phong\b|\bgio\s*hang\b|\bky\s*gui\b/, 'nhận tìm / dẫn xem phòng'],
    [/\bsale\b/, 'có chữ "sale"'],
  ];

  function fmtM(v) {
    return String(Math.round(v * 100) / 100).replace('.', ',');
  }

  // Trả về danh sách lý do nếu tin giống tin của "sale trọ" (người dẫn khách, đăng
  // một tin cho nhiều phòng với khoảng giá), rỗng nếu là tin bình thường.
  function saleReasons(ad) {
    const text = adText(ad);
    const reasons = [];
    for (const m of text.matchAll(RANGE_RE)) {
      const a = millions(m[1], m[2]);
      const b = millions(m[3], m[4]);
      if (a != null && b != null && a > 0 && a < b && b <= 100 && b - a >= 0.3) {
        reasons.push(`khoảng giá ${fmtM(a)} – ${fmtM(b)} triệu`);
        break;
      }
    }
    if (!reasons.length) {
      for (const m of text.matchAll(RANGE_VND_RE)) {
        const a = Number(m[1].replace(/[.,]/g, ''));
        const b = Number(m[2].replace(/[.,]/g, ''));
        if (a >= 300000 && a < b && b <= 1e8) {
          reasons.push(`khoảng giá ${fmtM(a / 1e6)} – ${fmtM(b / 1e6)} triệu`);
          break;
        }
      }
    }
    for (const [re, label] of SALE_PHRASES) {
      if (re.test(text)) reasons.push(label);
    }
    return reasons;
  }

  // Lý do tin bị ẩn bởi bộ lọc loại trừ, hoặc null nếu tin được hiện.
  // marked: người dùng đã đánh dấu tin này "không phù hợp".
  function hiddenReason(ad, state, sale, marked) {
    if (marked && state.hidemarked !== '0') return { kind: 'marked', text: 'bạn đã đánh dấu tin này không phù hợp' };
    const miss = missingKeyword(ad, state.kw, state.kwmode);
    if (miss) return { kind: 'include', text: `không có từ khoá "${miss}"` };
    const kw = excludedKeyword(ad, state.nq);
    if (kw) return { kind: 'keyword', text: `có từ khoá loại trừ "${kw}"` };
    if (state.nosale === '1') {
      const r = sale || saleReasons(ad);
      if (r.length) return { kind: 'sale', text: 'tin sale trọ: ' + r.join(', ') };
    }
    return null;
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

  // Link Google Maps (Maps URLs, không cần API key). Có toạ độ thì ghim đúng điểm,
  // không thì tìm theo địa chỉ.
  function googleMapsUrl(lat, lng, address) {
    const q = lat != null && lng != null ? `${round6(lat)},${round6(lng)}` : String(address || '');
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
  }

  // Mở thẳng khung Street View tại điểm gần toạ độ nhất có ảnh đường phố.
  function streetViewUrl(lat, lng) {
    return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${round6(lat)},${round6(lng)}`;
  }

  function round6(v) {
    return Number(Number(v).toFixed(6));
  }

  // Khoảng cách (m) giữa hai điểm [lat, lng], và độ dài một đường gấp khúc.
  function meters(a, b) {
    const r = Math.PI / 180;
    const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2
      + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  function pathLength(path) {
    let m = 0;
    for (let i = 1; i < path.length; i++) m += meters(path[i - 1], path[i]);
    return m;
  }

  function formatDistance(m) {
    return m >= 1000 ? `${String(Math.round(m / 100) / 10).replace('.', ',')} km` : `${Math.round(m)} m`;
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
    wardsOfArea, locationSources, googleMapsUrl, streetViewUrl,
    meters, pathLength, formatDistance,
    postedRange, postedLabel,
    parseZones, formatZones, inPolygon, inZones, MAX_ZONES, MAX_ZONE_POINTS,
    splitKeywords, joinKeywords, missingKeyword, excludedKeyword, saleReasons, hiddenReason,
  };
});
