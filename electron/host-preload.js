'use strict';

// Preload của cửa sổ công cụ: chỉ báo cho trang biết đang chạy trong app desktop
// để màn hình theo dõi dùng <webview> (trình duyệt thật) thay cho iframe qua proxy.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('etDesktop', { webview: true });
