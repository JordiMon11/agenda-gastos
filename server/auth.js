// Autenticación: registro, inicio de sesión con 2FA, sesiones, perfil y registro de actividad
const express = require('express');
const QRCode = require('qrcode');
const store = require('./db');
const { db } = store;
const D = require('./dates');
const mailer = require('./mailer');
const S = require('./security');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const LOGIN_TICKET_MS = 5 * 60 * 1000;
const tickets = new Map(); // inicio de sesión pendiente de 2FA: ticket -> { userId, exp, tries }

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    createdAt: u.createdAt,
    notify: u.notify,
    twoFactor: !!u.totp,
    recoveryLeft: u.totp ? (u.recoveryCodes || []).length : 0,
    passwordChangedAt: u.passwordChangedAt || u.createdAt,
  };
}

// ---------- Registro de actividad ----------
const EVENT_TEXT = {
  login: 'Inicio de sesión',
  login_failed: 'Intento de acceso fallido',
  login_2fa_failed: 'Código de verificación incorrecto',
  login_recovery: 'Acceso con código de recuperación',
  register: 'Cuenta creada',
  logout: 'Sesión cerrada',
  password_changed: 'Contraseña cambiada',
  twofa_enabled: 'Verificación en dos pasos activada',
  twofa_disabled: 'Verificación en dos pasos desactivada',
  recovery_regenerated: 'Códigos de recuperación renovados',
  session_revoked: 'Sesión cerrada en otro dispositivo',
  locked: 'Acceso bloqueado temporalmente por intentos fallidos',
};
function logEvent(user, type, req) {
  db.securityLog.push({ id: store.id(), userId: user.id, type, ip: S.clientIp(req), device: S.deviceName(req.get('user-agent')), at: new Date().toISOString() });
  const mine = db.securityLog.filter((e) => e.userId === user.id);
  if (mine.length > 60) {
    const drop = new Set(mine.slice(0, mine.length - 60).map((e) => e.id));
    db.securityLog = db.securityLog.filter((e) => !drop.has(e.id));
  }
}

// ---------- Sesiones ----------
function createSession(req, res, user) {
  const token = S.randomToken();
  const now = Date.now();
  const ua = String(req.get('user-agent') || '').slice(0, 300);
  const known = db.sessions.some((s) => s.userId === user.id && s.ua === ua) || db.securityLog.some((e) => e.userId === user.id && e.type === 'login' && e.device === S.deviceName(ua));
  db.sessions.push({ id: store.id(), hash: S.sha256(token), userId: user.id, createdAt: now, lastSeen: now, expires: now + S.SESSION_DAYS * 86400000, ua, ip: S.clientIp(req) });
  S.setSessionCookie(req, res, token);
  logEvent(user, 'login', req);
  store.save();
  // Aviso por correo si es un dispositivo nuevo
  if (!known && db.sessions.filter((s) => s.userId === user.id).length > 1) {
    mailer.send(mailer.newLoginEmail(user, S.deviceName(ua), S.clientIp(req))).catch((e) => console.error('[aviso acceso]', e.message));
  }
}
function revokeSessions(userId, exceptId = null) {
  db.sessions = db.sessions.filter((s) => s.userId !== userId || s.id === exceptId);
}
// Las sesiones antiguas (sin hash) se eliminan: obliga a volver a entrar con el sistema nuevo
function migrateSessions() {
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.hash && s.expires > Date.now());
  if (db.sessions.length !== before) store.save();
}

function authMiddleware(req, res, next) {
  const token = S.parseCookies(req.get('cookie'))[S.SESSION_COOKIE];
  const hash = token && S.sha256(token);
  const s = hash && db.sessions.find((x) => x.hash === hash);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'No has iniciado sesión' });
  const user = db.users.find((u) => u.id === s.userId);
  if (!user) return res.status(401).json({ error: 'No has iniciado sesión' });
  if (Date.now() - s.lastSeen > 5 * 60 * 1000) {
    s.lastSeen = Date.now();
    s.ip = S.clientIp(req);
    store.save();
  }
  req.user = user;
  req.session = s;
  next();
}

const router = express.Router();
const publicRouter = express.Router();

// ---------- Registro ----------
publicRouter.post('/auth/register', h(async (req, res) => {
  const ip = S.clientIp(req);
  if (!S.limiter({ key: 'reg:' + ip, max: 5, windowMs: 60 * 60 * 1000 }).ok) throw new HttpError(429, 'Demasiados registros desde esta conexión. Inténtalo más tarde.');
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!name) throw new HttpError(400, 'Escribe tu nombre');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 160) throw new HttpError(400, 'Escribe un correo válido');
  const policy = S.checkPasswordPolicy(password);
  if (policy) throw new HttpError(400, policy);
  if (password.toLowerCase().includes(email.split('@')[0])) throw new HttpError(400, 'La contraseña no puede contener tu correo');
  if (db.users.some((u) => u.email === email)) throw new HttpError(409, 'Ya existe una cuenta con ese correo');
  const { salt, hash } = S.hashPassword(password);
  const user = {
    id: store.id(), name, email, salt, passHash: hash,
    createdAt: new Date().toISOString(), passwordChangedAt: new Date().toISOString(),
    notify: { reminders: true, weekly: true },
    lastWeeklySent: D.ymd(D.weekStart(D.today())),
  };
  db.users.push(user);
  for (const c of router.DEFAULT_CATEGORIES || []) db.categories.push({ id: store.id(), userId: user.id, ...c });
  logEvent(user, 'register', req);
  createSession(req, res, user);
  mailer.send(mailer.welcomeEmail(user)).catch((e) => console.error('[bienvenida]', e.message));
  res.json({ user: publicUser(user) });
}));

// ---------- Inicio de sesión (paso 1: contraseña) ----------
publicRouter.post('/auth/login', h(async (req, res) => {
  const ip = S.clientIp(req);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const ipLimit = S.limiter({ key: 'login-ip:' + ip, max: 30, windowMs: 15 * 60 * 1000 });
  if (!ipLimit.ok) throw new HttpError(429, `Demasiados intentos. Espera ${ipLimit.retryIn} min.`);
  const user = db.users.find((u) => u.email === email);
  const lock = user?.lockedUntil && user.lockedUntil > Date.now();
  if (lock) throw new HttpError(429, `Cuenta bloqueada temporalmente por seguridad. Inténtalo en ${Math.ceil((user.lockedUntil - Date.now()) / 60000)} min.`);
  const ok = user ? S.verifyPassword(password, user.salt, user.passHash) : (S.verifyPassword(password, S.DUMMY.salt, S.DUMMY.hash), false);
  if (!ok) {
    if (user) {
      user.failedLogins = (user.failedLogins || 0) + 1;
      logEvent(user, 'login_failed', req);
      if (user.failedLogins >= 5) {
        user.lockedUntil = Date.now() + 15 * 60 * 1000;
        user.failedLogins = 0;
        logEvent(user, 'locked', req);
        mailer.send(mailer.lockedEmail(user, S.clientIp(req))).catch(() => {});
      }
      store.save();
    }
    throw new HttpError(401, 'Correo o contraseña incorrectos');
  }
  user.failedLogins = 0;
  // Si el hash se creó con parámetros antiguos se puede renovar aquí en el futuro
  if (user.totp) {
    const ticket = S.randomToken();
    tickets.set(ticket, { userId: user.id, exp: Date.now() + LOGIN_TICKET_MS, tries: 0 });
    store.save();
    return res.json({ twoFactor: true, ticket });
  }
  createSession(req, res, user);
  res.json({ user: publicUser(user) });
}));

// ---------- Inicio de sesión (paso 2: código 2FA o de recuperación) ----------
publicRouter.post('/auth/2fa', h(async (req, res) => {
  const t = tickets.get(String(req.body?.ticket || ''));
  if (!t || t.exp < Date.now()) throw new HttpError(401, 'La verificación ha caducado. Vuelve a introducir tu contraseña.');
  const user = db.users.find((u) => u.id === t.userId);
  if (!user?.totp) throw new HttpError(401, 'La verificación ha caducado. Vuelve a introducir tu contraseña.');
  t.tries++;
  if (t.tries > 5) {
    tickets.delete(req.body.ticket);
    throw new HttpError(429, 'Demasiados códigos incorrectos. Vuelve a empezar.');
  }
  const code = String(req.body?.code || '').trim();
  let ok = false;
  let usedRecovery = false;
  if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
    const step = S.verifyTotp(S.decrypt(user.totp), code, user.totpLastStep ?? -1);
    if (step !== null) { user.totpLastStep = step; ok = true; }
  } else {
    const hash = S.sha256(S.normalizeRecovery(code));
    const idx = (user.recoveryCodes || []).findIndex((c) => S.safeEqual(c, hash));
    if (idx >= 0) { user.recoveryCodes.splice(idx, 1); ok = true; usedRecovery = true; }
  }
  if (!ok) {
    logEvent(user, 'login_2fa_failed', req);
    store.save();
    throw new HttpError(401, 'Código incorrecto');
  }
  tickets.delete(req.body.ticket);
  if (usedRecovery) logEvent(user, 'login_recovery', req);
  createSession(req, res, user);
  res.json({ user: publicUser(user) });
}));

publicRouter.post('/auth/logout', (req, res) => {
  const token = S.parseCookies(req.get('cookie'))[S.SESSION_COOKIE];
  if (token) {
    const hash = S.sha256(token);
    const s = db.sessions.find((x) => x.hash === hash);
    if (s) {
      const user = db.users.find((u) => u.id === s.userId);
      db.sessions = db.sessions.filter((x) => x !== s);
      if (user) logEvent(user, 'logout', req);
      store.save();
    }
  }
  S.clearSessionCookie(req, res);
  res.json({ ok: true });
});

// ---------- Perfil ----------
router.get('/me', (req, res) => res.json(publicUser(req.user)));
router.put('/me', h(async (req, res) => {
  const b = req.body || {};
  if (b.name !== undefined) {
    if (!String(b.name).trim()) throw new HttpError(400, 'El nombre no puede estar vacío');
    req.user.name = String(b.name).trim().slice(0, 60);
  }
  if (b.notify) req.user.notify = { reminders: !!b.notify.reminders, weekly: !!b.notify.weekly };
  store.save();
  res.json(publicUser(req.user));
}));

function requirePassword(user, pw) {
  if (!S.verifyPassword(String(pw || ''), user.salt, user.passHash)) throw new HttpError(401, 'La contraseña actual no es correcta');
}
function requireTotp(user, code) {
  const step = S.verifyTotp(S.decrypt(user.totp), code, user.totpLastStep ?? -1);
  if (step === null) throw new HttpError(401, 'El código de verificación no es correcto');
  user.totpLastStep = step;
}

router.post('/me/password', h(async (req, res) => {
  const u = req.user;
  if (!S.limiter({ key: 'pw:' + u.id, max: 8, windowMs: 15 * 60 * 1000 }).ok) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  requirePassword(u, req.body?.currentPassword);
  const pw = String(req.body?.newPassword || '');
  const policy = S.checkPasswordPolicy(pw);
  if (policy) throw new HttpError(400, policy);
  if (S.verifyPassword(pw, u.salt, u.passHash)) throw new HttpError(400, 'La nueva contraseña debe ser distinta de la actual');
  if (u.totp) requireTotp(u, req.body?.code);
  const hp = S.hashPassword(pw);
  Object.assign(u, { salt: hp.salt, passHash: hp.hash, passwordChangedAt: new Date().toISOString() });
  revokeSessions(u.id, req.session.id); // cierra el resto de dispositivos
  logEvent(u, 'password_changed', req);
  store.save();
  mailer.send(mailer.securityChangeEmail(u, 'Se ha cambiado la contraseña de tu cuenta.')).catch(() => {});
  res.json(publicUser(u));
}));

// ---------- Verificación en dos pasos ----------
router.post('/2fa/setup', h(async (req, res) => {
  const u = req.user;
  if (u.totp) throw new HttpError(400, 'La verificación en dos pasos ya está activada');
  const secret = S.newTotpSecret();
  u.totpPending = S.encrypt(secret);
  store.save();
  const url = S.otpauthUrl(secret, u.email);
  res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), qr: await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' }) });
}));
router.post('/2fa/enable', h(async (req, res) => {
  const u = req.user;
  if (!u.totpPending) throw new HttpError(400, 'Primero genera el código QR');
  const secret = S.decrypt(u.totpPending);
  const step = S.verifyTotp(secret, req.body?.code);
  if (step === null) throw new HttpError(400, 'El código no es correcto. Revisa que la hora del móvil esté bien y vuelve a probar.');
  const codes = S.newRecoveryCodes();
  u.totp = S.encrypt(secret);
  u.totpLastStep = step;
  u.recoveryCodes = codes.map((c) => S.sha256(S.normalizeRecovery(c)));
  delete u.totpPending;
  revokeSessions(u.id, req.session.id);
  logEvent(u, 'twofa_enabled', req);
  store.save();
  mailer.send(mailer.securityChangeEmail(u, 'Has activado la verificación en dos pasos. A partir de ahora necesitarás tu app autenticadora para entrar.')).catch(() => {});
  res.json({ user: publicUser(u), recoveryCodes: codes });
}));
router.post('/2fa/disable', h(async (req, res) => {
  const u = req.user;
  if (!u.totp) throw new HttpError(400, 'La verificación en dos pasos no está activada');
  requirePassword(u, req.body?.password);
  requireTotp(u, req.body?.code);
  delete u.totp;
  delete u.totpLastStep;
  delete u.recoveryCodes;
  logEvent(u, 'twofa_disabled', req);
  store.save();
  mailer.send(mailer.securityChangeEmail(u, 'Se ha DESACTIVADO la verificación en dos pasos de tu cuenta. Si no has sido tú, cambia tu contraseña ya.')).catch(() => {});
  res.json(publicUser(u));
}));
router.post('/2fa/recovery', h(async (req, res) => {
  const u = req.user;
  if (!u.totp) throw new HttpError(400, 'La verificación en dos pasos no está activada');
  requireTotp(u, req.body?.code);
  const codes = S.newRecoveryCodes();
  u.recoveryCodes = codes.map((c) => S.sha256(S.normalizeRecovery(c)));
  logEvent(u, 'recovery_regenerated', req);
  store.save();
  res.json({ user: publicUser(u), recoveryCodes: codes });
}));

// ---------- Sesiones abiertas y actividad ----------
router.get('/sessions', (req, res) => {
  res.json(
    db.sessions
      .filter((s) => s.userId === req.user.id && s.expires > Date.now())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((s) => ({ id: s.id, device: S.deviceName(s.ua), ip: s.ip, createdAt: s.createdAt, lastSeen: s.lastSeen, current: s.id === req.session.id }))
  );
});
router.delete('/sessions/:id', h(async (req, res) => {
  const s = db.sessions.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!s) throw new HttpError(404, 'Sesión no encontrada');
  if (s.id === req.session.id) throw new HttpError(400, 'Para cerrar esta sesión usa «Cerrar sesión»');
  db.sessions = db.sessions.filter((x) => x !== s);
  logEvent(req.user, 'session_revoked', req);
  store.save();
  res.json({ ok: true });
}));
router.post('/sessions/revoke-others', (req, res) => {
  revokeSessions(req.user.id, req.session.id);
  logEvent(req.user, 'session_revoked', req);
  store.save();
  res.json({ ok: true });
});
router.get('/security-log', (req, res) => {
  res.json(
    db.securityLog
      .filter((e) => e.userId === req.user.id)
      .slice(-30)
      .reverse()
      .map((e) => ({ type: e.type, text: EVENT_TEXT[e.type] || e.type, device: e.device, ip: e.ip, at: e.at }))
  );
});

// Limpieza periódica
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.expires > now);
  if (db.sessions.length !== before) store.save();
}, 10 * 60 * 1000).unref();

module.exports = { router, publicRouter, authMiddleware, migrateSessions, HttpError };
