// Genera los iconos PNG de la app (web/móvil y escritorio). Uso: npm --prefix desktop run icons
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const draw = `(size, maskable) => {
  const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, size, size); g.addColorStop(0, '#4f46e5'); g.addColorStop(1, '#7c3aed');
  x.fillStyle = g;
  if (maskable) x.fillRect(0, 0, size, size);
  else { const r = size * 0.22; x.beginPath(); x.roundRect(0, 0, size, size, r); x.fill(); }
  const s = maskable ? 0.62 : 0.8;
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = 'bold ' + Math.round(size * 0.52 * s) + 'px Segoe UI, Arial';
  x.fillText('€', size / 2, size * 0.47);
  x.fillStyle = 'rgba(255,255,255,.85)';
  const w = size * 0.34 * s, h = size * 0.045 * s;
  x.beginPath(); x.roundRect(size / 2 - w / 2, size * 0.47 + size * 0.24 * s, w, h, h / 2); x.fill();
  return c.toDataURL('image/png');
}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const out = [
    ['public/icons/icon-192.png', 192, false],
    ['public/icons/icon-512.png', 512, false],
    ['public/icons/maskable-512.png', 512, true],
    ['public/icons/apple-touch-icon.png', 180, true],
    ['public/icons/favicon-32.png', 32, false],
    ['desktop/build/icon.png', 512, false],
  ];
  for (const [file, size, mask] of out) {
    const url = await win.webContents.executeJavaScript(`(${draw})(${size}, ${mask})`);
    fs.writeFileSync(path.join(ROOT, file), Buffer.from(url.split(',')[1], 'base64'));
    console.log('Creado', file);
  }
  app.quit();
});
