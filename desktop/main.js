// App de escritorio (Electron).
// Se conecta al servidor online indicado en config.json (serverUrl), así comparte cuenta y datos
// con la web y el móvil. Si no hay serverUrl (modo desarrollo) arranca el servidor local.
const path = require('path');
const fs = require('fs');
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {}

const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron');
const net = require('net');

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch {}
const PORT = Number(process.env.PORT || 3000);
const REMOTE = (process.env.SERVER_URL || cfg.serverUrl || '').replace(/\/$/, '');
const SERVER_URL = REMOTE || `http://localhost:${PORT}`;
const ICON_FILE = path.join(__dirname, 'build', 'icon.png');
const ICON = fs.existsSync(ICON_FILE) ? nativeImage.createFromPath(ICON_FILE) : undefined;

let win = null;
let tray = null;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

const WAIT_PAGE = (msg) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;
  font-family:Segoe UI,sans-serif;background:#0b1020;color:#e6e9f5;text-align:center">
  <div><div style="font-size:46px">💸</div><h2 style="margin:10px 0 6px">Agenda de Gastos</h2>
  <p style="color:#94a0c0">${msg}</p><p style="color:#94a0c0;font-size:13px">Reintentando automáticamente…</p></div></body></html>`);

function loadApp() {
  if (!win) return;
  win.loadURL(SERVER_URL).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1300,
    height: 850,
    minWidth: 380,
    title: 'Agenda de Gastos',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Si no hay conexión (o el servidor gratuito está despertando) se muestra un aviso y se reintenta
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (!isMain || code === -3 || url.startsWith('data:')) return;
    win.loadURL(WAIT_PAGE('Conectando con el servidor… comprueba tu conexión a internet.'));
    setTimeout(loadApp, 5000);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
  if (REMOTE) win.loadURL(WAIT_PAGE('Abriendo tu agenda…')).then(loadApp);
  else loadApp();
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.agendagastos.app'); // necesario para notificaciones en Windows
  if (!REMOTE && !(await portInUse(PORT))) {
    try {
      await require('../server/index.js').start(PORT);
    } catch (e) {
      console.error('No se pudo arrancar el servidor local:', e.message);
    }
  }
  createWindow();

  if (ICON) {
    tray = new Tray(ICON.resize({ width: 16, height: 16 }));
    tray.setToolTip('Agenda de Gastos');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir Agenda de Gastos', click: () => (win ? win.show() : createWindow()) },
        { label: 'Abrir la versión web', click: () => shell.openExternal(SERVER_URL) },
        { type: 'separator' },
        { label: 'Salir', click: () => app.quit() },
      ])
    );
    tray.on('click', () => (win ? win.show() : createWindow()));
  }
});

app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => app.quit());
