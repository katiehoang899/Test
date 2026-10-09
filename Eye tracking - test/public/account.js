'use strict';

// Nút tài khoản trên header (mọi trang sau khi đăng nhập): tên người dùng, đổi mật khẩu, đăng xuất.
// Admin còn có thêm liên kết tới trang "Người tham gia".
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let me = null;

  function render() {
    const host = document.querySelector('.header-actions');
    if (!host || !me) return;
    let box = document.getElementById('accountBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'accountBox';
      box.className = 'account-box';
      host.prepend(box);
    }
    const onPeople = location.pathname.endsWith('/participants.html');
    box.innerHTML = `${me.role === 'admin' && !onPeople ? `<a class="btn" href="/__et/participants.html">${esc(t('acct.participants'))}</a>` : ''}
      <button type="button" class="account-btn" id="accountBtn" aria-haspopup="dialog">
        <span class="avatar" aria-hidden="true">${esc((me.name || me.username).trim().charAt(0).toUpperCase())}</span>
        <span class="who"><b>${esc(me.name || me.username)}</b><span class="small muted">${esc(me.role === 'admin' ? t('acct.role_admin') : t('acct.role_guest'))}</span></span>
      </button>`;
    document.getElementById('accountBtn').addEventListener('click', openDialog);
  }

  function openDialog() {
    let dlg = document.getElementById('accountDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'accountDialog';
      dlg.className = 'settings';
      document.body.appendChild(dlg);
    }
    dlg.innerHTML = `<form method="dialog" id="pwForm">
        <h2>${esc(me.name || me.username)}</h2>
        <p class="small muted">${esc(t('acct.username'))}: <b>${esc(me.username)}</b></p>
        <h3 class="small" style="margin: 16px 0 6px">${esc(t('acct.change_password'))}</h3>
        <label for="pwCurrent">${esc(t('acct.current'))}</label>
        <input type="password" id="pwCurrent" autocomplete="current-password" required>
        <label for="pwNext" style="margin-top: 8px">${esc(t('acct.next'))}</label>
        <input type="password" id="pwNext" autocomplete="new-password" minlength="8" required>
        <p class="small form-error" id="pwError" role="alert"></p>
        <div class="row" style="justify-content: space-between; margin-top: 12px">
          <button type="button" class="danger" id="logoutBtn">${esc(t('acct.logout'))}</button>
          <span class="row" style="gap: 8px">
            <button type="button" id="pwClose">${esc(t('common.close'))}</button>
            <button type="submit" class="primary">${esc(t('acct.save_password'))}</button>
          </span>
        </div>
      </form>`;
    dlg.querySelector('#pwClose').addEventListener('click', () => dlg.close());
    dlg.querySelector('#logoutBtn').addEventListener('click', logout);
    dlg.querySelector('#pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await fetch('/__et/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: dlg.querySelector('#pwCurrent').value, next: dlg.querySelector('#pwNext').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        dlg.querySelector('#pwError').textContent = data.error || 'HTTP ' + res.status;
        return;
      }
      dlg.querySelector('#pwError').textContent = '';
      dlg.close();
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = t('acct.password_changed');
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2500);
    });
    dlg.showModal();
  }

  async function logout() {
    await fetch('/__et/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/__et/login.html';
  }

  async function init() {
    const res = await fetch('/__et/api/me').catch(() => null);
    if (!res || res.status === 401) {
      location.href = '/__et/login.html?next=' + encodeURIComponent(location.pathname + location.search);
      return;
    }
    me = (await res.json()).user;
    window.HeatmapAccount = { me, logout };
    document.dispatchEvent(new CustomEvent('account:ready', { detail: me }));
    render();
  }

  document.addEventListener('i18n:change', render);
  init();
})();
