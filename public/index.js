'use strict';

const $ = (s) => document.querySelector(s);
const isDesktop = !!(window.etDesktop && window.etDesktop.webview);
let activeTab = 'web';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
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
  loadSessions();
});

document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.save({ language: b.dataset.lang })));
$('#openSettings').addEventListener('click', () => $('#settingsDialog').showModal());
$('#setLanguage').addEventListener('change', (e) => I18N.save({ language: e.target.value }).then(() => toast(t('settings.saved'))));
$('#setEye').addEventListener('change', (e) => I18N.save({ eyeTrackingEnabled: e.target.checked }).then(() => toast(t('settings.saved'))));

// ---------- tạo phiên ----------

$('#startForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#formError').textContent = '';
  const kind = activeTab;
  const url = (kind === 'figma' ? $('#figmaUrl') : $('#url')).value.trim();
  if (!url) {
    (kind === 'figma' ? $('#figmaUrl') : $('#url')).focus();
    return;
  }
  const isLocalFile = /^(file:|\/|~\/|[a-z]:\\)/i.test(url);
  if (kind === 'web' && isLocalFile && !isDesktop) {
    $('#formError').textContent = t('home.local_file_web');
    return;
  }
  try {
    const res = await fetch('/__et/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        url,
        participant: $('#participant').value,
        eyeTracking: I18N.settings.eyeTrackingEnabled && $('#eyeTracking').checked,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('home.create_failed'));
    location.href = '/__et/track.html?id=' + data.id;
  } catch (err) {
    $('#formError').textContent = err.message;
  }
});

if (window.etDesktop && window.etDesktop.pickHtmlFile) {
  $('#pickFile').hidden = false;
  $('#pickFile').addEventListener('click', async () => {
    const url = await window.etDesktop.pickHtmlFile();
    if (url) $('#url').value = url;
  });
}

// ---------- danh sách phiên ----------

async function loadSessions() {
  const tbody = $('#sessions');
  try {
    const list = await (await fetch('/__et/api/sessions')).json();
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted">${esc(t('home.no_sessions'))}</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map((s) => {
      const acc = s.calibration && s.calibration.accuracy != null
        ? `<span class="tag ${s.calibration.accuracy >= 70 ? 'ok' : 'warn'}">${Math.round(s.calibration.accuracy)}%</span>`
        : s.eyeTracking ? `<span class="tag warn">${esc(t('home.not_calibrated'))}</span>` : `<span class="tag">${esc(t('common.off'))}</span>`;
      const kind = s.kind === 'figma' ? '<span class="tag figma">Figma</span> ' : '';
      return `<tr>
        <td>${esc(new Date(s.createdAt).toLocaleString(I18N.locale()))}</td>
        <td class="url">${kind}${esc(s.url)}</td>
        <td>${esc(s.participant || '—')}</td>
        <td>${s.eventCount || 0}</td>
        <td class="eye-col">${acc}</td>
        <td style="white-space: nowrap">
          <a class="btn" href="/__et/report.html?id=${s.id}">${esc(t('home.report'))}</a>
          <button class="danger" data-del="${s.id}" title="${esc(t('home.delete'))}" aria-label="${esc(t('home.delete'))}">✕</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">${esc(t('home.error', { msg: err.message }))}</td></tr>`;
  }
}

$('#sessions').addEventListener('click', async (e) => {
  const id = e.target.dataset && e.target.dataset.del;
  if (!id || !confirm(t('home.delete_confirm'))) return;
  await fetch('/__et/api/sessions/' + id, { method: 'DELETE' });
  loadSessions();
});

$('#reload').addEventListener('click', loadSessions);
I18N.load();
