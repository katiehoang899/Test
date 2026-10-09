'use strict';

// Trang người tham gia: các kịch bản được giao → đồng ý ghi → bắt đầu phiên.
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMobile = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;

let scenarios = [];
let picked = null;

function fmtWhen(iso) {
  return new Date(iso).toLocaleString(I18N.locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

function renderHello() {
  const me = window.HeatmapAccount && HeatmapAccount.me;
  $('#hello').textContent = me ? t('guest.hello', { name: me.name }) : '';
}

function render() {
  renderHello();
  const box = $('#scenarios');
  if (!scenarios.length) {
    box.innerHTML = `<div class="card muted">${esc(t('guest.none'))}</div>`;
    return;
  }
  box.innerHTML = scenarios.map((sc) => {
    const done = sc.sessions.filter((s) => s.endedAt);
    const open = sc.sessions.find((s) => !s.endedAt);
    const status = done.length
      ? `<span class="tag ok">✓ ${esc(t('guest.status_done', { when: fmtWhen(done[0].endedAt) }))}</span>`
      : open ? `<span class="tag warn">${esc(t('guest.status_open'))}</span>`
        : `<span class="tag">${esc(t('guest.status_new'))}</span>`;
    const needs = [
      `<li>🖱 ${esc(t('guest.needs_mouse'))}</li>`,
      sc.eyeTracking ? `<li>📷 ${esc(t('guest.needs_camera'))}</li>` : '',
      sc.recordAudio ? `<li>🎙 ${esc(t('guest.needs_mic'))}</li>` : '',
    ].join('');
    const warn = isMobile && sc.eyeTracking ? `<p class="small" style="color: var(--warn)">${esc(t('guest.mobile_warn'))}</p>` : '';
    const action = !sc.url
      ? `<p class="small muted">${esc(t('guest.no_url'))}</p>`
      : `<button type="button" class="primary" data-start="${esc(sc.id)}">${esc(done.length || open ? t('guest.start_again') : t('guest.start'))}</button>`;
    return `<article class="card scenario-card">
      <div class="sessions-head"><h2 style="margin: 0">${esc(sc.name)}</h2>${status}</div>
      ${sc.instructions ? `<div class="instructions"><b>${esc(t('guest.task'))}</b><p>${esc(sc.instructions)}</p></div>` : ''}
      <p class="small muted" style="margin-bottom: 4px">${esc(t('guest.will_record'))}</p>
      <ul class="needs">${needs}</ul>
      ${warn}
      ${action}
    </article>`;
  }).join('');
}

async function load() {
  const res = await fetch('/__et/api/guest/scenarios');
  if (res.status === 401) return (location.href = '/__et/login.html');
  scenarios = res.ok ? await res.json() : [];
  render();
}

// ---------- đồng ý & bắt đầu ----------

$('#scenarios').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-start]');
  if (!btn) return;
  picked = scenarios.find((sc) => sc.id === btn.dataset.start);
  if (!picked) return;
  $('#consentScenario').textContent = t('guest.consent_scenario', { name: picked.name });
  $('#consentList').innerHTML = [
    t('guest.consent_mouse'),
    picked.eyeTracking ? t('guest.consent_camera') : null,
    picked.recordAudio ? t('guest.consent_mic') : null,
    t('guest.consent_screen'),
    t('guest.consent_storage'),
  ].filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('');
  $('#consentCheck').checked = false;
  $('#consentError').textContent = '';
  $('#consentDialog').showModal();
});

$('#consentCancel').addEventListener('click', () => $('#consentDialog').close());
$('#consentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('#consentCheck').checked) return;
  $('#consentStart').disabled = true;
  try {
    const res = await fetch('/__et/api/guest/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: picked.id, consent: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    location.href = '/__et/track.html?id=' + data.id;
  } catch (err) {
    $('#consentError').textContent = err.message;
    $('#consentStart').disabled = false;
  }
});

document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.setLanguage(b.dataset.lang)));
document.addEventListener('i18n:change', (e) => {
  document.querySelectorAll('.lang-switch button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.lang === e.detail.language)));
  render();
});
document.addEventListener('account:ready', renderHello);

if (params.get('done')) $('#doneBanner').hidden = false;
I18N.load().then(load);
