// Importación de extractos bancarios: análisis, revisión, importación masiva, historial y reversión.
// Los movimientos importados se guardan en las mismas colecciones que los manuales (gastos, ingresos y
// transferencias), así que aparecen en el panel, el calendario, los presupuestos, los informes y las previsiones.
// El archivo del banco solo se lee en memoria: nunca se guarda ni se publica en ninguna URL.
const express = require('express');
const crypto = require('crypto');
const store = require('./db');
const { db } = store;
const D = require('./dates');
const L = require('./ledger');
const R = require('./recurrence');
const St = require('./statements');
const C = require('./classify');
const { HttpError } = require('./auth');

const MAX_MB = Math.max(1, Math.min(50, Number(process.env.IMPORT_MAX_MB) || 10));
const JSON_LIMIT = `${Math.ceil(MAX_MB * 1.4) + 2}mb`; // base64 ocupa ~4/3 del archivo
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const round = L.round;
const of = (list, uid) => list.filter((x) => x.userId === uid);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const FP_RE = /^[a-f0-9]{64}$/;
const router = express.Router();

for (const k of ['imports', 'importRules', 'importMappings', 'bankConnections']) if (!Array.isArray(db[k])) db[k] = [];

// Límite de análisis por usuario (un extracto grande cuesta CPU)
const hits = new Map();
function limit(userId, max = 40) {
  const now = Date.now();
  const l = (hits.get(userId) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (l.length >= max) throw new HttpError(429, 'Demasiados archivos seguidos. Espera unos minutos.');
  l.push(now);
  hits.set(userId, l);
}
function myAccount(user, id) {
  const a = db.accounts.find((x) => x.id === id && x.userId === user.id);
  if (!a) throw new HttpError(400, 'Elige la cuenta en la que se importan los movimientos');
  return a;
}

// ---------- Huella de cada movimiento (para no importarlo dos veces) ----------
// Con identificador del banco: cuenta + identificador. Si no: cuenta + fecha + importe + descripción + saldo
// (o el número de repetición dentro del archivo, para dos cafés iguales el mismo día).
function fingerprints(userId, accountId, rows) {
  const seen = new Map();
  return rows.map((r) => {
    const desc = St.norm(r.description).replace(/\d{5,}/g, '').slice(0, 120);
    if (r.bankId) return sha(`${userId}|${accountId}|id:${r.bankId}`);
    const base = `${r.date}|${(r.amount ?? 0).toFixed(2)}|${desc}`;
    if (r.balance !== null && r.balance !== undefined) return sha(`${userId}|${accountId}|${base}|b${r.balance.toFixed(2)}`);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return sha(`${userId}|${accountId}|${base}|#${n}`);
  });
}
function knownFingerprints(uid) {
  const s = new Set();
  for (const k of ['expenses', 'incomes', 'transfers']) for (const x of of(db[k], uid)) if (x.fingerprint) s.add(x.fingerprint);
  return s;
}

// Movimientos que ya existen en la cuenta (manuales, de tickets, automáticos de pagos fijos o importados)
function existingMovements(user, accountId) {
  const def = L.defaultAccount(user)?.id || null;
  const inAcc = (id) => (id || def) === accountId || !id;
  const out = [];
  for (const e of of(db.expenses, user.id)) if (inAcc(e.accountId)) out.push({ kind: 'expense', id: e.id, date: e.date, amount: -e.amount, name: e.name, place: e.place, recurring: !!e.recurringId, imported: !!e.importId });
  for (const i of of(db.incomes, user.id)) if (inAcc(i.accountId)) out.push({ kind: 'income', id: i.id, date: i.date, amount: i.amount, name: i.name, imported: !!i.importId });
  for (const t of of(db.transfers, user.id)) {
    if (t.type === 'adjust') continue;
    if (t.fromId === accountId) out.push({ kind: 'transfer', id: t.id, date: t.date, amount: -t.amount, name: t.note || 'Transferencia', other: t.toId, imported: !!t.importId });
    if (t.toId === accountId) out.push({ kind: 'transfer', id: t.id, date: t.date, amount: t.amount, name: t.note || 'Transferencia', other: t.fromId, imported: !!t.importId });
  }
  return out;
}
const words = (s) => new Set(St.norm(s).split(' ').filter((w) => w.length > 2 && !/^\d+$/.test(w)));
function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.5;
}

// ---------- Análisis: lee el archivo y prepara la tabla de revisión (no guarda nada) ----------
function analyzeRows(user, account, parsed) {
  const cats = of(db.categories, user.id);
  const rules = new Map(of(db.importRules, user.id).map((r) => [r.key, r]));
  // Lo que el usuario suele hacer con cada comercio (categoría más usada)
  const histCount = new Map();
  for (const e of of(db.expenses, user.id)) {
    if (!e.categoryId) continue;
    for (const k of new Set([C.keyOf(e.place || ''), C.keyOf(e.name)].filter(Boolean))) {
      const m = histCount.get(k) || new Map();
      m.set(e.categoryId, (m.get(e.categoryId) || 0) + 1);
      histCount.set(k, m);
    }
  }
  const history = new Map([...histCount].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  const ctx = { cats, rules, history };

  const fps = fingerprints(user.id, account.id, parsed.rows);
  const known = knownFingerprints(user.id);
  const ignored = new Set(of(db.imports, user.id).flatMap((i) => i.ignored || []));
  const existing = existingMovements(user, account.id);
  const byAmount = new Map();
  for (const m of existing) {
    const k = Math.abs(m.amount).toFixed(2);
    (byAmount.get(k) || byAmount.set(k, []).get(k)).push(m);
  }
  const accs = of(db.accounts, user.id).filter((a) => a.id !== account.id);
  const cashAcc = accs.find((a) => a.type === 'efectivo');
  const recs = of(db.recurring, user.id).filter((r) => r.active);
  const expensesByKey = new Map();
  for (const e of of(db.expenses, user.id)) {
    const k = C.keyOf(e.place || e.name);
    (expensesByKey.get(k) || expensesByKey.set(k, []).get(k)).push({ id: e.id, date: e.date, amount: e.amount, name: e.name });
  }

  // Compras del propio archivo (para enlazar devoluciones con su compra aunque aún no estén guardadas)
  parsed.rows.forEach((r, i) => {
    if (!(r.amount < 0) || !r.date) return;
    const k = C.keyOf(r.description);
    (expensesByKey.get(k) || expensesByKey.set(k, []).get(k)).push({ fp: fps[i], date: r.date, amount: -r.amount, name: C.merchantOf(r.description) || r.description });
  });
  const out = parsed.rows.map((r, i) => {
    const cl = r.amount === null ? { merchant: C.merchantOf(r.description), key: C.keyOf(r.description), type: 'expense', categoryId: null, suggestedCategory: '', confidence: 0, reason: '' } : C.classify(r, ctx);
    const row = {
      i, fp: fps[i], line: r.line, date: r.date, valueDate: r.valueDate, description: r.description, merchant: cl.merchant, key: cl.key,
      amount: r.amount, currency: r.currency, ref: r.ref, bankId: r.bankId ? 'sí' : '', balance: r.balance,
      type: cl.type, categoryId: cl.categoryId, suggestedCategory: cl.suggestedCategory, incomeSource: cl.incomeSource || null,
      confidence: cl.confidence, reason: cl.reason, status: 'new', notes: [], selected: true, counterpartId: null, dupOf: null, refundOf: null, recurringMatch: null,
      paymentMethod: C.paymentMethodOf(cl.type, r.description), error: r.error || '',
    };
    if (row.error) { row.status = 'review'; row.selected = false; row.notes.push(row.error); return row; }
    if (known.has(row.fp)) { row.status = 'duplicate'; row.selected = false; row.notes.push('Ya importado antes'); return row; }

    // Transferencias entre cuentas propias y efectivo: se propone la otra cuenta
    if (row.type === 'transfer') {
      const U = St.norm(r.description);
      const byName = accs.find((a) => St.norm(a.name).split(' ').some((w) => w.length > 3 && U.includes(w)));
      const byType = /ahorro/.test(U) ? accs.find((a) => a.type === 'ahorro') : null;
      row.counterpartId = (byName || byType)?.id || null;
    }
    if (row.type === 'cash_withdrawal' || row.type === 'cash_deposit') row.counterpartId = cashAcc?.id || null;
    // ¿Ya está ese traspaso registrado (por ejemplo, al importar la otra cuenta)?
    const cands = byAmount.get(Math.abs(r.amount).toFixed(2)) || [];
    const near = (m, days) => Math.abs(D.diffDays(D.parse(m.date), D.parse(r.date))) <= days && Math.sign(m.amount) === Math.sign(r.amount);
    const tr = cands.find((m) => m.kind === 'transfer' && near(m, 3) && (!row.counterpartId || m.other === row.counterpartId));
    if (tr && ['transfer', 'cash_withdrawal', 'cash_deposit'].includes(row.type)) {
      row.status = 'possible'; row.selected = false; row.dupOf = { kind: 'transfer', id: tr.id, date: tr.date, name: tr.name, amount: tr.amount };
      row.notes.push('Este traspaso ya está registrado (desde la otra cuenta)');
      return row;
    }
    // Posibles duplicados: mismo importe, fecha cercana y descripción parecida (o el mismo día exacto)
    const dup = cands.find((m) => m.kind !== 'transfer' && near(m, m.recurring ? 5 : 3) && (m.recurring || similar(`${m.name} ${m.place || ''}`, r.description) || C.keyOf(m.place || m.name) === row.key || m.date === r.date));
    if (dup) {
      row.status = 'possible'; row.selected = false; row.dupOf = { kind: dup.kind, id: dup.id, date: dup.date, name: dup.name, amount: dup.amount };
      row.notes.push(dup.recurring ? 'Puede ser el pago fijo que la app ya apuntó' : 'Parecido a un movimiento que ya tienes');
      return row;
    }
    // Devoluciones: se enlazan con la compra original si se encuentra
    if (row.type === 'refund') {
      const orig = (expensesByKey.get(row.key) || []).filter((e) => e.amount >= r.amount && e.date <= r.date && D.diffDays(D.parse(e.date), D.parse(r.date)) <= 120).sort((a, b) => b.date.localeCompare(a.date))[0];
      if (orig) { row.refundOf = { id: orig.id || null, fp: orig.fp || null, date: orig.date, name: orig.name, amount: orig.amount }; row.notes.push(`Devolución de «${orig.name}» del ${orig.date.split('-').reverse().join('/')}`); }
    }
    // ¿Es un pago fijo que ya tienes dado de alta? Se marca como pagado al importar
    if (r.amount < 0) {
      for (const rec of recs) {
        if (C.keyOf(rec.name) !== row.key && !similar(rec.name, r.description)) continue;
        if (Math.abs(rec.amount - Math.abs(r.amount)) > Math.max(1, rec.amount * 0.15)) continue;
        const due = R.occurrences(rec, D.addDays(D.parse(r.date), -6), D.addDays(D.parse(r.date), 6)).find((d) => !R.isPaid(rec, d));
        if (due) { row.recurringMatch = { id: rec.id, name: rec.name, due: D.ymd(due) }; row.notes.push(`Pago fijo «${rec.name}»`); if (!row.categoryId && rec.categoryId) row.categoryId = rec.categoryId; break; }
      }
    }
    if (ignored.has(row.fp)) { row.status = 'review'; row.selected = false; row.notes.push('La última vez decidiste no importarlo'); }
    else if (row.type === 'transfer' && !row.counterpartId) { row.status = 'review'; row.notes.push('Elige la otra cuenta si es un traspaso entre tus cuentas'); }
    else if (r.signGuessed) { row.status = 'review'; row.notes.push('Comprueba si es cargo o abono'); }
    else if (r.amount < 0 && !row.categoryId && !row.suggestedCategory && !['transfer', 'cash_withdrawal'].includes(row.type)) row.status = 'review';
    return row;
  });
  return out;
}

router.get('/imports/config', (req, res) => res.json({
  maxMb: MAX_MB,
  formats: ['CSV', 'XLS', 'XLSX', 'PDF', 'OFX', 'QFX', 'XML (CAMT.053)', 'Norma 43', 'Foto o PDF escaneado (OCR)'],
  banks: St.BANKS.map((b) => b.name),
  fields: St.FIELD_LABELS,
  types: Object.fromEntries(Object.entries(C.TYPES).map(([k, v]) => [k, v.label])),
}));

router.post('/imports/analyze', express.json({ limit: JSON_LIMIT }), h(async (req, res) => {
  limit(req.user.id);
  const b = req.body || {};
  const account = myAccount(req.user, b.accountId);
  const fileName = String(b.fileName || 'extracto').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120);
  let buffer = null;
  if (typeof b.text !== 'string') {
    if (typeof b.data !== 'string' || !b.data) throw new HttpError(400, 'Falta el archivo');
    buffer = Buffer.from(b.data.replace(/^data:[^,]*,/, ''), 'base64');
    if (buffer.length > MAX_MB * 1024 * 1024) throw new HttpError(413, `El archivo supera el máximo de ${MAX_MB} MB`);
  } else if (b.text.length > 2_000_000) throw new HttpError(413, 'El texto es demasiado largo');
  let mapping = null;
  if (b.mapping && typeof b.mapping === 'object') {
    mapping = {};
    for (const [k, v] of Object.entries(b.mapping)) if (/^\d{1,3}$/.test(k) && St.FIELD_LABELS[v] && v !== 'ignore') mapping[k] = v;
  }
  const saved = (sig) => of(db.importMappings, req.user.id).find((m) => m.signature === sig)?.mapping || null;
  let parsed;
  try {
    parsed = await St.parse({ name: fileName, buffer, text: typeof b.text === 'string' ? b.text : undefined, mapping, savedMapping: saved });
  } catch (e) {
    if (e.status) throw new HttpError(e.status, e.message);
    console.error('[importar]', e.message);
    throw new HttpError(400, 'No se ha podido leer el archivo. Prueba con otro formato (CSV o Excel).');
  } finally {
    if (buffer) buffer.fill(0); // borrado del archivo en memoria
  }
  if (b.saveMapping && mapping && parsed.signature) {
    db.importMappings = db.importMappings.filter((m) => !(m.userId === req.user.id && m.signature === parsed.signature));
    db.importMappings.push({ id: store.id(), userId: req.user.id, signature: parsed.signature, bank: parsed.bank?.name || String(b.bankName || '').slice(0, 60), headers: parsed.headers, mapping, updatedAt: new Date().toISOString() });
    store.save();
  }
  const base = { fileName, format: parsed.format, bank: parsed.bank, iban: parsed.iban, warnings: parsed.warnings, headers: parsed.headers, sample: parsed.sample, mapping: parsed.mapping, savedMapping: !!(parsed.signature && saved(parsed.signature)) };
  if (parsed.needsOcr) return res.json({ ...base, needsOcr: true, rows: [] });
  if (parsed.needsMapping) return res.json({ ...base, needsMapping: true, rows: [] });
  if (!parsed.rows.length) throw new HttpError(422, 'No se ha encontrado ningún movimiento en el archivo');
  const rows = analyzeRows(req.user, account, parsed);
  res.json({ ...base, needsMapping: false, needsOcr: false, rows, accountId: account.id });
}));

// ---------- Importación (solo lo que el usuario confirma) ----------
const recHash = (x) => sha(JSON.stringify([x.name ?? x.note ?? '', x.amount, x.date, x.categoryId ?? null, x.accountId ?? x.fromId ?? null, x.toId ?? null, x.notes ?? '', x.place ?? '']));
const TYPE_KEYS = Object.keys(C.TYPES);

router.post('/imports/commit', express.json({ limit: JSON_LIMIT }), h(async (req, res) => {
  const user = req.user;
  const b = req.body || {};
  const account = myAccount(user, b.accountId);
  const list = Array.isArray(b.rows) ? b.rows : [];
  if (!list.length) throw new HttpError(400, 'No hay movimientos seleccionados');
  if (list.length > 20000) throw new HttpError(400, 'Demasiados movimientos en una sola importación');
  const accIds = new Set(of(db.accounts, user.id).map((a) => a.id));
  const cats = of(db.categories, user.id);
  const known = knownFingerprints(user.id);
  const importId = store.id();
  const now = new Date().toISOString();
  const created = { expenses: [], incomes: [], transfers: [], categories: [] };
  const items = [];
  const linked = [];
  const paidMarks = [];
  const ignored = [];
  const errors = [];
  let dupSkipped = 0, excluded = 0, incomeTotal = 0, expenseTotal = 0, transfersCount = 0;
  const catByName = new Map(cats.map((c) => [St.norm(c.name), c]));
  const PALETTE = ['#0ea5e9', '#16a34a', '#f97316', '#9333ea', '#db2777', '#ca8a04', '#2563eb', '#dc2626'];
  const ICONS = { gasolina: 'fuel', restaurantes: 'utensils', electricidad: 'zap', suministros: 'droplets', 'internet y telefono': 'wifi', seguros: 'shield', impuestos: 'landmark', educacion: 'graduation-cap', comisiones: 'percent', efectivo: 'banknote' };
  const categoryFor = (v) => {
    if (!v) return null;
    if (typeof v === 'string' && v.startsWith('new:')) {
      const name = v.slice(4).trim().slice(0, 40);
      if (!name) return null;
      const n = St.norm(name);
      if (catByName.has(n)) return catByName.get(n).id;
      const c = { id: store.id(), userId: user.id, name, icon: ICONS[n] || 'tag', color: PALETTE[catByName.size % PALETTE.length], createdAt: now };
      catByName.set(n, c);
      created.categories.push(c);
      return c.id;
    }
    return cats.some((c) => c.id === v) ? v : null;
  };
  const seenFp = new Set();

  for (const r of list) {
    const fp = String(r?.fp || '');
    if (!FP_RE.test(fp)) { errors.push({ line: r?.line, error: 'Movimiento no válido' }); continue; }
    if (r.action === 'exclude') { excluded++; ignored.push(fp); continue; }
    if (known.has(fp) || seenFp.has(fp)) { dupSkipped++; continue; }
    if (r.action === 'skip') { dupSkipped++; continue; }
    seenFp.add(fp);
    const amount = Number(r.amount);
    const date = String(r.date || '');
    if (!D.isYmd(date)) { errors.push({ line: r.line, error: 'Fecha no válida' }); continue; }
    if (!Number.isFinite(amount) || !amount || Math.abs(amount) > 1e9) { errors.push({ line: r.line, error: 'Importe no válido' }); continue; }
    const description = String(r.description || '').trim().slice(0, 300) || 'Movimiento';
    const merchant = String(r.merchant || '').trim().slice(0, 60);
    let type = TYPE_KEYS.includes(r.type) ? r.type : amount < 0 ? 'expense' : 'income';
    const sign = C.TYPES[type].sign;
    if (sign && sign !== Math.sign(amount)) type = amount < 0 ? 'expense' : 'income'; // nunca se confunde un cargo con un abono
    const base = { importId, fingerprint: fp, bankRef: String(r.ref || '').slice(0, 80), createdAt: now };

    // Vincular con un movimiento que ya existe: no se crea nada, solo se recuerda para futuras importaciones
    if (r.action === 'link' && r.dupOf?.id) {
      const coll = { expense: db.expenses, income: db.incomes, transfer: db.transfers }[r.dupOf.kind];
      const ex = coll && coll.find((x) => x.id === r.dupOf.id && x.userId === user.id);
      if (ex && !ex.fingerprint) { linked.push({ ex, fp }); items.push({ kind: r.dupOf.kind, id: ex.id, linked: true }); }
      dupSkipped++;
      continue;
    }

    const counterpart = r.counterpartId && accIds.has(r.counterpartId) && r.counterpartId !== account.id ? r.counterpartId : null;
    if (['transfer', 'cash_withdrawal', 'cash_deposit'].includes(type) && counterpart) {
      const t = { id: store.id(), userId: user.id, type: 'transfer', fromId: amount < 0 ? account.id : counterpart, toId: amount < 0 ? counterpart : account.id, amount: round(Math.abs(amount)), date, note: description.slice(0, 200), ...base };
      created.transfers.push(t);
      items.push({ kind: 'transfer', id: t.id, hash: recHash(t) });
      transfersCount++;
      continue;
    }
    if (amount > 0 && type !== 'refund') {
      const inc = { id: store.id(), userId: user.id, name: (merchant || description).slice(0, 100), amount: round(amount), date, source: r.incomeSource === 'nomina' ? 'nomina' : type === 'cash_deposit' ? 'otros' : 'otros', notes: description, accountId: account.id, movementType: type, ...base };
      created.incomes.push(inc);
      items.push({ kind: 'income', id: inc.id, hash: recHash(inc) });
      incomeTotal += amount;
      continue;
    }
    const e = {
      id: store.id(), userId: user.id, name: (merchant || description).slice(0, 100), amount: round(type === 'refund' ? -Math.abs(amount) : Math.abs(amount)),
      categoryId: categoryFor(r.categoryId), date, place: merchant, notes: description, accountId: account.id,
      paymentMethod: L.PAYMENT_METHODS[r.paymentMethod] ? r.paymentMethod : C.paymentMethodOf(type, description), tags: [], movementType: type, ...base,
    };
    if (type === 'refund') {
      e.refund = true;
      const orig = r.refundOf?.id && db.expenses.find((x) => x.id === r.refundOf.id && x.userId === user.id);
      if (orig) e.refundOf = orig.id;
      else if (FP_RE.test(String(r.refundOf?.fp || ''))) e._refundFp = r.refundOf.fp; // compra del mismo archivo
    }
    const rec = r.recurringMatch?.id && db.recurring.find((x) => x.id === r.recurringMatch.id && x.userId === user.id);
    if (rec && D.isYmd(r.recurringMatch.due) && !R.isPaid(rec, D.parse(r.recurringMatch.due))) {
      e.recurringId = rec.id;
      e.dueDate = r.recurringMatch.due;
      paidMarks.push({ rec, due: r.recurringMatch.due });
    }
    created.expenses.push(e);
    items.push({ kind: 'expense', id: e.id, hash: recHash(e) });
    expenseTotal += e.amount;
  }

  for (const e of created.expenses) {
    if (!e._refundFp) continue;
    const orig = created.expenses.find((x) => x.fingerprint === e._refundFp) || db.expenses.find((x) => x.userId === user.id && x.fingerprint === e._refundFp);
    if (orig) e.refundOf = orig.id;
    delete e._refundFp;
  }
  for (const it of items) { const e = it.kind === 'expense' && created.expenses.find((x) => x.id === it.id); if (e) it.hash = recHash(e); }

  // Reglas aprendidas: lo que el usuario corrige se recuerda para la próxima vez
  const learned = [];
  for (const r of list) {
    if (!r?.learn || !r.key || typeof r.key !== 'string') continue;
    const key = St.norm(r.key).slice(0, 60);
    if (!key) continue;
    const categoryId = typeof r.categoryId === 'string' && r.categoryId.startsWith('new:') ? catByName.get(St.norm(r.categoryId.slice(4)))?.id : (cats.some((c) => c.id === r.categoryId) ? r.categoryId : null);
    learned.push({ key, categoryId: categoryId || null, type: TYPE_KEYS.includes(r.type) ? r.type : null });
  }

  const imported = created.expenses.length + created.incomes.length + created.transfers.length;
  const record = {
    id: importId, userId: user.id, fileName: String(b.fileName || 'extracto').slice(0, 120), format: String(b.format || '').slice(0, 20),
    bank: String(b.bank || '').slice(0, 60), accountId: account.id, accountName: account.name, createdAt: now, by: user.name || user.email,
    detected: Math.max(Number(b.detected) || 0, list.length), imported, duplicatesSkipped: dupSkipped, excluded, errors: errors.length, errorList: errors.slice(0, 50),
    incomeTotal: round(incomeTotal), expenseTotal: round(expenseTotal), transfers: transfersCount, status: imported || linked.length ? 'completada' : 'sin cambios',
    items, ignored: ignored.slice(0, 5000), events: [{ at: now, action: 'Importación', detail: `${imported} movimientos importados`, by: user.name || user.email }],
  };

  // Guardado «todo o nada»: si algo falla, se deshace en memoria y no queda nada a medias
  const snapshot = { expenses: db.expenses.length, incomes: db.incomes.length, transfers: db.transfers.length, categories: db.categories.length, imports: db.imports.length, rules: structuredClone(of(db.importRules, user.id)) };
  const paidBackup = paidMarks.map(({ rec }) => ({ rec, paid: [...(rec.paid || [])], lastPaidMonth: rec.lastPaidMonth }));
  try {
    db.categories.push(...created.categories);
    db.expenses.push(...created.expenses);
    db.incomes.push(...created.incomes);
    db.transfers.push(...created.transfers);
    for (const { ex, fp } of linked) ex.fingerprint = fp;
    for (const { rec, due } of paidMarks) R.markPaid(rec, D.parse(due));
    for (const l of learned) {
      const ex = db.importRules.find((x) => x.userId === user.id && x.key === l.key);
      if (ex) Object.assign(ex, { categoryId: l.categoryId, type: l.type, updatedAt: now });
      else db.importRules.push({ id: store.id(), userId: user.id, ...l, createdAt: now, updatedAt: now });
    }
    db.imports.push(record);
    await store.save();
  } catch (e) {
    db.expenses.length = snapshot.expenses; db.incomes.length = snapshot.incomes; db.transfers.length = snapshot.transfers;
    db.categories.length = snapshot.categories; db.imports.length = snapshot.imports;
    db.importRules = [...db.importRules.filter((x) => x.userId !== user.id), ...snapshot.rules];
    for (const { ex } of linked) delete ex.fingerprint;
    for (const p of paidBackup) { p.rec.paid = p.paid; p.rec.lastPaidMonth = p.lastPaidMonth; }
    console.error('[importar] Error guardando:', e.message);
    throw new HttpError(500, 'No se ha podido completar la importación. No se ha guardado ningún movimiento.');
  }

  res.json({
    id: importId, imported, incomes: created.incomes.length, expenses: created.expenses.length, transfers: transfersCount,
    incomeTotal: record.incomeTotal, expenseTotal: record.expenseTotal, duplicatesSkipped: dupSkipped, excluded, errors, linked: linked.length,
    newCategories: created.categories.map((c) => c.name), rulesLearned: learned.length, recurringSuggestions: recurringSuggestions(user, created.expenses),
  });
}));

// Pagos que se repiten cada mes entre lo importado y tu historial → se proponen como pagos fijos
function recurringSuggestions(user, fresh) {
  if (!fresh.length) return [];
  const recs = of(db.recurring, user.id);
  const freshKeys = new Set(fresh.filter((e) => !e.recurringId && e.amount > 0).map((e) => C.keyOf(e.place || e.name)));
  const groups = new Map();
  for (const e of of(db.expenses, user.id)) {
    if (e.amount <= 0 || e.recurringId) continue;
    const k = C.keyOf(e.place || e.name);
    if (!freshKeys.has(k) || !k) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(e);
  }
  const out = [];
  for (const [k, list] of groups) {
    if (list.length < 2 || recs.some((r) => C.keyOf(r.name) === k)) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const months = new Set(list.map((e) => e.date.slice(0, 7)));
    if (months.size < 2 || months.size < list.length * 0.8) continue;
    const last = list[list.length - 1];
    const amounts = list.slice(-3).map((e) => e.amount);
    const avg = amounts.reduce((a, x) => a + x, 0) / amounts.length;
    if (amounts.some((a) => Math.abs(a - avg) > Math.max(1.5, avg * 0.15))) continue;
    const gaps = list.slice(1).map((e, i) => D.diffDays(D.parse(list[i].date), D.parse(e.date)));
    if (!gaps.every((g) => g >= 25 && g <= 36)) continue;
    out.push({ name: last.place || last.name, amount: round(last.amount), categoryId: last.categoryId, dayOfMonth: +last.date.slice(8, 10), lastDate: last.date, count: list.length, accountId: last.accountId });
  }
  return out.slice(0, 10);
}

// ---------- Historial de importaciones ----------
const summaryOf = (i) => { const { items, ignored, events, errorList, ...rest } = i; return { ...rest, events: events?.length || 0 }; };
router.get('/imports', (req, res) => res.json(of(db.imports, req.user.id).map(summaryOf).sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
function findImport(req) {
  const i = db.imports.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!i) throw new HttpError(404, 'Importación no encontrada');
  return i;
}
const COLL = { expense: 'expenses', income: 'incomes', transfer: 'transfers' };
function itemState(it, uid) {
  const x = db[COLL[it.kind]].find((y) => y.id === it.id && y.userId === uid);
  if (it.linked) return { x, state: x ? 'vinculado' : 'eliminado' };
  if (!x) return { x, state: 'eliminado' };
  return { x, state: recHash(x) === it.hash ? 'sin cambios' : 'modificado' };
}
router.get('/imports/:id', (req, res) => {
  const imp = findImport(req);
  const cats = of(db.categories, req.user.id);
  const accName = (id) => db.accounts.find((a) => a.id === id && a.userId === req.user.id)?.name || '';
  const movements = imp.items.slice(0, 3000).map((it) => {
    const { x, state } = itemState(it, req.user.id);
    if (!x) return { kind: it.kind, id: it.id, state };
    return {
      kind: it.kind, id: x.id, state, date: x.date,
      name: it.kind === 'transfer' ? `${accName(x.fromId)} → ${accName(x.toId)}` : x.name,
      amount: it.kind === 'expense' ? -x.amount : x.amount, category: it.kind === 'expense' ? cats.find((c) => c.id === x.categoryId)?.name || '' : '',
    };
  });
  const canRevert = imp.status === 'completada' && movements.every((m) => m.state !== 'modificado');
  res.json({ ...summaryOf(imp), events: imp.events || [], errorList: imp.errorList || [], movements, canRevert, modified: movements.filter((m) => m.state === 'modificado').length });
});

// Revertir: elimina solo los movimientos de esa importación, y solo si nadie los ha cambiado después
router.post('/imports/:id/revert', h(async (req, res) => {
  const imp = findImport(req);
  if (imp.status !== 'completada') throw new HttpError(400, 'Esta importación ya no se puede revertir');
  if (req.body?.confirm !== true) throw new HttpError(400, 'Confirma la reversión');
  const states = imp.items.map((it) => ({ it, ...itemState(it, req.user.id) }));
  const modified = states.filter((s) => s.state === 'modificado');
  if (modified.length) throw new HttpError(409, `No se puede revertir: has modificado ${modified.length} de estos movimientos después de importarlos.`);
  let removed = 0;
  for (const s of states) {
    if (!s.x) continue;
    if (s.it.linked) { delete s.x.fingerprint; continue; }
    if (s.it.kind === 'expense' && s.x.recurringId && s.x.dueDate) {
      const rec = db.recurring.find((r) => r.id === s.x.recurringId);
      if (rec) {
        rec.paid = (rec.paid || []).filter((d) => d !== s.x.dueDate);
        if (rec.lastPaidMonth === s.x.dueDate.slice(0, 7)) rec.lastPaidMonth = null;
      }
    }
    const coll = db[COLL[s.it.kind]];
    coll.splice(coll.indexOf(s.x), 1);
    if (s.it.kind === 'expense') for (const r of db.receipts) if (r.expenseId === s.x.id) r.expenseId = null;
    removed++;
  }
  const now = new Date().toISOString();
  imp.status = 'revertida';
  imp.revertedAt = now;
  imp.events = [...(imp.events || []), { at: now, action: 'Reversión', detail: `${removed} movimientos eliminados`, by: req.user.name || req.user.email }];
  await store.save();
  res.json({ ok: true, removed });
}));

// ---------- Reglas y mapeos guardados ----------
router.get('/imports-rules', (req, res) => {
  const cats = of(db.categories, req.user.id);
  res.json({
    rules: of(db.importRules, req.user.id).map((r) => ({ id: r.id, key: r.key, type: r.type, category: cats.find((c) => c.id === r.categoryId)?.name || '', updatedAt: r.updatedAt })),
    mappings: of(db.importMappings, req.user.id).map((m) => ({ id: m.id, bank: m.bank, headers: m.headers, updatedAt: m.updatedAt })),
  });
});
router.delete('/imports-rules/:id', h(async (req, res) => {
  const before = db.importRules.length + db.importMappings.length;
  db.importRules = db.importRules.filter((r) => !(r.id === req.params.id && r.userId === req.user.id));
  db.importMappings = db.importMappings.filter((r) => !(r.id === req.params.id && r.userId === req.user.id));
  if (before === db.importRules.length + db.importMappings.length) throw new HttpError(404, 'No encontrado');
  await store.save();
  res.json({ ok: true });
}));

module.exports = { router, analyzeRows, fingerprints, MAX_MB, JSON_LIMIT };
