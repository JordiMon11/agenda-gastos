// Clasificación automática aplicada a los datos del usuario: contexto (reglas, diccionario, historial),
// clasificar movimientos nuevos, aprender de las correcciones, revisión inteligente y transferencias propias.
const express = require('express');
const store = require('./db');
const { db } = store;
const D = require('./dates');
const L = require('./ledger');
const C = require('./classify');
const { HttpError } = require('./auth');

const of = (list, uid) => list.filter((x) => x.userId === uid);
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const round = L.round;
for (const k of ['importRules', 'dictionary']) if (!Array.isArray(db[k])) db[k] = [];

// Texto que describe un movimiento ya guardado (para clasificarlo igual que uno del banco)
const textOf = (x) => [x.notes && x.notes !== x.name ? x.notes : '', x.name, x.place].filter(Boolean).join(' ').slice(0, 300) || x.name || '';
const confirmed = (x) => !x.review || x.review === 'confirmed';

function historyOf(user) {
  const count = new Map();
  for (const e of of(db.expenses, user.id)) {
    if (!e.categoryId || !confirmed(e)) continue;
    for (const k of new Set([C.keyOf(e.place || ''), C.keyOf(e.name)].filter(Boolean))) {
      const m = count.get(k) || new Map();
      m.set(e.categoryId, (m.get(e.categoryId) || 0) + 1);
      count.set(k, m);
    }
  }
  const out = new Map();
  for (const [k, m] of count) {
    const sorted = [...m].sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((a, x) => a + x[1], 0);
    if (sorted[0][1] >= 2 && sorted[0][1] / total >= 0.75) out.set(k, sorted[0][0]); // 2+ veces y sin dudas
  }
  return out;
}
function contextFor(user) {
  const rules = of(db.importRules, user.id).map((r) => ({ ...r, match: r.match || 'merchant', pattern: r.pattern || r.key }));
  return C.buildContext({ cats: of(db.categories, user.id), rules, dictionary: of(db.dictionary, user.id), history: historyOf(user) });
}
const classifyWith = (ctx, x) => C.classify(x, ctx);

// Datos de clasificación que se guardan en cada movimiento
const clsOf = (cl, extra = {}) => ({ merchant: cl.merchant || '', subcategory: cl.subcategory || '', rule: cl.rule || '', source: cl.source || '', confidence: Math.round((cl.confidence || 0) * 100) / 100, ...extra });

// Gasto creado a mano o desde un ticket: si el usuario eligió categoría, está confirmado; si no, se clasifica solo
function onExpenseCreated(user, e, { userCategory }) {
  if (userCategory) {
    e.review = 'confirmed';
    e.cls = { merchant: e.place || '', subcategory: '', rule: 'Elegida por ti', source: 'manual', confidence: 1 };
    return e;
  }
  const cl = classifyWith(contextFor(user), { description: textOf(e), amount: -Math.abs(e.amount) });
  if (cl.categoryId && cl.confidence >= C.MEDIUM) e.categoryId = cl.categoryId;
  e.cls = clsOf(cl);
  e.review = cl.categoryId ? cl.review : 'pending';
  return e;
}

// ---------- Reglas ----------
const MATCHES = { merchant: 'El comercio es', contains: 'La descripción contiene', counterparty: 'Viene de / va a' };
function cleanRule(user, b) {
  const match = MATCHES[b?.match] ? b.match : 'merchant';
  const pattern = String(b?.pattern || '').trim().slice(0, 60);
  if (C.U(pattern).trim().length < 2) throw new HttpError(400, 'Escribe la palabra o el comercio');
  const categoryId = b?.categoryId && db.categories.some((c) => c.id === b.categoryId && c.userId === user.id) ? b.categoryId : null;
  const type = C.TYPES[b?.type] ? b.type : null;
  const incomeSource = ['nomina', 'freelance', 'ventas', 'inversiones', 'alquiler', 'regalos', 'devoluciones', 'otros'].includes(b?.incomeSource) ? b.incomeSource : null;
  if (!categoryId && !type && !incomeSource) throw new HttpError(400, 'La regla tiene que asignar una categoría, un tipo o un origen de ingreso');
  return { match, pattern, key: match === 'merchant' ? C.keyOf(pattern) || pattern.toLowerCase() : undefined, categoryId, subcategory: String(b?.subcategory || '').trim().slice(0, 40), type, incomeSource };
}
function upsertRule(user, data) {
  const now = new Date().toISOString();
  const same = (r) => r.userId === user.id && (r.match || 'merchant') === data.match && C.U(r.pattern || r.key).trim() === C.U(data.pattern).trim();
  const ex = db.importRules.find(same);
  if (ex) { Object.assign(ex, data, { updatedAt: now }); return ex; }
  const r = { id: store.id(), userId: user.id, ...data, createdAt: now, updatedAt: now };
  db.importRules.push(r);
  return r;
}
// Movimientos que una regla cambiaría (los confirmados por ti no se tocan)
function matchesOfRule(user, rule) {
  const ctx = C.buildContext({ cats: of(db.categories, user.id), rules: [{ ...rule }] });
  const out = [];
  for (const e of of(db.expenses, user.id)) {
    if (e.review === 'confirmed' && e.cls?.source === 'manual') continue;
    const cl = C.classify({ description: textOf(e), amount: -Math.abs(e.amount) }, ctx);
    if (cl.source === 'rule' && (cl.categoryId !== e.categoryId || (rule.subcategory && e.cls?.subcategory !== rule.subcategory))) out.push({ e, cl });
  }
  return out;
}
function applyRule(user, rule) {
  let n = 0;
  for (const { e, cl } of matchesOfRule(user, rule)) {
    if (cl.categoryId) e.categoryId = cl.categoryId;
    e.cls = clsOf(cl);
    e.review = 'auto';
    n++;
  }
  return n;
}

// Vuelve a clasificar lo que no has confirmado (tras crear reglas o cambiar el diccionario)
function reclassify(user) {
  const ctx = contextFor(user);
  let changed = 0;
  for (const e of of(db.expenses, user.id)) {
    if (confirmed(e) || e.refund) continue;
    const cl = classifyWith(ctx, { description: textOf(e), amount: -Math.abs(e.amount) });
    const cat = cl.categoryId && cl.confidence >= C.MEDIUM ? cl.categoryId : e.categoryId;
    if (cat !== e.categoryId || cl.confidence !== e.cls?.confidence) changed++;
    e.categoryId = cat;
    e.cls = clsOf(cl);
    e.review = cat ? cl.review : 'pending';
  }
  return changed;
}

// ---------- Transferencias entre tus cuentas apuntadas como gasto + ingreso ----------
const TRANSFER_WORDS = / TRASPASO| TRANSFERENCIA| TRANSF | TRF | HUCHA| AHORRO| BIZUM| ENTRE CUENTAS| CUENTA PROPIA/;
function ownTransferCandidates(user) {
  const accs = of(db.accounts, user.id);
  if (accs.length < 2) return [];
  const def = L.defaultAccount(user)?.id;
  const exps = of(db.expenses, user.id).filter((e) => !e.refund && !e.recurringId && e.amount > 0);
  const incs = of(db.incomes, user.id);
  const dismissed = new Set((user.dismissedTransfers || []));
  const out = [];
  const used = new Set();
  for (const e of exps) {
    const ea = e.accountId || def;
    for (const i of incs) {
      if (used.has(i.id) || dismissed.has(`${e.id}|${i.id}`)) continue;
      const ia = i.accountId || def;
      if (!ea || !ia || ea === ia || Math.abs(e.amount - i.amount) > 0.001) continue;
      if (Math.abs(D.diffDays(D.parse(e.date), D.parse(i.date))) > 3) continue;
      const words = TRANSFER_WORDS.test(C.U(textOf(e))) || TRANSFER_WORDS.test(C.U(textOf(i)));
      out.push({ expense: { id: e.id, name: e.name, date: e.date, accountId: ea }, income: { id: i.id, name: i.name, date: i.date, accountId: ia }, amount: e.amount, sure: words });
      used.add(i.id);
      break;
    }
  }
  return out.slice(0, 50);
}
function convertToTransfer(user, expenseId, incomeId) {
  const e = db.expenses.find((x) => x.id === expenseId && x.userId === user.id);
  const i = db.incomes.find((x) => x.id === incomeId && x.userId === user.id);
  if (!e || !i) throw new HttpError(404, 'Movimientos no encontrados');
  if (Math.abs(e.amount - i.amount) > 0.001) throw new HttpError(400, 'Los importes no coinciden');
  const def = L.defaultAccount(user)?.id;
  const fromId = e.accountId || def, toId = i.accountId || def;
  if (!fromId || !toId || fromId === toId) throw new HttpError(400, 'Tienen que ser dos cuentas distintas');
  const t = { id: store.id(), userId: user.id, type: 'transfer', fromId, toId, amount: round(e.amount), date: e.date, note: `${e.name} → ${i.name}`.slice(0, 200), createdAt: new Date().toISOString(), convertedFrom: { expense: { ...e }, income: { ...i } }, ...(e.fingerprint ? { fingerprint: e.fingerprint } : {}) };
  db.expenses.splice(db.expenses.indexOf(e), 1);
  db.incomes.splice(db.incomes.indexOf(i), 1);
  db.transfers.push(t);
  return t;
}

// ---------- Rutas ----------
const router = express.Router();
const cat = (user, id) => db.categories.find((c) => c.id === id && c.userId === user.id);
function itemView(user, kind, x) {
  const c = kind === 'expense' ? cat(user, x.categoryId) : null;
  return {
    kind, id: x.id, date: x.date, name: x.name, description: x.notes && x.notes.toLowerCase() !== String(x.name).toLowerCase() ? x.notes : '', amount: kind === 'expense' ? -x.amount : x.amount, accountId: x.accountId || null,
    categoryId: x.categoryId || null, category: c ? { name: c.name, color: c.color, icon: c.icon } : null, type: x.movementType || (kind === 'income' ? 'income' : 'expense'),
    merchant: x.cls?.merchant || x.place || '', subcategory: x.cls?.subcategory || '', rule: x.cls?.rule || (confirmed(x) ? 'Elegida por ti' : ''), confidence: x.cls?.confidence ?? 1,
    review: x.review || 'confirmed', importId: x.importId || null,
  };
}
router.get('/review', (req, res) => {
  const u = req.user;
  const items = [...of(db.expenses, u.id).map((e) => itemView(u, 'expense', e)), ...of(db.incomes, u.id).map((i) => itemView(u, 'income', i))];
  const state = ['auto', 'review', 'pending', 'confirmed'].includes(req.query.state) ? req.query.state : 'pending';
  const counts = { auto: 0, review: 0, pending: 0, confirmed: 0 };
  for (const x of items) counts[x.review] = (counts[x.review] || 0) + 1;
  const list = items.filter((x) => x.review === state).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 500);
  const dups = require('./insights').anomalies(u).filter((a) => a.type === 'duplicate').slice(0, 30);
  const rules = of(db.importRules, u.id).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 8)
    .map((r) => ({ id: r.id, match: r.match || 'merchant', pattern: r.pattern || r.key, category: cat(u, r.categoryId)?.name || '', type: r.type, updatedAt: r.updatedAt }));
  res.json({ state, counts: { ...counts, duplicates: dups.length }, items: list, duplicates: dups, ownTransfers: ownTransferCandidates(u), rules });
});
router.post('/review/bulk', h(async (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const list = Array.isArray(b.items) ? b.items.slice(0, 2000) : [];
  if (!list.length) throw new HttpError(400, 'Elige al menos un movimiento');
  const categoryId = b.categoryId ? (cat(u, b.categoryId) ? b.categoryId : null) : undefined;
  if (b.categoryId && !categoryId) throw new HttpError(400, 'Categoría no válida');
  let n = 0;
  for (const it of list) {
    const coll = it.kind === 'income' ? db.incomes : db.expenses;
    const x = coll.find((y) => y.id === it.id && y.userId === u.id);
    if (!x) continue;
    if (categoryId !== undefined && it.kind !== 'income') { x.categoryId = categoryId; x.cls = { ...(x.cls || {}), rule: 'Elegida por ti', source: 'manual', confidence: 1 }; }
    if (b.subcategory !== undefined) x.cls = { ...(x.cls || {}), subcategory: String(b.subcategory).slice(0, 40) };
    x.review = 'confirmed';
    n++;
  }
  await store.save();
  res.json({ updated: n });
}));
router.post('/review/accept-high', h(async (req, res) => {
  let n = 0;
  for (const k of ['expenses', 'incomes']) for (const x of of(db[k], req.user.id)) if (x.review === 'auto') { x.review = 'confirmed'; n++; }
  await store.save();
  res.json({ accepted: n });
}));
router.post('/review/reclassify', h(async (req, res) => {
  const n = reclassify(req.user);
  await store.save();
  res.json({ changed: n });
}));
router.post('/review/own-transfer', h(async (req, res) => {
  const t = convertToTransfer(req.user, req.body?.expenseId, req.body?.incomeId);
  await store.save();
  res.json(t);
}));
router.post('/review/own-transfer/dismiss', h(async (req, res) => {
  const k = `${req.body?.expenseId}|${req.body?.incomeId}`;
  req.user.dismissedTransfers = [...new Set([...(req.user.dismissedTransfers || []), k])].slice(-500);
  await store.save();
  res.json({ ok: true });
}));

// Reglas: crear (con vista previa de a cuántos movimientos afecta), listar y borrar
router.get('/rules', (req, res) => res.json(of(db.importRules, req.user.id).map((r) => ({ id: r.id, match: r.match || 'merchant', pattern: r.pattern || r.key, categoryId: r.categoryId, category: cat(req.user, r.categoryId)?.name || '', subcategory: r.subcategory || '', type: r.type || null, incomeSource: r.incomeSource || null, updatedAt: r.updatedAt })).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))));
router.post('/rules/preview', h(async (req, res) => {
  const data = cleanRule(req.user, req.body);
  const m = matchesOfRule(req.user, data);
  res.json({ count: m.length, examples: m.slice(0, 5).map(({ e }) => ({ name: e.name, date: e.date, amount: e.amount })) });
}));
router.post('/rules', h(async (req, res) => {
  const data = cleanRule(req.user, req.body);
  const r = upsertRule(req.user, data);
  const applied = req.body?.applyToExisting ? applyRule(req.user, r) : 0;
  await store.save();
  res.json({ rule: r, applied });
}));
router.delete('/rules/:id', h(async (req, res) => {
  const r = db.importRules.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!r) throw new HttpError(404, 'Regla no encontrada');
  db.importRules.splice(db.importRules.indexOf(r), 1);
  await store.save();
  res.json({ ok: true });
}));

// Diccionario: el general (editable: cambiar su categoría o desactivarlo) y el tuyo (palabras nuevas)
router.get('/dictionary', (req, res) => {
  const mine = of(db.dictionary, req.user.id);
  const cats = of(db.categories, req.user.id);
  const general = C.DICTIONARY.map((e) => {
    const ov = mine.find((d) => d.overrides === e.id);
    const auto = (() => { for (const p of e.prefs) { const c = cats.find((x) => require('./statements').norm(x.name).startsWith(p)); if (c) return c; } return null; })();
    return { id: e.id, words: e.words, category: e.category, subcategory: ov?.subcategory || e.subcategory, type: e.type || null, income: !!e.income, categoryId: ov?.categoryId || auto?.id || null, edited: !!ov && !ov.disabled, disabled: !!ov?.disabled };
  });
  const own = mine.filter((d) => !d.overrides).map((d) => ({ id: d.id, words: d.words, categoryId: d.categoryId, subcategory: d.subcategory || '', type: d.type || null }));
  res.json({ general, own });
});
const cleanWords = (w) => (Array.isArray(w) ? w : String(w || '').split(/[,;\n]/)).map((x) => String(x).trim().toUpperCase().slice(0, 40)).filter((x) => C.U(x).trim().length >= 2).slice(0, 50);
router.post('/dictionary', h(async (req, res) => {
  const words = cleanWords(req.body?.words);
  if (!words.length) throw new HttpError(400, 'Escribe al menos una palabra');
  if (!cat(req.user, req.body?.categoryId)) throw new HttpError(400, 'Elige la categoría');
  const d = { id: store.id(), userId: req.user.id, words, categoryId: req.body.categoryId, subcategory: String(req.body?.subcategory || '').slice(0, 40), type: C.TYPES[req.body?.type] ? req.body.type : null, createdAt: new Date().toISOString() };
  db.dictionary.push(d);
  const changed = reclassify(req.user);
  await store.save();
  res.json({ entry: d, reclassified: changed });
}));
router.put('/dictionary/general/:entry', h(async (req, res) => {
  if (!C.DICTIONARY.some((e) => e.id === req.params.entry)) throw new HttpError(404, 'Entrada no encontrada');
  db.dictionary = db.dictionary.filter((d) => !(d.userId === req.user.id && d.overrides === req.params.entry));
  if (!req.body?.reset) {
    const categoryId = req.body?.categoryId && cat(req.user, req.body.categoryId) ? req.body.categoryId : null;
    db.dictionary.push({ id: store.id(), userId: req.user.id, overrides: req.params.entry, categoryId, subcategory: String(req.body?.subcategory || '').slice(0, 40), disabled: !!req.body?.disabled, createdAt: new Date().toISOString() });
  }
  const changed = reclassify(req.user);
  await store.save();
  res.json({ ok: true, reclassified: changed });
}));
router.delete('/dictionary/:id', h(async (req, res) => {
  const d = db.dictionary.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!d) throw new HttpError(404, 'No encontrado');
  db.dictionary.splice(db.dictionary.indexOf(d), 1);
  reclassify(req.user);
  await store.save();
  res.json({ ok: true });
}));
// Clasificar un texto (para probar reglas y para el formulario de gasto)
router.post('/classify', (req, res) => {
  const cl = classifyWith(contextFor(req.user), { description: String(req.body?.description || '').slice(0, 300), amount: Number(req.body?.amount) || -1 });
  res.json({ ...cl, typeLabel: C.TYPES[cl.type]?.label });
});

module.exports = { router, contextFor, classifyWith, clsOf, onExpenseCreated, upsertRule, applyRule, matchesOfRule, reclassify, ownTransferCandidates, convertToTransfer, textOf, MATCHES };
