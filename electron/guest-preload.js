'use strict';

// Preload của <webview> (website đang được test). Chạy trong "isolated world":
// trang web không truy cập được biến hay API Electron ở đây, chỉ có bộ ghi đọc DOM
// và gửi sự kiện về cửa sổ công cụ qua ipcRenderer.sendToHost.
const { ipcRenderer } = require('electron');
const { installRecorder } = require('../public/recorder.js');

function start() {
  if (window !== window.top) return; // chỉ ghi khung chính, bỏ qua iframe quảng cáo/nhúng
  if (!/^https?:$/.test(location.protocol)) return;
  installRecorder(window, (ev) => ipcRenderer.sendToHost('et', ev));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
