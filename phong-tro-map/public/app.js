'use strict';

/* global L, Filters */

const PAGE = 50; // số tin mỗi lần gọi API (tối đa của Chợ Tốt)
const LOAD_ALL_CAP = 5000; // "Tải tất cả" dừng ở đây để không gọi API quá nhiều
const RENDER_STEP = 60; // số thẻ tin thêm vào danh sách mỗi lần cuộn
const AUTO_FILL_MIN = 20; // bộ lọc loại trừ ẩn nhiều tin: tự tải thêm trang cho đủ số tin này…
const AUTO_FILL_PAGES = 8; // …nhưng không quá số trang này mỗi lần, sau đó chờ người dùng bấm "Xem thêm"
const LOCAL_ONLY = ['nq', 'nosale']; // bộ lọc chỉ chạy trên trình duyệt, đổi không cần gọi lại API

const $ = (s) => document.querySelector(s);
const el = {
  form: $('#filters'), q: $('#q'), searchForm: $('#searchForm'),
  st: $('#st'), region: $('#region'), area: $('#area'), ward: $('#ward'),
  f: $('#f'), sort: $('#sort'), reset: $('#reset'),
  priceMin: $('#priceMin'), priceMax: $('#priceMax'), sizeMin: $('#sizeMin'), sizeMax: $('#sizeMax'),
  priceLabel: $('#priceLabel'), sizeLabel: $('#sizeLabel'), furnLabel: $('#furnLabel'),
  count: $('#count'), list: $('#list'), loadAll: $('#loadAll'), inBounds: $('#inBounds'), approx: $('#approx'),
  nqLabel: $('#nqLabel'), nqChips: $('#nqChips'), nqInput: $('#nqInput'), nqAdd: $('#nqAdd'), nqSuggest: $('#nqSuggest'),
  nosale: $('#nosale'), showHidden: $('#showHidden'), showHiddenWrap: $('#showHiddenWrap'),
};

let state = Filters.stateFromSearch(location.search);
let regions = []; // [{ id, name, areas: [{ id, name }] }] từ API, rỗng nếu API khu vực không trả về
const seenPlaces = { regions: new Map(), areas: new Map(), wards: new Map() }; // dự phòng: lấy từ tin đã tải

const store = { ads: new Map(), total: 0, offset: 0, done: false, loading: false, token: 0, error: '' };
let loadingAll = false;
let visible = []; // tin đang hiển thị (sau lọc + sắp xếp)
let rendered = 0;
let fitPending = true;
let autoPages = 0;
const hiddenCount = { sale: 0, keyword: 0 };

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
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);
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
    <a class="go" href="${esc(ad.url)}" target="_blank" rel="noopener">Xem tin trên Nhà Tốt ↗</a>
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
  for (const ad of filteredAds()) {
    const ll = adLatLng(ad);
    if (!ll) continue;
    const m = L.marker(ll, { icon: ad.lat != null ? icons.exact : icons.approx, title: ad.title });
    m.bindPopup(() => popupHtml(ad), { maxWidth: 260, minWidth: 220 });
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
  const out = [];
  for (const ad of store.ads.values()) {
    if (!Filters.matches(ad, state)) continue;
    ad.hidden = Filters.hiddenReason(ad, state, saleOf(ad));
    if (ad.hidden) {
      hiddenCount[ad.hidden.kind]++;
      if (!withHidden) continue;
    }
    out.push(ad);
  }
  return Filters.sortAds(out, state.sort);
}

function cardHtml(ad) {
  const where = [ad.ward, ad.area, ad.region].filter(Boolean).join(', ');
  const tags = [
    ad.size ? `${ad.size} m²` : '',
    ad.furnishingText || '',
    ad.deposit ? `Cọc ${Filters.formatMoney(ad.deposit)}` : '',
  ].filter(Boolean);
  const loc = ad.lat != null ? '' : ad.approxAt ? '<span class="badge soft">Vị trí gần đúng</span>' : '<span class="badge soft">Chưa có vị trí</span>';
  const sale = saleOf(ad);
  const saleBadge = !ad.hidden && sale.length ? `<span class="badge sale" title="${esc('Dấu hiệu: ' + sale.join(', '))}">Có thể là sale</span>` : '';
  return `<article class="card${ad.hidden ? ' is-hidden' : ''}" data-id="${esc(ad.id)}" tabindex="0">
    <div class="thumb">${ad.thumb ? `<img src="${esc(ad.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span>Không có ảnh</span>'}
      ${ad.imageCount > 1 ? `<span class="imgs">${ad.imageCount} ảnh</span>` : ''}</div>
    <div class="info">
      <a class="title" href="${esc(ad.url)}" target="_blank" rel="noopener">${esc(ad.title)}</a>
      <div class="price">${esc(priceText(ad))}</div>
      <div class="tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      <div class="where">${esc(where)}</div>
      <div class="meta">
        <span>${esc(ad.date)}</span>
        <span class="badge ${ad.isCompany ? 'pro' : ''}">${ad.isCompany ? 'Môi giới' : 'Cá nhân'}</span>
        ${ad.type === 'h' ? '<span class="badge">Cần thuê</span>' : ''}
        ${loc}
        ${saleBadge}
      </div>
      ${ad.hidden ? `<div class="why">Bị ẩn: ${esc(ad.hidden.text)}</div>` : ''}
    </div>
  </article>`;
}

// keep = true: giữ số thẻ đã hiện (khi chỉ có thêm tin mới) để danh sách không nhảy về đầu.
function renderList(keep = false) {
  const count = keep ? Math.max(rendered, RENDER_STEP) : RENDER_STEP;
  let list = filteredAds({ withHidden: el.showHidden.checked });
  if (el.inBounds.checked) {
    const b = map.getBounds();
    list = list.filter((ad) => {
      const ll = adLatLng(ad);
      return ll && b.contains(ll);
    });
  }
  visible = list;
  rendered = 0;
  el.list.innerHTML = '';
  if (!list.length) {
    const hidden = hiddenCount.sale + hiddenCount.keyword;
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

// Bộ lọc loại trừ có thể ẩn gần hết một trang: tự tải thêm vài trang cho đủ tin để xem.
function maybeAutoFill() {
  if (store.done || store.loading || store.error || loadingAll || el.inBounds.checked) return;
  if (visible.length >= AUTO_FILL_MIN || autoPages >= AUTO_FILL_PAGES) return;
  if (!hiddenCount.sale && !hiddenCount.keyword) return;
  autoPages++;
  loadPage();
}

function renderMore(step = RENDER_STEP) {
  const next = visible.slice(rendered, rendered + step);
  rendered += next.length;
  el.list.querySelector('.sentinel')?.remove();
  el.list.insertAdjacentHTML('beforeend', next.map(cardHtml).join(''));
  const more = rendered < visible.length || (!store.done && !el.inBounds.checked);
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
  else if (!store.done && !store.loading) loadPage();
}

el.list.addEventListener('click', (e) => {
  if (e.target.closest('.sentinel button')) return onSentinel();
  if (e.target.closest('a')) return;
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
  if (store.error && !loaded) text = store.error;
  else if (!loaded && store.loading) text = 'Đang tải…';
  else {
    text = `${shown.toLocaleString('vi-VN')} tin hiển thị · đã tải ${loaded.toLocaleString('vi-VN')} / ${store.total.toLocaleString('vi-VN')} tin · ${onMap.toLocaleString('vi-VN')} trên bản đồ`;
    if (store.loading) text += ' · đang tải…';
    if (geo.pending) text += ` · đang định vị ${geo.pending} khu vực…`;
    const parts = [];
    if (hiddenCount.sale) parts.push(`${hiddenCount.sale.toLocaleString('vi-VN')} tin sale`);
    if (hiddenCount.keyword) parts.push(`${hiddenCount.keyword.toLocaleString('vi-VN')} tin có từ khoá loại trừ`);
    if (parts.length) text += ` · đã ẩn ${parts.join(', ')}`;
  }
  el.count.textContent = text;
  el.showHiddenWrap.hidden = !hiddenCount.sale && !hiddenCount.keyword && !el.showHidden.checked;
  el.loadAll.textContent = loadingAll ? '■ Dừng tải' : store.done ? 'Đã tải hết' : 'Tải tất cả';
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
    const data = await api('/api/ads?' + Filters.toApiParams(state, store.offset, PAGE));
    if (token !== store.token) return;
    store.total = data.total || 0;
    store.offset += PAGE;
    for (const ad of data.ads) {
      if (!store.ads.has(ad.id)) store.ads.set(ad.id, ad);
      rememberPlaces(ad);
    }
    if (!data.ads.length || store.offset >= store.total) store.done = true;
    queueGeocode(data.ads);
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
  store.total = 0;
  store.offset = 0;
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
    if (!store.ads.has(ad.id)) continue;
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

function fillSelect(select, firstLabel, items, selected) {
  select.replaceChildren(option('', firstLabel, selected), ...items.map((it) => option(it.id, it.name, selected)));
  // Giữ lựa chọn từ URL kể cả khi chưa có tên (danh sách chưa tải xong).
  if (selected && !items.some((it) => String(it.id) === String(selected))) select.append(option(selected, `Mã ${selected}`, selected));
  select.disabled = select !== el.region && !items.length && !selected;
}

function sortedPlaces(m) {
  return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

function rememberPlaces(ad) {
  let changed = false;
  const put = (m, id, name) => {
    if (id == null || !name || m.has(String(id))) return;
    m.set(String(id), name);
    changed = true;
  };
  put(seenPlaces.regions, ad.regionId, ad.region);
  if (!state.region_v2 || String(ad.regionId) === String(state.region_v2)) put(seenPlaces.areas, ad.areaId, ad.area);
  if (state.area_v2 && String(ad.areaId) === String(state.area_v2)) put(seenPlaces.wards, ad.wardId, ad.ward);
  if (changed) {
    clearTimeout(rememberPlaces.t);
    rememberPlaces.t = setTimeout(fillPlaces, 300);
  }
}

let wardsFor = null;
let wardsList = [];

async function fillPlaces() {
  const regionItems = regions.length ? regions : sortedPlaces(seenPlaces.regions);
  fillSelect(el.region, 'Toàn quốc', regionItems, state.region_v2);

  const region = regions.find((r) => String(r.id) === String(state.region_v2));
  const areaItems = region ? region.areas : state.region_v2 ? sortedPlaces(seenPlaces.areas) : [];
  fillSelect(el.area, 'Tất cả quận / huyện', areaItems, state.area_v2);

  if (state.area_v2 && wardsFor !== state.area_v2) {
    wardsFor = state.area_v2;
    wardsList = [];
    const area = state.area_v2;
    const data = await api('/api/wards?area=' + encodeURIComponent(area)).catch(() => ({ wards: [] }));
    if (wardsFor === area) wardsList = data.wards || [];
  }
  const wardItems = !state.area_v2 ? [] : wardsList.length ? wardsList : sortedPlaces(seenPlaces.wards);
  fillSelect(el.ward, 'Tất cả phường / xã', wardItems, state.ward);
}

function syncForm() {
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
    x.textContent = '×';
    chip.append(x);
    return chip;
  }));
  const folded = Filters.splitKeywords(state.nq);
  el.nqSuggest.querySelectorAll('button').forEach((b) => { b.disabled = folded.includes(Filters.splitKeywords(b.dataset.k)[0]); });
  document.querySelectorAll('.pop').forEach((p) => p.classList.toggle('set', Boolean(p.querySelector('b').textContent)));
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
  update({ region_v2: el.region.value, area_v2: '', ward: '' });
});
el.area.addEventListener('change', () => {
  seenPlaces.wards.clear();
  update({ area_v2: el.area.value, ward: '' });
});
el.ward.addEventListener('change', () => update({ ward: el.ward.value }));

el.form.addEventListener('click', (e) => {
  const preset = e.target.closest('.presets button');
  if (preset) {
    const key = preset.parentElement.dataset.target;
    preset.closest('details').open = false;
    return update({ [key]: state[key] === preset.dataset.v ? '' : preset.dataset.v });
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
  restart();
  try {
    regions = (await api('/api/regions')).regions || [];
  } catch {
    regions = [];
  }
  fillPlaces();
})();
