'use strict';

// Preload của cửa sổ công cụ: báo cho trang biết đang chạy trong app desktop để
//  - màn hình theo dõi / báo cáo dùng <webview> (trình duyệt thật) thay cho iframe qua proxy
//  - trang chủ hiện nút "Chọn file…" để test file HTML trên máy
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('etDesktop', {
  webview: true,
  pickHtmlFile: () => ipcRenderer.invoke('et:pick-html'),
  pickFolder: (current) => ipcRenderer.invoke('et:pick-folder', current),
  openFolder: () => ipcRenderer.invoke('et:open-folder'),
  revealSession: (id) => ipcRenderer.invoke('et:reveal-session', String(id)),
  saveSessionAs: (id) => ipcRenderer.invoke('et:save-session', String(id)),
});
