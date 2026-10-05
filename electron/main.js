'use strict';

// Ứng dụng desktop: chạy server của công cụ ngay trong tiến trình Electron
// rồi mở cửa sổ trỏ vào http://127.0.0.1:<cổng>/__et/.

const path = require('node:path');
const { app, BrowserWindow, Menu, session, shell, systemPreferences, dialog } = require('electron');

// Dữ liệu phiên lưu trong thư mục dữ liệu của ứng dụng
// (macOS: ~/Library/Application Support/Eye Tracking Tool/sessions).
process.env.DATA_DIR = process.env.DATA_DIR || app.getPath('userData');
// Bản đóng gói chỉ mang theo thư mục dist của WebGazer (xem build.extraResources trong package.json).
if (app.isPackaged) process.env.WEBGAZER_DIR = path.join(process.resourcesPath, 'webgazer');

const { createServer, TOOL_PREFIX } = require(path.join(__dirname, '..', 'server.js'));

const BROWSE_PARTITION = 'persist:browse'; // cookie/đăng nhập của website test, tách khỏi công cụ
const GUEST_PRELOAD = path.join(__dirname, 'guest-preload.js');

let baseUrl = null;
let mainWindow = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    // Cổng 0 = hệ điều hành chọn cổng trống, tránh đụng ứng dụng khác.
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function isOwnUrl(url) {
  return typeof url === 'string' && url.startsWith(baseUrl);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Eye Tracking Tool',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'host-preload.js'),
      webviewTag: true,
    },
  });

  // Khung trình duyệt (<webview>) của màn hình theo dõi: luôn dùng preload ghi tương tác
  // của app, không bật Node cho website, chỉ cho mở http/https.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preloadURL;
    webPreferences.preload = GUEST_PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false; // preload cần require() bộ ghi dùng chung
    params.partition = BROWSE_PARTITION;
    if (params.src && !/^(https?:|about:blank)/i.test(params.src)) event.preventDefault();
  });

  // Website mở tab/cửa sổ mới → mở ngay trong khung trình duyệt để tiếp tục ghi.
  mainWindow.webContents.on('did-attach-webview', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault();
    });
  });

  // Link mở tab mới (ví dụ "Mở trực tiếp trong tab mới") → mở bằng trình duyệt mặc định.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isOwnUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Cửa sổ chính chỉ được ở trong công cụ; link ngoài mở bằng trình duyệt.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isOwnUrl(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL(baseUrl + TOOL_PREFIX + '/');
}

function setupPermissions() {
  // Chỉ trang của công cụ được xin quyền camera (cho WebGazer); mọi quyền khác bị từ chối.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc.getURL();
    callback(permission === 'media' && isOwnUrl(origin) && (!details.mediaTypes || details.mediaTypes.every((t) => t === 'video')));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return permission === 'media' && isOwnUrl(requestingOrigin + '/');
  });
  // Website đang test không được xin camera, micro, vị trí, thông báo…
  const browse = session.fromPartition(BROWSE_PARTITION);
  browse.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  browse.setPermissionCheckHandler(() => false);
}

async function askCameraAccess() {
  if (process.platform !== 'darwin') return;
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'not-determined') {
    await systemPreferences.askForMediaAccess('camera');
  } else if (status === 'denied' || status === 'restricted') {
    dialog.showMessageBox({
      type: 'warning',
      message: 'Ứng dụng chưa được phép dùng camera',
      detail: 'Eye tracking cần webcam. Mở System Settings → Privacy & Security → Camera và bật cho "Eye Tracking Tool". Bạn vẫn có thể ghi chuột, click và cuộn trang khi không có camera.',
    });
  }
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'Xem',
      submenu: [
        { label: 'Trang chủ công cụ', accelerator: 'CmdOrCtrl+Shift+H', click: () => mainWindow && mainWindow.loadURL(baseUrl + TOOL_PREFIX + '/') },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Dữ liệu',
      submenu: [
        { label: 'Mở thư mục dữ liệu', click: () => shell.openPath(path.join(process.env.DATA_DIR, 'sessions')) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const port = await startServer();
    baseUrl = `http://127.0.0.1:${port}`;
    console.log('Eye Tracking Tool server:', baseUrl);
    setupPermissions();
    buildMenu();
    await askCameraAccess();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((err) => {
    dialog.showErrorBox('Không khởi động được Eye Tracking Tool', String(err && err.stack || err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
