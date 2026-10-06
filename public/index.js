'use strict';

const $ = (s) => document.querySelector(s);
const desktop = window.etDesktop || null;
const isDesktop = !!(desktop && desktop.webview);
let activeTab = 'web';
let scenarios = [];
let sessionsCache = [];
let startPick = null; // { mode, id } — lần chọn gần nhất, nhớ giữa các lần mở
let scenariosLoaded = false;
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
  $('#aiKeyState').textContent = settings.aiKey === 'settings' ? t('settings.ai_key_saved', { hint: settings.aiKeyHint })
    : settings.aiKey === 'env' ? t('settings.ai_key_env') : t('settings.ai_key_none');
  $('#aiKeyRemove').hidden = settings.aiKey !== 'settings';
  // Tắt eye tracking trong Cài đặt → ẩn hẳn tuỳ chọn webcam và cột Eye tracking
  $('#eyeOption').hidden = !settings.eyeTrackingEnabled;
  renderAudioOption();
  document.body.classList.toggle('no-eye', !settings.eyeTrackingEnabled);
  if (isDesktop) {
    $('#url').placeholder = t('home.url_placeholder_desktop');
    $('#urlHint').textContent = t('home.url_hint_desktop');
  } else {
    $('#urlHint').textContent = t('home.url_hint_web');
  }
}

// Ghi âm chỉ có khi bật eye tracking bằng webcam.
function renderAudioOption() {
  $('#audioOption').hidden = !I18N.settings.eyeTrackingEnabled || !$('#eyeTracking').checked;
}
$('#eyeTracking').addEventListener('change', renderAudioOption);

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

// API key chỉ được gửi lên server cục bộ và lưu trong settings.json; trang không bao giờ đọc lại key.
$('#aiKeySave').addEventListener('click', async () => {
  const key = $('#setAiKey').value.trim();
  if (!key) return;
  await I18N.save({ anthropicApiKey: key });
  $('#setAiKey').value = '';
  saved();
});
$('#aiKeyRemove').addEventListener('click', () => I18N.save({ anthropicApiKey: '' }).then(saved));

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

  renderStartScenario();

  $('#bulkScenario').innerHTML = opts;
  const one = filter.value && filter.value !== 'none';
  $('#renameScenario').hidden = !one;
  $('#deleteScenario').hidden = !one;
  $('#overviewLink').href = '/__et/overview.html' + (filter.value ? '?scenario=' + encodeURIComponent(filter.value) : '');
}

/**
 * Hỏi tên kịch bản bằng hộp thoại trong trang (app desktop không có window.prompt()).
 * save(name) lưu lên server; lỗi được hiện ngay trong hộp thoại. Trả về kết quả của save, hoặc null nếu huỷ.
 */
function askScenarioName({ title, ok, value = '', save }) {
  const dlg = $('#nameDialog');
  const input = $('#nameInput');
  $('#nameTitle').textContent = title;
  $('#nameOk').textContent = ok;
  $('#nameError').textContent = '';
  input.value = value;
  return new Promise((resolve) => {
    let result = null;
    const submit = async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return input.focus();
      $('#nameOk').disabled = true;
      try {
        result = await save(name);
        dlg.close();
      } catch (err) {
        $('#nameError').textContent = err.message;
      } finally {
        $('#nameOk').disabled = false;
      }
    };
    const cancel = () => dlg.close();
    const done = () => {
      $('#nameForm').removeEventListener('submit', submit);
      $('#nameCancel').removeEventListener('click', cancel);
      resolve(result);
    };
    $('#nameForm').addEventListener('submit', submit);
    $('#nameCancel').addEventListener('click', cancel);
    dlg.addEventListener('close', done, { once: true });
    dlg.showModal();
    input.select();
  });
}

async function createScenario() {
  const sc = await askScenarioName({
    title: t('home.new_scenario'),
    ok: t('home.create'),
    save: (name) => api('POST', '/scenarios', { name }),
  });
  if (sc) await loadScenarios();
  return sc;
}

async function loadScenarios() {
  scenarios = await api('GET', '/scenarios').catch(() => []);
  scenariosLoaded = true;
  renderScenarioSelects();
}

$('#newScenario').addEventListener('click', async () => {
  const sc = await createScenario();
  if (sc) {
    $('#scenarioFilter').value = sc.id;
    renderScenarioSelects();
    followFilter();
    loadSessions();
  }
});
// ---------- kịch bản cho phiên mới: không / có sẵn / tạo mới ----------

const START_STORE = 'heatmap.startScenario';

function loadStartPick() {
  try {
    return JSON.parse(localStorage.getItem(START_STORE) || 'null');
  } catch {
    return null;
  }
}

function saveStartPick(pick) {
  try {
    localStorage.setItem(START_STORE, JSON.stringify(pick));
  } catch { /* chỉ không nhớ được */ }
}

const startMode = () => (document.querySelector('input[name=scMode]:checked') || {}).value || 'none';

function setStartMode(mode) {
  document.querySelectorAll('input[name=scMode]').forEach((r) => { r.checked = r.value === mode; });
  renderStartMode();
}

function renderStartScenario() {
  const select = $('#startScenario');
  const prev = select.value;
  select.innerHTML = scenarios.map((sc) => `<option value="${esc(sc.id)}">${esc(sc.name)} (${sc.sessionCount})</option>`).join('');
  const exists = (id) => scenarios.some((sc) => sc.id === id);
  if (!scenariosLoaded) return; // chưa có danh sách thì chưa chọn mặc định được
  if (!startPick) {
    // lần đầu: ưu tiên kịch bản đang lọc, rồi lựa chọn lần trước
    const filter = $('#scenarioFilter').value;
    const saved = loadStartPick();
    if (filter && exists(filter)) startPick = { mode: 'existing', id: filter };
    else if (saved && saved.mode === 'existing' && exists(saved.id)) startPick = saved;
    else startPick = { mode: 'none' };
    setStartMode(startPick.mode);
    if (startPick.id) select.value = startPick.id;
  } else if (exists(prev)) {
    select.value = prev;
  }
  document.querySelector('input[name=scMode][value=existing]').disabled = !scenarios.length;
  if (startMode() === 'existing' && !scenarios.length) setStartMode('none');
  else renderStartMode();
}

function renderStartMode() {
  const mode = startMode();
  $('#startScenario').hidden = mode !== 'existing';
  $('#newScenarioName').hidden = mode !== 'new';
  const hint = $('#scenarioHint');
  const name = $('#newScenarioName').value.trim().toLowerCase();
  const dup = mode === 'new' && name && scenarios.some((sc) => sc.name.trim().toLowerCase() === name);
  hint.textContent = dup ? t('home.sc_reuse') : !scenarios.length && mode !== 'new' ? t('home.sc_empty') : '';
  hint.hidden = !hint.textContent;
}

document.querySelectorAll('input[name=scMode]').forEach((r) => r.addEventListener('change', () => {
  renderStartMode();
  if (startMode() === 'new') $('#newScenarioName').focus();
}));
$('#newScenarioName').addEventListener('input', renderStartMode);

/** Kịch bản cho phiên sắp tạo: id có sẵn, tạo mới theo tên, hoặc không có. */
async function resolveStartScenario() {
  const mode = startMode();
  if (mode === 'existing') return $('#startScenario').value || undefined;
  if (mode !== 'new') return undefined;
  const name = $('#newScenarioName').value.trim();
  if (!name) {
    $('#newScenarioName').focus();
    throw new Error(t('home.sc_name_required'));
  }
  // trùng tên thì dùng lại kịch bản đó thay vì tạo bản sao
  const same = scenarios.find((sc) => sc.name.trim().toLowerCase() === name.toLowerCase());
  if (same) return same.id;
  const sc = await api('POST', '/scenarios', { name });
  scenarios.push(sc);
  return sc.id;
}
/** Đang xem một kịch bản → phiên mới mặc định thuộc kịch bản đó. */
function followFilter() {
  const id = $('#scenarioFilter').value;
  if (!scenarios.some((sc) => sc.id === id)) return;
  $('#startScenario').value = id;
  setStartMode('existing');
}

$('#scenarioFilter').addEventListener('change', () => {
  selected.clear();
  renderScenarioSelects();
  followFilter();
  loadSessions();
});
$('#renameScenario').addEventListener('click', async () => {
  const id = $('#scenarioFilter').value;
  const renamed = await askScenarioName({
    title: t('home.rename_scenario'),
    ok: t('home.save'),
    value: scenarioName(id),
    save: (name) => api('PATCH', '/scenarios/' + id, { name }),
  });
  if (renamed) loadAll();
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
    const sc = await resolveStartScenario();
    saveStartPick(sc ? { mode: 'existing', id: sc } : { mode: 'none' });
    const data = await api('POST', '/sessions', {
      kind,
      url,
      participant: $('#participant').value,
      eyeTracking: I18N.settings.eyeTrackingEnabled && $('#eyeTracking').checked,
      recordAudio: I18N.settings.eyeTrackingEnabled && $('#eyeTracking').checked && $('#recordAudio').checked,
      scenarioId: sc,
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
