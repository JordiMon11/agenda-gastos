// Genera public/icons.js con solo los iconos de Lucide (https://lucide.dev, licencia ISC) que usa la app.
// Uso: npm run icons
const fs = require('fs');
const path = require('path');
const { icons } = require('lucide');

// Iconos de la interfaz
const UI = [
  'layout-dashboard', 'receipt-text', 'calendar-days', 'repeat', 'chart-pie', 'settings', 'download', 'log-out', 'plus', 'bell',
  'mail', 'map-pin', 'pencil', 'trash-2', 'chevron-left', 'chevron-right', 'search', 'file-down', 'trending-up', 'trending-down',
  'ellipsis', 'x', 'check', 'zap', 'smartphone', 'monitor', 'apple', 'wallet', 'clock', 'pause', 'circle-check', 'hourglass',
  'user', 'lock', 'send', 'arrow-up-right', 'arrow-down-right', 'calendar-range', 'store', 'info', 'triangle-alert', 'share',
  'shield-check', 'sparkles', 'piggy-bank', 'banknote', 'calendar-check', 'list', 'tag', 'chevron-down', 'laptop', 'party-popper',
  'square-plus', 'calendar-clock', 'trophy', 'activity', 'sun', 'moon',
];
// Iconos disponibles para las categorías
const CATEGORY = [
  'utensils', 'shopping-cart', 'car', 'house', 'lightbulb', 'tv', 'gamepad-2', 'pill', 'shopping-bag', 'package',
  'coffee', 'pizza', 'beer', 'wine', 'cake', 'plane', 'fuel', 'bus', 'train-front', 'bike', 'circle-parking',
  'dumbbell', 'graduation-cap', 'book-open', 'gift', 'heart', 'baby', 'dog', 'cat', 'paw-print', 'shirt', 'scissors', 'gem',
  'smartphone', 'laptop', 'wifi', 'phone', 'headphones', 'music', 'film', 'ticket', 'camera', 'palette', 'trophy',
  'wrench', 'hammer', 'sofa', 'bath', 'droplets', 'flame', 'bolt', 'leaf', 'flower-2', 'umbrella',
  'briefcase', 'credit-card', 'landmark', 'banknote', 'hand-coins', 'piggy-bank', 'receipt', 'percent', 'shield-check',
  'stethoscope', 'glasses', 'sparkles', 'tag',
];

const pascal = (s) => s.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const esc = (v) => String(v).replace(/"/g, '&quot;');
const out = {};
for (const name of [...new Set([...UI, ...CATEGORY])]) {
  const node = icons[pascal(name)];
  if (!node) throw new Error('No existe el icono ' + name);
  out[name] = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`).join('');
}
const file = `/* Generado por scripts/build-icons.js — iconos de Lucide (ISC) */
window.ICONS = ${JSON.stringify(out)};
window.CATEGORY_ICONS = ${JSON.stringify(CATEGORY)};
`;
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icons.js'), file);
console.log(`public/icons.js: ${Object.keys(out).length} iconos, ${(file.length / 1024).toFixed(1)} KB`);
