'use strict';

// Ứng dụng desktop: chạy server của Phòng trọ Map ngay trong tiến trình Electron
// rồi mở cửa sổ trỏ vào http://127.0.0.1:<cổng>/.

const path = require('node:path');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

// Cache geocode, ảnh Street View và API key lưu trong thư mục dữ liệu của app
// (macOS: ~/Library/Application Support/Phong Tro Map).
process.env.DATA_DIR = process.env.DATA_DIR || app.getPath('userData');

const { createServer } = require(path.join(__dirname, '..', 'server.js'));

// Cổng cố định để trình duyệt nhớ chế độ xem (localStorage theo cổng); bận thì lấy cổng trống bất kỳ.
const PREFERRED_PORT = 31070;

let baseUrl = null;
let mainWindow = null;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

async function startServer() {
  const server = createServer();
  try {
    return await listen(server, PREFERRED_PORT);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    return listen(server, 0);
  }
}

function isOwnUrl(url) {
  return baseUrl !== null && url.startsWith(baseUrl);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 380,
    minHeight: 500,
    title: 'Phòng trọ Map',
    backgroundColor: '#f5f6f7',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Link tới Nhà Tốt, Google Maps, Street View… mở bằng trình duyệt mặc định.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isOwnUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isOwnUrl(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(baseUrl);
}

function showMainWindow() {
  if (!baseUrl) return;
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' }, // cần cho Copy / Paste (vd. dán Google Maps API key)
    {
      label: 'Xem',
      submenu: [
        { label: 'Tải lại', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { label: 'Về trang đầu (xoá bộ lọc)', click: () => mainWindow?.loadURL(baseUrl) },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Cỡ chữ mặc định' },
        { role: 'zoomIn', label: 'Phóng to' },
        { role: 'zoomOut', label: 'Thu nhỏ' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toàn màn hình' },
        { role: 'toggleDevTools', label: 'Công cụ nhà phát triển' },
      ],
    },
    {
      label: 'Dữ liệu',
      submenu: [
        { label: 'Mở thư mục dữ liệu', click: () => shell.openPath(process.env.DATA_DIR) },
        { label: 'Mở trong trình duyệt', click: () => baseUrl && shell.openExternal(baseUrl) },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.whenReady().then(async () => {
    try {
      const port = await startServer();
      baseUrl = `http://127.0.0.1:${port}/`;
    } catch (err) {
      dialog.showErrorBox('Không khởi động được Phòng trọ Map', String(err && err.message ? err.message : err));
      app.quit();
      return;
    }
    buildMenu();
    createWindow();
    app.on('activate', showMainWindow);
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
