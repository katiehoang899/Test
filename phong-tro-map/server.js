'use strict';

// Phòng trọ Map: hiển thị tin cho thuê phòng trọ của Nhà Tốt (nhatot.com / Chợ Tốt)
// dạng danh sách + bản đồ. Server này chỉ làm proxy tới API công khai của Chợ Tốt
// (gateway.chotot.com) để trình duyệt không bị chặn CORS, kèm cache và geocode.

const http = require('node:http');
const crypto = require('node:crypto');
const Filters = require('./public/filters.js');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3100;
const GATEWAY = (process.env.CHOTOT_GATEWAY || 'https://gateway.chotot.com').replace(/\/+$/, '');
const NOMINATIM = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
// Dịch vụ chỉ đường OSRM (miễn phí) để vẽ đoạn ngập A–B bám theo đường phố.
const OSRM = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
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

// ---------- tiện ích ----------

function toRad(d) { return (d * Math.PI) / 180; }

// Khoảng cách (m) giữa hai điểm { lat, lng }.
function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body quá lớn'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- tin yêu thích / tin đã ẩn ----------

// Lưu trong DATA_DIR/saved.json, kèm bản chụp nội dung tin để vẫn xem được khi tin đã
// bị gỡ khỏi Nhà Tốt: { fav: { id: { ad, at } }, hidden: { id: { ad, at } } }.
const savedFile = path.join(DATA_DIR, 'saved.json');
const SAVED_KINDS = ['fav', 'hidden'];
const SAVED_MAX = 3000;
let savedCache = null;

function loadSaved() {
  if (savedCache) return savedCache;
  try { savedCache = JSON.parse(fs.readFileSync(savedFile, 'utf8')); } catch { savedCache = {}; }
  for (const k of SAVED_KINDS) if (!savedCache[k] || typeof savedCache[k] !== 'object') savedCache[k] = {};
  return savedCache;
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
    type: ad.type === 'h' ? 'h' : 'u',
    phones: Array.isArray(ad.phones) ? ad.phones.map(Filters.normalizePhone).filter(Boolean).slice(0, 3) : [],
    url: url.startsWith('https://www.nhatot.com/') ? url : `https://www.nhatot.com/${encodeURIComponent(id)}.htm`,
  };
}

async function updateSaved(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) {
    throw Object.assign(new Error('Cần Content-Type: application/json'), { status: 415 });
  }
  let body;
  try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { throw Object.assign(new Error('JSON không hợp lệ'), { status: 400 }); }
  const { kind, op } = body;
  const id = String(body.id ?? '');
  if (!SAVED_KINDS.includes(kind) || !['add', 'remove', 'clear'].includes(op)) {
    throw Object.assign(new Error('Thao tác không hợp lệ'), { status: 400 });
  }
  if (op !== 'clear' && !/^\d{1,15}$/.test(id)) throw Object.assign(new Error('Mã tin không hợp lệ'), { status: 400 });
  const saved = loadSaved();
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(savedFile, JSON.stringify(saved));
  return saved;
}

// ---------- số điện thoại của tin ----------

// Danh sách tin không có số điện thoại, nên hỏi riêng API của Chợ Tốt (chỉ khi người dùng
// bấm "Hiện SĐT"). Không có thì tìm số trong nội dung đầy đủ của tin.
async function adPhone(id) {
  if (!/^\d{1,15}$/.test(id || '')) throw Object.assign(new Error('Mã tin không hợp lệ'), { status: 400 });
  return cached('phone:' + id, 24 * 3600 * 1000, async () => {
    const urls = [
      `${GATEWAY}/v1/public/ad-listing/phone?list_id=${id}`,
      `${GATEWAY}/v1/public/ad-listing/${id}`,
    ];
    let reached = false;
    for (const url of urls) {
      let data;
      try { data = await getJson(url); } catch { continue; }
      reached = true;
      const ad = data.ad || data.data || {};
      const direct = Filters.normalizePhone(data.phone ?? ad.phone ?? ad.phone_number ?? ad.contact_phone);
      if (direct) return { phone: direct };
      const inText = Filters.extractPhones([ad.subject, ad.body].join('\n'));
      if (inText.length) return { phone: inText[0], fromText: true };
    }
    if (!reached) throw Object.assign(new Error('Không kết nối được Chợ Tốt'), { status: 502 });
    return { phone: null };
  });
}

// ---------- lớp bản đồ do người dùng thêm (điểm ngập, chỗ đỗ xe hơi) ----------

// Mỗi lớp lưu trong DATA_DIR/<tên lớp>.json: [{ id, type: 'point' | 'line', level,
// coords: [lat, lng] (điểm) hoặc path: [[lat, lng], …] (đoạn A–B), note, at }].
// level là mức độ ngập, hoặc loại chỗ đỗ xe.
const USER_LAYERS = {
  floods: { levels: ['frequent', 'medium', 'light', 'unknown'], what: 'điểm ngập' },
  parking: { levels: ['free', 'paid', 'limited', 'unknown'], what: 'điểm đỗ xe' },
};
const USER_LAYER_MAX = 2000;
const userLayerCache = {};

function loadUserLayer(name) {
  if (userLayerCache[name]) return userLayerCache[name];
  let items;
  try { items = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8')); } catch { items = []; }
  userLayerCache[name] = Array.isArray(items) ? items : [];
  return userLayerCache[name];
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

async function updateUserLayer(name, req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) {
    throw Object.assign(new Error('Cần Content-Type: application/json'), { status: 415 });
  }
  let body;
  try { body = JSON.parse(await readBody(req, 512 * 1024)); } catch { throw badRequest('JSON không hợp lệ'); }
  const { levels, what } = USER_LAYERS[name];
  const items = loadUserLayer(name);
  const level = levels.includes(body.level) ? body.level : 'unknown';
  const note = str(body.note, 300).trim();
  if (body.op === 'add') {
    if (items.length >= USER_LAYER_MAX) throw badRequest(`Đã đủ số ${what} tối đa`);
    const item = { id: crypto.randomUUID(), type: body.type === 'line' ? 'line' : 'point', level, note, at: Date.now() };
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
  } else {
    throw badRequest('Thao tác không hợp lệ');
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(items));
  return items;
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
      if (u.pathname === '/api/saved' && req.method === 'POST') return sendJson(res, 200, await updateSaved(req));
      // /api/floods, /api/parking: lớp điểm ngập / chỗ đỗ xe hơi do người dùng thêm.
      const layer = /^\/api\/(floods|parking)$/.exec(u.pathname)?.[1];
      if (layer && req.method === 'POST') return sendJson(res, 200, { [layer]: await updateUserLayer(layer, req) });
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (u.pathname === '/api/saved') return sendJson(res, 200, loadSaved());
      if (layer) return sendJson(res, 200, { [layer]: loadUserLayer(layer) });
      if (u.pathname === '/api/route') return sendJson(res, 200, await route(u.searchParams.get('from'), u.searchParams.get('to')));
      if (u.pathname === '/api/phone') return sendJson(res, 200, await adPhone(u.searchParams.get('id')));
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
  // Mặc định chỉ nghe trên máy này (localhost). HOST=0.0.0.0 để máy khác trong mạng LAN mở được.
  const HOST = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Cổng ${PORT} đang được dùng (có thể Phòng trọ Map đã chạy rồi: mở http://localhost:${PORT}).`);
      console.error(`Muốn chạy ở cổng khác: PORT=3200 npm start`);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Phòng trọ Map đang chạy: http://localhost:${PORT}`);
    console.log('Nhấn Ctrl+C (hoặc đóng cửa sổ này) để tắt.');
  });
}

module.exports = { createServer, buildListingUrl, normalizeAd, normalizeRegions, normalizeWards, distance };
