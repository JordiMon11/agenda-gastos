// Panel de administración: usuarios, contraseñas, bloqueos, roles y ajustes de la app.
// Solo para administradores con la verificación en dos pasos activada. Cada acción queda registrada.
const express = require('express');
const store = require('./db');
const { db } = store;
const S = require('./security');
const mailer = require('./mailer');
const A = require('./auth');
const { HttpError } = A;

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

router.use((req, res, next) => {
  if (!A.isAdmin(req.user)) return res.status(403).json({ error: 'Solo los administradores pueden entrar aquí' });
  if (!req.user.totp) return res.status(403).json({ error: 'Activa la verificación en dos pasos para usar la administración', code: 'admin_2fa' });
  next();
});

function audit(req, action, target, detail = '') {
  db.adminLog.push({
    id: store.id(), at: new Date().toISOString(), ip: S.clientIp(req),
    adminId: req.user.id, adminEmail: req.user.email,
    targetId: target?.id || null, targetEmail: target?.email || null, action, detail,
  });
  if (db.adminLog.length > 500) db.adminLog.splice(0, db.adminLog.length - 500);
  if (target && target.id !== req.user.id) A.logEvent(target, 'admin_change', req);
  store.save();
}
const findUser = (id) => {
  const u = db.users.find((x) => x.id === id);
  if (!u) throw new HttpError(404, 'Usuario no encontrado');
  return u;
};
const notSelf = (req, u, msg) => { if (u.id === req.user.id) throw new HttpError(400, msg); };
const adminCount = () => db.users.filter((u) => A.isAdmin(u) && !u.blocked).length;
const count = (list, id) => list.reduce((n, x) => n + (x.userId === id ? 1 : 0), 0);

function userRow(u) {
  const sessions = db.sessions.filter((s) => s.userId === u.id && s.expires > Date.now());
  return {
    id: u.id, name: u.name, email: u.email, createdAt: u.createdAt,
    lastActiveAt: u.lastActiveAt || sessions.reduce((m, s) => Math.max(m, s.lastSeen), 0) || u.createdAt,
    twoFactor: !!u.totp, blocked: !!u.blocked, isAdmin: A.isAdmin(u), envAdmin: A.isAdmin(u) && u.role !== 'admin',
    locked: !!(u.lockedUntil && u.lockedUntil > Date.now()), mustChangePassword: !!u.mustChangePassword,
    sessions: sessions.length,
    counts: { expenses: count(db.expenses, u.id), incomes: count(db.incomes, u.id), recurring: count(db.recurring, u.id), savings: count(db.savings, u.id) },
  };
}

// ---------- Resumen ----------
router.get('/stats', (req, res) => {
  const now = Date.now();
  const days = (n) => new Date(now - n * 86400000).toISOString();
  const users = db.users;
  const regs = [...Array(30)].map((_, i) => {
    const d = new Date(now - (29 - i) * 86400000).toISOString().slice(0, 10);
    return { date: d, count: users.filter((u) => (u.createdAt || '').startsWith(d)).length };
  });
  res.json({
    users: users.length,
    newWeek: users.filter((u) => u.createdAt >= days(7)).length,
    newMonth: users.filter((u) => u.createdAt >= days(30)).length,
    active7: users.filter((u) => (userRow(u).lastActiveAt || '') >= days(7)).length,
    twoFactor: users.filter((u) => u.totp).length,
    admins: users.filter(A.isAdmin).length,
    blocked: users.filter((u) => u.blocked).length,
    registrations: regs,
    totals: { expenses: db.expenses.length, incomes: db.incomes.length, recurring: db.recurring.length, savings: db.savings.length },
    mailConfigured: mailer.configured(),
    encrypted: S.hasKey(),
    settings: db.settings,
  });
});

// ---------- Usuarios ----------
router.get('/users', (req, res) => {
  res.json(db.users.map(userRow).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
});

router.patch('/users/:id', h(async (req, res) => {
  const u = findUser(req.params.id);
  const changes = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'El nombre no puede estar vacío');
    if (name !== u.name) { changes.push(`nombre: ${u.name} → ${name}`); u.name = name; }
  }
  if (req.body?.email !== undefined) {
    const email = String(req.body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Correo no válido');
    if (email !== u.email) {
      if (db.users.some((x) => x.email === email)) throw new HttpError(409, 'Ya existe una cuenta con ese correo');
      const old = u.email;
      changes.push(`correo: ${old} → ${email}`);
      u.email = email;
      mailer.send(mailer.securityChangeEmail({ ...u, email: old }, `Un administrador ha cambiado el correo de tu cuenta a ${email}.`)).catch(() => {});
    }
  }
  if (changes.length) audit(req, 'Datos editados', u, changes.join('; '));
  res.json(userRow(u));
}));

router.post('/users/:id/reset-link', h(async (req, res) => {
  const u = findUser(req.params.id);
  const r = await mailer.send(mailer.resetEmail(u, A.createResetLink(req, u)));
  audit(req, 'Enlace para restablecer contraseña enviado', u);
  res.json({ ok: true, simulated: !!r.simulated });
}));

router.post('/users/:id/temp-password', h(async (req, res) => {
  const u = findUser(req.params.id);
  notSelf(req, u, 'Para cambiar tu propia contraseña usa el apartado Seguridad');
  const raw = S.randomToken(9).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
  const password = `${raw}${Math.floor(Math.random() * 90 + 10)}`;
  const hp = S.hashPassword(password);
  Object.assign(u, { salt: hp.salt, passHash: hp.hash, mustChangePassword: true, passwordChangedAt: new Date().toISOString(), failedLogins: 0 });
  delete u.lockedUntil;
  A.revokeSessions(u.id);
  audit(req, 'Contraseña temporal generada', u);
  mailer.send(mailer.securityChangeEmail(u, 'Un administrador te ha asignado una contraseña temporal. Te la comunicará por otro medio y tendrás que cambiarla al entrar.')).catch(() => {});
  res.json({ password });
}));

router.post('/users/:id/disable-2fa', h(async (req, res) => {
  const u = findUser(req.params.id);
  notSelf(req, u, 'No puedes quitarte el 2FA desde aquí: sin él perderías el acceso a la administración');
  if (!u.totp) throw new HttpError(400, 'Este usuario no tiene la verificación en dos pasos activada');
  delete u.totp; delete u.totpLastStep; delete u.recoveryCodes; delete u.totpPending;
  A.revokeSessions(u.id);
  audit(req, 'Verificación en dos pasos desactivada', u);
  mailer.send(mailer.securityChangeEmail(u, 'Un administrador ha desactivado la verificación en dos pasos de tu cuenta. Vuelve a activarla en Seguridad.')).catch(() => {});
  res.json(userRow(u));
}));

router.post('/users/:id/logout-all', h(async (req, res) => {
  const u = findUser(req.params.id);
  notSelf(req, u, 'Para cerrar tus sesiones usa el apartado Seguridad');
  A.revokeSessions(u.id);
  audit(req, 'Sesiones cerradas', u);
  res.json(userRow(u));
}));

router.post('/users/:id/unlock', h(async (req, res) => {
  const u = findUser(req.params.id);
  delete u.lockedUntil;
  u.failedLogins = 0;
  audit(req, 'Cuenta desbloqueada', u);
  res.json(userRow(u));
}));

router.post('/users/:id/block', h(async (req, res) => {
  const u = findUser(req.params.id);
  notSelf(req, u, 'No puedes desactivar tu propia cuenta');
  const blocked = !!req.body?.blocked;
  if (blocked && A.isAdmin(u) && adminCount() <= 1) throw new HttpError(400, 'Debe quedar al menos un administrador activo');
  u.blocked = blocked;
  if (blocked) A.revokeSessions(u.id);
  audit(req, blocked ? 'Cuenta desactivada' : 'Cuenta reactivada', u);
  res.json(userRow(u));
}));

router.post('/users/:id/role', h(async (req, res) => {
  const u = findUser(req.params.id);
  const admin = !!req.body?.admin;
  if (!admin) {
    notSelf(req, u, 'No puedes quitarte a ti mismo los permisos de administrador');
    if (u.role !== 'admin') throw new HttpError(400, 'Este administrador está definido en ADMIN_EMAILS (configuración del servidor)');
    if (adminCount() <= 1) throw new HttpError(400, 'Debe quedar al menos un administrador');
    delete u.role;
  } else {
    if (u.blocked) throw new HttpError(400, 'Reactiva la cuenta antes de hacerla administradora');
    u.role = 'admin';
  }
  audit(req, admin ? 'Permisos de administrador concedidos' : 'Permisos de administrador retirados', u);
  res.json(userRow(u));
}));

router.delete('/users/:id', h(async (req, res) => {
  const u = findUser(req.params.id);
  notSelf(req, u, 'No puedes eliminar tu propia cuenta desde aquí');
  if (String(req.body?.confirmEmail || '').trim().toLowerCase() !== u.email) throw new HttpError(400, 'Escribe el correo del usuario para confirmar');
  if (A.isAdmin(u) && adminCount() <= 1) throw new HttpError(400, 'Debe quedar al menos un administrador');
  audit(req, 'Cuenta eliminada', u, `${userRow(u).counts.expenses} gastos, ${userRow(u).counts.incomes} ingresos`);
  await store.deleteUserData(u.id);
  res.json({ ok: true });
}));

// ---------- Registro de acciones y ajustes ----------
router.get('/log', (req, res) => res.json(db.adminLog.slice(-100).reverse()));

router.get('/settings', (req, res) => res.json(db.settings));
router.put('/settings', h(async (req, res) => {
  const b = req.body || {};
  const before = JSON.stringify(db.settings);
  db.settings = {
    ...db.settings, // conserva la marca de entorno y otros ajustes internos
    registrationOpen: b.registrationOpen === undefined ? db.settings.registrationOpen !== false : !!b.registrationOpen,
    banner: b.banner === undefined ? db.settings.banner || '' : String(b.banner).trim().slice(0, 300),
    bannerType: ['info', 'warn', 'ok'].includes(b.bannerType) ? b.bannerType : db.settings.bannerType || 'info',
  };
  if (JSON.stringify(db.settings) !== before) audit(req, 'Ajustes de la aplicación cambiados', null, `registros ${db.settings.registrationOpen ? 'abiertos' : 'cerrados'}; aviso: ${db.settings.banner ? '«' + db.settings.banner + '»' : 'ninguno'}`);
  res.json(db.settings);
}));

module.exports = { router };
