// Rutas de planificación: cuentas, transferencias, presupuestos, previsiones, asistente, informes, avisos,
// configuración financiera, datos de demostración y derechos sobre los datos (exportar / borrar cuenta).
const express = require('express');
const store = require('./db');
const { db } = store;
const D = require('./dates');
const L = require('./ledger');
const I = require('./insights');
const F = require('./forecast');
const A = require('./assistant');
const R = require('./recurrence');
const S = require('./security');
const demo = require('./demo');
const { HttpError } = require('./auth');
const { catInfo } = require('./summary');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();
const { round, of } = L;
const mine = (list, req) => of(list, req.user.id);
function findMine(list, req, id = req.params.id) {
  const item = list.find((x) => x.id === id && x.userId === req.user.id);
  if (!item) throw new HttpError(404, 'No encontrado');
  return item;
}
const money = (v, msg = 'El importe debe ser mayor que 0') => {
  const n = Number(v);
  if (!(n > 0) || n > 1e9) throw new HttpError(400, msg);
  return round(n);
};
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// ---------- Cuentas ----------
function cleanAccount(b) {
  const name = String(b?.name || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'La cuenta necesita un nombre');
  const initial = Number(b?.initialBalance ?? 0);
  if (!Number.isFinite(initial) || Math.abs(initial) > 1e9) throw new HttpError(400, 'Saldo no válido');
  return {
    name,
    type: L.ACCOUNT_TYPES[b.type] ? b.type : 'corriente',
    initialBalance: round(initial),
    balanceDate: D.isYmd(b.balanceDate) ? b.balanceDate : D.ymd(D.today()),
    color: COLOR_RE.test(b.color || '') ? b.color : '#1e3a8a',
    currency: 'EUR',
  };
}
router.get('/accounts', (req, res) => res.json(L.accountBalances(req.user)));
router.post('/accounts', h(async (req, res) => {
  const a = { id: store.id(), userId: req.user.id, ...cleanAccount(req.body), createdAt: new Date().toISOString() };
  db.accounts.push(a);
  if (req.body?.isDefault || mine(db.accounts, req).length === 1) req.user.finance = { ...(req.user.finance || {}), defaultAccountId: a.id };
  store.save();
  res.json(L.accountBalances(req.user).find((x) => x.id === a.id));
}));
router.put('/accounts/:id', h(async (req, res) => {
  const a = findMine(db.accounts, req);
  const c = cleanAccount({ ...a, ...req.body });
  Object.assign(a, c);
  if (req.body?.isDefault) req.user.finance = { ...(req.user.finance || {}), defaultAccountId: a.id };
  store.save();
  res.json(L.accountBalances(req.user).find((x) => x.id === a.id));
}));
router.delete('/accounts/:id', h(async (req, res) => {
  const a = findMine(db.accounts, req);
  db.accounts.splice(db.accounts.indexOf(a), 1);
  for (const x of [...db.expenses, ...db.incomes]) if (x.userId === req.user.id && x.accountId === a.id) delete x.accountId;
  db.transfers = db.transfers.filter((t) => !(t.userId === req.user.id && (t.fromId === a.id || t.toId === a.id)));
  if (req.user.finance?.defaultAccountId === a.id) req.user.finance.defaultAccountId = null;
  store.save();
  res.json({ ok: true });
}));
// Movimientos de una cuenta (gastos, ingresos, transferencias y ajustes)
router.get('/accounts/:id/movements', h(async (req, res) => {
  const a = findMine(db.accounts, req);
  const moves = L.movements(req.user).filter((m) => m.accountId === a.id);
  const detail = (m) => {
    if (m.kind === 'expense') { const e = db.expenses.find((x) => x.id === m.id); return { name: e.name, category: catInfo(req.user.id, e.categoryId) }; }
    if (m.kind === 'income') return { name: db.incomes.find((x) => x.id === m.id).name };
    const t = db.transfers.find((x) => x.id === m.id);
    if (m.kind === 'adjust') return { name: t.note || 'Ajuste de saldo' };
    const other = db.accounts.find((x) => x.id === (m.amount < 0 ? t.toId : t.fromId));
    return { name: `${m.amount < 0 ? 'Transferencia a' : 'Transferencia desde'} ${other?.name || 'otra cuenta'}`, note: t.note };
  };
  res.json(moves.sort((x, y) => y.date.localeCompare(x.date) || y.createdAt.localeCompare(x.createdAt)).slice(0, 300).map((m) => ({ ...m, ...detail(m), counted: m.always || m.date > a.balanceDate || (m.date === a.balanceDate && m.createdAt > a.createdAt) })));
}));

// ---------- Transferencias y ajustes de saldo ----------
router.get('/transfers', (req, res) => res.json(mine(db.transfers, req).sort((a, b) => b.date.localeCompare(a.date))));
router.post('/transfers', h(async (req, res) => {
  const b = req.body || {};
  if (!D.isYmd(b.date)) throw new HttpError(400, 'Fecha no válida');
  if (b.type === 'adjust') {
    const acc = findMine(db.accounts, req, b.accountId);
    const target = Number(b.newBalance);
    if (!Number.isFinite(target)) throw new HttpError(400, 'Indica el saldo real de la cuenta');
    const cur = L.accountBalances(req.user).find((x) => x.id === acc.id).balance;
    const diff = round(target - cur);
    if (!diff) throw new HttpError(400, 'El saldo ya coincide');
    const t = { id: store.id(), userId: req.user.id, type: 'adjust', toId: acc.id, amount: diff, date: b.date, note: String(b.note || 'Ajuste de saldo').slice(0, 200), createdAt: new Date().toISOString() };
    db.transfers.push(t);
    store.save();
    return res.json(t);
  }
  const from = findMine(db.accounts, req, b.fromId);
  const to = findMine(db.accounts, req, b.toId);
  if (from.id === to.id) throw new HttpError(400, 'Elige dos cuentas distintas');
  const t = { id: store.id(), userId: req.user.id, type: 'transfer', fromId: from.id, toId: to.id, amount: money(b.amount), date: b.date, note: String(b.note || '').slice(0, 200), createdAt: new Date().toISOString() };
  db.transfers.push(t);
  store.save();
  res.json(t);
}));
router.delete('/transfers/:id', h(async (req, res) => {
  const t = findMine(db.transfers, req);
  db.transfers.splice(db.transfers.indexOf(t), 1);
  store.save();
  res.json({ ok: true });
}));

// ---------- Configuración financiera ----------
router.get('/finance-settings', (req, res) => res.json({ ...L.financeOf(req.user), notifyApp: I.prefsOf(req.user), onboarded: !!req.user.onboarded }));
router.put('/finance-settings', h(async (req, res) => {
  const b = req.body || {};
  const f = { ...(req.user.finance || {}) };
  const opt = (v, max) => (v === '' || v === null || v === undefined ? null : Number(v) >= 0 && Number(v) <= max ? round(Number(v)) : (() => { throw new HttpError(400, 'Valor no válido'); })());
  if ('monthlyIncome' in b) f.monthlyIncome = opt(b.monthlyIncome, 1e8);
  if ('payday' in b) f.payday = b.payday ? Math.min(31, Math.max(1, Math.round(Number(b.payday)) || 1)) : null;
  if ('savingsGoal' in b) f.savingsGoal = opt(b.savingsGoal, 1e8);
  if ('lowBalance' in b) f.lowBalance = opt(b.lowBalance, 1e8) ?? 0;
  if ('thresholds' in b) {
    const th = (b.thresholds || []).map(Number);
    if (th.length !== 3 || !(th[0] > 0 && th[0] < th[1] && th[1] < th[2] && th[2] < 100)) throw new HttpError(400, 'Los porcentajes deben ir de menor a mayor y estar entre 1 y 99');
    f.thresholds = th;
  }
  if ('defaultAccountId' in b) f.defaultAccountId = b.defaultAccountId && mine(db.accounts, req).some((a) => a.id === b.defaultAccountId) ? b.defaultAccountId : null;
  req.user.finance = f;
  if (b.notifyApp) req.user.notifyApp = Object.fromEntries(Object.keys(I.NOTIFY_DEFAULTS).map((k) => [k, b.notifyApp[k] !== false]));
  if (b.onboarded) req.user.onboarded = true;
  store.save();
  res.json({ ...L.financeOf(req.user), notifyApp: I.prefsOf(req.user), onboarded: !!req.user.onboarded });
}));

// ---------- Presupuestos ----------
function cleanBudget(b, req) {
  const categoryId = b?.categoryId || null;
  if (categoryId && !db.categories.some((c) => c.id === categoryId && c.userId === req.user.id)) throw new HttpError(400, 'Categoría no válida');
  return { categoryId, amount: money(b?.amount, 'El límite debe ser mayor que 0') };
}
router.get('/budgets', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : D.monthKey(D.today());
  res.json({ month, thresholds: L.financeOf(req.user).thresholds, budgets: L.budgetStatus(req.user, month).map((b) => ({ ...b, category: b.categoryId ? catInfo(req.user.id, b.categoryId) : null })), suggestions: I.budgetSuggestions(req.user) });
});
router.post('/budgets', h(async (req, res) => {
  const c = cleanBudget(req.body, req);
  if (mine(db.budgets, req).some((b) => (b.categoryId || null) === c.categoryId)) throw new HttpError(409, c.categoryId ? 'Esa categoría ya tiene presupuesto' : 'Ya tienes un presupuesto general');
  const b = { id: store.id(), userId: req.user.id, ...c, period: 'monthly', createdAt: new Date().toISOString() };
  db.budgets.push(b);
  store.save();
  res.json(b);
}));
router.put('/budgets/:id', h(async (req, res) => {
  const b = findMine(db.budgets, req);
  b.amount = money(req.body?.amount, 'El límite debe ser mayor que 0');
  store.save();
  res.json(b);
}));
router.delete('/budgets/:id', h(async (req, res) => {
  const b = findMine(db.budgets, req);
  db.budgets.splice(db.budgets.indexOf(b), 1);
  store.save();
  res.json({ ok: true });
}));
// Historial: cumplimiento de los últimos meses con los límites actuales
router.get('/budgets/history', (req, res) => {
  const t = D.today();
  const months = [...Array(6)].map((_, k) => D.monthKey(new Date(t.getFullYear(), t.getMonth() - 5 + k, 1)));
  const rows = months.map((m) => {
    const st = L.budgetStatus(req.user, m);
    const exps = of(db.expenses, req.user.id).filter((e) => e.date.startsWith(m));
    const incs = of(db.incomes, req.user.id).filter((e) => e.date.startsWith(m));
    return { month: m, label: I.monthLabel(m), met: st.filter((b) => b.percent < 100).length, over: st.filter((b) => b.percent >= 100).length, total: st.length, spent: L.sum(exps), saved: round(L.sum(incs) - L.sum(exps)), budgets: st.map((b) => ({ id: b.id, categoryId: b.categoryId, spent: b.spent, amount: b.amount, percent: b.percent })) };
  });
  const overCount = {};
  for (const r of rows) for (const b of r.budgets) if (b.percent >= 100) overCount[b.categoryId || 'general'] = (overCount[b.categoryId || 'general'] || 0) + 1;
  res.json({ months: rows, mostExceeded: Object.entries(overCount).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ name: k === 'general' ? 'Presupuesto general' : catInfo(req.user.id, k).name, times: n })) });
});

// ---------- Calendario: gastos, ingresos y cobros previstos del mes ----------
router.get('/calendar', (req, res) => {
  const month = /^d{4}-d{2}$/.test(req.query.month || '') ? req.query.month : D.monthKey(D.today());
  const [y, m] = month.split('-').map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0);
  const t = D.today();
  const bills = [];
  for (const r of mine(db.recurring, req).filter((r) => r.active)) {
    for (const d of R.occurrences(r, from, to)) {
      const paid = R.isPaid(r, d);
      bills.push({ recurringId: r.id, name: r.name, amount: r.amount, categoryId: r.categoryId, date: D.ymd(d), paid, auto: !!r.autoAdd && !paid, overdue: !paid && !r.autoAdd && d < t && D.ymd(d) >= (r.startDate || '0000'), frequency: R.freqLabel(r) });
    }
  }
  const inMonth = (x) => x.date.startsWith(month);
  res.json({ month, expenses: mine(db.expenses, req).filter(inMonth), incomes: mine(db.incomes, req).filter(inMonth), bills: bills.sort((a, b) => a.date.localeCompare(b.date)) });
});

// ---------- Panel, previsiones e informes ----------
router.get('/overview', (req, res) => {
  const t = D.today();
  const mk = D.monthKey(t);
  const prevMk = D.monthKey(new Date(t.getFullYear(), t.getMonth() - 1, 1));
  const exps = mine(db.expenses, req);
  const incs = mine(db.incomes, req);
  const m = L.moneySummary(req.user);
  const fc = F.forecast(req.user, { horizon: 62 });
  const monthExp = L.sum(exps.filter((e) => e.date.startsWith(mk)));
  const monthInc = L.sum(incs.filter((e) => e.date.startsWith(mk)));
  res.json({
    money: m,
    monthExpenses: monthExp,
    monthIncomes: monthInc,
    prevMonthExpenses: L.sum(exps.filter((e) => e.date.startsWith(prevMk))),
    monthSaving: round(monthInc - monthExp),
    savingsRate: monthInc > 0 ? Math.round(((monthInc - monthExp) / monthInc) * 100) : null,
    endOfMonth: fc.checkpoints.find((c) => c.key === 'eom'),
    confidence: fc.confidence,
    forecastSeries: fc.series.slice(0, 32).map((x) => ({ date: x.date, realistic: x.realistic })),
    history: fc.history.slice(-30),
    months: I.monthSeries(req.user, 6, t),
    budgets: L.budgetStatus(req.user).slice(0, 5).map((b) => ({ ...b, category: b.categoryId ? catInfo(req.user.id, b.categoryId) : null })),
    tips: I.recommendations(req.user).slice(0, 3),
    alerts: fc.alerts.slice(0, 3),
    accounts: L.accountBalances(req.user),
    onboarded: !!req.user.onboarded,
    hasData: exps.length + incs.length > 0,
  });
});
router.get('/forecast', (req, res) => res.json(F.forecast(req.user, { horizon: 185 })));
router.post('/forecast/simulate', h(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || 'Compra').trim().slice(0, 80) || 'Compra';
  const date = D.isYmd(b.date) ? b.date : D.ymd(D.today());
  if (date < D.ymd(D.today())) throw new HttpError(400, 'La fecha debe ser hoy o posterior');
  res.json(F.simulate(req.user, { name, price: money(b.price, 'Indica el precio'), date, monthly: !!b.monthly }));
}));
router.get('/insights', (req, res) => res.json({
  recommendations: I.recommendations(req.user),
  anomalies: I.anomalies(req.user),
  categories: I.categoryComparison(req.user),
  months: I.monthSeries(req.user, 12),
}));
router.post('/insights/anomalies/dismiss', h(async (req, res) => {
  const key = String(req.body?.key || '').slice(0, 200);
  if (!key) throw new HttpError(400, 'Falta la alerta');
  req.user.dismissedAnomalies = [...new Set([...(req.user.dismissedAnomalies || []), key])].slice(-300);
  db.notifications = db.notifications.filter((n) => !(n.userId === req.user.id && n.key === 'anom:' + key));
  store.save();
  res.json({ ok: true });
}));
router.get('/reports/month', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : D.monthKey(D.today());
  res.json(I.monthlyReport(req.user, month));
});
router.get('/reports/period', h(async (req, res) => {
  const { from, to } = req.query;
  if (!D.isYmd(from) || !D.isYmd(to) || from > to) throw new HttpError(400, 'Fechas no válidas');
  res.json({ ...I.periodReport(req.user, from, to), budgets: L.budgetStatus(req.user, to.slice(0, 7)).map((b) => ({ ...b, name: b.categoryId ? catInfo(req.user.id, b.categoryId).name : 'Presupuesto general' })), forecast: F.forecast(req.user, { horizon: 62 }).checkpoints });
}));

// CSV de todos los movimientos (se abre en Excel, Numbers o Google Sheets)
router.get('/export.csv', h(async (req, res) => {
  const from = D.isYmd(req.query.from) ? req.query.from : '0000-01-01';
  const to = D.isYmd(req.query.to) ? req.query.to : '9999-12-31';
  const accName = (id) => db.accounts.find((a) => a.id === id && a.userId === req.user.id)?.name || '';
  const rows = [
    ...mine(db.expenses, req).map((e) => [e.date, 'Gasto', e.name, catInfo(req.user.id, e.categoryId).name, accName(e.accountId), L.PAYMENT_METHODS[e.paymentMethod] || '', e.place || '', -e.amount, (e.tags || []).join(' '), e.notes || '']),
    ...mine(db.incomes, req).map((i) => [i.date, 'Ingreso', i.name, '', accName(i.accountId), '', '', i.amount, '', i.notes || '']),
    ...mine(db.transfers, req).map((t) => (t.type === 'adjust' ? [t.date, 'Ajuste', t.note || 'Ajuste de saldo', '', accName(t.toId), '', '', t.amount, '', ''] : [t.date, 'Transferencia', `${accName(t.fromId)} → ${accName(t.toId)}`, '', '', '', '', t.amount, '', t.note || ''])),
  ].filter((r) => r[0] >= from && r[0] <= to).sort((a, b) => a[0].localeCompare(b[0]));
  const cell = (v) => {
    if (typeof v === 'number') return v.toFixed(2).replace('.', ',');
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita fórmulas maliciosas al abrirlo en Excel
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [['Fecha', 'Tipo', 'Concepto', 'Categoría', 'Cuenta', 'Método de pago', 'Lugar', 'Importe', 'Etiquetas', 'Notas'], ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="movimientos-${D.ymd(D.today())}.csv"`);
  res.send(csv);
}));

// ---------- Asistente ----------
router.post('/assistant/ask', h(async (req, res) => {
  const lim = S.limiter({ key: 'ask:' + req.user.id, max: 60, windowMs: 10 * 60 * 1000 });
  if (!lim.ok) throw new HttpError(429, `Demasiadas preguntas seguidas. Espera ${lim.retryIn} min.`);
  const q = String(req.body?.question || '').trim();
  if (!q) throw new HttpError(400, 'Escribe una pregunta');
  res.json(await A.ask(req.user, q));
}));
router.get('/assistant/help', (req, res) => res.json({ suggestions: A.HELP, ai: !!process.env.ANTHROPIC_API_KEY }));

// ---------- Avisos ----------
const lastRefresh = new Map();
router.get('/notifications', (req, res) => {
  if (Date.now() - (lastRefresh.get(req.user.id) || 0) > 60_000) {
    lastRefresh.set(req.user.id, Date.now());
    try { I.refreshNotifications(req.user); } catch (e) { console.error('[avisos]', e.message); }
  }
  const list = mine(db.notifications, req).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ unread: list.filter((n) => !n.read).length, list: list.slice(0, 50) });
});
router.post('/notifications/read', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? new Set(req.body.ids) : null;
  for (const n of mine(db.notifications, req)) if (!ids || ids.has(n.id)) n.read = true;
  store.save();
  res.json({ ok: true });
});
router.delete('/notifications', (req, res) => {
  db.notifications = db.notifications.filter((n) => n.userId !== req.user.id || !n.read);
  store.save();
  res.json({ ok: true });
});

// ---------- Datos de demostración ----------
router.get('/demo', (req, res) => res.json({ active: demo.count(req.user) > 0, count: demo.count(req.user) }));
router.post('/demo', h(async (req, res) => {
  if (demo.count(req.user)) throw new HttpError(400, 'Ya tienes los datos de demostración cargados');
  res.json({ created: demo.create(req.user) });
}));
router.delete('/demo', h(async (req, res) => res.json({ removed: await demo.remove(req.user) })));

// ---------- Tus datos (RGPD) ----------
router.get('/me/export', (req, res) => {
  const out = { exportedAt: new Date().toISOString(), user: { name: req.user.name, email: req.user.email, createdAt: req.user.createdAt, finance: req.user.finance || {}, notify: req.user.notify } };
  for (const k of ['categories', 'accounts', 'expenses', 'incomes', 'transfers', 'recurring', 'budgets', 'savings', 'savingMoves', 'receipts', 'notifications', 'securityLog', 'imports', 'importRules', 'importMappings']) {
    out[k] = mine(db[k], req).map(({ userId, ...x }) => x);
  }
  res.setHeader('Content-Disposition', `attachment; filename="mis-datos-${D.ymd(D.today())}.json"`);
  res.json(out);
});
router.post('/me/delete', h(async (req, res) => {
  const u = req.user;
  if (!S.limiter({ key: 'del:' + u.id, max: 5, windowMs: 15 * 60 * 1000 }).ok) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  if (!S.verifyPassword(String(req.body?.password || ''), u.salt, u.passHash)) throw new HttpError(401, 'La contraseña no es correcta');
  if (u.totp && S.verifyTotp(S.decrypt(u.totp), req.body?.code, u.totpLastStep ?? -1) === null) throw new HttpError(401, 'El código de verificación no es correcto');
  if (require('./auth').isAdmin(u) && db.users.filter((x) => require('./auth').isAdmin(x)).length <= 1 && db.users.length > 1) throw new HttpError(400, 'Eres el único administrador: nombra a otro antes de borrar tu cuenta');
  await store.deleteUserData(u.id);
  S.clearSessionCookie(req, res);
  res.json({ ok: true });
}));

module.exports = { router };
