const path = require('path');
const ROOT = path.join(__dirname, '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {}

const express = require('express');
const os = require('os');
const store = require('./db');
const { db } = store;
const D = require('./dates');
const mailer = require('./mailer');
const scheduler = require('./scheduler');
const { weekSummary, round } = require('./summary');
const S = require('./security');
const auth = require('./auth');
const finance = require('./finance');
const admin = require('./admin');
const receipts = require('./receipts');
const planning = require('./planning');
const imports = require('./imports');
const openbanking = require('./openbanking');
const R = require('./recurrence');
const L = require('./ledger');
const insights = require('./insights');
const APP_ENV = process.env.APP_ENV || 'produccion';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DEFAULT_CATEGORIES = [
  { name: 'Comida', icon: 'utensils', color: '#f97316' },
  { name: 'Supermercado', icon: 'shopping-cart', color: '#16a34a' },
  { name: 'Transporte', icon: 'car', color: '#2563eb' },
  { name: 'Casa', icon: 'house', color: '#9333ea' },
  { name: 'Facturas', icon: 'lightbulb', color: '#ca8a04' },
  { name: 'Suscripciones', icon: 'tv', color: '#db2777' },
  { name: 'Ocio', icon: 'gamepad-2', color: '#0891b2' },
  { name: 'Salud', icon: 'pill', color: '#dc2626' },
  { name: 'Compras', icon: 'shopping-bag', color: '#7c3aed' },
  { name: 'Otros', icon: 'package', color: '#64748b' },
];
// Las categorías antiguas usaban emojis: se convierten a nombres de icono
const EMOJI_TO_ICON = {
  '🍔': 'utensils', '🛒': 'shopping-cart', '🚗': 'car', '🏠': 'house', '💡': 'lightbulb', '📺': 'tv',
  '🎮': 'gamepad-2', '💊': 'pill', '🛍️': 'shopping-bag', '🛍': 'shopping-bag', '📦': 'package',
};
const ICON_RE = /^[a-z0-9-]{1,40}$/;
function migrateCategoryIcons() {
  let changed = false;
  for (const c of db.categories) {
    if (!ICON_RE.test(c.icon || '')) {
      c.icon = EMOJI_TO_ICON[c.icon] || 'tag';
      changed = true;
    }
  }
  if (changed) store.save();
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(S.securityHeaders);
app.use('/api/receipts', express.json({ limit: '8mb' })); // fotos de tickets
app.use('/api/imports', express.json({ limit: imports.JSON_LIMIT })); // extractos bancarios (solo en memoria)
app.use(express.json({ limit: '200kb' }));
app.use('/api', S.csrfGuard);
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders: (res, p) => res.setHeader('Cache-Control', /\.(html|js|css|webmanifest)$/.test(p) ? 'no-cache' : 'public, max-age=604800'),
}));
app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'chart.js', 'dist')));
// Lector de tickets gratuito en el dispositivo (Tesseract OCR + idioma español)
const longCache = { maxAge: '30d' };
app.use('/vendor/tesseract', express.static(path.join(ROOT, 'node_modules', 'tesseract.js', 'dist'), longCache));
app.use('/vendor/tesseract-core', express.static(path.join(ROOT, 'node_modules', 'tesseract.js-core'), longCache));
app.use('/vendor/pdfjs', express.static(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build'), longCache));
app.use('/vendor/tessdata', express.static(path.join(ROOT, 'node_modules', '@tesseract.js-data', 'spa', '4.0.0_best_int'), longCache));

// ---------- Rutas públicas ----------
app.get('/healthz', (req, res) => res.json({ ok: true, cifrado: S.hasKey(), entorno: APP_ENV }));
app.get('/api/public-config', (req, res) =>
  res.json({ downloadUrl: process.env.DESKTOP_DOWNLOAD_URL || 'https://github.com/JordiMon11/agenda-gastos/releases/latest/download/Agenda-Gastos-Setup.exe',
    releasesUrl: process.env.RELEASES_URL || 'https://github.com/JordiMon11/agenda-gastos/releases/latest',
    banner: db.settings.banner || '', bannerType: db.settings.bannerType || 'info', registrationOpen: !db.users.length || db.settings.registrationOpen !== false,
    environment: APP_ENV })
);
// Disparador externo de los avisos (GitHub Actions lo llama cada 30 min y así también despierta el servidor gratuito).
// Es seguro dejarlo público: solo revisa avisos pendientes y cada aviso se envía una única vez.
let lastCron = 0;
app.all('/api/cron', h(async (req, res) => {
  if (Date.now() - lastCron > 60_000) {
    lastCron = Date.now();
    await scheduler.run();
  }
  res.json({ ok: true, at: new Date().toISOString() });
}));

// ---------- Autenticación (ver server/auth.js) ----------
auth.router.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;
app.use('/api', auth.publicRouter);
app.use('/api', auth.authMiddleware);
app.use('/api', auth.router);
app.use('/api', finance.router);
app.use('/api/admin', admin.router);
app.use('/api', receipts.router);
app.use('/api', planning.router);
app.use('/api', imports.router);
app.use('/api', openbanking.router);

// ---------- Categorías ----------
const mine = (list, req) => list.filter((x) => x.userId === req.user.id);
function findMine(list, req) {
  const item = list.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!item) throw new HttpError(404, 'No encontrado');
  return item;
}
function cleanCategory(b) {
  const name = String(b?.name || '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, 'La categoría necesita un nombre');
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#64748b';
  return { name, color, icon: ICON_RE.test(b.icon || '') ? b.icon : 'tag' };
}
app.get('/api/categories', (req, res) => res.json(mine(db.categories, req)));
app.post('/api/categories', (req, res) => {
  const c = { id: store.id(), userId: req.user.id, ...cleanCategory(req.body) };
  db.categories.push(c);
  store.save();
  res.json(c);
});
app.put('/api/categories/:id', h(async (req, res) => {
  const c = findMine(db.categories, req);
  Object.assign(c, cleanCategory(req.body));
  store.save();
  res.json(c);
}));
app.delete('/api/categories/:id', h(async (req, res) => {
  const c = findMine(db.categories, req);
  db.categories.splice(db.categories.indexOf(c), 1);
  for (const x of [...db.expenses, ...db.recurring]) if (x.categoryId === c.id) x.categoryId = null;
  db.budgets = db.budgets.filter((b) => b.categoryId !== c.id);
  store.save();
  res.json({ ok: true });
}));

// ---------- Gastos ----------
function cleanExpense(b, req) {
  // Las devoluciones importadas del banco se guardan como gasto negativo (restan de su categoría)
  const amount = b?.refund ? -Math.abs(Number(b?.amount)) : Number(b?.amount);
  const name = String(b?.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'El gasto necesita un nombre');
  if (!(b?.refund ? amount < 0 : amount > 0)) throw new HttpError(400, 'El importe debe ser mayor que 0');
  if (!D.isYmd(b.date)) throw new HttpError(400, 'Fecha no válida');
  if (b.categoryId && !db.categories.some((c) => c.id === b.categoryId && c.userId === req.user.id))
    throw new HttpError(400, 'Categoría no válida');
  if (b.accountId && !db.accounts.some((a) => a.id === b.accountId && a.userId === req.user.id)) throw new HttpError(400, 'Cuenta no válida');
  const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[,#]/))
    .map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24)).filter(Boolean);
  return {
    name,
    amount: round(amount),
    ...(amount < 0 ? { refund: true } : {}),
    categoryId: b.categoryId || null,
    date: b.date,
    place: String(b.place || '').trim().slice(0, 100),
    notes: String(b.notes || '').slice(0, 500),
    accountId: b.accountId || null,
    paymentMethod: L.PAYMENT_METHODS[b.paymentMethod] ? b.paymentMethod : null,
    tags: [...new Set(tags)].slice(0, 8),
  };
}
receipts.setExpenseCleaner(cleanExpense);
app.get('/api/expenses', (req, res) => {
  const { from, to, category, q, account, tag } = req.query;
  let list = mine(db.expenses, req);
  if (from) list = list.filter((e) => e.date >= from);
  if (to) list = list.filter((e) => e.date <= to);
  if (category) list = list.filter((e) => (category === 'none' ? !e.categoryId : e.categoryId === category));
  if (account) list = list.filter((e) => e.accountId === account);
  if (tag) list = list.filter((e) => (e.tags || []).includes(String(tag)));
  if (q) {
    const s = String(q).toLowerCase();
    list = list.filter((e) => `${e.name} ${e.place} ${e.notes} ${(e.tags || []).join(' ')}`.toLowerCase().includes(s));
  }
  res.json(list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '')));
});
app.post('/api/expenses', h(async (req, res) => {
  const e = { id: store.id(), userId: req.user.id, ...cleanExpense(req.body, req), ...(req.body?.scanned ? { scanned: true } : {}), createdAt: new Date().toISOString() };
  db.expenses.push(e);
  store.save();
  res.json(e);
}));
// Duplicar un gasto (por ejemplo, una compra que repites)
app.post('/api/expenses/:id/duplicate', h(async (req, res) => {
  const src = findMine(db.expenses, req);
  const date = D.isYmd(req.body?.date) ? req.body.date : D.ymd(D.today());
  const e = { ...cleanExpense({ ...src, date }, req), id: store.id(), userId: req.user.id, createdAt: new Date().toISOString() };
  db.expenses.push(e);
  store.save();
  res.json(e);
}));
app.put('/api/expenses/:id', h(async (req, res) => {
  const e = findMine(db.expenses, req);
  Object.assign(e, cleanExpense({ ...req.body, refund: !!e.refund }, req));
  store.save();
  res.json(e);
}));
app.delete('/api/expenses/:id', h(async (req, res) => {
  const e = findMine(db.expenses, req);
  db.expenses.splice(db.expenses.indexOf(e), 1);
  for (const r of db.receipts) if (r.expenseId === e.id) r.expenseId = null; // el ticket se conserva
  store.save();
  res.json({ ok: true });
}));
app.get('/api/places', (req, res) => {
  const counts = {};
  for (const e of mine(db.expenses, req)) if (e.place) counts[e.place] = (counts[e.place] || 0) + 1;
  res.json(Object.keys(counts).sort((a, b) => counts[b] - counts[a]));
});

// ---------- Pagos fijos (recurrentes: semanales, mensuales, anuales…) ----------
function cleanRecurring(b, req) {
  const amount = Number(b?.amount);
  const remind = Number(b?.remindDaysBefore ?? 3);
  const name = String(b?.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'El pago fijo necesita un nombre');
  if (!(amount > 0)) throw new HttpError(400, 'El importe debe ser mayor que 0');
  if (!Number.isInteger(remind) || remind < 0 || remind > 30) throw new HttpError(400, 'Los días de aviso deben estar entre 0 y 30');
  if (b.categoryId && !db.categories.some((c) => c.id === b.categoryId && c.userId === req.user.id))
    throw new HttpError(400, 'Categoría no válida');
  if (b.accountId && !db.accounts.some((a) => a.id === b.accountId && a.userId === req.user.id)) throw new HttpError(400, 'Cuenta no válida');
  const frequency = R.FREQS[b.frequency] ? b.frequency : 'monthly';
  let anchorDate = D.isYmd(b.anchorDate) ? b.anchorDate : null;
  let day = Number(b?.dayOfMonth);
  if (anchorDate) day = D.parse(anchorDate).getDate();
  else {
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new HttpError(400, 'Indica la fecha del primer cobro');
    const t = D.today();
    anchorDate = D.ymd(D.dueInMonth(day, t.getFullYear(), t.getMonth()));
  }
  const out = {
    name,
    amount: round(amount),
    categoryId: b.categoryId || null,
    accountId: b.accountId || null,
    frequency,
    anchorDate,
    dayOfMonth: day,
    place: String(b.place || '').trim().slice(0, 100),
    remindDaysBefore: remind,
    autoAdd: !!b.autoAdd,
    active: b.active === undefined ? true : !!b.active,
  };
  if (frequency === 'custom') {
    const every = Math.round(Number(b.every));
    if (!(every >= 1 && every <= 365)) throw new HttpError(400, 'Indica cada cuántos días o meses se repite');
    Object.assign(out, { every, unit: b.unit === 'days' ? 'days' : 'months' });
  }
  return out;
}
function recurringView(r) {
  const st = R.status(r);
  return {
    ...r,
    state: st.state,
    nextDue: st.nextDue ? D.ymd(st.nextDue) : null,
    daysLeft: st.daysLeft,
    paidThisMonth: st.paidThisPeriod,
    monthly: R.monthlyAmount(r),
    frequencyLabel: R.freqLabel(r),
  };
}
app.get('/api/recurring', (req, res) => res.json(mine(db.recurring, req).map(recurringView).sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999))));
app.post('/api/recurring', h(async (req, res) => {
  const r = { id: store.id(), userId: req.user.id, ...cleanRecurring(req.body, req), startDate: D.ymd(D.today()), paid: [], createdAt: new Date().toISOString() };
  db.recurring.push(r);
  store.save();
  await scheduler.checkUser(req.user); // por si el aviso ya toca
  res.json(recurringView(r));
}));
app.put('/api/recurring/:id', h(async (req, res) => {
  const r = findMine(db.recurring, req);
  const before = r.anchorDate;
  Object.assign(r, cleanRecurring(req.body, req));
  if (before !== r.anchorDate) delete r.lastRemindedFor;
  if (r.frequency !== 'custom') { delete r.every; delete r.unit; }
  store.save();
  await scheduler.checkUser(req.user);
  res.json(recurringView(r));
}));
app.delete('/api/recurring/:id', h(async (req, res) => {
  const r = findMine(db.recurring, req);
  db.recurring.splice(db.recurring.indexOf(r), 1);
  store.save();
  res.json({ ok: true });
}));
// Marcar como pagado el cobro pendiente (atrasado o el próximo): crea el gasto real una sola vez
app.post('/api/recurring/:id/pay', h(async (req, res) => {
  const r = findMine(db.recurring, req);
  const st = R.status(r);
  if (!r.active) throw new HttpError(400, 'Este pago está en pausa');
  if (!st.nextDue || st.daysLeft > 45) throw new HttpError(400, 'Todavía no hay ningún cobro pendiente');
  if (R.isPaid(r, st.nextDue)) throw new HttpError(400, 'Ese cobro ya está marcado como pagado');
  const amount = Number(req.body?.amount) > 0 ? round(Number(req.body.amount)) : r.amount;
  const e = {
    id: store.id(),
    userId: req.user.id,
    name: r.name,
    amount,
    categoryId: r.categoryId,
    date: D.ymd(D.today()),
    place: r.place || '',
    notes: `Pago fijo (vencimiento ${st.nextDue.toLocaleDateString('es-ES')})`,
    recurringId: r.id,
    dueDate: D.ymd(st.nextDue),
    accountId: r.accountId || null,
    paymentMethod: 'domiciliacion',
    tags: [],
    createdAt: new Date().toISOString(),
  };
  db.expenses.push(e);
  R.markPaid(r, st.nextDue);
  store.save();
  res.json({ expense: e, recurring: recurringView(r) });
}));

// ---------- Resúmenes y correo ----------
app.get('/api/summary/week', (req, res) => {
  const date = D.isYmd(req.query.date) ? req.query.date : D.ymd(D.today());
  res.json(weekSummary(req.user.id, date));
});
app.post('/api/summary/week/email', h(async (req, res) => {
  const date = D.isYmd(req.body?.date) ? req.body.date : D.ymd(D.today());
  res.json(await mailer.send(mailer.weeklyEmail(req.user, weekSummary(req.user.id, date))));
}));
app.get('/api/mail/status', (req, res) => res.json({ configured: mailer.configured(), to: req.user.email, outbox: mailer.OUTBOX }));
app.post('/api/mail/test', h(async (req, res) => res.json(await mailer.send(mailer.testEmail(req.user)))));

// ---------- Errores ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || err.statusCode || 500).json({ error: err.status ? err.message : err.type === 'entity.too.large' ? 'Archivo demasiado grande' : 'Error interno', ...(err.fallback ? { fallback: true } : {}), ...(err.code && typeof err.code === 'string' && err.status ? { code: err.code } : {}) });
});

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

async function start(port = Number(process.env.PORT || 3000)) {
  await store.init();
  migrateCategoryIcons();
  auth.migrateSessions();
  auth.ensureAdmin();
  if (!S.hasKey()) console.warn("   ⚠ Falta APP_SECRET: los secretos del 2FA se guardarán sin cifrar");
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`\n💸 Agenda de Gastos funcionando en http://localhost:${port}`);
      for (const ip of lanAddresses()) console.log(`   Desde otros dispositivos de tu red: http://${ip}:${port}`);
      console.log(
        mailer.useBrevo() ? '   Correo: Brevo ✅' : mailer.configured() ? '   Correo: SMTP ✅' : '   Correo: sin configurar -> los correos se guardan en data/outbox'
      );
      scheduler.start();
      resolve(server);
    });
    server.on('error', reject);
  });
}

if (require.main === module)
  start().catch((e) => {
    console.error('No se pudo arrancar:', e);
    process.exit(1);
  });
// Guardar lo pendiente antes de que el hosting apague el servidor
process.on('SIGTERM', async () => {
  await store.flush();
  process.exit(0);
});
module.exports = { start, app };
