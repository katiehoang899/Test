'use strict';

// Admin: cấu hình kịch bản cho bản online (link, hướng dẫn, eye tracking / ghi âm)
// và cấp tài khoản guest cho người tham gia. Trạng thái tự cập nhật vài giây một lần.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const REFRESH_MS = 5000;

let scenarios = [];
let users = [];
let currentId = new URLSearchParams(location.search).get('scenario') || '';
let lastCreds = []; // [{ user, password }] vừa tạo — chỉ hiện một lần

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

const current = () => scenarios.find((sc) => sc.id === currentId) || null;
const guestsOf = (id) => users.filter((u) => u.role === 'guest' && u.scenarioIds.includes(id));
const loginLink = (username) => `${location.origin}/__et/login.html?u=${encodeURIComponent(username)}`;

// Các thẻ chèn được vào thư mời; {password} chỉ có khi vừa tạo / cấp lại mật khẩu.
const INVITE_TAGS = ['name', 'scenario', 'link', 'username', 'password', 'instructions'];
const fillInvite = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (INVITE_TAGS.includes(k) ? String(vars[k] ?? '') : m));
const defaultInvite = () => t('ppl.invite'); // mẫu mặc định (chưa điền), theo ngôn ngữ giao diện

function inviteText(user, password) {
  const sc = current();
  return fillInvite((sc && sc.inviteTemplate) || defaultInvite(), {
    name: user.name,
    scenario: sc ? sc.name : '',
    link: loginLink(user.username),
    username: user.username,
    password: password || t('ppl.invite_password_hidden'),
    instructions: sc ? sc.instructions || '' : '',
  });
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http không bảo mật: chép bằng ô chọn tạm
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg || t('sum.copied'));
}

// ---------- danh sách kịch bản ----------

function renderList() {
  $('#scenarioList').innerHTML = scenarios.length
    ? scenarios.map((sc) => {
      const g = guestsOf(sc.id);
      const done = g.filter((u) => u.doneCount > 0).length;
      return `<button type="button" class="side-item" data-id="${esc(sc.id)}" aria-current="${sc.id === currentId}">
        <span class="name">${esc(sc.name)}</span>
        <span class="small muted">${esc(t('ppl.progress', { done, total: g.length }))}${sc.url ? '' : ' · ' + esc(t('ppl.no_url'))}</span>
      </button>`;
    }).join('')
    : `<p class="small muted">${esc(t('ppl.no_scenarios'))}</p>`;
}

$('#scenarioList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  currentId = b.dataset.id;
  lastCreds = [];
  history.replaceState(null, '', '?scenario=' + currentId);
  renderAll(true);
});

$('#newScenarioForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#newScenarioInput').value.trim();
  if (!name) return;
  try {
    const sc = await api('POST', '/scenarios', { name, eyeTracking: true });
    $('#newScenarioInput').value = '';
    currentId = sc.id;
    history.replaceState(null, '', '?scenario=' + currentId);
    await load(true);
    $('#cfgUrl').focus();
  } catch (err) {
    toast(err.message, 4000);
  }
});

// ---------- cấu hình kịch bản ----------

function fillConfig() {
  const sc = current();
  $('#emptyDetail').hidden = !!sc;
  $('#configForm').hidden = !sc;
  $('#peopleCard').hidden = !sc;
  if (!sc) return;
  $('#cfgName').value = sc.name;
  $('#cfgUrl').value = sc.url || '';
  $('#cfgInstructions').value = sc.instructions || '';
  $('#cfgEye').checked = sc.eyeTracking !== false;
  $('#cfgAudio').checked = !!sc.recordAudio;
  $('#cfgAudio').disabled = !$('#cfgEye').checked;
  $('#cfgError').textContent = '';
  $('#overviewLink').href = '/__et/overview.html?scenario=' + encodeURIComponent(sc.id);
}

$('#cfgEye').addEventListener('change', () => {
  $('#cfgAudio').disabled = !$('#cfgEye').checked;
  if (!$('#cfgEye').checked) $('#cfgAudio').checked = false;
});

$('#configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#cfgError').textContent = '';
  try {
    await api('PATCH', '/scenarios/' + currentId, {
      name: $('#cfgName').value.trim(),
      url: $('#cfgUrl').value.trim(),
      kind: /figma\.com\//i.test($('#cfgUrl').value) ? 'figma' : 'web',
      instructions: $('#cfgInstructions').value,
      eyeTracking: $('#cfgEye').checked,
      recordAudio: $('#cfgEye').checked && $('#cfgAudio').checked,
    });
    toast(t('settings.saved'));
    await load(true);
  } catch (err) {
    $('#cfgError').textContent = err.message;
  }
});

// ---------- nội dung thư mời ----------

let inviteLoaded = { id: null, text: '' }; // nội dung đang hiện trong ô sửa, để biết có thay đổi chưa lưu

const inviteDirty = () => inviteLoaded.id === currentId && $('#inviteText').value !== inviteLoaded.text;

function fillInviteEditor(force) {
  const sc = current();
  $('#inviteCard').hidden = !sc;
  if (!sc) return;
  // đang sửa dở thì không ghi đè (tự cập nhật 5 giây / lưu cấu hình)
  if (!force && inviteDirty()) return renderInvite();
  const text = sc.inviteTemplate || defaultInvite();
  $('#inviteText').value = text;
  inviteLoaded = { id: sc.id, text };
  $('#inviteError').textContent = '';
  renderInvite();
}

function renderInvite() {
  const sc = current();
  if (!sc) return;
  $('#inviteTags').innerHTML = INVITE_TAGS.map((k) => `<button type="button" data-tag="${k}">${esc(t('ppl.tag_' + k))}<code>{${k}}</code></button>`).join('');
  $('#inviteState').textContent = inviteDirty() ? t('ppl.invite_unsaved') : sc.inviteTemplate ? t('ppl.invite_custom') : t('ppl.invite_default_note');
  $('#inviteReset').disabled = !sc.inviteTemplate && !inviteDirty();
  // xem trước với người vừa tạo (nếu có) hoặc người mẫu
  const sample = lastCreds[0] || { user: guestsOf(sc.id)[0] || { name: t('ppl.sample_name'), username: 'user12345' }, password: 'aB3dE7gH9k' };
  $('#invitePreview').textContent = fillInvite($('#inviteText').value || defaultInvite(), {
    name: sample.user.name,
    scenario: sc.name,
    link: loginLink(sample.user.username),
    username: sample.user.username,
    password: sample.password,
    instructions: sc.instructions || '',
  });
}

async function saveInvite(text) {
  $('#inviteError').textContent = '';
  // giữ nguyên mẫu mặc định thì không lưu bản riêng, để thư mời vẫn đổi theo ngôn ngữ
  const value = text.trim() === defaultInvite().trim() ? '' : text;
  try {
    const sc = await api('PATCH', '/scenarios/' + currentId, { inviteTemplate: value });
    const local = current();
    if (local) {
      if (sc.inviteTemplate) local.inviteTemplate = sc.inviteTemplate;
      else delete local.inviteTemplate;
    }
    fillInviteEditor(true);
    toast(value ? t('ppl.invite_saved') : t('ppl.invite_reset_done'));
  } catch (err) {
    $('#inviteError').textContent = err.message;
  }
}

$('#inviteText').addEventListener('input', renderInvite);
$('#inviteSave').addEventListener('click', () => saveInvite($('#inviteText').value));
$('#inviteReset').addEventListener('click', () => saveInvite(''));
$('#inviteTags').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  const ta = $('#inviteText');
  ta.focus();
  ta.setRangeText(`{${b.dataset.tag}}`, ta.selectionStart, ta.selectionEnd, 'end');
  renderInvite();
});

// ---------- người tham gia ----------

function statusOf(u) {
  if (u.disabled) return `<span class="tag">${esc(t('ppl.status_disabled'))}</span>`;
  if (u.inProgress) return `<span class="tag warn"><span class="live-dot"></span>${esc(t('ppl.status_progress'))}</span>`;
  if (u.doneCount) return `<span class="tag ok">✓ ${esc(t('ppl.status_done', { n: u.doneCount }))}</span>`;
  if (u.lastLoginAt) return `<span class="tag">${esc(t('ppl.status_logged_in'))}</span>`;
  return `<span class="tag">${esc(t('ppl.status_invited'))}</span>`;
}

function renderPeople() {
  const sc = current();
  if (!sc) return;
  const list = guestsOf(sc.id);
  $('#people').innerHTML = list.length
    ? list.map((u) => `<tr>
        <td><b>${esc(u.name)}</b></td>
        <td><code>${esc(u.username)}</code></td>
        <td>${statusOf(u)}</td>
        <td class="nowrap small">${u.lastLoginAt ? esc(new Date(u.lastLoginAt).toLocaleString(I18N.locale())) : '—'}</td>
        <td class="actions">
          ${u.latestSessionId ? `<a class="btn" href="/__et/report.html?id=${esc(u.latestSessionId)}">${esc(t('home.report'))}</a>` : ''}
          <button type="button" data-act="link" data-id="${esc(u.id)}">${esc(t('ppl.copy_link'))}</button>
          <button type="button" data-act="reset" data-id="${esc(u.id)}">${esc(t('ppl.reset'))}</button>
          <button type="button" data-act="toggle" data-id="${esc(u.id)}">${esc(u.disabled ? t('ppl.enable') : t('ppl.disable'))}</button>
          <button type="button" class="danger" data-act="delete" data-id="${esc(u.id)}" title="${esc(t('ppl.delete'))}" aria-label="${esc(t('ppl.delete'))}">✕</button>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="muted">${esc(t('ppl.no_people'))}</td></tr>`;
}

function renderCreds() {
  $('#creds').hidden = !lastCreds.length;
  $('#credsBody').innerHTML = lastCreds.map(({ user, password }, i) => `<tr>
      <td><b>${esc(user.name)}</b></td>
      <td><code>${esc(user.username)}</code></td>
      <td><code>${esc(password)}</code></td>
      <td class="actions">
        <button type="button" data-copy="${i}">${esc(t('ppl.copy_invite'))}</button>
        <button type="button" data-copy-link="${i}">${esc(t('ppl.copy_link'))}</button>
      </td>
    </tr>`).join('');
}

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#addError').textContent = '';
  const names = $('#addNames').value.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
  if (!names.length) return;
  try {
    lastCreds = await api('POST', '/users', { names, scenarioId: currentId });
    $('#addNames').value = '';
    await load();
    renderCreds();
  } catch (err) {
    $('#addError').textContent = err.message;
  }
});

$('#credsBody').addEventListener('click', (e) => {
  const linkBtn = e.target.closest('[data-copy-link]');
  if (linkBtn) return copy(loginLink(lastCreds[Number(linkBtn.dataset.copyLink)].user.username), t('ppl.link_copied'));
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const { user, password } = lastCreds[Number(b.dataset.copy)];
  copy(inviteText(user, password), t('ppl.invite_copied'));
});
$('#copyAll').addEventListener('click', () => copy(lastCreds.map(({ user, password }) => inviteText(user, password)).join('\n\n----\n\n'), t('ppl.invite_copied')));
// chỉ link mời, mỗi người một dòng (mật khẩu gửi riêng)
$('#copyAllLinks').addEventListener('click', () => copy(lastCreds.map(({ user }) => loginLink(user.username)).join('\n'), t('ppl.links_copied')));
$('#closeCreds').addEventListener('click', () => {
  lastCreds = [];
  renderCreds();
});
$('#downloadCsv').addEventListener('click', () => {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['name', 'username', 'password', 'link'], ...lastCreds.map(({ user, password }) => [user.name, user.username, password, loginLink(user.username)])];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + rows.map((r) => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
  a.download = `${(current() || {}).name || 'participants'} - accounts.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('#people').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const u = users.find((x) => x.id === b.dataset.id);
  if (!u) return;
  try {
    if (b.dataset.act === 'link') {
      copy(loginLink(u.username), t('ppl.link_copied'));
    } else if (b.dataset.act === 'reset') {
      if (!confirm(t('ppl.reset_confirm', { name: u.name }))) return;
      const out = await api('POST', `/users/${u.id}/reset-password`);
      lastCreds = [out];
      renderCreds();
    } else if (b.dataset.act === 'toggle') {
      await api('PATCH', '/users/' + u.id, { disabled: !u.disabled });
    } else if (b.dataset.act === 'delete') {
      if (!confirm(t('ppl.delete_confirm', { name: u.name }))) return;
      await api('DELETE', '/users/' + u.id);
    }
    await load();
  } catch (err) {
    toast(err.message, 4000);
  }
});

// ---------- tải dữ liệu ----------

function renderAll(refill) {
  Nav.breadcrumb(() => {
    const sc = current();
    return [Nav.home(), Nav.scenariosRoot(), ...(sc ? [{ label: sc.name }] : [])];
  });
  renderList();
  if (refill) fillConfig();
  if (refill || inviteLoaded.id !== currentId) fillInviteEditor(inviteLoaded.id !== currentId);
  else renderInvite();
  renderPeople();
  renderCreds();
}

async function load(refill) {
  [scenarios, users] = await Promise.all([api('GET', '/scenarios'), api('GET', '/users')]);
  if (!current()) currentId = scenarios[0] ? scenarios[0].id : '';
  renderAll(refill);
}

// tự cập nhật trạng thái (đang làm / đã xong) khi người tham gia đang test
setInterval(() => {
  if (document.hidden) return;
  load(false).catch(() => {}); // chỉ cập nhật danh sách, không đụng vào ô cấu hình đang sửa
}, REFRESH_MS);

document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => I18N.setLanguage(b.dataset.lang)));
document.addEventListener('i18n:change', (e) => {
  document.querySelectorAll('.lang-switch button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.lang === e.detail.language)));
  // đang dùng mẫu mặc định và chưa sửa → đổi theo ngôn ngữ mới
  const sc = current();
  if (sc && !sc.inviteTemplate && !inviteDirty()) inviteLoaded.id = null;
  if (scenarios.length) renderAll(false);
});

I18N.load().then(() => load(true));
