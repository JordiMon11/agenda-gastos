// Utilidades de seguridad: contraseñas, 2FA (TOTP), cifrado, límites de intentos, cookies, cabeceras y CSRF
const crypto = require('crypto');

// ---------- Contraseñas (scrypt) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64, SCRYPT).toString('hex') };
}
function verifyPassword(pw, salt, hash) {
  const calc = Buffer.from(hashPassword(pw, salt).hash, 'hex');
  const real = Buffer.from(hash, 'hex');
  return calc.length === real.length && crypto.timingSafeEqual(calc, real);
}
// Hash de relleno para que comprobar un correo inexistente tarde lo mismo (evita adivinar qué correos existen)
const DUMMY = hashPassword('relleno-que-nunca-coincide');
function checkPasswordPolicy(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
  if (pw.length > 200) return 'La contraseña es demasiado larga';
  if (!/[a-zA-ZñÑ]/.test(pw) || !/\d/.test(pw)) return 'La contraseña debe incluir letras y números';
  if (/^(.)\1+$/.test(pw) || /^(12345678|password|contraseña|qwertyui)/i.test(pw)) return 'Esa contraseña es demasiado fácil de adivinar';
  return null;
}

// ---------- Tokens ----------
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

// ---------- Cifrado de secretos (AES-256-GCM) ----------
// La clave sale de APP_SECRET (variable de entorno). Sin ella los secretos se guardan sin cifrar.
const KEY = process.env.APP_SECRET ? crypto.createHash('sha256').update(process.env.APP_SECRET).digest() : null;
function encrypt(text) {
  if (!KEY) return text;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(value) {
  if (!value || !String(value).startsWith('enc:')) return value;
  if (!KEY) throw new Error('Falta APP_SECRET para descifrar los datos de seguridad');
  const buf = Buffer.from(value.slice(4), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// ---------- TOTP (RFC 6238), compatible con Google Authenticator, Authy, Microsoft Authenticator ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
// Devuelve el "paso" de tiempo que coincide (para impedir reutilizar un código) o null
function verifyTotp(secretB32, code, lastStep = -1) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now - 1, now, now + 1]) {
    if (step > lastStep && safeEqual(hotp(secret, step), code)) return step;
  }
  return null;
}
const otpauthUrl = (secret, email) =>
  `otpauth://totp/${encodeURIComponent('Agenda de Gastos')}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent('Agenda de Gastos')}&algorithm=SHA1&digits=6&period=30`;
function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(5)).toLowerCase();
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
}
const normalizeRecovery = (c) => String(c || '').toLowerCase().replace(/[^a-z2-7]/g, '');

// ---------- Límite de intentos (en memoria) ----------
const buckets = new Map();
function limiter({ key, max, windowMs }) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  return { ok: b.count <= max, retryIn: Math.ceil((b.reset - now) / 60000) };
}
const resetLimit = (key) => buckets.delete(key);
setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (b.reset < n) buckets.delete(k); }, 10 * 60 * 1000).unref();

// ---------- Cookies ----------
const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Strict${secure}`);
}
function clearSessionCookie(req, res) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secure}`);
}

// ---------- Cabeceras de seguridad ----------
function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
      "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
}

// ---------- CSRF ----------
// Las peticiones que modifican datos deben llevar la cabecera X-Requested-With (un sitio ajeno no puede añadirla)
// y, si el navegador indica el origen, debe ser este mismo servidor.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/cron') return next();
  if (req.get('x-requested-with') !== 'agenda') return res.status(403).json({ error: 'Petición no permitida' });
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origen no permitido' });
    } catch {
      return res.status(403).json({ error: 'Origen no permitido' });
    }
  }
  next();
}

const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';
function deviceName(ua = '') {
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone/iPad' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Dispositivo';
  const app = /Electron/i.test(ua) ? 'App de escritorio' : /Edg\//i.test(ua) ? 'Edge' : /OPR\//i.test(ua) ? 'Opera' : /Firefox/i.test(ua) ? 'Firefox' : /Chrome/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : 'Navegador';
  return `${app} en ${os}`;
}

module.exports = {
  hashPassword, verifyPassword, DUMMY, checkPasswordPolicy,
  randomToken, sha256, safeEqual, encrypt, decrypt, hasKey: () => !!KEY,
  newTotpSecret, verifyTotp, otpauthUrl, newRecoveryCodes, normalizeRecovery,
  limiter, resetLimit,
  SESSION_DAYS, SESSION_COOKIE, parseCookies, setSessionCookie, clearSessionCookie,
  securityHeaders, csrfGuard, clientIp, deviceName,
};
