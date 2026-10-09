'use strict';

// Quản lý kịch bản (admin + mod): danh sách, tạo, đổi tên, đi tới cấu hình / phiên / báo cáo; admin xoá được.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let scenarios = [];
let guests = [];
let sessionsTotal = 0;
let unassigned = 0;
let editing = null; // id kịch bản đang đổi tên

function toast(msg, ms = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
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

function renderTiles() {
  const done = guests.filter((g) => g.doneCount > 0).length;
  const tiles = [
    [t('scn.tile_scenarios'), scenarios.length],
    [t('scn.tile_sessions'), sessionsTotal],
    [t('scn.tile_people'), `${done}/${guests.length}`],
    [t('home.unassigned'), unassigned],
  ];
  $('#tiles').innerHTML = tiles.map(([label, value]) => `<div class="stat-tile"><span class="small muted">${esc(label)}</span><b>${esc(value)}</b></div>`).join('');
}

function renderRows() {
  const q = $('#search').value.trim().toLowerCase();
  const list = scenarios
    .filter((sc) => !q || sc.name.toLowerCase().includes(q) || (sc.url || '').toLowerCase().includes(q))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (!list.length) {
    $('#rows').innerHTML = `<tr><td colspan="6" class="muted">${esc(scenarios.length ? t('scn.no_match') : t('ppl.no_scenarios'))}</td></tr>`;
    return;
  }
  $('#rows').innerHTML = list.map((sc) => {
    const people = guests.filter((g) => g.scenarioIds.includes(sc.id));
    const done = people.filter((g) => g.doneCount > 0).length;
    const live = people.filter((g) => g.inProgress).length;
    const pct = people.length ? Math.round((done / people.length) * 100) : 0;
    const name = editing === sc.id
      ? `<form class="row rename-form" data-id="${esc(sc.id)}" style="gap: 6px; flex-wrap: nowrap">
          <input type="text" class="rename-input" value="${esc(sc.name)}" maxlength="120" required aria-label="${esc(t('home.rename_scenario'))}">
          <button type="submit" class="primary">${esc(t('home.save'))}</button>
          <button type="button" data-act="cancel">${esc(t('sum.cancel'))}</button>
        </form>`
      : `<a class="scn-name" href="/__et/participants.html?scenario=${esc(sc.id)}">${esc(sc.name)}</a>
         <div class="small muted scn-url">${sc.url ? esc(sc.url) : esc(t('ppl.no_url'))}</div>`;
    const opts = [
      sc.kind === 'figma' ? '<span class="tag figma">Figma</span>' : '',
      sc.eyeTracking !== false ? `<span class="tag">📷 ${esc(t('scn.eye'))}</span>` : '',
      sc.recordAudio ? `<span class="tag">🎙 ${esc(t('scn.audio'))}</span>` : '',
    ].join(' ');
    return `<tr>
      <td>${name}</td>
      <td class="num">${sc.sessionCount}</td>
      <td>
        <div class="progress-mini" title="${esc(t('ppl.progress', { done, total: people.length }))}"><span style="width: ${pct}%"></span></div>
        <span class="small">${esc(t('ppl.progress', { done, total: people.length }))}</span>
        ${live ? `<span class="tag warn"><span class="live-dot"></span>${esc(t('scn.live', { n: live }))}</span>` : ''}
      </td>
      <td>${opts || '<span class="muted">—</span>'}</td>
      <td class="nowrap small">${sc.createdAt ? esc(new Date(sc.createdAt).toLocaleDateString(I18N.locale())) : '—'}</td>
      <td class="actions">
        <a class="btn" href="/__et/participants.html?scenario=${esc(sc.id)}">${esc(t('scn.manage'))}</a>
        <a class="btn" href="/__et/?scenario=${esc(sc.id)}">${esc(t('scn.sessions'))}</a>
        <a class="btn" href="/__et/overview.html?scenario=${esc(sc.id)}">${esc(t('home.report'))}</a>
        <button type="button" data-act="rename" data-id="${esc(sc.id)}">${esc(t('home.rename_scenario'))}</button>
        <button type="button" class="danger admin-only" data-act="delete" data-id="${esc(sc.id)}" title="${esc(t('home.delete_scenario'))}" aria-label="${esc(t('home.delete_scenario'))}">✕</button>
      </td>
    </tr>`;
  }).join('');
  const input = document.querySelector('.rename-input');
  if (input) {
    input.focus();
    input.select();
  }
}

function render() {
  renderTiles();
  renderRows();
}

async function load() {
  const [sc, users, sessions] = await Promise.all([api('GET', '/scenarios'), api('GET', '/users'), api('GET', '/sessions')]);
  scenarios = sc;
  guests = users.filter((u) => u.role === 'guest');
  sessionsTotal = sessions.length;
  const known = new Set(sc.map((x) => x.id));
  unassigned = sessions.filter((s) => !s.scenarioId || !known.has(s.scenarioId)).length;
  render();
}

$('#createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#createError').textContent = '';
  const name = $('#createName').value.trim();
  if (!name) return;
  try {
    const sc = await api('POST', '/scenarios', { name, eyeTracking: true });
    $('#createName').value = '';
    toast(t('scn.created', { name: sc.name }));
    await load();
  } catch (err) {
    $('#createError').textContent = err.message;
  }
});

$('#search').addEventListener('input', renderRows);

$('#rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'rename') {
    editing = b.dataset.id;
    renderRows();
  } else if (b.dataset.act === 'cancel') {
    editing = null;
    renderRows();
  } else if (b.dataset.act === 'delete') {
    const sc = scenarios.find((x) => x.id === b.dataset.id);
    if (!sc || !confirm(t('home.delete_scenario_confirm', { name: sc.name }))) return;
    try {
      await api('DELETE', '/scenarios/' + sc.id);
      await load();
    } catch (err) {
      toast(err.message, 4000);
    }
  }
});

$('#rows').addEventListener('submit', async (e) => {
  const form = e.target.closest('.rename-form');
  if (!form) return;
  e.preventDefault();
  const name = form.querySelector('.rename-input').value.trim();
  if (!name) return;
  try {
    await api('PATCH', '/scenarios/' + form.dataset.id, { name });
    editing = null;
    toast(t('scn.renamed'));
    await load();
  } catch (err) {
    toast(err.message, 4000);
  }
});

$('#rows').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editing) {
    editing = null;
    renderRows();
  }
});

document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.setLanguage(b.dataset.lang)));
document.addEventListener('i18n:change', (e) => {
  document.querySelectorAll('.lang-switch button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.lang === e.detail.language)));
  if (scenarios.length || guests.length) render();
});

Nav.breadcrumb(() => [Nav.home(), { label: t('nav.scenarios') }]);
I18N.load().then(load);
// cập nhật tiến độ người tham gia
setInterval(() => { if (!document.hidden && !editing) load().catch(() => {}); }, 10000);
