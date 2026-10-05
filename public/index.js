'use strict';

const $ = (s) => document.querySelector(s);
const desktop = window.etDesktop || null;
const isDesktop = !!(desktop && desktop.webview);
let activeTab = 'web';
let scenarios = [];
let sessionsCache = [];
const selected = new Set();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 2200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function fmtDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

async function api(method, path, body) {
  const res = await fetch('/__et/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// ---------- tabs: website / file  |  Figma prototype ----------

function selectTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  $('#formError').textContent = '';
  (name === 'figma' ? $('#figmaUrl') : $('#url')).focus();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

// ---------- cài đặt & ngôn ngữ ----------

function renderSettings(settings) {
  document.querySelectorAll('.lang-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === settings.language)));
  $('#setLanguage').value = settings.language;
  $('#setEye').checked = settings.eyeTrackingEnabled;
  $('#setCamera').checked = !!settings.showCamera;
  $('#cameraSetting').hidden = !settings.eyeTrackingEnabled;
  if (document.activeElement !== $('#setStorage')) $('#setStorage').value = settings.storagePath || '';
  // Tắt eye tracking trong Cài đặt → ẩn hẳn tuỳ chọn webcam và cột Eye tracking
  $('#eyeOption').hidden = !settings.eyeTrackingEnabled;
  document.body.classList.toggle('no-eye', !settings.eyeTrackingEnabled);
  if (isDesktop) {
    $('#url').placeholder = t('home.url_placeholder_desktop');
    $('#urlHint').textContent = t('home.url_hint_desktop');
  } else {
    $('#urlHint').textContent = t('home.url_hint_web');
  }
}

document.addEventListener('i18n:change', (e) => {
  renderSettings(e.detail);
  renderScenarioSelects();
  renderSessions();
});

const saved = () => toast(t('settings.saved'));
document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.save({ language: b.dataset.lang })));
$('#openSettings').addEventListener('click', () => {
  $('#storageError').textContent = '';
  $('#settingsDialog').showModal();
});
$('#setLanguage').addEventListener('change', (e) => I18N.save({ language: e.target.value }).then(saved));
$('#setEye').addEventListener('change', (e) => I18N.save({ eyeTrackingEnabled: e.target.checked }).then(saved));
$('#setCamera').addEventListener('change', (e) => I18N.save({ showCamera: e.target.checked }).then(saved));

async function setStorage(dir) {
  $('#storageError').textContent = '';
  try {
    const before = I18N.settings.storagePath;
    const next = await I18N.save({ storageDir: dir });
    if (next.error) throw new Error(next.error);
    if (next.storagePath !== before) toast(t('settings.storage_moved'));
    loadAll();
  } catch (err) {
    $('#storageError').textContent = err.message;
  }
}
$('#storageApply').addEventListener('click', () => setStorage($('#setStorage').value));
$('#storageDefault').addEventListener('click', () => setStorage(''));
if (desktop && desktop.pickFolder) {
  $('#storageChoose').hidden = false;
  $('#storageOpen').hidden = false;
  $('#storageChoose').addEventListener('click', async () => {
    const dir = await desktop.pickFolder(I18N.settings.storagePath);
    if (dir) {
      $('#setStorage').value = dir;
      setStorage(dir);
    }
  });
  $('#storageOpen').addEventListener('click', () => desktop.openFolder());
}

// ---------- kịch bản ----------

function scenarioName(id) {
  const sc = scenarios.find((x) => x.id === id);
  return sc ? sc.name : '';
}

function renderScenarioSelects() {
  const opts = scenarios.map((sc) => `<option value="${esc(sc.id)}">${esc(sc.name)} (${sc.sessionCount})</option>`).join('');
  const filter = $('#scenarioFilter');
  const fv = filter.value;
  filter.innerHTML = `<option value="">${esc(t('home.all_sessions'))}</option><option value="none">${esc(t('home.unassigned'))}</option>${opts}`;
  filter.value = [...filter.options].some((o) => o.value === fv) ? fv : '';

  const start = $('#startScenario');
  const sv = start.value;
  start.innerHTML = `<option value="">${esc(t('home.no_scenario'))}</option>${opts}<option value="__new">${esc(t('home.new_scenario_option'))}</option>`;
  // phiên mới mặc định thuộc kịch bản đang xem
  start.value = [...start.options].some((o) => o.value === sv && sv !== '__new') ? sv : (filter.value && filter.value !== 'none' ? filter.value : '');

  $('#bulkScenario').innerHTML = opts;
  const one = filter.value && filter.value !== 'none';
  $('#renameScenario').hidden = !one;
  $('#deleteScenario').hidden = !one;
  $('#overviewLink').href = '/__et/overview.html' + (filter.value ? '?scenario=' + encodeURIComponent(filter.value) : '');
}

async function createScenario() {
  const name = prompt(t('home.new_scenario_prompt'));
  if (!name || !name.trim()) return null;
  const sc = await api('POST', '/scenarios', { name });
  await loadScenarios();
  return sc;
}

async function loadScenarios() {
  scenarios = await api('GET', '/scenarios').catch(() => []);
  renderScenarioSelects();
}

$('#newScenario').addEventListener('click', async () => {
  const sc = await createScenario();
  if (sc) {
    $('#scenarioFilter').value = sc.id;
    renderScenarioSelects();
    loadSessions();
  }
});
$('#startScenario').addEventListener('change', async (e) => {
  if (e.target.value !== '__new') return;
  const sc = await createScenario();
  e.target.value = sc ? sc.id : '';
});
$('#scenarioFilter').addEventListener('change', () => {
  selected.clear();
  renderScenarioSelects();
  loadSessions();
});
$('#renameScenario').addEventListener('click', async () => {
  const id = $('#scenarioFilter').value;
  const name = prompt(t('home.new_scenario_prompt'), scenarioName(id));
  if (!name || !name.trim()) return;
  await api('PATCH', '/scenarios/' + id, { name });
  loadAll();
});
$('#deleteScenario').addEventListener('click', async () => {
  const id = $('#scenarioFilter').value;
  if (!confirm(t('home.delete_scenario_confirm', { name: scenarioName(id) }))) return;
  await api('DELETE', '/scenarios/' + id);
  $('#scenarioFilter').value = '';
  loadAll();
});

// ---------- tạo phiên ----------

$('#startForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#formError').textContent = '';
  const kind = activeTab;
  const input = kind === 'figma' ? $('#figmaUrl') : $('#url');
  const url = input.value.trim();
  if (!url) return input.focus();
  const isLocalFile = /^(file:|\/|~\/|[a-z]:\\)/i.test(url);
  if (kind === 'web' && isLocalFile && !isDesktop) {
    $('#formError').textContent = t('home.local_file_web');
    return;
  }
  try {
    const sc = $('#startScenario').value;
    const data = await api('POST', '/sessions', {
      kind,
      url,
      participant: $('#participant').value,
      eyeTracking: I18N.settings.eyeTrackingEnabled && $('#eyeTracking').checked,
      scenarioId: sc && sc !== '__new' ? sc : undefined,
    });
    location.href = '/__et/track.html?id=' + data.id;
  } catch (err) {
    $('#formError').textContent = err.message || t('home.create_failed');
  }
});

if (desktop && desktop.pickHtmlFile) {
  $('#pickFile').hidden = false;
  $('#pickFile').addEventListener('click', async () => {
    const url = await desktop.pickHtmlFile();
    if (url) $('#url').value = url;
  });
}

// ---------- danh sách phiên ----------

function renderBulk() {
  const n = selected.size;
  $('#bulkBar').hidden = n === 0;
  $('#bulkCount').textContent = t('home.selected', { n });
  $('#bulkApply').disabled = !scenarios.length;
  const boxes = [...document.querySelectorAll('#sessions input[data-sel]')];
  $('#selectAll').checked = boxes.length > 0 && boxes.every((b) => b.checked);
  $('#selectAll').indeterminate = n > 0 && !$('#selectAll').checked;
}

function renderSessions() {
  const tbody = $('#sessions');
  const list = sessionsCache;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted">${esc(t('home.no_sessions'))}</td></tr>`;
    renderBulk();
    return;
  }
  tbody.innerHTML = list.map((s) => {
    const acc = s.calibration && s.calibration.accuracy != null
      ? `<span class="tag ${s.calibration.accuracy >= 70 ? 'ok' : 'warn'}">${Math.round(s.calibration.accuracy)}%</span>`
      : s.eyeTracking ? `<span class="tag warn">${esc(t('home.not_calibrated'))}</span>` : `<span class="tag">${esc(t('common.off'))}</span>`;
    const kind = s.kind === 'figma' ? '<span class="tag figma">Figma</span> ' : '';
    const sc = s.scenarioId ? `<span class="tag scenario">${esc(scenarioName(s.scenarioId) || '—')}</span>` : '<span class="muted">—</span>';
    const fileBtn = desktop && desktop.revealSession
      ? `<button type="button" data-act="reveal" data-id="${s.id}">${esc(t('home.show_file'))}</button>` : '';
    return `<tr>
      <td class="sel"><input type="checkbox" data-sel="${s.id}" ${selected.has(s.id) ? 'checked' : ''} aria-label="${esc(t('home.select_row'))}"></td>
      <td class="nowrap">${esc(new Date(s.createdAt).toLocaleString(I18N.locale()))}</td>
      <td class="url">${kind}${esc(s.url)}</td>
      <td>${esc(s.participant || '—')}</td>
      <td class="num">${fmtDuration(s.durationMs)}</td>
      <td class="num">${s.eventCount || 0}</td>
      <td class="eye-col">${acc}</td>
      <td>${sc}</td>
      <td class="actions">
        <a class="btn" href="/__et/report.html?id=${s.id}">${esc(t('home.report'))}</a>
        <button type="button" data-act="save" data-id="${s.id}">${esc(t('home.save_as'))}</button>
        ${fileBtn}
        <button type="button" class="danger" data-act="delete" data-id="${s.id}" title="${esc(t('home.delete'))}" aria-label="${esc(t('home.delete'))}">✕</button>
      </td>
    </tr>`;
  }).join('');
  renderBulk();
}

async function loadSessions() {
  try {
    const f = $('#scenarioFilter').value;
    sessionsCache = await api('GET', '/sessions' + (f ? '?scenario=' + encodeURIComponent(f) : ''));
    for (const id of [...selected]) if (!sessionsCache.some((s) => s.id === id)) selected.delete(id);
    renderSessions();
  } catch (err) {
    $('#sessions').innerHTML = `<tr><td colspan="9">${esc(t('home.error', { msg: err.message }))}</td></tr>`;
  }
}

async function loadAll() {
  await loadScenarios();
  await loadSessions();
}

async function saveAs(id) {
  if (desktop && desktop.saveSessionAs) {
    const path = await desktop.saveSessionAs(id);
    if (path) toast(t('home.saved_to', { path }), 3500);
    return;
  }
  // bản web: trình duyệt tải file về (hỏi nơi lưu nếu được cấu hình như vậy)
  const a = document.createElement('a');
  a.href = `/__et/api/sessions/${id}/export?format=json`;
  a.download = `heatmap-session-${id}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('#sessions').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === 'save') return saveAs(id);
  if (btn.dataset.act === 'reveal') return desktop.revealSession(id);
  if (btn.dataset.act === 'delete') {
    if (!confirm(t('home.delete_confirm'))) return;
    await api('DELETE', '/sessions/' + id);
    selected.delete(id);
    loadAll();
  }
});

$('#sessions').addEventListener('change', (e) => {
  const id = e.target.dataset && e.target.dataset.sel;
  if (!id) return;
  if (e.target.checked) selected.add(id);
  else selected.delete(id);
  renderBulk();
});

$('#selectAll').addEventListener('change', (e) => {
  for (const s of sessionsCache) {
    if (e.target.checked) selected.add(s.id);
    else selected.delete(s.id);
  }
  renderSessions();
});

async function bulkAssign(scenarioId) {
  await Promise.all([...selected].map((id) => api('PATCH', '/sessions/' + id, { scenarioId })));
  selected.clear();
  loadAll();
}
$('#bulkApply').addEventListener('click', () => $('#bulkScenario').value && bulkAssign($('#bulkScenario').value));
$('#bulkRemove').addEventListener('click', () => bulkAssign(null));

$('#reload').addEventListener('click', loadAll);
I18N.load().then(loadAll);
