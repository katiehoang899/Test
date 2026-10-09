'use strict';

// Nút tài khoản trên header (mọi trang sau khi đăng nhập): tên người dùng, đổi mật khẩu, đăng xuất.
// Admin còn có liên kết tới trang "Người tham gia" và phần mã khôi phục (dùng khi quên mật khẩu).
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let me = null;

  function toast(msg, ms = 3000) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  async function post(path, body) {
    const res = await fetch('/__et/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

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
    // liên kết nhanh: Kịch bản (admin + mod), Nhóm quản lý (chỉ admin)
    const here = (page) => location.pathname.endsWith('/' + page);
    const links = [
      staff() && !here('scenarios.html') ? `<a class="btn" href="/__et/scenarios.html">${esc(t('nav.scenarios'))}</a>` : '',
      me.role === 'admin' && !here('team.html') ? `<a class="btn" href="/__et/team.html">${esc(t('nav.team'))}</a>` : '',
    ].join('');
    box.innerHTML = `${links}
      <button type="button" class="account-btn" id="accountBtn" aria-haspopup="dialog">
        <span class="avatar" aria-hidden="true">${esc((me.name || me.username).trim().charAt(0).toUpperCase())}</span>
        <span class="who"><b>${esc(me.name || me.username)}</b><span class="small muted">${esc(t('acct.role_' + me.role))}</span></span>
      </button>`;
    document.getElementById('accountBtn').addEventListener('click', () => openDialog());
  }

  const staff = () => me && (me.role === 'admin' || me.role === 'mod');

  function recoverySection() {
    if (!staff()) return '';
    const left = me.recoveryCodesLeft || 0;
    return `<section class="recovery-section" id="recoverySection">
        <h3 class="small" style="margin: 18px 0 4px">${esc(t('rc.title'))}</h3>
        <p class="small muted" style="margin: 0 0 8px">${esc(t('rc.desc'))}</p>
        <p class="small" style="margin: 0 0 8px"><b id="rcStatus">${esc(left ? t('rc.left', { n: left }) : t('rc.none'))}</b></p>
        <form id="rcForm" class="row" style="gap: 6px; flex-wrap: nowrap">
          <input type="password" id="rcPassword" autocomplete="current-password" required placeholder="${esc(t('acct.current'))}" aria-label="${esc(t('acct.current'))}">
          <button type="submit" id="rcSubmit">${esc(left ? t('rc.regenerate') : t('rc.generate'))}</button>
        </form>
        <p class="small form-error" id="rcError" role="alert"></p>
        <div id="rcCodes" hidden></div>
      </section>`;
  }

  function showCodes(dlg, codes) {
    const box = dlg.querySelector('#rcCodes');
    box.hidden = false;
    // mặc định che mã (tránh bị nhìn trộm / chụp màn hình); bấm Hiện mã mới thấy
    const masked = (c) => c.replace(/[A-Z0-9]/g, '•');
    box.innerHTML = `<div class="recovery-codes" id="rcList" data-shown="false">${codes.map((c) => `<code>${esc(masked(c))}</code>`).join('')}</div>
      <p class="small" style="color: var(--warn); margin: 8px 0">${esc(t('rc.once'))}</p>
      <div class="row" style="gap: 6px">
        <button type="button" id="rcToggle" aria-pressed="false" aria-controls="rcList">👁 ${esc(t('rc.show'))}</button>
        <button type="button" id="rcCopy">${esc(t('rc.copy'))}</button>
        <button type="button" id="rcDownload">${esc(t('rc.download'))}</button>
      </div>`;
    box.querySelector('#rcToggle').addEventListener('click', (e) => {
      const list = box.querySelector('#rcList');
      const shown = list.dataset.shown !== 'true';
      list.dataset.shown = String(shown);
      list.querySelectorAll('code').forEach((el, i) => { el.textContent = shown ? codes[i] : masked(codes[i]); });
      e.currentTarget.setAttribute('aria-pressed', String(shown));
      e.currentTarget.textContent = `👁 ${shown ? t('rc.hide') : t('rc.show')}`;
    });
    const text = `${t('rc.file_title', { user: me.username, host: location.host })}\n${new Date().toLocaleString(I18N.locale())}\n\n${codes.join('\n')}\n\n${t('rc.file_note')}\n`;
    box.querySelector('#rcCopy').addEventListener('click', async () => {
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
      toast(t('sum.copied'));
    });
    box.querySelector('#rcDownload').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = `heatmap-recovery-codes-${me.username}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  }

  function openDialog(focusRecovery) {
    let dlg = document.getElementById('accountDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'accountDialog';
      dlg.className = 'settings';
      document.body.appendChild(dlg);
    }
    dlg.innerHTML = `<div>
        <h2>${esc(me.name || me.username)}</h2>
        <p class="small muted">${esc(t('acct.username'))}: <b>${esc(me.username)}</b></p>
        <form id="pwForm">
          <h3 class="small" style="margin: 16px 0 6px">${esc(t('acct.change_password'))}</h3>
          <label for="pwCurrent">${esc(t('acct.current'))}</label>
          <input type="password" id="pwCurrent" autocomplete="current-password" required>
          <label for="pwNext" style="margin-top: 8px">${esc(t('acct.next'))}</label>
          <input type="password" id="pwNext" autocomplete="new-password" minlength="8" required>
          <p class="small form-error" id="pwError" role="alert"></p>
          <button type="submit" class="primary">${esc(t('acct.save_password'))}</button>
        </form>
        ${recoverySection()}
        <div class="row" style="justify-content: space-between; margin-top: 18px">
          <button type="button" class="danger" id="logoutBtn">${esc(t('acct.logout'))}</button>
          <button type="button" id="pwClose">${esc(t('common.close'))}</button>
        </div>
      </div>`;
    dlg.querySelector('#pwClose').addEventListener('click', () => dlg.close());
    dlg.querySelector('#logoutBtn').addEventListener('click', logout);
    dlg.querySelector('#pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await post('/account/password', { current: dlg.querySelector('#pwCurrent').value, next: dlg.querySelector('#pwNext').value });
        dlg.querySelector('#pwError').textContent = '';
        dlg.querySelector('#pwCurrent').value = '';
        dlg.querySelector('#pwNext').value = '';
        toast(t('acct.password_changed'));
      } catch (err) {
        dlg.querySelector('#pwError').textContent = err.message;
      }
    });
    const rcForm = dlg.querySelector('#rcForm');
    if (rcForm) {
      rcForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if ((me.recoveryCodesLeft || 0) > 0 && !confirm(t('rc.regenerate_confirm'))) return;
        try {
          const { codes } = await post('/account/recovery-codes', { password: dlg.querySelector('#rcPassword').value });
          dlg.querySelector('#rcError').textContent = '';
          dlg.querySelector('#rcPassword').value = '';
          me.recoveryCodesLeft = codes.length;
          dlg.querySelector('#rcStatus').textContent = t('rc.left', { n: codes.length });
          dlg.querySelector('#rcSubmit').textContent = t('rc.regenerate');
          showCodes(dlg, codes);
          render();
        } catch (err) {
          dlg.querySelector('#rcError').textContent = err.message;
        }
      });
    }
    dlg.showModal();
    if (focusRecovery && dlg.querySelector('#rcPassword')) dlg.querySelector('#rcPassword').focus();
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
    // ẩn nút chỉ dành cho admin (xoá dữ liệu, cài đặt chung) với mod: .admin-only trong style.css
    document.body.classList.add('role-' + me.role);
    document.dispatchEvent(new CustomEvent('account:ready', { detail: me }));
    render();
    // vừa đặt lại mật khẩu bằng mã khôi phục → báo số mã còn lại
    let recovered = null;
    try {
      recovered = sessionStorage.getItem('heatmap.recovered');
      sessionStorage.removeItem('heatmap.recovered');
    } catch { /* bỏ qua */ }
    if (recovered !== null) {
      // đợi bản dịch tải xong rồi mới báo
      let shown = false;
      const show = () => { if (!shown) { shown = true; toast(t('rc.used', { n: recovered }), 6000); } };
      document.addEventListener('i18n:change', show, { once: true });
      setTimeout(show, 1500);
    }
  }

  document.addEventListener('i18n:change', render);
  init();
})();
