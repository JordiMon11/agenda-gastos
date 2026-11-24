const path = require('path');
const ROOT = path.join(__dirname, '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {}

const express = require('express');
const crypto = require('crypto');
const os = require('os');
const store = require('./db');
const { db } = store;
const D = require('./dates');
const mailer = require('./mailer');
const scheduler = require('./scheduler');
const { weekSummary, round } = require('./summary');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DEFAULT_CATEGORIES = [
  { name: 'Comida', icon: '🍔', color: '#f97316' },
  { name: 'Supermercado', icon: '🛒', color: '#22c55e' },
  { name: 'Transporte', icon: '🚗', color: '#3b82f6' },
  { name: 'Casa', icon: '🏠', color: '#a855f7' },
  { name: 'Facturas', icon: '💡', color: '#eab308' },
  { name: 'Suscripciones', icon: '📺', color: '#ec4899' },
  { name: 'Ocio', icon: '🎮', color: '#06b6d4' },
  { name: 'Salud', icon: '💊', color: '#ef4444' },
  { name: 'Compras', icon: '🛍️', color: '#8b5cf6' },
  { name: 'Otros', icon: '📦', color: '#64748b' },
];

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: (res, p) => p.endsWith('sw.js') && res.setHeader('Cache-Control', 'no-cache') }));
app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'chart.js', 'dist')));

// ---------- Rutas públicas ----------
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/public-config', (req, res) =>
  res.json({ downloadUrl: process.env.DESKTOP_DOWNLOAD_URL || 'https://github.com/JordiMon11/agenda-gastos/releases/latest/download/Agenda-Gastos-Setup.exe',
    releasesUrl: process.env.RELEASES_URL || 'https://github.com/JordiMon11/agenda-gastos/releases/latest', })
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

// ---------- Autenticación ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function publicUser(u) {
  const { passHash, salt, ...rest } = u;
  return rest;
}
function newSession(u) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ token, userId: u.id, createdAt: Date.now() });
  store.save();
  return token;
}

app.post('/api/auth/register', h(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6)
    throw new HttpError(400, 'Rellena tu nombre, un correo válido y una contraseña de al menos 6 caracteres');
  if (db.users.some((u) => u.email === email)) throw new HttpError(409, 'Ya existe una cuenta con ese correo');
  const { salt, hash } = hashPw(password);
  const user = {
    id: store.id(),
    name,
    email,
    salt,
    passHash: hash,
    createdAt: new Date().toISOString(),
    notify: { reminders: true, weekly: true },
    lastWeeklySent: D.ymd(D.weekStart(D.today())),
  };
  db.users.push(user);
  for (const c of DEFAULT_CATEGORIES) db.categories.push({ id: store.id(), userId: user.id, ...c });
  store.save();
  mailer.send(mailer.welcomeEmail(user)).catch((e) => console.error('[bienvenida]', e.message));
  res.json({ token: newSession(user), user: publicUser(user) });
}));

app.post('/api/auth/login', h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = db.users.find((u) => u.email === email);
  const ok =
    user &&
    crypto.timingSafeEqual(Buffer.from(hashPw(req.body?.password || '', user.salt).hash, 'hex'), Buffer.from(user.passHash, 'hex'));
  if (!ok) throw new HttpError(401, 'Correo o contraseña incorrectos');
  res.json({ token: newSession(user), user: publicUser(user) });
}));

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = token && db.sessions.find((s) => s.token === token);
  const user = s && db.users.find((u) => u.id === s.userId);
  if (!user) return res.status(401).json({ error: 'No has iniciado sesión' });
  req.user = user;
  req.token = token;
  next();
}
app.use('/api', auth);

app.post('/api/auth/logout', (req, res) => {
  db.sessions = db.sessions.filter((s) => s.token !== req.token);
  store.save();
  res.json({ ok: true });
});

// ---------- Perfil ----------
app.get('/api/me', (req, res) => res.json(publicUser(req.user)));
app.put('/api/me', h(async (req, res) => {
  const b = req.body || {};
  if (b.name !== undefined) {
    if (!String(b.name).trim()) throw new HttpError(400, 'El nombre no puede estar vacío');
    req.user.name = String(b.name).trim().slice(0, 60);
  }
  if (b.notify) req.user.notify = { reminders: !!b.notify.reminders, weekly: !!b.notify.weekly };
  if (b.newPassword) {
    if (String(b.newPassword).length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres');
    const { salt, hash } = hashPw(b.newPassword);
    Object.assign(req.user, { salt, passHash: hash });
  }
  store.save();
  res.json(publicUser(req.user));
}));

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
  return { name, color, icon: String(b.icon || '📦').slice(0, 4) };
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
  store.save();
  res.json({ ok: true });
}));

// ---------- Gastos ----------
function cleanExpense(b, req) {
  const amount = Number(b?.amount);
  const name = String(b?.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'El gasto necesita un nombre');
  if (!(amount > 0)) throw new HttpError(400, 'El importe debe ser mayor que 0');
  if (!D.isYmd(b.date)) throw new HttpError(400, 'Fecha no válida');
  if (b.categoryId && !db.categories.some((c) => c.id === b.categoryId && c.userId === req.user.id))
    throw new HttpError(400, 'Categoría no válida');
  return {
    name,
    amount: round(amount),
    categoryId: b.categoryId || null,
    date: b.date,
    place: String(b.place || '').trim().slice(0, 100),
    notes: String(b.notes || '').slice(0, 500),
  };
}
app.get('/api/expenses', (req, res) => {
  const { from, to, category, q } = req.query;
  let list = mine(db.expenses, req);
  if (from) list = list.filter((e) => e.date >= from);
  if (to) list = list.filter((e) => e.date <= to);
  if (category) list = list.filter((e) => (category === 'none' ? !e.categoryId : e.categoryId === category));
  if (q) {
    const s = String(q).toLowerCase();
    list = list.filter((e) => `${e.name} ${e.place} ${e.notes}`.toLowerCase().includes(s));
  }
  res.json(list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '')));
});
app.post('/api/expenses', h(async (req, res) => {
  const e = { id: store.id(), userId: req.user.id, ...cleanExpense(req.body, req), createdAt: new Date().toISOString() };
  db.expenses.push(e);
  store.save();
  res.json(e);
}));
app.put('/api/expenses/:id', h(async (req, res) => {
  const e = findMine(db.expenses, req);
  Object.assign(e, cleanExpense(req.body, req));
  store.save();
  res.json(e);
}));
app.delete('/api/expenses/:id', h(async (req, res) => {
  const e = findMine(db.expenses, req);
  db.expenses.splice(db.expenses.indexOf(e), 1);
  store.save();
  res.json({ ok: true });
}));
app.get('/api/places', (req, res) => {
  const counts = {};
  for (const e of mine(db.expenses, req)) if (e.place) counts[e.place] = (counts[e.place] || 0) + 1;
  res.json(Object.keys(counts).sort((a, b) => counts[b] - counts[a]));
});

// ---------- Gastos mensuales (actividades recurrentes) ----------
function cleanRecurring(b, req) {
  const amount = Number(b?.amount);
  const day = Number(b?.dayOfMonth);
  const remind = Number(b?.remindDaysBefore ?? 3);
  const name = String(b?.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'El gasto mensual necesita un nombre');
  if (!(amount > 0)) throw new HttpError(400, 'El importe debe ser mayor que 0');
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new HttpError(400, 'El día del mes debe estar entre 1 y 31');
  if (!Number.isInteger(remind) || remind < 0 || remind > 30) throw new HttpError(400, 'Los días de aviso deben estar entre 0 y 30');
  if (b.categoryId && !db.categories.some((c) => c.id === b.categoryId && c.userId === req.user.id))
    throw new HttpError(400, 'Categoría no válida');
  return {
    name,
    amount: round(amount),
    categoryId: b.categoryId || null,
    dayOfMonth: day,
    place: String(b.place || '').trim().slice(0, 100),
    remindDaysBefore: remind,
    autoAdd: !!b.autoAdd,
    active: b.active === undefined ? true : !!b.active,
  };
}
function recurringView(r) {
  const t = D.today();
  const due = D.nextDue(r, t);
  return { ...r, nextDue: D.ymd(due), daysLeft: D.diffDays(t, due), paidThisMonth: r.lastPaidMonth === D.monthKey(t) };
}
app.get('/api/recurring', (req, res) => res.json(mine(db.recurring, req).map(recurringView).sort((a, b) => a.daysLeft - b.daysLeft)));
app.post('/api/recurring', h(async (req, res) => {
  const r = { id: store.id(), userId: req.user.id, ...cleanRecurring(req.body, req), startDate: D.ymd(D.today()), createdAt: new Date().toISOString() };
  db.recurring.push(r);
  store.save();
  await scheduler.checkUser(req.user); // por si el aviso ya toca
  res.json(recurringView(r));
}));
app.put('/api/recurring/:id', h(async (req, res) => {
  const r = findMine(db.recurring, req);
  const before = r.dayOfMonth;
  Object.assign(r, cleanRecurring(req.body, req));
  if (before !== r.dayOfMonth) delete r.lastRemindedFor;
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
// Marcar como pagado este mes (lo añade a tus gastos)
app.post('/api/recurring/:id/pay', h(async (req, res) => {
  const r = findMine(db.recurring, req);
  const t = D.today();
  const mk = D.monthKey(t);
  if (r.lastPaidMonth === mk) throw new HttpError(400, 'Ya está marcado como pagado este mes');
  const e = {
    id: store.id(),
    userId: req.user.id,
    name: r.name,
    amount: r.amount,
    categoryId: r.categoryId,
    date: D.ymd(t),
    place: r.place || '',
    notes: 'Gasto mensual',
    recurringId: r.id,
    createdAt: new Date().toISOString(),
  };
  db.expenses.push(e);
  r.lastPaidMonth = mk;
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
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Error interno: ' + err.message });
});

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

async function start(port = Number(process.env.PORT || 3000)) {
  await store.init();
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
