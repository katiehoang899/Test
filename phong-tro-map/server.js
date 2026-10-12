'use strict';

// Phòng trọ Map: hiển thị tin cho thuê phòng trọ của Nhà Tốt (nhatot.com / Chợ Tốt)
// dạng danh sách + bản đồ. Server này chỉ làm proxy tới API công khai của Chợ Tốt
// (gateway.chotot.com) để trình duyệt không bị chặn CORS, kèm cache và geocode.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3100;
const GATEWAY = (process.env.CHOTOT_GATEWAY || 'https://gateway.chotot.com').replace(/\/+$/, '');
const NOMINATIM = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (PhongTroMap; +https://github.com/katiehoang899/test)';

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
    body: typeof ad.body === 'string' ? ad.body.slice(0, 600) : '',
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

async function listRegions() {
  return cached('regions', 24 * 3600 * 1000, async () => {
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
    return [];
  });
}

function normalizeWards(data) {
  const list = Array.isArray(data) ? data : data.wards || data.data || data.results || [];
  return (Array.isArray(list) ? list : Object.values(list))
    .map((w) => ({ id: String(w.id ?? w.ward_id ?? w.ward), name: w.name || w.ward_name }))
    .filter((w) => w.id !== 'undefined' && w.name);
}

async function listWards(area) {
  if (!/^\d{1,10}$/.test(area || '')) return [];
  return cached('wards:' + area, 24 * 3600 * 1000, async () => {
    try {
      return normalizeWards(await getJson(`${GATEWAY}/v2/public/chapy-pro/wards?area=${area}`));
    } catch {
      return [];
    }
  });
}

// ---------- geocode (cho tin không có toạ độ) ----------

// Nominatim cho phép tối đa 1 request/giây, nên xếp hàng và lưu kết quả ra file.
const geoFile = path.join(DATA_DIR, 'geocode-cache.json');
let geoCache = null;
let geoQueue = Promise.resolve();
let geoSaveTimer = null;

function loadGeoCache() {
  if (geoCache) return geoCache;
  try { geoCache = JSON.parse(fs.readFileSync(geoFile, 'utf8')); } catch { geoCache = {}; }
  return geoCache;
}

function saveGeoCacheSoon() {
  clearTimeout(geoSaveTimer);
  geoSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(geoFile, JSON.stringify(geoCache));
    } catch { /* cache chỉ là phụ */ }
  }, 1000);
  geoSaveTimer.unref?.();
}

function geocode(q) {
  const key = String(q || '').trim().toLowerCase().slice(0, 200);
  if (!key) return Promise.resolve(null);
  const cache = loadGeoCache();
  if (key in cache) return Promise.resolve(cache[key]);
  const job = geoQueue.then(async () => {
    if (key in cache) return cache[key];
    const u = new URL(NOMINATIM + '/search');
    u.searchParams.set('q', key);
    u.searchParams.set('format', 'json');
    u.searchParams.set('limit', '1');
    u.searchParams.set('countrycodes', 'vn');
    let result = null;
    try {
      const data = await getJson(u.toString());
      const hit = Array.isArray(data) && data[0];
      if (hit && validLatLng(num(hit.lat), num(hit.lon))) result = { lat: num(hit.lat), lng: num(hit.lon) };
      cache[key] = result;
      saveGeoCacheSoon();
    } catch { /* lỗi mạng: không cache, lần sau thử lại */ }
    if (!process.env.NOMINATIM_URL) await new Promise((r) => setTimeout(r, 1100));
    return result;
  });
  geoQueue = job.catch(() => null);
  return job;
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (u.pathname === '/api/ads') return sendJson(res, 200, await listAds(u.searchParams));
      if (u.pathname === '/api/regions') return sendJson(res, 200, { regions: await listRegions() });
      if (u.pathname === '/api/wards') return sendJson(res, 200, { wards: await listWards(u.searchParams.get('area')) });
      if (u.pathname === '/api/geocode') return sendJson(res, 200, { result: await geocode(u.searchParams.get('q')) });
      return serveStatic(u.pathname, res);
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message || 'Lỗi không xác định' });
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`Phòng trọ Map: http://localhost:${PORT}`);
  });
}

module.exports = { createServer, buildListingUrl, normalizeAd, normalizeRegions, normalizeWards };
