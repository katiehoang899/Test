'use strict';

// Báo cáo tất cả phiên, chia theo link (có thể lọc theo kịch bản).
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let summary = [];
let scenarios = [];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Nhãn ngắn cho một link (đầy đủ trong tooltip/bảng). */
function shortLink(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)figma\.com$/.test(u.hostname)) return 'Figma · ' + decodeURIComponent(u.pathname.split('/')[3] || u.pathname.split('/')[2] || '');
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || u.pathname);
    return u.host + (u.pathname === '/' ? '' : decodeURIComponent(u.pathname));
  } catch {
    return url;
  }
}

function renderScope() {
  const sel = $('#scope');
  const v = sel.value || params.get('scenario') || '';
  sel.innerHTML = `<option value="">${esc(t('home.all_sessions'))}</option><option value="none">${esc(t('home.unassigned'))}</option>`
    + scenarios.map((sc) => `<option value="${esc(sc.id)}">${esc(sc.name)} (${sc.sessionCount})</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === v) ? v : '';
}

function render() {
  const sum = (f) => summary.reduce((a, g) => a + f(g), 0);
  const tiles = [
    ['overview.links', summary.length],
    ['overview.sessions', sum((g) => g.sessions)],
    ['overview.participants', sum((g) => g.participants)],
    ['overview.total_time', fmtDuration(sum((g) => g.totalMs))],
    ['overview.clicks', Charts.fmtNum(sum((g) => g.clicks))],
  ];
  $('#tiles').innerHTML = tiles.map(([k, v]) => `<div class="stat-tile"><span>${esc(t(k))}</span><b>${esc(v)}</b></div>`).join('');

  const eyeAny = summary.some((g) => g.eyeSessions);
  document.body.classList.toggle('no-eye', !eyeAny);
  $('#rows').innerHTML = summary.length
    ? summary.map((g) => `<tr>
        <td class="url">${g.kind === 'figma' ? '<span class="tag figma">Figma</span> ' : ''}${esc(g.url)}</td>
        <td class="num">${g.sessions}</td>
        <td class="num">${g.participants}</td>
        <td class="num">${fmtDuration(g.avgMs)}</td>
        <td class="num">${fmtDuration(g.totalMs)}</td>
        <td class="num">${g.avgClicks.toFixed(1)}</td>
        <td class="num">${Math.round(g.avgDepth)}%</td>
        <td class="num eye-col">${g.avgAccuracy == null ? '—' : Math.round(g.avgAccuracy) + '%'}</td>
        <td class="nowrap">${esc(new Date(g.lastAt).toLocaleString(I18N.locale()))}</td>
        <td class="actions"><a class="btn" href="/__et/report.html?id=${g.latestId}&merge=1">${esc(t('overview.open_merged'))}</a></td>
      </tr>`).join('')
    : `<tr><td colspan="10" class="muted">${esc(t('overview.empty'))}</td></tr>`;

  const box = $('#charts');
  box.replaceChildren();
  const rows = (f) => summary.map((g) => ({ label: shortLink(g.url), full: g.url, value: f(g) })).sort((a, b) => b.value - a.value).slice(0, 12);
  const common = { tableLabel: t('chart.table'), headers: [t('overview.col_link'), t('chart.col_value')], emptyText: t('overview.empty') };
  Charts.hbar(box, {
    ...common,
    title: t('overview.chart_sessions'),
    subtitle: t('overview.chart_sub_all'),
    rows: rows((g) => g.sessions),
    valueLabel: (v) => t(v === 1 ? 'overview.one_session' : 'overview.n_sessions', { n: v }),
  });
  Charts.hbar(box, {
    ...common,
    title: t('overview.chart_avg_time'),
    subtitle: t('overview.chart_sub_all'),
    rows: rows((g) => g.avgMs / 1000),
    valueLabel: (v) => fmtDuration(v * 1000),
  });
  Charts.hbar(box, {
    ...common,
    title: t('overview.chart_clicks'),
    subtitle: t('overview.chart_sub_all'),
    rows: rows((g) => g.avgClicks),
    valueLabel: (v) => v.toFixed(1),
  });
  Charts.hbar(box, {
    ...common,
    title: t('overview.chart_depth'),
    subtitle: t('overview.chart_sub_all'),
    rows: rows((g) => g.avgDepth),
    valueLabel: (v) => Math.round(v) + '%',
  });
}

async function load() {
  const scope = $('#scope').value;
  const qs = scope ? '?scenario=' + encodeURIComponent(scope) : '';
  history.replaceState(null, '', location.pathname + qs);
  summary = await (await fetch('/__et/api/summary' + qs)).json();
  render();
}

document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.setLanguage(b.dataset.lang)));
document.addEventListener('i18n:change', (e) => {
  document.querySelectorAll('.lang-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === e.detail.language)));
  document.title = t('overview.title') + ' — Heatmap';
  renderScope();
  render();
});
$('#scope').addEventListener('change', load);

(async () => {
  await I18N.load();
  scenarios = await (await fetch('/__et/api/scenarios')).json().catch(() => []);
  renderScope();
  await load();
})();

Charts.bindToggleAll($('#chartsToggle'), $('#charts'));
