'use strict';

// Nhóm quản lý (chỉ admin): tạo tài khoản Mod, cấp mật khẩu mới, khoá / mở khoá, xoá.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let staff = [];
let creds = null; // { user, password } vừa tạo / cấp lại — chỉ hiện một lần

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

function renderCreds() {
  $('#creds').hidden = !creds;
  if (!creds) return;
  $('#credsBody').innerHTML = `<tr>
    <td><b>${esc(creds.user.name)}</b></td>
    <td><code>${esc(creds.user.username)}</code></td>
    <td><code>${esc(creds.password)}</code></td>
  </tr>`;
}

function renderRows() {
  const me = window.HeatmapAccount && HeatmapAccount.me;
  $('#rows').innerHTML = staff.map((u) => {
    const isMe = me && me.id === u.id;
    const role = `<span class="tag ${u.role === 'admin' ? 'scenario' : ''}">${esc(t('acct.role_' + u.role))}</span>${u.disabled ? ` <span class="tag">${esc(t('ppl.status_disabled'))}</span>` : ''}`;
    const actions = u.role === 'mod'
      ? `<button type="button" data-act="reset" data-id="${esc(u.id)}">${esc(t('ppl.reset'))}</button>
         <button type="button" data-act="toggle" data-id="${esc(u.id)}">${esc(u.disabled ? t('ppl.enable') : t('ppl.disable'))}</button>
         <button type="button" class="danger" data-act="delete" data-id="${esc(u.id)}" title="${esc(t('ppl.delete'))}" aria-label="${esc(t('ppl.delete'))}">✕</button>`
      : '';
    return `<tr>
      <td><b>${esc(u.name)}</b>${isMe ? ` <span class="small muted">(${esc(t('team.you'))})</span>` : ''}</td>
      <td><code>${esc(u.username)}</code></td>
      <td>${role}</td>
      <td class="nowrap small">${u.lastLoginAt ? esc(new Date(u.lastLoginAt).toLocaleString(I18N.locale())) : '—'}</td>
      <td class="actions">${actions}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="muted">—</td></tr>`;
}

async function load() {
  const users = await api('GET', '/users');
  staff = users.filter((u) => u.role !== 'guest').sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'admin' ? -1 : 1));
  renderRows();
}

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#addError').textContent = '';
  try {
    creds = await api('POST', '/users', { role: 'mod', name: $('#modName').value.trim(), username: $('#modUsername').value.trim() });
    $('#modName').value = '';
    $('#modUsername').value = '';
    renderCreds();
    await load();
  } catch (err) {
    $('#addError').textContent = err.message;
  }
});

$('#copyCreds').addEventListener('click', async () => {
  const text = t('team.invite', { name: creds.user.name, link: `${location.origin}/__et/login.html?u=${encodeURIComponent(creds.user.username)}`, username: creds.user.username, password: creds.password });
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(t('ppl.invite_copied'));
});
$('#copyCredsLink').addEventListener('click', async () => {
  const link = `${location.origin}/__et/login.html?u=${encodeURIComponent(creds.user.username)}`;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = link;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(t('ppl.link_copied'));
});
$('#closeCreds').addEventListener('click', () => { creds = null; renderCreds(); });

$('#rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const u = staff.find((x) => x.id === b.dataset.id);
  if (!u) return;
  try {
    if (b.dataset.act === 'reset') {
      if (!confirm(t('ppl.reset_confirm', { name: u.name }))) return;
      creds = await api('POST', `/users/${u.id}/reset-password`);
      renderCreds();
    } else if (b.dataset.act === 'toggle') {
      await api('PATCH', '/users/' + u.id, { disabled: !u.disabled });
    } else if (b.dataset.act === 'delete') {
      if (!confirm(t('team.delete_confirm', { name: u.name }))) return;
      await api('DELETE', '/users/' + u.id);
    }
    await load();
  } catch (err) {
    toast(err.message, 4000);
  }
});

document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.setLanguage(b.dataset.lang)));
document.addEventListener('i18n:change', (e) => {
  document.querySelectorAll('.lang-switch button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.lang === e.detail.language)));
  renderRows();
  renderCreds();
});
document.addEventListener('account:ready', renderRows);

Nav.breadcrumb(() => [Nav.home(), { label: t('nav.team') }]);
I18N.load().then(load);
