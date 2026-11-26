// Conexión con bancos mediante Open Banking (PSD2), SOLO DE CONSULTA.
//
// Proveedores evaluados (noviembre 2026):
//  - GoCardless Bank Account Data (antes Nordigen): cerrado a clientes nuevos desde 2025.
//  - Tink (Visa) y Salt Edge: buena cobertura, pero de pago y con contrato comercial.
//  - Enable Banking: cubre bancos españoles y tiene un modo gratuito para uso personal con tus propias cuentas
//    («restricted mode»). Es el elegido: ENABLEBANKING_APP_ID + ENABLEBANKING_PRIVATE_KEY.
//  - «Banco de demostración»: simulado, para probar todo el flujo en la web de pruebas y en las pruebas automáticas.
//
// Reglas que se cumplen siempre:
//  - La app NUNCA pide ni guarda contraseñas del banco: autorizas en la web oficial de tu banco.
//  - Solo lectura: cuentas, saldos y movimientos. No hay ninguna función de pagos ni transferencias.
//  - El identificador de la sesión con el banco se guarda cifrado (AES-256-GCM con APP_SECRET).
//  - El permiso caduca (máx. 180 días según PSD2): se avisa y se puede renovar. Se puede desconectar en cualquier momento.
//  - Los movimientos pasan por el mismo proceso que un extracto: huella, duplicados y clasificación.
const express = require('express');
const crypto = require('crypto');
const store = require('./db');
const { db } = store;
const D = require('./dates');
const L = require('./ledger');
const S = require('./security');
const A = require('./auth');
const { HttpError } = A;

const of = (list, uid) => list.filter((x) => x.userId === uid);
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
for (const k of ['bankConnections', 'bankSyncs']) if (!Array.isArray(db[k])) db[k] = [];
const round = L.round;
const nowIso = () => new Date().toISOString();
const SYNC_EVERY_H = 6; // los bancos suelen permitir ~4 consultas automáticas al día
const maskIban = (iban) => { const s = String(iban || '').replace(/\s/g, '').toUpperCase(); return s.length > 8 ? `${s.slice(0, 4)} •••• ${s.slice(-4)}` : ''; };

class ProviderError extends Error {
  constructor(message, { expired = false, status = 502 } = {}) { super(message); this.expired = expired; this.status = status; }
}

// ================= Enable Banking (proveedor real) =================
const EB_API = 'https://api.enablebanking.com';
// La configuración puede venir de variables de entorno (Render) o, más cómodo, de la propia app:
// un administrador pega el ID de la aplicación y sube el archivo .pem en «Mi dinero» (se guarda cifrado).
function ebConfig() {
  if (process.env.ENABLEBANKING_APP_ID && process.env.ENABLEBANKING_PRIVATE_KEY) {
    return { appId: process.env.ENABLEBANKING_APP_ID.trim(), key: process.env.ENABLEBANKING_PRIVATE_KEY.replace(/\\n/g, '\n'), source: 'env' };
  }
  const s = db.bankProvider;
  if (s?.appId && s.keyEnc) {
    try { return { appId: s.appId, key: S.decrypt(s.keyEnc), source: 'app' }; } catch { return null; }
  }
  return null;
}
const ebConfigured = () => !!ebConfig();
function ebJwt(cfg = ebConfig()) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ typ: 'JWT', alg: 'RS256', kid: cfg.appId });
  const body = b64({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(cfg.key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
async function ebFetch(path, { method = 'GET', body, cfg, setup = false } = {}) {
  let r;
  try {
    r = await fetch(EB_API + path, { method, headers: { Authorization: `Bearer ${ebJwt(cfg)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new ProviderError('No se ha podido contactar con el servicio de conexión bancaria');
  }
  const data = await r.json().catch(() => ({}));
  if (setup && (r.status === 401 || r.status === 403)) throw new ProviderError('Enable Banking no reconoce ese ID de aplicación con esa clave. Comprueba que el archivo .pem es el de esta aplicación.', { status: 400 });
  if (r.status === 401 && !/session/i.test(path) && !path.startsWith('/accounts')) throw new ProviderError('Enable Banking no acepta las credenciales de la aplicación. Revísalas en Mi dinero → Conexión con tu banco.', { status: 502 });
  if (r.status === 401 || r.status === 403 || /EXPIRED|REVOKED|INVALID_SESSION|CLOSED_SESSION/i.test(data?.error || data?.code || '')) throw new ProviderError('El permiso con el banco ha caducado o se ha revocado', { expired: true, status: 409 });
  if (!r.ok) throw new ProviderError(`El banco no ha respondido bien (${r.status}${data?.message ? ': ' + String(data.message).slice(0, 120) : ''})`);
  return data;
}
const EB_TYPES = { CACC: 'corriente', SVGS: 'ahorro', CARD: 'credito', CASH: 'corriente', LOAN: 'otra', MOMA: 'ahorro', TRAS: 'corriente' };
const enableBanking = {
  id: 'enablebanking',
  name: 'Enable Banking',
  available: ebConfigured,
  async banks() {
    const d = await ebFetch('/aspsps?country=ES&psu_type=personal');
    return (d.aspsps || []).map((a) => ({ id: a.name, name: a.name, logo: a.logo || null, maxDays: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : 90 }));
  },
  async start({ bank, state, redirectUrl, days }) {
    const valid = new Date(Date.now() + Math.min(180, days || 90) * 86400000).toISOString();
    const d = await ebFetch('/auth', { method: 'POST', body: { access: { valid_until: valid }, aspsp: { name: bank, country: 'ES' }, state, redirect_url: redirectUrl, psu_type: 'personal' } });
    return { url: d.url };
  },
  async finish(code) {
    const d = await ebFetch('/sessions', { method: 'POST', body: { code } });
    return {
      session: d.session_id,
      validUntil: d.access?.valid_until || null,
      accounts: (d.accounts || []).map((a) => ({
        externalId: a.uid, name: a.name || a.product || a.details || 'Cuenta', iban: a.account_id?.iban || '', currency: a.currency || 'EUR',
        type: EB_TYPES[a.cash_account_type] || 'corriente', product: a.product || '', shared: false,
      })),
    };
  },
  async balances(session, externalId) {
    const d = await ebFetch(`/accounts/${encodeURIComponent(externalId)}/balances`);
    const list = d.balances || [];
    const pick = (...types) => list.find((b) => types.includes(b.balance_type));
    const booked = pick('CLBD', 'ITBD', 'XPCD', 'OTHR') || list[0];
    const avail = pick('ITAV', 'CLAV', 'XPCD');
    if (!booked) return null;
    return { booked: Number(booked.balance_amount.amount), available: avail ? Number(avail.balance_amount.amount) : null, at: (booked.reference_date || booked.last_change_date_time || D.ymd(D.today())).slice(0, 10), currency: booked.balance_amount.currency };
  },
  async transactions(session, externalId, from) {
    const out = [];
    let key = null;
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ date_from: from, ...(key ? { continuation_key: key } : {}) });
      const d = await ebFetch(`/accounts/${encodeURIComponent(externalId)}/transactions?${qs}`);
      for (const t of d.transactions || []) {
        if (t.status && t.status !== 'BOOK') continue; // solo movimientos contabilizados (los pendientes pueden cambiar)
        const amount = Number(t.transaction_amount?.amount) * (t.credit_debit_indicator === 'DBIT' ? -1 : 1);
        const party = t.credit_debit_indicator === 'DBIT' ? t.creditor?.name : t.debtor?.name;
        out.push({
          bankId: t.entry_reference || t.transaction_id || '', date: (t.booking_date || t.value_date || '').slice(0, 10), valueDate: (t.value_date || '').slice(0, 10) || null,
          description: [party, ...(t.remittance_information || [])].filter(Boolean).join(' · ').slice(0, 300) || 'Movimiento', amount: round(amount), currency: t.transaction_amount?.currency || 'EUR',
          ref: t.reference_number || '', kindHint: t.bank_transaction_code?.description || '', balance: null,
        });
      }
      key = d.continuation_key;
      if (!key) break;
    }
    return out;
  },
  async revoke(session) { await ebFetch(`/sessions/${encodeURIComponent(session)}`, { method: 'DELETE' }).catch(() => {}); },
};

// ================= Banco de demostración (simulado) =================
// Dos bancos ficticios con cuenta corriente, cuenta de ahorro, hucha separada y tarjeta de crédito.
// El código de autorización permite simular errores: «demo-caducado» (permiso ya caducado) y «demo-incompleto»
// (una cuenta no devuelve saldo).
const DEMO_BANKS = {
  'demo-uno': { name: 'Banco Demo Uno', accounts: [
    { externalId: 'uno-corriente', name: 'Cuenta Nómina', iban: 'ES7600730100110123456789', type: 'corriente', booked: 2350, available: 2310, product: 'Cuenta corriente' },
    { externalId: 'uno-ahorro', name: 'Cuenta Ahorro', iban: 'ES1200730100110987654321', type: 'ahorro', booked: 3000, available: 3000, product: 'Cuenta de ahorro' },
    { externalId: 'uno-hucha', name: 'Hucha Vacaciones', iban: 'ES5500730100110555555555', type: 'ahorro', booked: 1000, available: 1000, product: 'Espacio de ahorro' },
  ] },
  'demo-dos': { name: 'Banco Demo Dos', accounts: [
    { externalId: 'dos-corriente', name: 'Cuenta Online', iban: 'ES9014650100720000123456', type: 'corriente', booked: 640.5, available: 640.5, product: 'Cuenta sin comisiones' },
    { externalId: 'dos-tarjeta', name: 'Tarjeta Oro', iban: '', type: 'credito', booked: -230.4, available: 1769.6, product: 'Tarjeta de crédito' },
  ] },
};
function demoTransactions(externalId) {
  const d = (n) => D.ymd(D.addDays(D.today(), -n));
  const T = {
    'uno-corriente': [
      [28, 'NOMINA EMPRESA DEMO SL', 1850], [26, 'RECIBO ALQUILER VIVIENDA', -650], [25, 'COMPRA TARJ. MERCADONA 0452', -62.3], [22, 'RECIBO ENDESA ENERGIA', -54.1],
      [20, 'NETFLIX.COM', -12.99], [18, 'REPSOL ESTACION 1234', -48], [15, 'TRASPASO A CUENTA AHORRO', -300], [12, 'UBER EATS', -21.5],
      [10, 'FARMACIA CENTRAL', -9.4], [8, 'BIZUM ENVIADO A JUAN PEREZ', -15], [5, 'COMPRA AMAZON.ES', -35], [3, 'DEVOLUCION COMPRA AMAZON', 35], [2, 'TIENDA DESCONOCIDA XYZ', -18],
    ],
    'uno-ahorro': [[15, 'TRASPASO DESDE CUENTA NOMINA', 300]],
    'uno-hucha': [[20, 'APORTACION A HUCHA VACACIONES', 100]],
    'dos-corriente': [[24, 'TRANSFERENCIA RECIBIDA DE PEDRO', 120], [14, 'LIQUIDACION TARJETA CREDITO', -230.4], [6, 'LIDL SUPERMERCADOS', -27.8]],
    'dos-tarjeta': [[19, 'ZARA ESPANA', -59.95], [11, 'CINESA LA GAVIA', -18], [4, 'SPOTIFY AB', -10.99]],
  };
  return (T[externalId] || []).map(([n, desc, amount], i) => ({ bankId: `${externalId}-${i}-${n}`, date: d(n), valueDate: d(n), description: desc, amount, currency: 'EUR', ref: '', kindHint: '', balance: null }));
}
const demo = {
  id: 'demo',
  name: 'Banco de demostración',
  available: () => process.env.APP_ENV === 'pruebas' || process.env.OPENBANKING_PROVIDER === 'demo' || process.env.NODE_ENV === 'test',
  async banks() { return Object.entries(DEMO_BANKS).map(([id, b]) => ({ id, name: b.name, logo: null, maxDays: 90 })); },
  async start({ bank, state, simulate }) { if (!DEMO_BANKS[bank]) throw new ProviderError('Banco no disponible', { status: 400 }); const sim = ['caducado', 'incompleto'].includes(simulate) ? ':' + simulate : ''; return { url: `/banco-conectado?state=${encodeURIComponent(state)}&code=demo:${bank}${sim}` }; },
  async finish(code) {
    const [, bank, mode] = /^demo:([a-z-]+?)(?::(caducado|incompleto))?$/.exec(code) || [];
    if (!DEMO_BANKS[bank]) throw new ProviderError('Código de autorización no válido', { status: 400 });
    return {
      session: `demo-session:${bank}:${mode || 'ok'}:${crypto.randomUUID()}`,
      validUntil: mode === 'caducado' ? new Date(Date.now() - 86400000).toISOString() : new Date(Date.now() + 90 * 86400000).toISOString(),
      accounts: DEMO_BANKS[bank].accounts.map(({ booked, available, ...a }) => ({ ...a, currency: 'EUR', shared: false })),
    };
  },
  async balances(session, externalId) {
    const [, bank, mode] = session.split(':');
    if (mode === 'caducado') throw new ProviderError('El permiso con el banco ha caducado', { expired: true, status: 409 });
    if (mode === 'incompleto' && externalId.endsWith('ahorro')) throw new ProviderError('El banco no ha devuelto el saldo de esta cuenta');
    const a = DEMO_BANKS[bank].accounts.find((x) => x.externalId === externalId);
    return { booked: a.booked, available: a.available, at: D.ymd(D.today()), currency: 'EUR' };
  },
  async transactions(session, externalId, from) {
    if (session.split(':')[2] === 'caducado') throw new ProviderError('El permiso con el banco ha caducado', { expired: true, status: 409 });
    return demoTransactions(externalId).filter((t) => t.date >= from);
  },
  async revoke() {},
};

const PROVIDERS = { enablebanking: enableBanking, demo };
const activeProviders = () => Object.values(PROVIDERS).filter((p) => p.available());

// ================= Conexiones =================
const pending = new Map(); // state → { userId, connectionId, exp } (autorizaciones en curso, 30 min)
function connView(c) {
  const expired = c.validUntil && c.validUntil < nowIso();
  const status = expired && c.status === 'activa' ? 'caducada' : c.status;
  const daysLeft = c.validUntil ? Math.floor((Date.parse(c.validUntil) - Date.now()) / 86400000) : null;
  return {
    id: c.id, provider: c.provider, providerName: PROVIDERS[c.provider]?.name || c.provider, bank: c.bankName, status, validUntil: c.validUntil || null, daysLeft,
    renewSoon: status === 'activa' && daysLeft !== null && daysLeft <= 7, lastSync: c.lastSync || null, lastError: c.lastError || null, createdAt: c.createdAt,
    accounts: (c.accounts || []).map((a) => ({ externalId: a.externalId, name: a.name, iban: maskIban(a.iban), type: a.type, product: a.product, accountId: a.accountId || null, included: !!a.accountId })),
  };
}
function notify(user, key, title, text, level = 'warn') {
  if (!Array.isArray(db.notifications)) return;
  if (db.notifications.some((n) => n.userId === user.id && n.key === key)) return;
  db.notifications.push({ id: store.id(), userId: user.id, key, type: 'bank', level, title, text, link: '#/cuentas', read: false, createdAt: nowIso() });
}
const sessionOf = (c) => S.decrypt(c.sessionEnc);

// Trae saldos y movimientos de una conexión y los integra con el resto de la app
async function syncConnection(user, c, { reason = 'manual' } = {}) {
  const p = PROVIDERS[c.provider];
  const log = { id: store.id(), userId: user.id, connectionId: c.id, bank: c.bankName, at: nowIso(), reason, status: 'ok', accounts: 0, imported: 0, duplicates: 0, errors: [] };
  const imports = require('./imports');
  if (!p || !p.available()) { log.status = 'error'; log.errors.push('El proveedor de conexión bancaria no está configurado'); }
  else if (c.validUntil && c.validUntil < nowIso()) { log.status = 'caducada'; log.errors.push('El permiso con el banco ha caducado: renuévalo'); }
  else {
    const session = sessionOf(c);
    for (const link of (c.accounts || []).filter((a) => a.accountId)) {
      const acc = db.accounts.find((a) => a.id === link.accountId && a.userId === user.id);
      if (!acc) continue;
      try {
        const bal = await p.balances(session, link.externalId);
        if (bal && Number.isFinite(bal.booked)) acc.bank = { booked: round(bal.booked), available: Number.isFinite(bal.available) ? round(bal.available) : null, at: bal.at, source: 'banco', updatedAt: nowIso() };
        const from = link.lastTxDate ? D.ymd(D.addDays(D.parse(link.lastTxDate), -5)) : D.ymd(D.addDays(D.today(), -90));
        const txs = (await p.transactions(session, link.externalId, from)).filter((t) => D.isYmd(t.date) && Number.isFinite(t.amount) && t.amount !== 0);
        log.accounts++;
        if (txs.length) {
          const rows = imports.analyzeRows(user, acc, { rows: txs.map((t, i) => ({ ...t, line: i + 1, error: '' })) });
          const toImport = rows.filter((r) => r.status === 'new' || (r.status === 'review' && !r.error && r.selected));
          if (toImport.length) {
            const res = await imports.commitImport(user, { accountId: acc.id, fileName: `${c.bankName} · ${acc.name}`, format: 'open banking', bank: c.bankName, detected: rows.length, connectionId: c.id, rows: toImport.map((r) => ({ ...r, action: 'import' })) });
            log.imported += res.imported;
          }
          log.duplicates += rows.filter((r) => r.status === 'duplicate' || r.status === 'possible').length;
          link.lastTxDate = txs.map((t) => t.date).sort().pop();
        }
        link.lastSync = nowIso();
        link.lastError = null;
      } catch (e) {
        link.lastError = e.message;
        log.errors.push(`${acc.name}: ${e.message}`);
        if (e.expired) { log.status = 'caducada'; break; }
        log.status = 'incompleta';
      }
    }
  }
  // Cuentas creadas desde la conexión: no se sabe su saldo de hace 90 días, así que se calcula al final (cuando ya están
  // todos los movimientos y traspasos de todas las cuentas) para que el historial cuadre con el saldo que da el banco
  for (const link of c.accounts || []) {
    const acc = db.accounts.find((a) => a.id === link.accountId && a.userId === user.id);
    if (!acc?.autoInitial || !acc.bank) continue;
    const r = L.accountBalances(user).find((x) => x.id === acc.id)?.reconcile || 0;
    acc.initialBalance = round(acc.initialBalance + r);
    delete acc.autoInitial;
  }
  if (log.status === 'caducada') {
    c.status = 'caducada';
    notify(user, `bank-expired:${c.id}:${c.validUntil || ''}`, `Renueva la conexión con ${c.bankName}`, 'El permiso para leer tus cuentas ha caducado. Los saldos de esas cuentas pueden estar desfasados hasta que lo renueves.');
  } else if (log.status !== 'error') {
    c.status = 'activa';
  }
  c.lastSync = log.at;
  c.lastError = log.errors[0] || null;
  db.bankSyncs.push(log);
  const mine = db.bankSyncs.filter((x) => x.userId === user.id);
  if (mine.length > 200) { const drop = new Set(mine.slice(0, mine.length - 200).map((x) => x.id)); db.bankSyncs = db.bankSyncs.filter((x) => !drop.has(x.id)); }
  await store.save();
  return log;
}

// Sincronización automática (la llama el programador de tareas cada 30 min; cada conexión como mucho cada 6 h)
async function autoSync() {
  for (const c of db.bankConnections.filter((x) => x.status === 'activa')) {
    if (c.lastSync && Date.now() - Date.parse(c.lastSync) < SYNC_EVERY_H * 3600000) continue;
    const user = db.users.find((u) => u.id === c.userId);
    if (!user) continue;
    try { await syncConnection(user, c, { reason: 'automática' }); } catch (e) { console.error('[bancos]', e.message); }
    const days = c.validUntil ? (Date.parse(c.validUntil) - Date.now()) / 86400000 : null;
    if (days !== null && days > 0 && days <= 7) notify(user, `bank-renew:${c.id}:${c.validUntil}`, `La conexión con ${c.bankName} caduca pronto`, `Quedan ${Math.ceil(days)} días. Renuévala para que sigan llegando tus movimientos.`, 'info');
  }
}

// ================= Rutas =================
const router = express.Router();
const myConn = (req, id = req.params.id) => {
  const c = db.bankConnections.find((x) => x.id === id && x.userId === req.user.id);
  if (!c) throw new HttpError(404, 'Conexión no encontrada');
  return c;
};
router.get('/banks/status', (req, res) => {
  const list = activeProviders();
  res.json({
    available: list.length > 0,
    providers: list.map((p) => ({ id: p.id, name: p.name, demo: p.id === 'demo' })),
    connections: of(db.bankConnections, req.user.id).map(connView),
    syncs: of(db.bankSyncs, req.user.id).slice(-20).reverse(),
    note: list.length ? null : 'La conexión directa con el banco no está activada en este servidor. Mientras tanto, importa el extracto que descargas de tu banca online.',
    canSetup: A.isAdmin(req.user),
    setupNeeds2fa: A.isAdmin(req.user) && !req.user.totp,
    realConfigured: ebConfigured(),
  });
});

// ---------- Configuración de Enable Banking desde la app (solo administradores) ----------
function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const host = req.get('host');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${local ? req.protocol : 'https'}://${host}`;
}
const onlyAdmin = (req) => {
  if (!A.isAdmin(req.user)) throw new HttpError(403, 'Solo un administrador puede configurar la conexión con bancos');
  if (!req.user.totp) throw new HttpError(403, 'Activa la verificación en dos pasos (Ajustes → Seguridad) para configurar la conexión con bancos');
};
const auditSetup = (req, action) => db.adminLog?.push({ id: store.id(), at: nowIso(), ip: S.clientIp(req), adminId: req.user.id, adminEmail: req.user.email, targetId: null, targetEmail: null, action, detail: '' });
async function ebCheck(cfg, req) {
  const app = await ebFetch('/application', { cfg, setup: true });
  const redirectUrl = `${publicBase(req)}/banco-conectado`;
  return {
    name: app.name || '', environment: app.environment || '', active: app.active !== false,
    redirectOk: (app.redirect_urls || []).some((u) => String(u).replace(/\/+$/, '') === redirectUrl), redirectUrls: app.redirect_urls || [],
    checkedAt: nowIso(),
  };
}
function setupView(req) {
  const cfg = ebConfig();
  const base = publicBase(req);
  return {
    configured: !!cfg, source: cfg?.source || null, appId: cfg?.appId || '',
    check: db.bankProvider?.check || null,
    redirectUrl: `${base}/banco-conectado`, privacyUrl: `${base}/privacidad.html`, termsUrl: `${base}/condiciones.html`,
  };
}
router.get('/banks/setup', (req, res) => { onlyAdmin(req); res.json(setupView(req)); });
router.post('/banks/setup', h(async (req, res) => {
  onlyAdmin(req);
  if (ebConfig()?.source === 'env') throw new HttpError(400, 'Ya está configurada con variables de entorno en el servidor (Render).');
  const appId = String(req.body?.appId || '').trim();
  const pem = String(req.body?.privateKey || '').replace(/\r/g, '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) throw new HttpError(400, 'El ID de la aplicación no es válido (es un código como 1a2b3c4d-…; también es el nombre del archivo .pem)');
  try {
    const k = crypto.createPrivateKey(pem);
    if (k.asymmetricKeyType !== 'rsa') throw new Error();
  } catch { throw new HttpError(400, 'Ese archivo no es una clave privada válida. Sube el archivo .pem que descargaste al registrar la aplicación.'); }
  if (!S.hasKey()) throw new HttpError(500, 'Falta APP_SECRET en el servidor: no se puede guardar la clave cifrada.');
  const cfg = { appId, key: pem, source: 'app' };
  let check;
  try { check = await ebCheck(cfg, req); } catch (e) { throw new HttpError(e.status || 502, e.message); }
  db.bankProvider = { appId, keyEnc: S.encrypt(pem), check, updatedAt: nowIso(), updatedBy: req.user.id };
  auditSetup(req, 'Conexión con bancos configurada (Enable Banking)');
  await store.save();
  res.json(setupView(req));
}));
router.post('/banks/setup/check', h(async (req, res) => {
  onlyAdmin(req);
  const cfg = ebConfig();
  if (!cfg) throw new HttpError(400, 'Todavía no está configurada');
  let check;
  try { check = await ebCheck(cfg, req); } catch (e) { throw new HttpError(e.status || 502, e.message); }
  if (cfg.source === 'app') { db.bankProvider.check = check; await store.save(); }
  res.json({ ...setupView(req), check });
}));
router.delete('/banks/setup', h(async (req, res) => {
  onlyAdmin(req);
  delete db.bankProvider;
  auditSetup(req, 'Configuración de Enable Banking quitada');
  await store.save();
  res.json(setupView(req));
}));
router.get('/banks/list', h(async (req, res) => {
  const p = PROVIDERS[req.query.provider];
  if (!p || !p.available()) throw new HttpError(400, 'Proveedor no disponible');
  try { res.json(await p.banks()); } catch (e) { throw new HttpError(e.status || 502, e.message); }
}));
async function startAuth(req, c, bank) {
  const p = PROVIDERS[c.provider];
  const state = S.randomToken ? S.randomToken(24) : crypto.randomBytes(24).toString('hex');
  pending.set(state, { userId: req.user.id, connectionId: c.id, exp: Date.now() + 30 * 60000 });
  const base = publicBase(req);
  try {
    return (await p.start({ bank, state, redirectUrl: `${base}/banco-conectado`, days: 90, simulate: req.body?.simulate })).url;
  } catch (e) {
    pending.delete(state);
    throw new HttpError(e.status || 502, e.message);
  }
}
router.post('/banks/connect', h(async (req, res) => {
  const p = PROVIDERS[req.body?.provider];
  if (!p || !p.available()) throw new HttpError(400, 'La conexión con bancos no está disponible');
  const bank = String(req.body?.bank || '').slice(0, 120);
  const bankName = String(req.body?.bankName || (p.id === 'demo' ? DEMO_BANKS[bank]?.name : '') || bank).slice(0, 80);
  if (!bank) throw new HttpError(400, 'Elige tu banco');
  const c = { id: store.id(), userId: req.user.id, provider: p.id, bankId: bank, bankName, status: 'pendiente', accounts: [], createdAt: nowIso() };
  db.bankConnections.push(c);
  await store.save();
  res.json({ url: await startAuth(req, c, bank), connectionId: c.id });
}));
router.post('/banks/connections/:id/renew', h(async (req, res) => {
  const c = myConn(req);
  res.json({ url: await startAuth(req, c, c.bankId) });
}));
// Elegir qué cuentas incorporar y con qué tipo (o enlazarlas con una cuenta que ya tenías)
router.post('/banks/connections/:id/accounts', h(async (req, res) => {
  const c = myConn(req);
  const choices = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
  const now = nowIso();
  for (const link of c.accounts) {
    const ch = choices.find((x) => x.externalId === link.externalId);
    if (!ch) continue;
    if (!ch.include) { if (link.accountId) { const a = db.accounts.find((x) => x.id === link.accountId); if (a) { delete a.connectionId; delete a.externalId; } } link.accountId = null; continue; }
    let acc = ch.accountId && ch.accountId !== 'new' ? db.accounts.find((a) => a.id === ch.accountId && a.userId === req.user.id) : null;
    const type = L.ACCOUNT_TYPES[ch.type] ? ch.type : link.type;
    if (!acc) {
      acc = { id: store.id(), userId: req.user.id, name: String(ch.name || link.name).slice(0, 60), type, initialBalance: 0, autoInitial: true, balanceDate: D.ymd(D.addDays(D.today(), -91)), color: type === 'ahorro' ? '#16a34a' : type === 'credito' ? '#7c3aed' : '#1e3a8a', currency: 'EUR', createdAt: now };
      db.accounts.push(acc);
    } else acc.type = type;
    acc.bankName = c.bankName;
    acc.iban = maskIban(link.iban);
    acc.connectionId = c.id;
    acc.externalId = link.externalId;
    link.accountId = acc.id;
    link.type = type;
  }
  if (!c.accounts.some((a) => a.accountId)) throw new HttpError(400, 'Elige al menos una cuenta');
  c.status = 'activa';
  await store.save();
  const log = await syncConnection(req.user, c, { reason: 'primera sincronización' });
  res.json({ connection: connView(c), sync: log });
}));
router.post('/banks/connections/:id/sync', h(async (req, res) => {
  const c = myConn(req);
  if (c.status === 'pendiente' || c.status === 'elegir') throw new HttpError(400, 'Termina primero de conectar el banco');
  if (c.lastSync && Date.now() - Date.parse(c.lastSync) < 60000) throw new HttpError(429, 'Acabas de actualizar: espera un minuto');
  res.json({ sync: await syncConnection(req.user, c), connection: connView(c) });
}));
// Desconectar: se revoca el permiso. Las cuentas se quedan como manuales; opcionalmente se borran los movimientos traídos del banco.
router.delete('/banks/connections/:id', h(async (req, res) => {
  const c = myConn(req);
  const p = PROVIDERS[c.provider];
  if (p && c.sessionEnc) { try { await p.revoke(sessionOf(c)); } catch {} }
  let removed = 0;
  if (req.query.deleteData === '1') {
    const imports = require('./imports');
    for (const imp of db.imports.filter((i) => i.userId === req.user.id && i.connectionId === c.id)) {
      for (const it of imp.items || []) {
        if (it.linked) continue;
        const coll = db[imports.COLL[it.kind]];
        const i = coll.findIndex((x) => x.id === it.id && x.userId === req.user.id);
        if (i >= 0) { coll.splice(i, 1); removed++; }
      }
      imp.status = 'revertida';
      imp.events = [...(imp.events || []), { at: nowIso(), action: 'Datos del banco eliminados', detail: 'Al desconectar el banco', by: req.user.name }];
    }
  }
  for (const a of db.accounts.filter((x) => x.connectionId === c.id)) { delete a.connectionId; delete a.externalId; if (a.bank?.source === 'banco') a.bank.source = 'banco (desconectado)'; }
  db.bankConnections.splice(db.bankConnections.indexOf(c), 1);
  db.bankSyncs.push({ id: store.id(), userId: req.user.id, connectionId: c.id, bank: c.bankName, at: nowIso(), reason: 'desconexión', status: 'desconectada', accounts: 0, imported: 0, duplicates: 0, errors: [], removed });
  await store.save();
  res.json({ ok: true, removed });
}));

// Vuelta desde el banco (página pública: la identifica el «state» de un solo uso, no hace falta la cookie)
async function callback(req, res) {
  const state = String(req.query.state || '');
  const p0 = pending.get(state);
  pending.delete(state);
  const back = (q) => res.redirect(`/#/cuentas?${q}`);
  if (!p0 || p0.exp < Date.now()) return back('banco=error&motivo=caducado');
  const c = db.bankConnections.find((x) => x.id === p0.connectionId && x.userId === p0.userId);
  if (!c) return back('banco=error');
  if (req.query.error) { c.status = c.sessionEnc ? c.status : 'error'; c.lastError = 'Has cancelado la autorización en el banco'; await store.save(); return back('banco=cancelado'); }
  try {
    const r = await PROVIDERS[c.provider].finish(String(req.query.code || ''));
    c.sessionEnc = S.encrypt(r.session);
    c.validUntil = r.validUntil;
    const prev = new Map((c.accounts || []).map((a) => [a.externalId, a]));
    const prevByIban = new Map((c.accounts || []).filter((a) => a.iban).map((a) => [a.iban, a]));
    c.accounts = r.accounts.map((a) => {
      const old = prev.get(a.externalId) || (a.iban && prevByIban.get(a.iban));
      // Detección del tipo: ahorro si el banco lo dice o el nombre lo indica (hucha, espacio, ahorro…)
      const type = /hucha|espacio|ahorro|savings|objetivo|meta/i.test(`${a.name} ${a.product}`) && a.type === 'corriente' ? 'ahorro' : a.type;
      return { ...a, type, accountId: old?.accountId || null, lastTxDate: old?.lastTxDate || null };
    });
    // Al renovar, las cuentas que ya estaban enlazadas siguen igual
    for (const link of c.accounts) if (link.accountId) { const acc = db.accounts.find((x) => x.id === link.accountId); if (acc) acc.externalId = link.externalId; }
    c.status = c.accounts.some((a) => a.accountId) ? 'activa' : 'elegir';
    c.lastError = null;
    await store.save();
    return back(`banco=${c.id}`);
  } catch (e) {
    c.status = c.sessionEnc ? 'caducada' : 'error';
    c.lastError = e.message;
    await store.save();
    return back('banco=error');
  }
}

module.exports = { router, callback, autoSync, syncConnection, PROVIDERS, activeProviders, connView, ProviderError, _pending: pending };
