'use strict';

// Lõi API của RentMAPs, chạy được cả trên Node (server.js, lưu file trong data/) và trên
// Cloudflare Pages Functions (functions/, lưu trong Cloudflare KV). Không dùng module riêng của
// Node: chỉ fetch, URL, crypto.randomUUID có sẵn ở cả hai nơi.
//
//   const api = createApi({ store, gateway, nominatim, osrm, overpass, geoDelay });
//   const res = await api.handle(method, url, contentType, readText); // { status, body, pretty? } | null
//
// store: { get(key) → giá trị (undefined nếu chưa có), put(key, value) } — khoá: saved, floods,
// parking, geo:<địa chỉ>.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RentApi = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const UA = 'Mozilla/5.0 (RentMAPs; +https://github.com/katiehoang899/test)';

function createApi(opts = {}) {
  const GATEWAY = (opts.gateway || 'https://gateway.chotot.com').replace(/\/+$/, '');
  const NOMINATIM = (opts.nominatim || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
  // Dịch vụ chỉ đường OSRM (miễn phí) để vẽ đoạn ngập A–B bám theo đường phố.
  const OSRM = (opts.osrm || 'https://router.project-osrm.org').replace(/\/+$/, '');
  // Overpass API: lấy công trình (bệnh viện, trường học…) từ OpenStreetMap. Máy chủ chính hay bận
  // nên có máy chủ dự phòng.
  const OVERPASS = opts.overpass ? [].concat(opts.overpass) : ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const GEO_DELAY = opts.geoDelay !== false; // 1 request/giây theo chính sách Nominatim
  const store = opts.store || memoryStore();

  // Danh mục "Phòng trọ" trên Nhà Tốt.
  const CATEGORY_ROOM = '1050';
  const MAX_LIMIT = 50;

  // Tham số lọc được chuyển thẳng lên API (giống tham số trên URL của nhatot.com).
  //   region_v2 / area_v2 / ward : tỉnh-thành / quận-huyện / phường-xã
  //   price=min-max (đồng), size=min-max (m²)
  //   furnishing_rent=1,2 : tình trạng nội thất
  //   f=p (cá nhân) | f=c (môi giới / chuyên trang)
  //   st=u,h : u = cho thuê, h = cần thuê
  //   sp : sắp xếp, q : từ khoá
  const PASS_PARAMS = ['region_v2', 'area_v2', 'ward', 'price', 'size', 'furnishing_rent', 'f', 'st', 'sp', 'q'];

  const FURNISHING = { 1: 'Nội thất cao cấp', 2: 'Nội thất đầy đủ', 3: 'Nhà trống', 4: 'Nội thất cơ bản' };

  // ---------- cache nhỏ trong bộ nhớ ----------

  const memo = new Map();
  async function cached(key, ttlMs, fn) {
    const hit = memo.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = await fn();
    memo.set(key, { value, until: Date.now() + ttlMs });
    if (memo.size > 2000) memo.delete(memo.keys().next().value);
    return value;
  }

  async function getJson(url) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'vi' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw Object.assign(new Error(`Upstream ${res.status} for ${url}`), { status: 502 });
    return res.json();
  }

  // ---------- tin đăng ----------

  function buildListingUrl(query) {
    const u = new URL(GATEWAY + '/v1/public/ad-listing');
    u.searchParams.set('cg', CATEGORY_ROOM);
    for (const key of PASS_PARAMS) {
      const v = query.get(key);
      if (v != null && v !== '') u.searchParams.set(key, String(v).slice(0, 200));
    }
    if (!u.searchParams.has('st')) u.searchParams.set('st', 'u,h');
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.get('limit'), 10) || 20));
    const offset = Math.max(0, parseInt(query.get('o'), 10) || 0);
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('o', String(offset));
    u.searchParams.set('page', String(Math.floor(offset / limit) + 1));
    u.searchParams.set('key_param_included', 'true');
    return u.toString();
  }

  function num(v) {
    const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
    return Number.isFinite(n) ? n : null;
  }

  function validLatLng(lat, lng) {
    // Khung bao quanh Việt Nam (kể cả Hoàng Sa, Trường Sa).
    return lat != null && lng != null && lat > 6 && lat < 24 && lng > 100 && lng < 118;
  }

  function normalizeAd(ad) {
    const lat = num(ad.latitude ?? ad.lat);
    const lng = num(ad.longitude ?? ad.lng ?? ad.long);
    const images = Array.isArray(ad.images) ? ad.images.filter((x) => typeof x === 'string') : [];
    const thumb = ad.thumbnail_image || ad.image || images[0] || null;
    const listId = ad.list_id ?? ad.ad_id;
    const furnishing = num(ad.furnishing_rent);
    const parts = [ad.street_name, ad.ward_name, ad.area_name, ad.region_name].filter(Boolean);
    return {
      id: String(listId),
      title: ad.subject || '',
      body: typeof ad.body === 'string' ? ad.body.slice(0, 4000) : '', // đủ dài để lọc từ khoá / tin sale
      price: num(ad.price),
      priceText: ad.price_string || null,
      size: num(ad.size),
      deposit: num(ad.deposit),
      furnishing,
      furnishingText: furnishing != null ? FURNISHING[furnishing] || null : null,
      regionId: ad.region_v2 ?? ad.region ?? null,
      region: ad.region_name || '',
      areaId: ad.area_v2 ?? ad.area ?? null,
      area: ad.area_name || '',
      wardId: ad.ward ?? null,
      ward: ad.ward_name || '',
      street: ad.street_name || '',
      address: ad.address || parts.join(', '),
      lat: validLatLng(lat, lng) ? lat : null,
      lng: validLatLng(lat, lng) ? lng : null,
      thumb,
      images: images.slice(0, 8),
      imageCount: num(ad.number_of_images) ?? images.length,
      hasVideo: Boolean(ad.videos?.length || ad.video),
      time: num(ad.list_time),
      date: ad.date || '',
      seller: ad.account_name || ad.full_name || '',
      sellerOid: OID_RE.test(String(ad.account_oid || '')) ? String(ad.account_oid) : null,
      sellerId: /^\d{1,15}$/.test(String(ad.account_id ?? '')) ? String(ad.account_id) : null,
      isCompany: Boolean(ad.company_ad),
      type: ad.type || null,
      url: `https://www.nhatot.com/${encodeURIComponent(String(listId))}.htm`,
    };
  }

  async function listAds(query) {
    const url = buildListingUrl(query);
    return cached('ads:' + url, 60 * 1000, async () => {
      const data = await getJson(url);
      const ads = Array.isArray(data.ads) ? data.ads.map(normalizeAd) : [];
      return { total: num(data.total) ?? ads.length, ads };
    });
  }

  // ---------- khu vực ----------

  // API khu vực của Chợ Tốt từng đổi định dạng vài lần, nên đọc "mềm": tìm mọi object
  // có id + name, các quận/huyện nằm trong khoá area / areas.
  function normalizeRegions(data) {
    const out = [];
    const seen = new Set();
    const toList = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);
    const pickName = (o) => o.name || o.name_vi || o.label || o.region_name || o.area_name;
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 8) return;
      for (const item of toList(node)) {
        if (!item || typeof item !== 'object') continue;
        const id = item.id ?? item.region_v2 ?? item.region_id;
        const areasRaw = item.area ?? item.areas;
        if (id != null && pickName(item) && areasRaw) {
          if (seen.has(String(id))) continue;
          seen.add(String(id));
          const areas = toList(areasRaw)
            .map((a) => ({ id: String(a.id ?? a.area_v2 ?? a.area_id), name: pickName(a) }))
            .filter((a) => a.id !== 'undefined' && a.name);
          out.push({ id: String(id), name: pickName(item), areas });
        } else {
          walk(item, depth + 1);
        }
      }
    };
    walk(data, 0);
    return out;
  }

  // Lỗi mạng / không có dữ liệu thì trả [] nhưng không ghi nhớ (lần sau hỏi lại), chỉ nhớ kết quả có dữ liệu.
  async function listRegions() {
    try {
      return await cached('regions', 24 * 3600 * 1000, async () => {
        const urls = [
          GATEWAY + '/v2/public/chapy-pro/regions',
          GATEWAY + '/v1/public/web-proxy-api/loadRegions',
        ];
        for (const url of urls) {
          try {
            const regions = normalizeRegions(await getJson(url));
            if (regions.length) return regions.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
          } catch { /* thử URL kế tiếp */ }
        }
        throw new Error('Chưa lấy được danh sách khu vực');
      });
    } catch {
      return [];
    }
  }

  function normalizeWards(data) {
    const list = Array.isArray(data) ? data : data.wards || data.data || data.results || [];
    return (Array.isArray(list) ? list : Object.values(list))
      .map((w) => ({ id: String(w.id ?? w.ward_id ?? w.ward), name: w.name || w.ward_name }))
      .filter((w) => w.id !== 'undefined' && w.name);
  }

  async function listWards(area) {
    if (!/^\d{1,10}$/.test(area || '')) return [];
    try {
      return await cached('wards:' + area, 24 * 3600 * 1000, async () => {
        const wards = normalizeWards(await getJson(`${GATEWAY}/v2/public/chapy-pro/wards?area=${area}`));
        if (!wards.length) throw new Error('Chưa lấy được danh sách phường');
        return wards;
      });
    } catch {
      return [];
    }
  }

  // ---------- geocode (cho tin không có toạ độ) ----------

  // Nominatim cho phép tối đa 1 request/giây, nên xếp hàng; kết quả lưu vào store (geo:<địa chỉ>).
  let geoQueue = Promise.resolve();

  async function geocode(q) {
    const key = String(q || '').trim().toLowerCase().slice(0, 200);
    if (!key) return null;
    const hit = await store.get('geo:' + key);
    if (hit !== undefined) return hit;
    const job = geoQueue.then(async () => {
      const again = await store.get('geo:' + key);
      if (again !== undefined) return again;
      const u = new URL(NOMINATIM + '/search');
      u.searchParams.set('q', key);
      u.searchParams.set('format', 'json');
      u.searchParams.set('limit', '1');
      u.searchParams.set('countrycodes', 'vn');
      let result = null;
      try {
        const data = await getJson(u.toString());
        const first = Array.isArray(data) && data[0];
        if (first && validLatLng(num(first.lat), num(first.lon))) result = { lat: num(first.lat), lng: num(first.lon) };
        await store.put('geo:' + key, result);
      } catch { /* lỗi mạng: không lưu, lần sau thử lại */ }
      if (GEO_DELAY) await new Promise((r) => setTimeout(r, 1100));
      return result;
    });
    geoQueue = job.catch(() => null);
    return job;
  }

  // ---------- tiện ích ----------

  function toRad(d) { return (d * Math.PI) / 180; }

  // Khoảng cách (m) giữa hai điểm { lat, lng }.
  function distance(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  // ---------- tin yêu thích / tin đã ẩn ----------

  // Lưu trong store, khoá "saved", kèm bản chụp nội dung tin để vẫn xem được khi tin đã
  // bị gỡ khỏi Nhà Tốt: { fav: { id: { ad, at } }, hidden: { id: { ad, at } } }.
  const SAVED_KINDS = ['fav', 'hidden'];
  const SAVED_MAX = 3000;

  async function loadSaved() {
    let saved = await store.get('saved');
    if (!saved || typeof saved !== 'object') saved = {};
    for (const k of SAVED_KINDS) if (!saved[k] || typeof saved[k] !== 'object') saved[k] = {};
    return saved;
  }

  function str(v, max = 300) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  function finite(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  // Chỉ giữ các trường đã biết, đúng kiểu, độ dài có giới hạn.
  function snapshotAd(ad, id) {
    const lat = finite(ad.lat);
    const lng = finite(ad.lng);
    const ax = ad.approxAt && finite(ad.approxAt.lat) != null && finite(ad.approxAt.lng) != null
      && validLatLng(ad.approxAt.lat, ad.approxAt.lng) ? { lat: ad.approxAt.lat, lng: ad.approxAt.lng } : null;
    const url = str(ad.url, 200);
    const thumb = str(ad.thumb, 500);
    return {
      id,
      title: str(ad.title, 300),
      price: finite(ad.price),
      priceText: str(ad.priceText, 60) || null,
      size: finite(ad.size),
      deposit: finite(ad.deposit),
      furnishingText: str(ad.furnishingText, 60) || null,
      region: str(ad.region, 100),
      area: str(ad.area, 100),
      ward: str(ad.ward, 100),
      street: str(ad.street, 200),
      address: str(ad.address, 400),
      lat: validLatLng(lat, lng) ? lat : null,
      lng: validLatLng(lat, lng) ? lng : null,
      approxAt: ax,
      approx: Boolean(ax) && !validLatLng(lat, lng),
      thumb: /^https:\/\//.test(thumb) ? thumb : null,
      imageCount: finite(ad.imageCount),
      date: str(ad.date, 60),
      time: finite(ad.time),
      isCompany: Boolean(ad.isCompany),
      seller: str(ad.seller, 100),
      sellerOid: OID_RE.test(String(ad.sellerOid || '')) ? String(ad.sellerOid) : null,
      sellerId: /^\d{1,15}$/.test(String(ad.sellerId ?? '')) ? String(ad.sellerId) : null,
      type: ad.type === 'h' ? 'h' : 'u',
      url: url.startsWith('https://www.nhatot.com/') ? url : `https://www.nhatot.com/${encodeURIComponent(id)}.htm`,
    };
  }

  async function updateSaved(body) {
    const { kind, op } = body;
    const id = String(body.id ?? '');
    if (!SAVED_KINDS.includes(kind) || !['add', 'remove', 'clear'].includes(op)) {
      throw Object.assign(new Error('Thao tác không hợp lệ'), { status: 400 });
    }
    if (op !== 'clear' && !/^\d{1,15}$/.test(id)) throw Object.assign(new Error('Mã tin không hợp lệ'), { status: 400 });
    const saved = await loadSaved();
    const list = saved[kind];
    if (op === 'clear') saved[kind] = {};
    else if (op === 'remove') delete list[id];
    else {
      list[id] = { ad: snapshotAd(body.ad && typeof body.ad === 'object' ? body.ad : {}, id), at: Date.now() };
      const ids = Object.keys(list);
      if (ids.length > SAVED_MAX) {
        ids.sort((a, b) => list[a].at - list[b].at).slice(0, ids.length - SAVED_MAX).forEach((x) => delete list[x]);
      }
    }
    await store.put('saved', saved);
    return saved;
  }

  // ---------- chi tiết tin: đủ ảnh + mô tả đầy đủ ----------

  // Danh sách tin thường chỉ có ảnh đầu (và có thể cắt ngắn mô tả): lấy từ trang chi tiết tin
  // khi mở popup xem ảnh / xem mô tả.
  async function adDetail(id) {
    if (!/^\d{1,15}$/.test(String(id || ''))) throw badRequest('Mã tin không hợp lệ');
    return cached('detail:' + id, 3600 * 1000, async () => {
      const data = await getJson(`${GATEWAY}/v1/public/ad-listing/${id}`);
      const ad = data.ad || data.data || {};
      const list = (Array.isArray(ad.images) ? ad.images : [ad.image])
        .map((x) => (typeof x === 'string' ? x : x?.url || x?.image))
        .filter((u) => /^https:\/\//.test(String(u || '')));
      return {
        images: [...new Set(list)].slice(0, 30),
        body: typeof ad.body === 'string' ? ad.body.slice(0, 10000) : '',
      };
    });
  }

  // ---------- người đăng tin ----------

  // Mã tài khoản Chợ Tốt (account_oid) của người đăng.
  const OID_RE = /^[A-Za-z0-9_-]{4,64}$/;

  // API hồ sơ của Chợ Tốt không có tài liệu, tên trường có thể khác nhau / đổi theo thời gian:
  // tìm theo nhiều tên quen thuộc, duyệt sâu vào các object con (tối đa 4 tầng).
  function deepPick(obj, names, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
    const want = new Set(names.map((n) => n.toLowerCase().replace(/_/g, '')));
    for (const [k, v] of Object.entries(obj)) {
      if (want.has(k.toLowerCase().replace(/_/g, '')) && v != null && v !== '' && typeof v !== 'object') return v;
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const found = deepPick(v, names, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  // Giây / mili giây / chuỗi ngày → mili giây.
  function toMs(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }

  // Tên trường có thể có (API không có tài liệu): thêm vào đây khi biết tên thật.
  const SELLER_FIELDS = {
    name: ['full_name', 'account_name', 'display_name', 'shop_name', 'name'],
    avatar: ['avatar', 'avatar_url', 'avatar_image', 'profile_image'],
    joined: ['create_time', 'created_time', 'created_at', 'start_time', 'join_time', 'joined_at', 'joined_date', 'register_time',
      'registered_at', 'member_since', 'createdAt'],
  };

  function normalizeSeller(key, profile) {
    const p = profile || {};
    const joinedAt = toMs(deepPick(p, SELLER_FIELDS.joined));
    const avatar = String(deepPick(p, SELLER_FIELDS.avatar) || '');
    return {
      name: str(deepPick(p, SELLER_FIELDS.name) || '', 100),
      avatar: /^https:\/\//.test(avatar) ? str(avatar, 500) : null,
      joinedAt: joinedAt && joinedAt < Date.now() ? joinedAt : null,
      url: key.oid ? `https://www.chotot.com/user/${encodeURIComponent(key.oid)}` : null,
    };
  }

  // key: { oid } hoặc { id } (account_oid / account_id của Chợ Tốt).
  function sellerKey(oid, id) {
    if (oid != null && oid !== '') {
      if (!OID_RE.test(String(oid))) throw badRequest('Mã người đăng không hợp lệ');
      return { oid: String(oid) };
    }
    if (!/^\d{1,15}$/.test(String(id ?? ''))) throw badRequest('Mã người đăng không hợp lệ');
    return { id: String(id) };
  }

  // Hồ sơ người đăng (/v1/public/profile): tên, ảnh đại diện, thời gian tham gia Nhà Tốt.
  async function seller(oid, id) {
    const key = sellerKey(oid, id);
    const ref = key.oid || key.id;
    const profile = await cached('seller:' + ref, 15 * 60 * 1000, () => getJson(`${GATEWAY}/v1/public/profile/${encodeURIComponent(ref)}`));
    return normalizeSeller(key, profile);
  }

  // Trang kiểm tra (mở bằng trình duyệt): dữ liệu gốc Chợ Tốt trả về về người đăng của một tin,
  // để biết đúng tên trường khi ảnh đại diện / thời gian tham gia không hiện. /api/debug/seller?ad=<mã tin>
  async function sellerDebug(adId) {
    if (!/^\d{1,15}$/.test(String(adId || ''))) throw badRequest('Mã tin không hợp lệ (là dãy số trong link tin trên Nhà Tốt)');
    const probe = async (url) => {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        const text = await res.text();
        return { url: url.replace(GATEWAY, ''), status: res.status, body: text.length > 4000 ? text.slice(0, 4000) + '…' : text };
      } catch (err) {
        return { url: url.replace(GATEWAY, ''), error: err.message };
      }
    };
    const detail = await probe(`${GATEWAY}/v1/public/ad-listing/${adId}`);
    let ad = {};
    try { const d = JSON.parse(detail.body); ad = d.ad || d.data || {}; } catch { /* để nguyên */ }
    const related = {};
    for (const [k, v] of Object.entries(ad)) {
      if (/account|seller|shop|owner|name|avatar|join|since|create/i.test(k)) related[k] = v;
    }
    const tries = [ad.account_oid, ad.account_id].filter((x) => x != null && x !== '').map((x) => `${GATEWAY}/v1/public/profile/${encodeURIComponent(x)}`);
    return {
      note: 'Copy toàn bộ trang này gửi lại để chỉnh phần thông tin người đăng.',
      ad: adId,
      detail: { status: detail.status, error: detail.error, keys: Object.keys(ad), seller: related },
      probes: await Promise.all(tries.map(probe)),
    };
  }

  // ---------- lớp bản đồ do người dùng thêm (điểm ngập, chỗ đỗ xe hơi) ----------

  // Mỗi lớp lưu trong store, khoá là tên lớp: [{ id, type: 'point' | 'line', level,
  // coords: [lat, lng] (điểm) hoặc path: [[lat, lng], …] (đoạn A–B), note, at }].
  // level là mức độ ngập, hoặc loại chỗ đỗ xe.
  const USER_LAYERS = {
    floods: { levels: ['frequent', 'medium', 'light', 'unknown'], what: 'điểm ngập' },
    parking: { levels: ['free', 'paid', 'limited', 'unknown'], what: 'điểm đỗ xe' },
  };
  const USER_LAYER_MAX = 2000;
  async function loadUserLayer(name) {
    const items = await store.get(name);
    return Array.isArray(items) ? items : [];
  }

  function cleanLatLng(p) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lat = finite(p[0]);
    const lng = finite(p[1]);
    return validLatLng(lat, lng) ? [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6] : null;
  }

  function badRequest(msg) {
    return Object.assign(new Error(msg), { status: 400 });
  }

  // Một điểm / đoạn từ file sao lưu: kiểm tra như khi thêm mới. null nếu không hợp lệ.
  function cleanImportedItem(raw, levels) {
    if (!raw || typeof raw !== 'object') return null;
    const item = {
      id: /^[\w-]{8,64}$/.test(String(raw.id || '')) ? String(raw.id) : globalThis.crypto.randomUUID(),
      type: raw.type === 'line' ? 'line' : 'point',
      level: levels.includes(raw.level) ? raw.level : 'unknown',
      note: str(raw.note, 300).trim(),
      at: finite(raw.at) && raw.at > 0 && raw.at <= Date.now() + 86400000 ? raw.at : Date.now(),
    };
    if (item.type === 'point') {
      item.coords = cleanLatLng(raw.coords);
      if (!item.coords) return null;
    } else {
      const pts = Array.isArray(raw.path) ? raw.path.slice(0, 5000).map(cleanLatLng) : [];
      if (pts.length < 2 || pts.some((p) => !p)) return null;
      item.path = pts;
      item.routed = Boolean(raw.routed);
    }
    return item;
  }

  // Trả về { items, imported?, skipped? }.
  async function updateUserLayer(name, body) {
    const { levels, what } = USER_LAYERS[name];
    let items = await loadUserLayer(name);
    const result = {};
    const level = levels.includes(body.level) ? body.level : 'unknown';
    const note = str(body.note, 300).trim();
    if (body.op === 'add') {
      if (items.length >= USER_LAYER_MAX) throw badRequest(`Đã đủ số ${what} tối đa`);
      const item = { id: globalThis.crypto.randomUUID(), type: body.type === 'line' ? 'line' : 'point', level, note, at: Date.now() };
      if (item.type === 'point') {
        item.coords = cleanLatLng(body.coords);
        if (!item.coords) throw badRequest('Toạ độ không hợp lệ');
      } else {
        const pts = Array.isArray(body.path) ? body.path.slice(0, 5000).map(cleanLatLng) : [];
        if (pts.length < 2 || pts.some((p) => !p)) throw badRequest('Đoạn A–B không hợp lệ');
        item.path = pts;
        item.routed = Boolean(body.routed);
      }
      items.push(item);
    } else if (body.op === 'update' || body.op === 'remove') {
      const i = items.findIndex((f) => f.id === body.id);
      if (i < 0) throw Object.assign(new Error(`Không tìm thấy ${what}`), { status: 404 });
      if (body.op === 'remove') items.splice(i, 1);
      else {
        if (levels.includes(body.level)) items[i].level = body.level;
        if (typeof body.note === 'string') items[i].note = note;
      }
    } else if (body.op === 'import') {
      // Mở file sao lưu: mode 'replace' thay toàn bộ danh sách, 'merge' gộp theo id (điểm đã có
      // thì cập nhật theo file, điểm mới thì thêm).
      if (!Array.isArray(body.items)) throw badRequest('File không có danh sách điểm');
      const clean = body.items.map((x) => cleanImportedItem(x, levels)).filter(Boolean);
      if (!clean.length && body.items.length) throw badRequest(`File không có ${what} hợp lệ`);
      const next = body.mode === 'replace' ? [] : items.slice();
      const at = new Map(next.map((f, i) => [f.id, i]));
      for (const item of clean) {
        if (at.has(item.id)) next[at.get(item.id)] = item;
        else if (next.length < USER_LAYER_MAX) { at.set(item.id, next.length); next.push(item); }
      }
      items = next;
      result.imported = clean.length;
      result.skipped = body.items.length - clean.length;
    } else {
      throw badRequest('Thao tác không hợp lệ');
    }
    await store.put(name, items);
    return { items, ...result };
  }

  // Đường đi A–B theo đường phố (OSRM). Không tìm được thì nối thẳng (routed: false).
  async function route(fromStr, toStr) {
    const a = cleanLatLng(String(fromStr || '').split(',').map(Number));
    const b = cleanLatLng(String(toStr || '').split(',').map(Number));
    if (!a || !b) throw badRequest('Toạ độ không hợp lệ');
    if (distance({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }) > 30000) throw badRequest('Hai điểm cách nhau quá xa (tối đa 30 km)');
    const straight = { path: [a, b], routed: false };
    return cached(`route:${a}:${b}`, 24 * 3600 * 1000, async () => {
      try {
        const url = `${OSRM}/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`;
        const data = await getJson(url);
        const coords = data.routes?.[0]?.geometry?.coordinates;
        if (data.code !== 'Ok' || !Array.isArray(coords) || coords.length < 2) return straight;
        const path = coords.map(([lng, lat]) => cleanLatLng([lat, lng])).filter(Boolean);
        // Nối đúng vào hai điểm người dùng bấm (OSRM bắt điểm vào đường gần nhất).
        return path.length >= 2 ? { path: [a, ...path, b], routed: true } : straight;
      } catch {
        return straight;
      }
    });
  }

  // ---------- công trình (OpenStreetMap / Overpass) ----------

  // Bản đồ chia thành ô 0,05° (~5,5 km). Trình duyệt hỏi theo ô để cache dùng lại được khi kéo bản đồ.
  const POI_CELL = 0.05;
  const POI_MAX = 4000;
  // [loại, khoá OSM, giá trị] — thứ tự là thứ tự ưu tiên khi một điểm có nhiều thẻ.
  const POI_TAGS = [
    ['hospital', 'amenity', ['hospital', 'clinic', 'doctors']],
    ['pharmacy', 'amenity', ['pharmacy']],
    ['school', 'amenity', ['school', 'kindergarten', 'college', 'university']],
    ['market', 'amenity', ['marketplace']],
    ['market', 'shop', ['supermarket', 'mall', 'department_store']],
    ['police', 'amenity', ['police']],
    ['bank', 'amenity', ['bank', 'atm']],
    ['bus', 'highway', ['bus_stop']],
    ['park', 'leisure', ['park', 'playground']],
  ];

  function poiCategory(tags = {}) {
    for (const [cat, key, values] of POI_TAGS) if (values.includes(tags[key])) return cat;
    return null;
  }

  function overpassQuery(s, w, n, e) {
    const bbox = `(${s},${w},${n},${e})`;
    const byKey = {};
    for (const [, key, values] of POI_TAGS) (byKey[key] ||= []).push(...values);
    const parts = Object.entries(byKey).map(([key, values]) => `nwr["${key}"~"^(${values.join('|')})$"]${bbox};`);
    return `[out:json][timeout:40];(${parts.join('')});out center;`;
  }

  function normalizePois(data) {
    const seen = new Set();
    const out = [];
    for (const el of data?.elements || []) {
      const cat = poiCategory(el.tags);
      const lat = Number(el.lat ?? el.center?.lat);
      const lng = Number(el.lon ?? el.center?.lon);
      const id = `${String(el.type || 'n')[0]}${el.id}`;
      if (!cat || !validLatLng(lat, lng) || seen.has(id)) continue;
      seen.add(id);
      const name = str(el.tags['name:vi'] || el.tags.name || el.tags.brand || el.tags.operator || '', 120);
      out.push({ id, cat, lat: +lat.toFixed(6), lng: +lng.toFixed(6), name });
      if (out.length >= POI_MAX) break;
    }
    return out;
  }

  // Overpass giới hạn số truy vấn cùng lúc mỗi máy: gửi lần lượt từng truy vấn.
  let overpassChain = Promise.resolve();
  function overpassSerial(fn) {
    const run = overpassChain.then(fn, fn);
    overpassChain = run.catch(() => {});
    return run;
  }

  async function fetchOverpass(query) {
    let last;
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(45000),
        });
        if (res.ok) return await res.json();
        last = new Error(`Overpass ${res.status}`);
      } catch (err) {
        last = err;
      }
    }
    throw Object.assign(new Error('Không tải được công trình từ OpenStreetMap (Overpass đang bận hoặc bị chặn). Thử lại sau.'), { status: 502, cause: last });
  }

  const poiInflight = new Map();
  function pois(cellStr) {
    const m = /^(-?\d{1,4}),(-?\d{1,4})$/.exec(String(cellStr || ''));
    const i = m && Number(m[1]);
    const j = m && Number(m[2]);
    if (!m || i < -1800 || i >= 1800 || j < -3600 || j >= 3600) throw badRequest('Ô bản đồ không hợp lệ');
    const key = `pois:${i},${j}`;
    if (poiInflight.has(key)) return poiInflight.get(key);
    const [s, w, n, e] = [i, j, i + 1, j + 1].map((k) => +(k * POI_CELL).toFixed(4));
    const p = cached(key, 24 * 3600 * 1000, async () => ({
      cell: `${i},${j}`,
      pois: normalizePois(await overpassSerial(() => fetchOverpass(overpassQuery(s, w, n, e)))),
    })).finally(() => poiInflight.delete(key));
    poiInflight.set(key, p);
    return p;
  }

  // ---------- định tuyến ----------

  const BODY_LIMIT = { saved: 64 * 1024, layer: 16 * 1024 * 1024 }; // file sao lưu điểm ngập có thể lớn

  async function readJson(contentType, readText, limit) {
    if (!String(contentType || '').startsWith('application/json')) {
      throw Object.assign(new Error('Cần Content-Type: application/json'), { status: 415 });
    }
    const text = await readText(limit);
    try { return JSON.parse(text); } catch { throw badRequest('JSON không hợp lệ'); }
  }

  const ok = (body) => ({ status: 200, body });

  // { status, body, pretty? } — pretty: trang kiểm tra, in JSON có xuống dòng cho dễ đọc / copy.
  // null nếu không phải đường dẫn /api/ (để bên ngoài trả file tĩnh).
  async function handle(method, url, contentType, readText) {
    const u = typeof url === 'string' ? new URL(url, 'http://localhost') : url;
    if (!u.pathname.startsWith('/api/')) return null;
    const q = u.searchParams;
    try {
      if (u.pathname === '/api/saved' && method === 'POST') return ok(await updateSaved(await readJson(contentType, readText, BODY_LIMIT.saved)));
      // /api/floods, /api/parking: lớp điểm ngập / chỗ đỗ xe hơi do người dùng thêm.
      const layer = /^\/api\/(floods|parking)$/.exec(u.pathname)?.[1];
      if (layer && method === 'POST') {
        const { items, ...stats } = await updateUserLayer(layer, await readJson(contentType, readText, BODY_LIMIT.layer));
        return ok({ [layer]: items, ...stats });
      }
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      if (u.pathname === '/api/saved') return ok(await loadSaved());
      if (layer) return ok({ [layer]: await loadUserLayer(layer) });
      if (u.pathname === '/api/detail') return ok(await adDetail(q.get('id')));
      if (u.pathname === '/api/seller') return ok(await seller(q.get('oid'), q.get('id')));
      if (u.pathname === '/api/debug/seller') return { ...ok(await sellerDebug(q.get('ad'))), pretty: true };
      if (u.pathname === '/api/pois') return ok(await pois(q.get('cell')));
      if (u.pathname === '/api/route') return ok(await route(q.get('from'), q.get('to')));
      if (u.pathname === '/api/ads') return ok(await listAds(q));
      if (u.pathname === '/api/regions') return ok({ regions: await listRegions() });
      if (u.pathname === '/api/wards') return ok({ wards: await listWards(q.get('area')) });
      if (u.pathname === '/api/geocode') return ok({ result: await geocode(q.get('q')) });
      return { status: 404, body: { error: 'Not found' } };
    } catch (err) {
      return { status: err.status || 500, body: { error: err.message || 'Lỗi không xác định' } };
    }
  }

  return { handle, buildListingUrl, normalizeAd, normalizeRegions, normalizeWards, distance, poiCategory, normalizePois, overpassQuery, normalizeSeller };
}

// Store tạm trong bộ nhớ (test / khi không có nơi lưu).
function memoryStore() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? structuredClone(m.get(key)) : undefined; },
    async put(key, value) { m.set(key, structuredClone(value)); },
  };
}

return { createApi, memoryStore, UA };
});
