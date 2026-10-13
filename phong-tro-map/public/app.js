'use strict';

/* global L, Filters */

const PAGE = 50; // số tin mỗi lần gọi API (tối đa của Chợ Tốt)
const LOAD_ALL_CAP = 5000; // "Tải tất cả" dừng ở đây để không gọi API quá nhiều
const RENDER_STEP = 60; // số thẻ tin thêm vào danh sách mỗi lần cuộn
const AUTO_FILL_MIN = 20; // bộ lọc loại trừ ẩn nhiều tin: tự tải thêm trang cho đủ số tin này…
const AUTO_FILL_PAGES = 8; // …nhưng không quá số trang này mỗi lần, sau đó chờ người dùng bấm "Xem thêm"
const LOCAL_ONLY = ['nq', 'nosale', 'hidemarked'];
const MAX_PARALLEL = 4; // chọn nhiều quận / phường: số nguồn tải song song mỗi lượt // bộ lọc chỉ chạy trên trình duyệt, đổi không cần gọi lại API

const $ = (s) => document.querySelector(s);
const el = {
  form: $('#filters'), q: $('#q'), searchForm: $('#searchForm'),
  st: $('#st'), region: $('#region'),
  areaPop: $('#areaPop'), wardPop: $('#wardPop'), areaOpts: $('#areaOpts'), wardOpts: $('#wardOpts'),
  areaLabel: $('#areaLabel'), wardLabel: $('#wardLabel'),
  f: $('#f'), sort: $('#sort'), reset: $('#reset'),
  priceMin: $('#priceMin'), priceMax: $('#priceMax'), sizeMin: $('#sizeMin'), sizeMax: $('#sizeMax'),
  priceLabel: $('#priceLabel'), sizeLabel: $('#sizeLabel'), postedLabel: $('#postedLabel'), furnLabel: $('#furnLabel'),
  count: $('#count'), list: $('#list'), loadAll: $('#loadAll'), inBounds: $('#inBounds'), approx: $('#approx'),
  nqLabel: $('#nqLabel'), nqChips: $('#nqChips'), nqInput: $('#nqInput'), nqAdd: $('#nqAdd'), nqSuggest: $('#nqSuggest'),
  nosale: $('#nosale'), showHidden: $('#showHidden'), showHiddenWrap: $('#showHiddenWrap'),
  hidemarked: $('#hidemarked'), savedBtn: $('#savedBtn'), savedCount: $('#savedCount'),
};

let state = Filters.stateFromSearch(location.search);
let regions = []; // [{ id, name, areas: [{ id, name }] }] từ API, rỗng nếu API khu vực không trả về
// Dự phòng khi API khu vực không trả về: lấy tên từ tin đã tải. wards: mãQuận → (mãPhường → tên).
const seenPlaces = { regions: new Map(), areas: new Map(), wards: new Map() };

// sources: mỗi quận / phường được chọn là một nguồn tải riêng (xem Filters.locationSources).
const store = { ads: new Map(), sources: [], total: 0, done: false, loading: false, token: 0, error: '' };
let loadingAll = false;
let visible = []; // tin đang hiển thị (sau lọc + sắp xếp)
let rendered = 0;
let fitPending = true;
let autoPages = 0;
const hiddenCount = { sale: 0, keyword: 0, marked: 0 };
const hiddenTotal = () => hiddenCount.sale + hiddenCount.keyword + hiddenCount.marked;

// Tin yêu thích / tin đã đánh dấu "không phù hợp" (lưu trên server, xem /api/saved):
// mãTin → { ad: bản chụp nội dung tin, at: thời điểm lưu }.
const myAds = { fav: new Map(), hidden: new Map() };
let savedView = ''; // '' = kết quả tìm kiếm, 'fav' = tab Yêu thích, 'hidden' = tab Đã ẩn

// ---------- tiện ích ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function priceText(ad) {
  if (ad.priceText) return ad.priceText;
  return ad.price != null ? Filters.formatMoney(ad.price) + '/tháng' : 'Thoả thuận';
}

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

// ---------- bản đồ ----------

const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([16.0, 106.5], 6);

// Nền bản đồ: OpenStreetMap, dự phòng CARTO (cùng dữ liệu OSM, máy chủ khác) khi ô bản đồ OSM
// không tải được (máy chủ OSM giới hạn / chặn, mạng chặn…) để không còn mảng trống.
const BASEMAPS = {
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }),
  carto: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  }),
  // Nền nhạt, gần như không có biểu tượng công trình: hợp để chỉ hiện các loại công trình tự chọn.
  light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  }),
};
let basemap = 'osm';
try { const saved = localStorage.getItem('phongtro.basemap'); if (BASEMAPS[saved]) basemap = saved; } catch { /* bỏ qua */ }
BASEMAPS[basemap].addTo(map);

// Đổi nền (bảng "Tuỳ chỉnh bản đồ" trong mapstyle.js). remember = false: tự chuyển, không lưu.
function setBasemap(name, remember = true) {
  if (!BASEMAPS[name] || name === basemap) return;
  map.removeLayer(BASEMAPS[basemap]);
  BASEMAPS[name].addTo(map);
  basemap = name;
  if (remember) try { localStorage.setItem('phongtro.basemap', name); } catch { /* bỏ qua */ }
  map.fire('basemapchange', { name });
}

let autoSwitched = false;

// OSM lỗi nhiều hơn tải được (ít nhất 6 ô) → tự chuyển sang CARTO, một lần mỗi lần mở trang.
const osmTiles = { ok: 0, err: 0 };
BASEMAPS.osm.on('tileload', () => { osmTiles.ok++; });
BASEMAPS.osm.on('tileerror', () => {
  osmTiles.err++;
  if (autoSwitched || basemap !== 'osm' || osmTiles.err < 6 || osmTiles.err <= osmTiles.ok) return;
  autoSwitched = true;
  setBasemap('carto', false);
  mapNotice('Không tải được bản đồ OpenStreetMap, đã chuyển sang bản đồ dự phòng CARTO. Đổi lại ở nút Tuỳ chỉnh bản đồ góc trái.');
});

// CARTO cũng lỗi (không có ô nào tải được): báo rõ, không để bản đồ trống mà không biết vì sao.
const cartoTiles = { ok: 0, err: 0 };
let noTilesShown = false;
const onCartoError = () => {
  cartoTiles.err++;
  if (noTilesShown || cartoTiles.ok || osmTiles.ok || cartoTiles.err < 6) return;
  noTilesShown = true;
  mapNotice('Không tải được ảnh nền bản đồ từ OpenStreetMap và CARTO. Máy đang mất mạng, hoặc mạng công ty / VPN / phần mềm chặn quảng cáo đang chặn tile.openstreetmap.org và basemaps.cartocdn.com. Tin đăng và ghim vẫn dùng được.', 0);
};
for (const layer of [BASEMAPS.carto, BASEMAPS.light]) {
  layer.on('tileload', () => { cartoTiles.ok++; });
  layer.on('tileerror', onCartoError);
}

// ms = 0: thông báo ở lại tới khi bấm ×.
function mapNotice(text, ms = 9000) {
  document.querySelectorAll('.map-notice').forEach((old) => old.remove()); // thông báo mới thay thông báo cũ
  const n = document.createElement('div');
  n.className = 'map-notice';
  n.setAttribute('role', 'status');
  n.textContent = text;
  if (!ms) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'map-notice-close';
    x.setAttribute('aria-label', 'Đóng');
    x.innerHTML = icon('close');
    x.addEventListener('click', () => n.remove());
    n.append(x);
  }
  document.querySelector('.map-wrap').append(n);
  if (ms) setTimeout(() => n.remove(), ms);
}
const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 50, chunkedLoading: true });
map.addLayer(cluster);
const markers = new Map(); // id → marker

const icons = {
  exact: L.divIcon({ className: 'pin exact', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 22], popupAnchor: [0, -20] }),
  approx: L.divIcon({ className: 'pin approx', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 22], popupAnchor: [0, -20] }),
};

function popupHtml(ad) {
  const meta = [ad.size ? `${ad.size} m²` : '', ad.furnishingText, ad.date].filter(Boolean).map(esc).join(' · ');
  return `<div class="popup">
    ${ad.thumb ? `<img src="${esc(ad.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    <a class="t" href="${esc(ad.url)}" target="_blank" rel="noopener">${esc(ad.title)}</a>
    <div class="p">${esc(priceText(ad))}</div>
    <div class="m">${meta}</div>
    <div class="a">${esc(ad.address)}${ad.approx ? ' <em>(vị trí gần đúng)</em>' : ''}</div>
    ${phoneHtml(ad)}
    ${actsHtml(ad)}
    ${gmapsHtml(ad)}
    <a class="go" href="${esc(ad.url)}" target="_blank" rel="noopener">Xem tin trên Nhà Tốt ${icon('external')}</a>
  </div>`;
}

// Nút mở Google Maps / Street View. Tin có toạ độ: đúng điểm đó. Tin vị trí gần đúng:
// Google Maps tìm theo địa chỉ (thường chính xác hơn), Street View ở giữa phường.
function gmapsHtml(ad) {
  const exact = ad.lat != null;
  const at = exact ? { lat: ad.lat, lng: ad.lng } : ad.approxAt;
  const maps = exact ? Filters.googleMapsUrl(ad.lat, ad.lng) : Filters.googleMapsUrl(null, null, ad.address);
  const links = [`<a href="${esc(maps)}" target="_blank" rel="noopener">${icon('pin')} Google Maps</a>`];
  if (at) {
    links.push(`<a href="${esc(Filters.streetViewUrl(at.lat, at.lng))}" target="_blank" rel="noopener"${exact ? '' : ' title="Vị trí gần đúng: Street View ở khu vực phường / quận"'}>${icon('person')} Street View</a>`);
  }
  return `<div class="gmaps">${links.join('')}</div>`;
}

// Click vào một điểm bất kỳ trên bản đồ → mở điểm đó trên Google Maps / Street View.
function pointPopupHtml(lat, lng) {
  const la = lat.toFixed(6);
  const ln = lng.toFixed(6);
  return `<div class="popup">
    <div class="coords">${la}, ${ln}</div>
    <div class="gmaps">
      <a href="${esc(Filters.googleMapsUrl(la, ln))}" target="_blank" rel="noopener">${icon('pin')} Google Maps</a>
      <a href="${esc(Filters.streetViewUrl(la, ln))}" target="_blank" rel="noopener">${icon('person')} Street View</a>
    </div>
  </div>`;
}

function adLatLng(ad) {
  if (ad.lat != null) return [ad.lat, ad.lng];
  if (!ad.approxAt) return null;
  // Lệch nhẹ (≤ ~250 m) theo id để các tin cùng phường không chồng khít lên nhau.
  const h = hash(ad.id);
  const dLat = (((h & 0xffff) / 0xffff) - 0.5) * 0.0045;
  const dLng = ((((h >>> 16) & 0xffff) / 0xffff) - 0.5) * 0.0045;
  return [ad.approxAt.lat + dLat, ad.approxAt.lng + dLng];
}

function renderMap() {
  cluster.clearLayers();
  markers.clear();
  const layers = [];
  for (const ad of shownAds()) {
    const ll = adLatLng(ad);
    if (!ll) continue;
    const m = L.marker(ll, { icon: ad.lat != null ? icons.exact : icons.approx, title: ad.title });
    // Nội dung popup là một phần tử DOM tạo một lần và dùng lại: mở lại popup không vẽ lại
    // từ đầu, nên phần đã cập nhật (vd. số điện thoại vừa lấy) không bị mất.
    let content = null;
    m.bindPopup(() => {
      if (!content) {
        content = document.createElement('div');
        content.innerHTML = popupHtml(ad);
      }
      return content;
    }, { maxWidth: 260, minWidth: 240 });
    m.on('popupopen', (e) => {
      syncActs(e.popup.getElement());
    });
    m.on('click', () => highlightCard(ad.id));
    markers.set(ad.id, m);
    layers.push(m);
  }
  cluster.addLayers(layers);
  if (fitPending && layers.length) {
    fitPending = false;
    const b = L.latLngBounds(layers.map((m) => m.getLatLng()));
    map.fitBounds(b.pad(0.1), { maxZoom: 15 });
  }
  updateCount();
}

let mapTimer = null;
function renderMapSoon() {
  clearTimeout(mapTimer);
  mapTimer = setTimeout(renderMap, 250);
}

function focusAd(id) {
  const m = markers.get(id);
  if (!m) return;
  if (document.body.dataset.view === 'list') setView('split');
  cluster.zoomToShowLayer(m, () => m.openPopup());
}

function highlightCard(id) {
  document.querySelectorAll('.card.active').forEach((c) => c.classList.remove('active'));
  const card = el.list.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// Bấm ra ngoài khi đang mở popup chỉ để đóng popup, không mở popup điểm mới.
let lastPopupClose = 0;
map.on('popupclose', () => { lastPopupClose = Date.now(); });
// Các chức năng khác (vd. thêm điểm ngập / chỗ đỗ xe, userlayers.js) xử lý cú bấm trước; trả về true là đã dùng.
const mapClickHooks = [];

map.on('click', (e) => {
  if (mapClickHooks.some((hook) => hook(e))) return;
  if (Date.now() - lastPopupClose < 400) return;
  L.popup({ maxWidth: 260, minWidth: 200 })
    .setLatLng(e.latlng)
    .setContent(pointPopupHtml(e.latlng.lat, e.latlng.lng))
    .openOn(map);
});

map.on('moveend', () => {
  if (el.inBounds.checked) renderList();
});

// ---------- danh sách ----------

function saleOf(ad) {
  if (!ad.sale) ad.sale = Filters.saleReasons(ad);
  return ad.sale;
}

// Tin khớp bộ lọc, đã sắp xếp. Tin bị bộ lọc loại trừ (từ khoá / sale trọ) được đếm
// vào hiddenCount và chỉ trả về khi withHidden (ad.hidden ghi lý do).
function filteredAds({ withHidden = false } = {}) {
  hiddenCount.sale = 0;
  hiddenCount.keyword = 0;
  hiddenCount.marked = 0;
  const out = [];
  for (const ad of store.ads.values()) {
    if (!Filters.matches(ad, state)) continue;
    ad.hidden = Filters.hiddenReason(ad, state, saleOf(ad), myAds.hidden.has(ad.id));
    if (ad.hidden) {
      hiddenCount[ad.hidden.kind]++;
      if (!withHidden) continue;
    }
    out.push(ad);
  }
  return Filters.sortAds(out, state.sort);
}

// Tin trong tab Đã lưu (mới lưu trước). Tin đang có trong kết quả thì dùng bản mới nhất.
function savedAds(kind) {
  return [...myAds[kind].values()]
    .sort((a, b) => b.at - a.at)
    .map((e) => {
      const ad = store.ads.get(e.ad.id) || e.ad;
      ad.hidden = null;
      return ad;
    });
}

// Tin đang hiển thị trên danh sách / bản đồ theo chế độ xem.
function shownAds({ withHidden = false } = {}) {
  return savedView ? savedAds(savedView) : filteredAds({ withHidden });
}

function phonesOf(ad) {
  if (!ad.phones) ad.phones = Filters.extractPhones([ad.title, ad.body].join('\n'));
  return ad.phones;
}

function phoneLinks(p) {
  return `<a href="tel:${esc(p)}">${esc(Filters.formatPhone(p))}</a> <a class="zalo" href="${esc(Filters.zaloUrl(p))}" target="_blank" rel="noopener" title="Nhắn Zalo số ${esc(p)}">Zalo</a>`;
}

// Số điện thoại: có trong nội dung tin thì hiện luôn, không thì nút "Hiện SĐT" hỏi API Nhà Tốt.
function phoneHtml(ad) {
  const phones = phonesOf(ad);
  const inner = phones.length
    ? phones.map(phoneLinks).join('<span class="sep">·</span>')
    : `<button type="button" class="link-btn" data-act="phone" data-id="${esc(ad.id)}">Hiện SĐT / Zalo</button>`;
  return `<div class="phone" data-phone="${esc(ad.id)}">${icon('phone')} ${inner}</div>`;
}

// Nút ♥ Yêu thích / ✓ Không phù hợp (trạng thái gán bằng syncActs).
function actsHtml(ad) {
  return `<div class="acts">
    <button type="button" class="act" data-act="fav" data-id="${esc(ad.id)}"></button>
    <button type="button" class="act" data-act="hide" data-id="${esc(ad.id)}"></button>
  </div>`;
}

function syncActs(root = document) {
  root.querySelectorAll('[data-act="fav"]').forEach((b) => {
    const on = myAds.fav.has(b.dataset.id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = on ? `${icon('heart', 'fill')} Đã thích` : `${icon('heart')} Yêu thích`;
    b.title = on ? 'Bỏ khỏi danh sách yêu thích' : 'Lưu vào danh sách yêu thích';
  });
  root.querySelectorAll('[data-act="hide"]').forEach((b) => {
    const on = myAds.hidden.has(b.dataset.id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = on ? `${icon('undo')} Bỏ ẩn` : `${icon('check')} Không phù hợp`;
    b.title = on ? 'Bỏ đánh dấu, hiện lại tin này' : 'Đã xem nhưng không phù hợp: ẩn tin này';
  });
}

const SNAP_KEYS = ['id', 'title', 'price', 'priceText', 'size', 'deposit', 'furnishingText', 'region', 'area', 'ward', 'street',
  'address', 'lat', 'lng', 'approxAt', 'thumb', 'imageCount', 'date', 'time', 'isCompany', 'type', 'url'];

function findAd(id) {
  return store.ads.get(id) || myAds.fav.get(id)?.ad || myAds.hidden.get(id)?.ad || null;
}

async function toggleSaved(kind, id) {
  const ad = findAd(id);
  const on = !myAds[kind].has(id);
  const snap = {};
  if (ad) {
    for (const k of SNAP_KEYS) snap[k] = ad[k];
    snap.phones = phonesOf(ad);
  }
  // Cập nhật ngay trên màn hình, lỗi thì trả lại như cũ.
  const before = myAds[kind].get(id);
  if (on) myAds[kind].set(id, { ad: { ...snap, id }, at: Date.now() });
  else myAds[kind].delete(id);
  afterSavedChange(kind);
  try {
    const res = await fetch('/api/saved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, op: on ? 'add' : 'remove', id, ad: snap }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
    loadMine(data);
  } catch (err) {
    if (before) myAds[kind].set(id, before);
    else myAds[kind].delete(id);
    afterSavedChange(kind);
    alert('Không lưu được: ' + err.message);
  }
}

function loadMine(data) {
  for (const kind of ['fav', 'hidden']) {
    myAds[kind] = new Map(Object.entries(data[kind] || {}));
  }
  updateSavedCount();
}

function updateSavedCount() {
  el.savedCount.textContent = myAds.fav.size ? String(myAds.fav.size) : '';
  document.querySelectorAll('.saved-tabs [data-tab]').forEach((t) => {
    t.querySelector('b').textContent = String(myAds[t.dataset.tab].size);
  });
}

function afterSavedChange(kind) {
  updateSavedCount();
  syncActs();
  // Ẩn / bỏ ẩn, hoặc đang ở tab Đã lưu: danh sách và bản đồ thay đổi.
  if (kind === 'hidden' || savedView) {
    renderList(true);
    renderMapSoon();
  }
}

async function showPhone(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Đang lấy số…';
  const ad = findAd(id);
  let html;
  try {
    const { phone } = await api('/api/phone?id=' + encodeURIComponent(id));
    if (phone) {
      if (ad) ad.phones = [phone];
      html = `${icon('phone')} ${phoneLinks(phone)}`;
    }
  } catch { /* xử lý bên dưới */ }
  if (!html) {
    const url = ad?.url || `https://www.nhatot.com/${encodeURIComponent(id)}.htm`;
    html = `${icon('phone')} <span class="muted">Không lấy được số.</span> <a href="${esc(url)}" target="_blank" rel="noopener">Xem trên Nhà Tốt ${icon('external')}</a>`;
  }
  document.querySelectorAll(`[data-phone="${CSS.escape(id)}"]`).forEach((x) => { x.innerHTML = html; });
}

// Nút trong thẻ tin và trong popup bản đồ (popup không nằm trong #list).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  e.stopPropagation();
  const id = b.dataset.id;
  if (b.dataset.act === 'fav') toggleSaved('fav', id);
  else if (b.dataset.act === 'hide') {
    if (!myAds.hidden.has(id)) map.closePopup();
    toggleSaved('hidden', id);
  } else if (b.dataset.act === 'phone') showPhone(id, b);
}, true);

const ICON_COPY = icon('copy');
const ICON_CHECK = icon('check');
const ICON_MAP = icon('pin');

// Địa chỉ bất động sản + nút copy + nút mở vị trí trên Google Maps.
function addressHtml(ad, fallback) {
  const addr = ad.address || fallback;
  if (!addr) return '';
  const gmaps = ad.lat != null ? Filters.googleMapsUrl(ad.lat, ad.lng) : Filters.googleMapsUrl(null, null, addr);
  return `<div class="addr">
    <span class="addr-text" title="${esc(addr)}"><b>Địa chỉ:</b> ${esc(addr)}</span>
    <button type="button" class="icon-btn" data-copy="${esc(addr)}" title="Copy địa chỉ" aria-label="Copy địa chỉ">${ICON_COPY}</button>
    <a class="icon-btn" href="${esc(gmaps)}" target="_blank" rel="noopener" title="Mở vị trí trên Google Maps" aria-label="Mở vị trí trên Google Maps">${ICON_MAP}</a>
  </div>`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Trình duyệt cũ / không cho dùng clipboard API: dùng ô chữ tạm.
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  e.stopPropagation();
  const ok = await copyText(b.dataset.copy);
  b.innerHTML = ok ? ICON_CHECK : ICON_COPY;
  b.classList.toggle('copied', ok);
  b.title = ok ? 'Đã copy' : 'Không copy được';
  clearTimeout(b.copyTimer);
  b.copyTimer = setTimeout(() => {
    b.innerHTML = ICON_COPY;
    b.classList.remove('copied');
    b.title = 'Copy địa chỉ';
  }, 1500);
}, true);

function cardHtml(ad) {
  const where = [ad.ward, ad.area, ad.region].filter(Boolean).join(', ');
  const tags = [
    ad.size ? `${ad.size} m²` : '',
    ad.furnishingText || '',
    ad.deposit ? `Cọc ${Filters.formatMoney(ad.deposit)}` : '',
  ].filter(Boolean);
  const loc = ad.lat != null ? '' : ad.approxAt ? '<span class="badge soft">Vị trí gần đúng</span>' : '<span class="badge soft">Chưa có vị trí</span>';
  const sale = saleOf(ad);
  const marked = myAds.hidden.has(ad.id) && !ad.hidden;
  const saleBadge = !ad.hidden && sale.length ? `<span class="badge sale" title="${esc('Dấu hiệu: ' + sale.join(', '))}">Có thể là sale</span>` : '';
  return `<article class="card${ad.hidden ? ' is-hidden' : ''}${marked && !savedView ? ' is-marked' : ''}" data-id="${esc(ad.id)}" tabindex="0">
    <div class="thumb">${ad.thumb ? `<img src="${esc(ad.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span>Không có ảnh</span>'}
      ${ad.imageCount > 1 ? `<span class="imgs">${ad.imageCount} ảnh</span>` : ''}</div>
    <div class="info">
      <a class="title" href="${esc(ad.url)}" target="_blank" rel="noopener">${esc(ad.title)}</a>
      <div class="price">${esc(priceText(ad))}</div>
      <div class="tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      ${addressHtml(ad, where)}
      <div class="meta">
        <span>${esc(ad.date)}</span>
        <span class="badge ${ad.isCompany ? 'pro' : ''}">${ad.isCompany ? 'Môi giới' : 'Cá nhân'}</span>
        ${ad.type === 'h' ? '<span class="badge">Cần thuê</span>' : ''}
        ${loc}
        ${saleBadge}
        ${marked && !savedView ? '<span class="badge marked">Đã đánh dấu không phù hợp</span>' : ''}
      </div>
      ${phoneHtml(ad)}
      ${actsHtml(ad)}
      ${ad.hidden ? `<div class="why">Bị ẩn: ${esc(ad.hidden.text)}</div>` : ''}
    </div>
  </article>`;
}

// keep = true: giữ số thẻ đã hiện (khi chỉ có thêm tin mới) để danh sách không nhảy về đầu.
function renderList(keep = false) {
  const count = keep ? Math.max(rendered, RENDER_STEP) : RENDER_STEP;
  let list = shownAds({ withHidden: el.showHidden.checked });
  if (el.inBounds.checked) {
    const b = map.getBounds();
    list = list.filter((ad) => {
      const ll = adLatLng(ad);
      return ll && b.contains(ll);
    });
  }
  visible = list;
  rendered = 0;
  el.list.innerHTML = savedView ? savedTabsHtml() : '';
  if (savedView && !list.length) {
    el.list.insertAdjacentHTML('beforeend', `<p class="empty">${savedView === 'fav'
      ? 'Chưa có tin yêu thích. Bấm “Yêu thích” trên một tin để lưu lại.'
      : 'Chưa ẩn tin nào. Bấm “Không phù hợp” trên tin đã xem mà không ưng để ẩn đi.'}</p>`);
  } else if (!list.length) {
    const hidden = hiddenTotal();
    let msg = 'Không có tin phù hợp với bộ lọc.';
    if (hidden) msg = `Không có tin phù hợp trong ${store.ads.size.toLocaleString('vi-VN')} tin đã tải (đã ẩn ${hidden.toLocaleString('vi-VN')} tin bởi bộ lọc loại trừ).`;
    el.list.innerHTML = store.loading && !hidden
      ? '<p class="empty">Đang tải tin…</p>'
      : `<p class="empty">${store.error ? esc(store.error) : esc(msg)}</p>`;
    if (!store.done && !store.error && !el.inBounds.checked) {
      el.list.insertAdjacentHTML('beforeend', '<div class="sentinel"><button type="button">Tải thêm tin</button></div>');
    }
  } else {
    renderMore(count);
  }
  updateCount();
  maybeAutoFill();
}

function savedTabsHtml() {
  const tab = (kind, label) => `<button type="button" data-tab="${kind}" aria-selected="${savedView === kind}">${label} <b>${myAds[kind].size}</b></button>`;
  return `<div class="saved-bar">
    <button type="button" class="back" data-saved-back>${icon('arrowLeft')} Kết quả tìm kiếm</button>
    <div class="saved-tabs" role="tablist">${tab('fav', `${icon('heart')} Yêu thích`)}${tab('hidden', `${icon('check')} Đã ẩn`)}</div>
    ${savedView === 'hidden' && myAds.hidden.size ? '<button type="button" class="link" data-unhide-all>Bỏ ẩn tất cả</button>' : ''}
  </div>`;
}

function openSaved(kind) {
  savedView = kind;
  document.body.dataset.saved = kind;
  el.savedBtn.setAttribute('aria-pressed', String(Boolean(kind)));
  fitPending = true;
  renderList();
  renderMap();
  if (kind) {
    el.list.scrollTop = 0;
    queueGeocode(savedAds(kind));
  }
}

el.savedBtn.addEventListener('click', () => openSaved(savedView ? '' : 'fav'));
el.list.addEventListener('click', async (e) => {
  const tab = e.target.closest('.saved-tabs [data-tab]');
  if (tab) return openSaved(tab.dataset.tab);
  if (e.target.closest('[data-saved-back]')) return openSaved('');
  if (e.target.closest('[data-unhide-all]')) {
    if (!confirm(`Bỏ ẩn tất cả ${myAds.hidden.size} tin đã đánh dấu không phù hợp?`)) return;
    const res = await fetch('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'hidden', op: 'clear' }) });
    if (res.ok) loadMine(await res.json());
    afterSavedChange('hidden');
  }
});

// Bộ lọc loại trừ có thể ẩn gần hết một trang: tự tải thêm vài trang cho đủ tin để xem.
function maybeAutoFill() {
  if (savedView || store.done || store.loading || store.error || loadingAll || el.inBounds.checked) return;
  if (visible.length >= AUTO_FILL_MIN || autoPages >= AUTO_FILL_PAGES) return;
  // Chỉ khi bộ lọc trên trình duyệt (loại trừ, thời gian đăng…) đã bỏ bớt tin đã tải.
  if (!hiddenTotal() && visible.length >= store.ads.size) return;
  autoPages++;
  loadPage();
}

function renderMore(step = RENDER_STEP) {
  const next = visible.slice(rendered, rendered + step);
  rendered += next.length;
  el.list.querySelector('.sentinel')?.remove();
  el.list.insertAdjacentHTML('beforeend', next.map(cardHtml).join(''));
  syncActs(el.list);
  const more = rendered < visible.length || (!savedView && !store.done && !el.inBounds.checked);
  if (more) {
    el.list.insertAdjacentHTML('beforeend', '<div class="sentinel"><button type="button">Xem thêm</button></div>');
    sentinelObserver.observe(el.list.querySelector('.sentinel'));
  }
}

const sentinelObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    sentinelObserver.unobserve(e.target);
    onSentinel();
  }
}, { root: null, rootMargin: '400px' });

function onSentinel() {
  autoPages = 0;
  if (rendered < visible.length) renderMore();
  else if (!savedView && !store.done && !store.loading) loadPage();
}

el.list.addEventListener('click', (e) => {
  if (e.target.closest('.sentinel button')) return onSentinel();
  if (e.target.closest('a, button')) return;
  const card = e.target.closest('.card');
  if (card) {
    highlightCard(card.dataset.id);
    focusAd(card.dataset.id);
  }
});
el.list.addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (card && e.key === 'Enter') focusAd(card.dataset.id);
});

function updateCount() {
  const loaded = store.ads.size;
  const shown = visible.length;
  const onMap = markers.size;
  let text;
  if (savedView) {
    text = `${shown.toLocaleString('vi-VN')} tin ${savedView === 'fav' ? 'yêu thích' : 'đã đánh dấu không phù hợp'} · ${onMap.toLocaleString('vi-VN')} trên bản đồ`;
  } else if (store.error && !loaded) text = store.error;
  else if (!loaded && store.loading) text = 'Đang tải…';
  else {
    text = `${shown.toLocaleString('vi-VN')} tin hiển thị · đã tải ${loaded.toLocaleString('vi-VN')} / ${store.total.toLocaleString('vi-VN')} tin · ${onMap.toLocaleString('vi-VN')} trên bản đồ`;
    if (store.loading) text += ' · đang tải…';
    if (geo.pending) text += ` · đang định vị ${geo.pending} khu vực…`;
    const parts = [];
    if (hiddenCount.sale) parts.push(`${hiddenCount.sale.toLocaleString('vi-VN')} tin sale`);
    if (hiddenCount.keyword) parts.push(`${hiddenCount.keyword.toLocaleString('vi-VN')} tin có từ khoá loại trừ`);
    if (hiddenCount.marked) parts.push(`${hiddenCount.marked.toLocaleString('vi-VN')} tin bạn đánh dấu không phù hợp`);
    if (parts.length) text += ` · đã ẩn ${parts.join(', ')}`;
  }
  el.count.textContent = text;
  el.showHiddenWrap.hidden = savedView || (!hiddenTotal() && !el.showHidden.checked);
  el.loadAll.innerHTML = loadingAll ? `${icon('stop')} Dừng tải` : store.done ? `${icon('check')} Đã tải hết` : `${icon('download')} Tải tất cả`;
  el.loadAll.disabled = store.done && !loadingAll;
}

// ---------- tải dữ liệu ----------

async function loadPage() {
  if (store.loading || store.done) return;
  store.loading = true;
  store.error = '';
  updateCount();
  const token = store.token;
  try {
    // Lấy trang kế tiếp của các nguồn tải ít nhất, tối đa MAX_PARALLEL nguồn một lượt.
    const batch = store.sources.filter((s) => !s.done).sort((a, b) => a.offset - b.offset).slice(0, MAX_PARALLEL);
    const results = await Promise.allSettled(batch.map((s) => api('/api/ads?' + Filters.toApiParams(state, s.offset, PAGE, s.src))));
    if (token !== store.token) return;
    let failed = null;
    results.forEach((r, i) => {
      const s = batch[i];
      if (r.status === 'rejected') {
        failed = r.reason;
        return;
      }
      const data = r.value;
      s.total = data.total || 0;
      s.offset += PAGE;
      for (const ad of data.ads) {
        if (!store.ads.has(ad.id)) store.ads.set(ad.id, ad);
        rememberPlaces(ad);
      }
      if (!data.ads.length || s.offset >= s.total) s.done = true;
      // Đang xếp tin mới nhất + lọc thời gian đăng: tin cuối trang (cũ nhất, tin đẩy lên đầu nằm
      // ở đầu trang) đã cũ hơn khoảng chọn thì các trang sau còn cũ hơn, không cần tải tiếp.
      const posted = Filters.postedRange(state.posted);
      const last = data.ads[data.ads.length - 1];
      if (posted && !state.sort && last && last.time != null && last.time < posted.from) s.done = true;
      queueGeocode(data.ads);
    });
    store.total = store.sources.reduce((n, s) => n + s.total, 0);
    store.done = store.sources.every((s) => s.done);
    if (failed) throw failed;
  } catch (err) {
    if (token !== store.token) return;
    store.error = 'Không tải được tin: ' + err.message;
    loadingAll = false;
  } finally {
    if (token === store.token) {
      store.loading = false;
      renderList(true);
      renderMapSoon();
    }
  }
}

async function loadAll() {
  if (loadingAll) {
    loadingAll = false;
    return updateCount();
  }
  loadingAll = true;
  const token = store.token;
  while (loadingAll && token === store.token && !store.done && store.ads.size < LOAD_ALL_CAP) {
    await loadPage();
    if (store.error) break;
  }
  if (token === store.token) {
    loadingAll = false;
    updateCount();
  }
}

function restart() {
  store.token++;
  store.ads.clear();
  store.sources = Filters.locationSources(state).map((src) => ({ src, offset: 0, total: 0, done: false }));
  store.total = 0;
  store.done = false;
  store.loading = false;
  store.error = '';
  loadingAll = false;
  fitPending = true;
  autoPages = 0;
  history.replaceState(null, '', location.pathname + Filters.stateToSearch(state));
  renderList();
  renderMap();
  loadPage();
}

el.loadAll.addEventListener('click', loadAll);
el.inBounds.addEventListener('change', () => renderList());
el.showHidden.addEventListener('change', () => renderList());

// ---------- định vị gần đúng ----------

const geo = { cache: new Map(), queue: [], running: false, pending: 0 };

function queueGeocode(ads) {
  if (!el.approx.checked) return;
  for (const ad of ads) {
    if (ad.lat != null || ad.approxAt) continue;
    geo.queue.push(ad);
  }
  runGeocode();
}

async function lookup(q) {
  if (!geo.cache.has(q)) {
    geo.cache.set(q, api('/api/geocode?q=' + encodeURIComponent(q)).then((d) => d.result).catch(() => null));
  }
  return geo.cache.get(q);
}

async function runGeocode() {
  if (geo.running) return;
  geo.running = true;
  while (geo.queue.length && el.approx.checked) {
    const ad = geo.queue.shift();
    if (!store.ads.has(ad.id) && !myAds.fav.has(ad.id) && !myAds.hidden.has(ad.id)) continue;
    geo.pending = new Set(geo.queue.map((a) => Filters.geoQueries(a)[0])).size;
    for (const q of Filters.geoQueries(ad)) {
      const hit = await lookup(q);
      if (hit) {
        ad.approxAt = hit;
        ad.approx = true;
        break;
      }
    }
    renderMapSoon();
    updateCount();
  }
  geo.pending = 0;
  geo.running = false;
  renderList(true);
  renderMapSoon();
}

el.approx.addEventListener('change', () => {
  if (el.approx.checked) queueGeocode([...store.ads.values()]);
  else {
    geo.queue = [];
    renderMapSoon();
  }
});

// ---------- bộ lọc ----------

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.selected = String(value) === String(selected);
  return o;
}

function sortedPlaces(m) {
  return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
}

function rememberPlaces(ad) {
  let changed = false;
  const put = (m, id, name) => {
    if (id == null || !name || m.has(String(id))) return;
    m.set(String(id), name);
    changed = true;
  };
  put(seenPlaces.regions, ad.regionId, ad.region);
  if (String(ad.regionId) === String(state.region_v2)) put(seenPlaces.areas, ad.areaId, ad.area);
  if (ad.areaId != null && state.area_v2.includes(String(ad.areaId))) {
    const key = String(ad.areaId);
    if (!seenPlaces.wards.has(key)) seenPlaces.wards.set(key, new Map());
    put(seenPlaces.wards.get(key), ad.wardId, ad.ward);
  }
  if (changed) {
    clearTimeout(rememberPlaces.t);
    rememberPlaces.t = setTimeout(fillPlaces, 300);
  }
}

// Danh sách phường của từng quận (từ API, lưu lại); rỗng nếu API không trả về.
const wardCache = new Map();
function fetchWards(area) {
  if (!wardCache.has(area)) {
    wardCache.set(area, api('/api/wards?area=' + encodeURIComponent(area)).then((d) => d.wards || []).catch(() => []));
  }
  return wardCache.get(area);
}

function areaItems() {
  const region = regions.find((r) => String(r.id) === String(state.region_v2));
  const items = region && region.areas.length ? region.areas : sortedPlaces(seenPlaces.areas);
  return items.map((a) => ({ id: String(a.id), name: a.name }));
}

function areaName(id) {
  return areaItems().find((a) => a.id === String(id))?.name || `Mã ${id}`;
}

async function wardItems(area) {
  const list = await fetchWards(area);
  if (list.length) return list.map((w) => ({ id: String(w.id), name: w.name }));
  return sortedPlaces(seenPlaces.wards.get(String(area)) || new Map());
}

// Ô đánh dấu đang được tick trong popup (giữ lựa chọn chưa áp dụng khi danh sách vẽ lại).
function checkedIn(pop) {
  return new Set([...pop.querySelectorAll('.opts input:checked')].map((c) => c.value));
}

function optHtml(value, name, checked) {
  return `<label data-name="${esc(Filters.fold(name))}"><input type="checkbox" value="${esc(value)}"${checked.has(value) ? ' checked' : ''}> ${esc(name)}</label>`;
}

function applyFilterBox(pop) {
  const q = Filters.fold(pop.querySelector('.filter-box').value.trim());
  pop.querySelectorAll('.opts label').forEach((l) => { l.hidden = Boolean(q) && !l.dataset.name.includes(q); });
}

// 1–2 nơi tên ngắn: hiện tên ("Quận 7, Quận 3"); nhiều hơn: "5 đã chọn".
function multiLabel(selected, nameOf) {
  if (!selected.length) return '';
  const names = selected.map(nameOf);
  const joined = names.join(', ');
  return names.length <= 2 && joined.length <= 24 ? joined : `${names.length} đã chọn`;
}

let placesRun = 0;
async function fillPlaces() {
  const run = ++placesRun;
  const regionItems = regions.length ? regions : sortedPlaces(seenPlaces.regions);
  el.region.replaceChildren(option('', 'Toàn quốc', state.region_v2), ...regionItems.map((r) => option(r.id, r.name, state.region_v2)));
  if (state.region_v2 && !regionItems.some((r) => String(r.id) === String(state.region_v2))) {
    el.region.append(option(state.region_v2, `Mã ${state.region_v2}`, state.region_v2));
  }

  // Quận / huyện
  const areas = areaItems();
  for (const id of state.area_v2) if (!areas.some((a) => a.id === id)) areas.push({ id, name: `Mã ${id}` });
  const areaChecked = el.areaPop.open ? checkedIn(el.areaPop) : new Set(state.area_v2);
  el.areaOpts.innerHTML = areas.length
    ? areas.map((a) => optHtml(a.id, a.name, areaChecked)).join('')
    : '<p class="none">Chọn tỉnh / thành trước.</p>';
  applyFilterBox(el.areaPop);
  el.areaPop.classList.toggle('disabled', !state.region_v2);
  el.areaLabel.textContent = multiLabel(state.area_v2, areaName);

  // Phường / xã, nhóm theo từng quận đang chọn
  el.wardPop.classList.toggle('disabled', !state.area_v2.length);
  const groups = await Promise.all(state.area_v2.map(async (a) => ({ area: a, wards: await wardItems(a) })));
  if (run !== placesRun) return;
  const wardChecked = el.wardPop.open ? checkedIn(el.wardPop) : new Set(state.ward);
  const names = new Map();
  el.wardOpts.innerHTML = groups.length
    ? groups.map((g) => {
      for (const w of g.wards) names.set(`${g.area}:${w.id}`, w.name);
      const opts = g.wards.map((w) => optHtml(`${g.area}:${w.id}`, w.name, wardChecked)).join('');
      return `<h4>${esc(areaName(g.area))}</h4>${opts || '<p class="none">Chưa có danh sách phường.</p>'}`;
    }).join('')
    : '<p class="none">Chọn quận / huyện trước.</p>';
  applyFilterBox(el.wardPop);
  el.wardLabel.textContent = multiLabel(state.ward, (w) => names.get(w) || `Mã ${w.split(':')[1]}`);
  markSetPops();
}

// Popup chọn nhiều: tick xong, bấm "Áp dụng" hoặc bấm ra ngoài thì mới lọc (một lần).
for (const pop of [el.areaPop, el.wardPop]) {
  pop.querySelector('.filter-box').addEventListener('input', () => applyFilterBox(pop));
  pop.querySelector('[data-none]').addEventListener('click', () => {
    pop.querySelectorAll('.opts input:checked').forEach((c) => { c.checked = false; });
  });
  pop.querySelector('[data-done]').addEventListener('click', () => { pop.open = false; });
  pop.addEventListener('toggle', () => {
    if (pop.open) {
      pop.querySelector('.filter-box').value = '';
      applyFilterBox(pop);
      return;
    }
    const picked = [...checkedIn(pop)];
    const key = pop.dataset.key;
    const same = picked.length === state[key].length && picked.every((v) => state[key].includes(v));
    if (same) return;
    if (key === 'area_v2') update({ area_v2: picked, ward: state.ward.filter((w) => picked.includes(w.split(':')[0])) });
    else update({ ward: picked });
  });
}

// Ô lọc có giá trị thì tô màu; nhãn đầy đủ hiện khi rê chuột (nhãn dài bị cắt "…").
function markSetPops() {
  document.querySelectorAll('.pop').forEach((p) => {
    const b = p.querySelector('b');
    p.classList.toggle('set', Boolean(b.textContent));
    b.title = b.textContent;
  });
}

function syncForm() {
  el.hidemarked.checked = state.hidemarked !== '0';
  el.q.value = state.q;
  el.st.value = state.st;
  el.f.value = state.f;
  el.sort.value = state.sort;
  const pr = Filters.parseRange(state.price);
  el.priceMin.value = pr.min != null ? pr.min / 1e6 : '';
  el.priceMax.value = pr.max != null ? pr.max / 1e6 : '';
  const sz = Filters.parseRange(state.size);
  el.sizeMin.value = sz.min ?? '';
  el.sizeMax.value = sz.max ?? '';
  el.priceLabel.textContent = Filters.rangeLabel(state.price);
  el.sizeLabel.textContent = Filters.rangeLabel(state.size, 'm2');
  el.postedLabel.textContent = Filters.postedLabel(state.posted);
  syncPostedInputs();
  document.querySelectorAll('input[name="furnishing_rent"]').forEach((c) => { c.checked = state.furnishing_rent.includes(c.value); });
  const n = state.furnishing_rent.length;
  el.furnLabel.textContent = n ? `${n} mục` : '';
  document.querySelectorAll('.presets').forEach((box) => {
    box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === state[box.dataset.target]));
  });
  el.nosale.checked = state.nosale === '1';
  const kws = nqList();
  el.nqLabel.textContent = kws.length ? String(kws.length) : '';
  el.nqChips.replaceChildren(...kws.map((k, i) => {
    const chip = document.createElement('span');
    chip.textContent = k;
    const x = document.createElement('button');
    x.type = 'button';
    x.dataset.remove = String(i);
    x.setAttribute('aria-label', `Bỏ từ khoá ${k}`);
    x.innerHTML = icon('close');
    chip.append(x);
    return chip;
  }));
  const folded = Filters.splitKeywords(state.nq);
  el.nqSuggest.querySelectorAll('button').forEach((b) => { b.disabled = folded.includes(Filters.splitKeywords(b.dataset.k)[0]); });
  markSetPops();
}

// Từ khoá loại trừ như người dùng gõ (bỏ trùng không phân biệt dấu).
function nqList() {
  const seen = new Set();
  return String(state.nq || '').split(/[,;\n]+/).map((k) => k.trim()).filter((k) => {
    const f = Filters.splitKeywords(k)[0];
    if (!f || seen.has(f)) return false;
    seen.add(f);
    return true;
  });
}

// Đổi bộ lọc chỉ chạy trên trình duyệt: lọc lại tin đã tải, không gọi lại API.
function updateLocal(patch) {
  Object.assign(state, patch);
  syncForm();
  history.replaceState(null, '', location.pathname + Filters.stateToSearch(state));
  autoPages = 0;
  renderList();
  renderMap();
}

function addKeywords(text) {
  const nq = Filters.joinKeywords([...nqList(), ...String(text).split(/[,;\n]+/)]);
  if (nq !== state.nq) updateLocal({ nq });
}

el.nqAdd.addEventListener('click', () => {
  addKeywords(el.nqInput.value);
  el.nqInput.value = '';
  el.nqInput.focus();
});
el.nqInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  el.nqAdd.click();
});
el.nqSuggest.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (b) addKeywords(b.dataset.k);
});
el.nqChips.addEventListener('click', (e) => {
  const x = e.target.closest('button[data-remove]');
  if (!x) return;
  const list = nqList();
  list.splice(Number(x.dataset.remove), 1);
  updateLocal({ nq: Filters.joinKeywords(list) });
});
el.nosale.addEventListener('change', () => updateLocal({ nosale: el.nosale.checked ? '1' : '' }));
el.hidemarked.addEventListener('change', () => updateLocal({ hidemarked: el.hidemarked.checked ? '1' : '0' }));

// ---------- thời gian đăng ----------

const postedInputs = {
  hFrom: $('#postedHFrom'), hTo: $('#postedHTo'), dFrom: $('#postedDFrom'), dTo: $('#postedDTo'),
};

function isoDate(t) {
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

// Điền các ô tự nhập theo bộ lọc đang chọn; ngày mặc định là hôm nay để chọn nhanh.
function syncPostedInputs() {
  const p = state.posted || '';
  const h = /^h(\d+)(?:-(\d+))?$/.exec(p);
  postedInputs.hFrom.value = h ? (h[2] != null ? Math.min(h[1], h[2]) : 0) : '';
  postedInputs.hTo.value = h ? (h[2] != null ? Math.max(h[1], h[2]) : h[1]) : '';
  const d = /^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/.exec(p);
  const today = isoDate(new Date());
  postedInputs.dFrom.value = d ? d[1] : today;
  postedInputs.dTo.value = d ? d[2] : today;
  postedInputs.dFrom.max = today;
  postedInputs.dTo.max = today;
}

// Giá trị bộ lọc từ các ô tự nhập; null nếu chưa nhập đủ / sai (ô sai được đánh dấu).
function postedFromInputs(kind) {
  if (kind === 'h') {
    const a = Math.round(Number(postedInputs.hFrom.value || 0));
    const b = Math.round(Number(postedInputs.hTo.value));
    const ok = Number.isFinite(b) && b > 0 && a >= 0 && a !== b;
    postedInputs.hTo.setCustomValidity(ok ? '' : 'Nhập số giờ lớn hơn ô "Từ"');
    if (!ok) return postedInputs.hTo.reportValidity(), null;
    const [lo, hi] = [a, b].sort((x, y) => x - y);
    return lo === 0 ? `h${hi}` : `h${lo}-${hi}`;
  }
  const a = postedInputs.dFrom.value;
  const b = postedInputs.dTo.value || a;
  if (!a) return postedInputs.dFrom.reportValidity(), null;
  const posted = a <= b ? `${a}~${b}` : `${b}~${a}`;
  return Filters.postedRange(posted) ? posted : null;
}

function update(patch) {
  Object.assign(state, patch);
  syncForm();
  fillPlaces();
  restart();
}

el.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  update({ q: el.q.value.trim() });
});
el.st.addEventListener('change', () => update({ st: el.st.value }));
el.f.addEventListener('change', () => update({ f: el.f.value }));
el.sort.addEventListener('change', () => {
  // Đổi sắp xếp: nếu đã tải hết thì chỉ sắp xếp lại, không cần gọi API.
  state.sort = el.sort.value;
  history.replaceState(null, '', location.pathname + Filters.stateToSearch(state));
  if (store.done) renderList();
  else restart();
});
el.region.addEventListener('change', () => {
  seenPlaces.areas.clear();
  seenPlaces.wards.clear();
  update({ region_v2: el.region.value, area_v2: [], ward: [] });
});

el.form.addEventListener('click', (e) => {
  const preset = e.target.closest('.presets button');
  if (preset) {
    const key = preset.parentElement.dataset.target;
    preset.closest('details').open = false;
    return update({ [key]: state[key] === preset.dataset.v ? '' : preset.dataset.v });
  }
  const applyPosted = e.target.closest('[data-apply-posted]');
  if (applyPosted) {
    const posted = postedFromInputs(applyPosted.dataset.applyPosted);
    if (posted === null) return;
    applyPosted.closest('details').open = false;
    return update({ posted });
  }
  const apply = e.target.closest('[data-apply]');
  if (apply) {
    const key = apply.dataset.apply;
    const k = key === 'price' ? 1e6 : 1;
    const min = parseFloat(el[key + 'Min'].value) * k;
    const max = parseFloat(el[key + 'Max'].value) * k;
    apply.closest('details').open = false;
    return update({ [key]: Filters.formatRange(min, max) });
  }
  const clear = e.target.closest('[data-clear]');
  if (clear) {
    const key = clear.dataset.clear;
    clear.closest('details').open = false;
    return (LOCAL_ONLY.includes(key) ? updateLocal : update)({ [key]: '' });
  }
});
el.form.addEventListener('change', (e) => {
  if (e.target.name !== 'furnishing_rent') return;
  const vals = [...document.querySelectorAll('input[name="furnishing_rent"]:checked')].map((c) => c.value);
  update({ furnishing_rent: vals });
});
el.form.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.range input')) {
    e.preventDefault();
    e.target.closest('.pop-body').querySelector('[data-apply]').click();
  }
});
el.reset.addEventListener('click', () => {
  seenPlaces.areas.clear();
  seenPlaces.wards.clear();
  update(Filters.emptyState());
});

// Popup lọc gần mép phải màn hình thì canh phải để không bị cắt.
document.querySelectorAll('details.pop').forEach((d) => d.addEventListener('toggle', () => {
  const body = d.querySelector('.pop-body');
  body.style.left = '';
  body.style.right = '';
  if (d.open && window.innerWidth > 800 && body.getBoundingClientRect().right > window.innerWidth - 8) {
    body.style.left = 'auto';
    body.style.right = '0';
  }
}));

// Chỉ mở một popup lọc tại một thời điểm; bấm ra ngoài thì đóng.
document.addEventListener('click', (e) => {
  if (!e.target.isConnected) return; // nút vừa bị vẽ lại (vd. bỏ một từ khoá) – giữ popup mở
  document.querySelectorAll('details.pop[open]').forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});

// ---------- màu cụm tin (Đậm / Xanh dương / Viền) ----------

const CLUSTER_STYLES = ['bold', 'blue', 'outline'];

function setClusterStyle(style) {
  if (!CLUSTER_STYLES.includes(style)) style = 'bold';
  document.body.dataset.cluster = style;
  document.querySelectorAll('.cluster-style [data-cluster]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.cluster === style)));
  try { localStorage.setItem('phongtro.cluster', style); } catch { /* không bắt buộc */ }
}

document.querySelector('.cluster-style').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cluster]');
  if (b) setClusterStyle(b.dataset.cluster);
});
try { setClusterStyle(localStorage.getItem('phongtro.cluster')); } catch { setClusterStyle('bold'); }

// ---------- chế độ xem ----------

function setView(v) {
  document.body.dataset.view = v;
  document.querySelectorAll('.views button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  try { localStorage.setItem('phongtro.view', v); } catch { /* không bắt buộc */ }
  setTimeout(() => map.invalidateSize(), 50);
}
document.querySelector('.views').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) setView(b.dataset.view);
});

// ---------- khởi động ----------

(async function init() {
  let saved = null;
  try { saved = localStorage.getItem('phongtro.view'); } catch { /* bỏ qua */ }
  setView(['list', 'split', 'map'].includes(saved) ? saved : window.innerWidth < 800 ? 'list' : 'split');
  syncForm();
  try {
    loadMine(await api('/api/saved'));
  } catch { /* chưa lưu được thì vẫn xem tin bình thường */ }
  restart();
  try {
    regions = (await api('/api/regions')).regions || [];
  } catch {
    regions = [];
  }
  fillPlaces();
})();
