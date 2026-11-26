// Libro de cuentas: saldos de las cuentas, dinero disponible y presupuestos.
// Todas las cifras que ve el usuario (y que usa el asistente) salen de aquí, calculadas con sus datos reales.
const { db } = require('./db');
const D = require('./dates');
const R = require('./recurrence');

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (list, f = (x) => x.amount) => round(list.reduce((a, x) => a + f(x), 0));
const of = (list, uid) => list.filter((x) => x.userId === uid);

const ACCOUNT_TYPES = {
  corriente: { label: 'Cuenta corriente', icon: 'landmark' },
  ahorro: { label: 'Cuenta de ahorro', icon: 'piggy-bank' },
  efectivo: { label: 'Efectivo', icon: 'banknote' },
  credito: { label: 'Tarjeta de crédito', icon: 'credit-card' },
  debito: { label: 'Tarjeta de débito', icon: 'wallet-cards' },
  deposito: { label: 'Depósito', icon: 'lock' },
  otra: { label: 'Otra', icon: 'wallet' },
};
// Grupos para el patrimonio: dinero para gastar, ahorro, efectivo y deudas
const GROUP = { corriente: 'corriente', debito: 'corriente', otra: 'corriente', ahorro: 'ahorro', deposito: 'ahorro', efectivo: 'efectivo', credito: 'credito' };
const SPENDABLE = new Set(['corriente', 'efectivo']);
const PAYMENT_METHODS = { tarjeta: 'Tarjeta', efectivo: 'Efectivo', bizum: 'Bizum', transferencia: 'Transferencia', domiciliacion: 'Domiciliación', otro: 'Otro' };

function financeOf(user) {
  const f = user.finance || {};
  const th = Array.isArray(f.thresholds) && f.thresholds.length === 3 ? f.thresholds.map(Number) : [50, 75, 90];
  return {
    currency: 'EUR',
    monthlyIncome: Number(f.monthlyIncome) > 0 ? round(f.monthlyIncome) : null,
    payday: Number(f.payday) >= 1 && Number(f.payday) <= 31 ? Number(f.payday) : null,
    savingsGoal: Number(f.savingsGoal) > 0 ? round(f.savingsGoal) : null,
    lowBalance: Number(f.lowBalance) >= 0 && f.lowBalance !== null && f.lowBalance !== undefined && f.lowBalance !== '' ? round(f.lowBalance) : 100,
    thresholds: th,
    defaultAccountId: f.defaultAccountId || null,
  };
}

// ---------- Cuentas ----------
function defaultAccount(user) {
  const accs = of(db.accounts, user.id);
  const fin = financeOf(user);
  return accs.find((a) => a.id === fin.defaultAccountId) || [...accs].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))[0] || null;
}

// Todos los movimientos del usuario con su efecto en cada cuenta (+ entra dinero, - sale)
function movements(user) {
  const def = defaultAccount(user)?.id || null;
  const accIds = new Set(of(db.accounts, user.id).map((a) => a.id));
  const acc = (id) => (id && accIds.has(id) ? id : def);
  const out = [];
  for (const e of of(db.expenses, user.id)) out.push({ kind: 'expense', id: e.id, date: e.date, createdAt: e.createdAt || '', accountId: acc(e.accountId), amount: -e.amount });
  for (const i of of(db.incomes, user.id)) out.push({ kind: 'income', id: i.id, date: i.date, createdAt: i.createdAt || '', accountId: acc(i.accountId), amount: i.amount });
  for (const t of of(db.transfers, user.id)) {
    if (t.type === 'adjust') out.push({ kind: 'adjust', id: t.id, date: t.date, createdAt: t.createdAt || '', accountId: t.toId, amount: t.amount, always: true });
    else {
      out.push({ kind: 'transfer', id: t.id, date: t.date, createdAt: t.createdAt || '', accountId: t.fromId, amount: -t.amount, always: true });
      out.push({ kind: 'transfer', id: t.id, date: t.date, createdAt: t.createdAt || '', accountId: t.toId, amount: t.amount, always: true });
    }
  }
  return out;
}
// El saldo inicial es el que había en balanceDate: solo cuentan los movimientos posteriores
const counts = (m, a) => m.always || m.date > a.balanceDate || (m.date === a.balanceDate && m.createdAt > (a.createdAt || ''));

// Referencia del saldo: el último saldo comunicado por el banco (extracto, conexión o tú a mano) si es posterior
// al saldo inicial. El saldo de hoy = esa referencia + los movimientos de después (eso último es estimado).
const bankAnchor = (a) => (a.bank && D.isYmd(a.bank.at) && Number.isFinite(a.bank.booked) && a.bank.at >= a.balanceDate ? a.bank : null);
const STALE_DAYS = 3;
function accountBalances(user, moves = movements(user)) {
  const t = D.ymd(D.today());
  return of(db.accounts, user.id).map((a) => {
    const mine = moves.filter((m) => m.accountId === a.id);
    const counted = mine.filter((m) => counts(m, a));
    const mk = D.monthKey(D.today());
    const bank = bankAnchor(a);
    const fromInitial = round(a.initialBalance + sum(counted));
    let balance = fromInitial, after = [], reconcile = null;
    if (bank) {
      after = mine.filter((m) => m.date > bank.at);
      balance = round(bank.booked + sum(after));
      // Diferencia entre lo que calcula la app con tus movimientos y lo que dice el banco en esa fecha
      const estimateAtBank = round(a.initialBalance + sum(counted.filter((m) => m.date <= bank.at)));
      reconcile = round(bank.booked - estimateAtBank);
    }
    const daysOld = bank ? D.diffDays(D.parse(bank.at), D.parse(t)) : null;
    return {
      ...a,
      typeLabel: (ACCOUNT_TYPES[a.type] || ACCOUNT_TYPES.otra).label,
      group: GROUP[a.type] || 'corriente',
      balance,
      // Tipos de saldo: contable y disponible (del banco), retenido (la diferencia), estimado (calculado por la app)
      balances: bank
        ? { booked: bank.booked, available: bank.available ?? null, pending: bank.available != null ? round(bank.booked - bank.available) : null, estimated: balance, at: bank.at, source: bank.source || 'manual', updatedAt: bank.updatedAt || null }
        : { booked: null, available: null, pending: null, estimated: balance, at: null, source: 'calculado', updatedAt: null },
      confirmed: !!bank && after.length === 0 && daysOld <= STALE_DAYS,
      stale: a.type !== 'efectivo' && (!bank || daysOld > STALE_DAYS), // el efectivo solo lo sabes tú: no hay banco que lo confirme
      daysOld,
      reconcile: reconcile && Math.abs(reconcile) >= 0.01 ? reconcile : 0,
      monthIn: sum(counted.filter((m) => m.date.startsWith(mk) && m.amount > 0 && m.kind !== 'transfer')),
      monthOut: -sum(counted.filter((m) => m.date.startsWith(mk) && m.amount < 0 && m.kind !== 'transfer')),
      movements: counted.length,
    };
  });
}
// Saldo total en una fecha pasada (para el gráfico de evolución)
function balanceAt(user, dateStr, moves = movements(user)) {
  let total = 0;
  for (const a of of(db.accounts, user.id)) {
    const mine = moves.filter((m) => m.accountId === a.id);
    const bank = bankAnchor(a);
    if (bank) {
      total += dateStr >= bank.at ? bank.booked + sum(mine.filter((m) => m.date > bank.at && m.date <= dateStr)) : bank.booked - sum(mine.filter((m) => m.date > dateStr && m.date <= bank.at));
      continue;
    }
    if (dateStr >= a.balanceDate) total += a.initialBalance + sum(mine.filter((m) => counts(m, a) && m.date <= dateStr));
    else total += a.initialBalance - sum(mine.filter((m) => !m.always && m.date > dateStr && m.date <= a.balanceDate && !counts(m, a)));
  }
  return round(total);
}

// ---------- Pagos fijos pendientes ----------
// Cobros de pagos recurrentes que aún no se han registrado entre from y to
function pendingBills(user, from, to) {
  const out = [];
  for (const r of of(db.recurring, user.id).filter((r) => r.active)) {
    const st = R.status(r, from);
    const list = R.occurrences(r, from, to).filter((d) => !R.isPaid(r, d));
    if (st.state === 'overdue' && st.nextDue < from) list.unshift(st.nextDue);
    for (const d of list) out.push({ recurringId: r.id, name: r.name, amount: r.amount, categoryId: r.categoryId, date: D.ymd(d), overdue: d < from, autoAdd: !!r.autoAdd });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Presupuestos ----------
function budgetLevel(p, th) {
  if (p >= 100) return { key: 'over', label: 'Superado' };
  if (p >= th[2]) return { key: 'alert', label: 'Alerta' };
  if (p >= th[1]) return { key: 'caution', label: 'Precaución' };
  if (p >= th[0]) return { key: 'watch', label: 'Seguimiento' };
  return { key: 'ok', label: 'Correcto' };
}
function budgetStatus(user, month = D.monthKey(D.today())) {
  const fin = financeOf(user);
  const [y, m] = month.split('-').map(Number);
  const dim = D.daysInMonth(y, m - 1);
  const t = D.today();
  const isCurrent = month === D.monthKey(t);
  const elapsed = isCurrent ? t.getDate() / dim : month < D.monthKey(t) ? 1 : 0;
  const exps = of(db.expenses, user.id).filter((e) => e.date.startsWith(month));
  return of(db.budgets, user.id).map((b) => {
    const list = b.categoryId ? exps.filter((e) => e.categoryId === b.categoryId) : exps;
    const spent = sum(list);
    const fixed = sum(list.filter((e) => e.recurringId));
    const p = b.amount ? (spent / b.amount) * 100 : 0;
    const expected = b.amount * elapsed;
    return {
      ...b,
      month,
      spent,
      remaining: round(b.amount - spent),
      percent: Math.round(p),
      level: budgetLevel(p, fin.thresholds),
      // ritmo: >1 significa que vas más rápido de lo que permite el presupuesto
      pace: expected > 0 ? Math.round((spent / expected) * 100) / 100 : null,
      projected: isCurrent && t.getDate() >= 5 ? round(fixed + ((spent - fixed) / t.getDate()) * dim) : null,
    };
  }).sort((a, b) => (a.categoryId ? 1 : 0) - (b.categoryId ? 1 : 0) || b.percent - a.percent);
}

// ---------- Resumen de dinero ----------
function moneySummary(user) {
  const t = D.today();
  const fin = financeOf(user);
  const accounts = accountBalances(user);
  const balance = sum(accounts, (a) => a.balance);
  const eom = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  const bills = pendingBills(user, t, eom).filter((b) => !b.autoAdd || b.date >= D.ymd(t));
  const reservedBills = sum(bills);
  const mk = D.monthKey(t);
  const savedMonth = sum(of(db.savingMoves, user.id).filter((m) => m.date.startsWith(mk)), (m) => (m.type === 'in' ? m.amount : -m.amount));
  const reservedSavings = fin.savingsGoal ? Math.max(0, round(fin.savingsGoal - savedMonth)) : 0;
  const savings = sum(of(db.savingMoves, user.id), (m) => (m.type === 'in' ? m.amount : -m.amount));
  const w = wealth(user, accounts);
  const available = round(w.spendable - reservedBills - reservedSavings);
  const daysLeft = D.diffDays(t, eom) + 1;
  const general = budgetStatus(user).find((b) => !b.categoryId) || null;
  return {
    hasAccounts: accounts.length > 0,
    balance,
    spendable: w.spendable,
    netWorth: w.total,
    inSavingsAccounts: w.byGroup.ahorro,
    inPiggyBanks: w.piggyTotal,
    stale: accounts.filter((a) => a.stale).map((a) => a.name),
    reservedBills,
    reservedSavings,
    available,
    savings,
    savedMonth,
    daysLeft,
    perDay: round(Math.max(0, general ? Math.min(available, general.remaining) : available) / daysLeft),
    perDayBalance: round(Math.max(0, available) / daysLeft),
    budgetExceeded: !!general && general.remaining <= 0,
    budgetRemaining: general ? general.remaining : null,
    bills,
  };
}

// ---------- Patrimonio: cuánto dinero tienes, dónde y cuánto puedes usar ----------
// Huchas: si están dentro de una cuenta (virtuales) son dinero reservado de esa cuenta y NO se suman otra vez;
// si están aparte, se suman al patrimonio. Las que no dicen dónde están se tratan como dentro de la cuenta principal
// (así nunca se cuenta dos veces el mismo dinero).
function piggyBanks(user) {
  const def = defaultAccount(user)?.id || null;
  return of(db.savings, user.id).map((s) => {
    const balance = sum(of(db.savingMoves, user.id).filter((m) => m.savingId === s.id), (m) => (m.type === 'in' ? m.amount : -m.amount));
    const location = s.location === 'separada' ? 'separada' : 'virtual';
    const accountId = location === 'virtual' ? (db.accounts.some((a) => a.id === s.accountId && a.userId === user.id) ? s.accountId : def) : null;
    return { id: s.id, name: s.name, goal: s.goal, color: s.color, icon: s.icon, balance, location, accountId, assigned: location === 'separada' || !!s.accountId };
  });
}
function wealth(user, accounts = accountBalances(user)) {
  const piggies = piggyBanks(user);
  const byGroup = { corriente: 0, ahorro: 0, efectivo: 0, credito: 0 };
  for (const a of accounts) byGroup[a.group] = round(byGroup[a.group] + a.balance);
  const virtualIn = (id) => sum(piggies.filter((p) => p.location === 'virtual' && p.accountId === id), (p) => p.balance);
  const separate = sum(piggies.filter((p) => p.location === 'separada'), (p) => p.balance);
  const piggyTotal = sum(piggies, (p) => p.balance);
  const debt = round(Math.min(0, byGroup.credito));
  const total = round(byGroup.corriente + byGroup.ahorro + byGroup.efectivo + debt + separate);
  const spendableAccounts = accounts.filter((a) => SPENDABLE.has(a.group));
  const spendable = round(sum(spendableAccounts, (a) => a.balance) - sum(spendableAccounts, (a) => virtualIn(a.id)));
  const items = accounts.map((a) => {
    const reserved = virtualIn(a.id);
    return { id: a.id, name: a.name, type: a.type, typeLabel: a.typeLabel, group: a.group, bankName: a.bankName || '', iban: a.iban || '', color: a.color, balance: a.balance, reserved, free: round(a.balance - reserved), share: total > 0 && a.group !== 'credito' ? Math.round((a.balance / total) * 1000) / 10 : 0, balances: a.balances, stale: a.stale, confirmed: a.confirmed, daysOld: a.daysOld, reconcile: a.reconcile, connectionId: a.connectionId || null };
  });
  return {
    total, // patrimonio financiero sin duplicar
    spendable, // cuentas para gastar y efectivo, sin lo apartado en huchas
    reservedForSavings: round(byGroup.ahorro + piggyTotal),
    byGroup, debt, piggyTotal, separatePiggies: separate,
    piggies, accounts: items,
    unassignedPiggies: piggies.filter((p) => !p.assigned && p.balance > 0).map((p) => p.name),
    stale: accounts.filter((a) => a.stale).map((a) => ({ id: a.id, name: a.name, daysOld: a.daysOld })),
  };
}

module.exports = {
  wealth, piggyBanks, GROUP, SPENDABLE, bankAnchor,
  ACCOUNT_TYPES, PAYMENT_METHODS, round, sum, of, financeOf, defaultAccount, movements, accountBalances, balanceAt,
  pendingBills, budgetStatus, budgetLevel, moneySummary,
};
