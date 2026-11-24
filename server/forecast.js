// Previsión del saldo futuro a partir del historial real y de los pagos/ingresos previstos.
// No es una certeza: se calculan tres escenarios y un indicador de fiabilidad.
const { db } = require('./db');
const D = require('./dates');
const L = require('./ledger');

const { round, sum, of } = L;
const SCEN = { optimistic: { variable: 0.85, income: 1 }, realistic: { variable: 1, income: 1 }, pessimistic: { variable: 1.2, income: 0.9 } };
const cv = (arr) => {
  if (arr.length < 2) return 1;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  if (!m) return 1;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length) / m;
};

// Gasto variable diario: lo que no son pagos fijos, en los últimos 90 días
function variableRate(user, t = D.today()) {
  const exps = of(db.expenses, user.id).filter((e) => !e.recurringId && e.date <= D.ymd(t));
  if (!exps.length) return { perDay: 0, days: 0 };
  const first = exps.reduce((m, e) => (e.date < m ? e.date : m), exps[0].date);
  const days = Math.min(90, D.diffDays(D.parse(first), t) + 1);
  const from = D.ymd(D.addDays(t, -days + 1));
  return { perDay: round(sum(exps.filter((e) => e.date >= from)) / days), days };
}

// Ingresos previstos: los que indica el usuario o, si no, los habituales de los últimos meses
function incomePlan(user, t = D.today()) {
  const fin = L.financeOf(user);
  if (fin.monthlyIncome) return { amount: fin.monthlyIncome, day: fin.payday || 1, source: 'settings', regularity: 1 };
  const incs = of(db.incomes, user.id);
  const months = [1, 2, 3].map((k) => D.monthKey(new Date(t.getFullYear(), t.getMonth() - k, 1)));
  const totals = months.map((mk) => sum(incs.filter((i) => i.date.startsWith(mk))));
  const withIncome = totals.filter((x) => x > 0);
  if (withIncome.length < 2) return null;
  const days = months.map((mk) => {
    const l = incs.filter((i) => i.date.startsWith(mk));
    return l.length ? Number(l.reduce((m, i) => (i.amount > m.amount ? i : m)).date.slice(8)) : null;
  }).filter(Boolean).sort((a, b) => a - b);
  return { amount: round(withIncome.reduce((a, b) => a + b, 0) / withIncome.length), day: days[Math.floor(days.length / 2)] || 1, source: 'history', regularity: Math.max(0, 1 - cv(withIncome)) };
}

// Proyección día a día. extra = compras simuladas [{date, amount, monthly}]
function project(user, { horizon = 92, extra = [] } = {}) {
  const t = D.today();
  const end = D.addDays(t, horizon);
  const money = L.moneySummary(user);
  const rate = variableRate(user, t);
  const plan = incomePlan(user, t);
  const bills = L.pendingBills(user, t, end);
  const mk = D.monthKey(t);
  const incomeThisMonth = sum(of(db.incomes, user.id).filter((i) => i.date.startsWith(mk)));
  const events = [];
  for (const b of bills) events.push({ date: b.overdue ? D.ymd(t) : b.date, amount: -b.amount, type: 'bill', name: b.name });
  if (plan) {
    for (let k = 0; k <= Math.ceil(horizon / 28) + 1; k++) {
      const d = D.dueInMonth(plan.day, t.getFullYear(), t.getMonth() + k);
      if (d < t || d > end) continue;
      // si este mes ya se ha cobrado casi todo lo habitual, no se cuenta otra vez
      if (k === 0 && incomeThisMonth >= plan.amount * 0.7) continue;
      events.push({ date: D.ymd(d), amount: plan.amount, type: 'income', name: 'Ingresos previstos' });
    }
  }
  for (const x of extra) {
    const d0 = D.parse(x.date);
    if (x.monthly) for (let k = 0; k < 12; k++) {
      const d = D.dueInMonth(d0.getDate(), d0.getFullYear(), d0.getMonth() + k);
      if (d >= t && d <= end) events.push({ date: D.ymd(d), amount: -x.amount, type: 'purchase', name: x.name });
    }
    else if (d0 >= t && d0 <= end) events.push({ date: x.date, amount: -x.amount, type: 'purchase', name: x.name });
  }
  const byDate = {};
  for (const e of events) (byDate[e.date] ||= []).push(e);
  const series = [];
  const bal = { optimistic: money.balance, realistic: money.balance, pessimistic: money.balance };
  // hoy ya puede haber gastos apuntados: solo se estima la parte que falta del día
  const spentToday = sum(of(db.expenses, user.id).filter((e) => e.date === D.ymd(t) && !e.recurringId));
  for (let i = 0; i <= horizon; i++) {
    const d = D.addDays(t, i);
    const ds = D.ymd(d);
    const dayEv = byDate[ds] || [];
    const variable = i === 0 ? Math.max(0, rate.perDay - spentToday) : rate.perDay;
    for (const [k, s] of Object.entries(SCEN)) {
      bal[k] += sum(dayEv.filter((e) => e.type === 'income'), (e) => e.amount * s.income) + sum(dayEv.filter((e) => e.type !== 'income')) - variable * s.variable;
    }
    series.push({ date: ds, optimistic: round(bal.optimistic), realistic: round(bal.realistic), pessimistic: round(bal.pessimistic), events: dayEv.map((e) => ({ name: e.name, amount: e.amount, type: e.type })) });
  }
  return { t, money, rate, plan, events, series };
}

function confidence(user, rate, plan) {
  const t = D.today();
  const exps = of(db.expenses, user.id).filter((e) => !e.recurringId);
  const weeks = [...Array(8)].map((_, k) => {
    const s = D.ymd(D.addDays(D.weekStart(t), -7 * (k + 1)));
    const e = D.ymd(D.addDays(D.weekStart(t), -7 * k - 1));
    return sum(exps.filter((x) => x.date >= s && x.date <= e));
  }).filter((x) => x > 0);
  const hist = Math.min(1, rate.days / 90);
  const score = Math.round(hist * 40 + (plan ? 25 * plan.regularity : 0) + (weeks.length >= 3 ? 20 * Math.max(0, 1 - cv(weeks)) : 0) + (of(db.recurring, user.id).length ? 15 : 0));
  const notes = [];
  if (rate.days < 30) notes.push(`Solo hay ${rate.days} día${rate.days === 1 ? '' : 's'} de historial de gastos: la estimación es provisional.`);
  if (!plan) notes.push('No hay ingresos previstos: indica tu nómina en Ajustes o registra ingresos de al menos dos meses.');
  else if (plan.source === 'history') notes.push('Los ingresos previstos se calculan con la media de los últimos meses.');
  if (!L.of(db.accounts, user.id).length) notes.push('No has añadido cuentas: el saldo de partida es 0 €.');
  return { score, label: score >= 70 ? 'Alta' : score >= 40 ? 'Media' : 'Baja', notes };
}

function checkpoints(series, t) {
  const at = (days) => series[Math.min(days, series.length - 1)];
  const eom = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  const eonm = new Date(t.getFullYear(), t.getMonth() + 2, 0);
  const byDate = (d) => series.find((p) => p.date === D.ymd(d)) || series[series.length - 1];
  return [
    { key: '7', label: 'En 7 días', ...at(7) },
    { key: '15', label: 'En 15 días', ...at(15) },
    { key: '30', label: 'En 30 días', ...at(30) },
    { key: 'eom', label: 'Fin de este mes', ...byDate(eom) },
    { key: 'eonm', label: 'Fin del mes que viene', ...byDate(eonm) },
    { key: '90', label: 'En 3 meses', ...at(90) },
    { key: '180', label: 'En 6 meses', ...at(180) },
  ].filter((c) => c.date).map(({ events, ...c }) => c);
}

function alerts(user, p) {
  const fin = L.financeOf(user);
  const out = [];
  const t = p.t;
  const eom = D.ymd(new Date(t.getFullYear(), t.getMonth() + 1, 0));
  const month = p.series.filter((x) => x.date <= eom);
  const low = p.series.slice(0, 45).find((x) => x.realistic < fin.lowBalance);
  if (low && L.of(db.accounts, user.id).length) out.push({ level: low.realistic < 0 ? 'danger' : 'warn', text: `Tu saldo podría bajar de ${fin.lowBalance} € el ${D.parse(low.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}.` });
  const mk = D.monthKey(t);
  const prev = D.monthKey(new Date(t.getFullYear(), t.getMonth() - 1, 1));
  const exps = of(db.expenses, user.id);
  const spentMonth = sum(exps.filter((e) => e.date.startsWith(mk)));
  const prevMonth = sum(exps.filter((e) => e.date.startsWith(prev)));
  const projectedMonth = round(spentMonth + sum(L.pendingBills(user, t, D.parse(eom))) + p.rate.perDay * (D.diffDays(t, D.parse(eom)) + 1) - (exps.some((e) => e.date === D.ymd(t)) ? 0 : 0));
  if (prevMonth > 0 && t.getDate() >= 5) {
    const diff = Math.round(((projectedMonth - prevMonth) / prevMonth) * 100);
    if (Math.abs(diff) >= 10) out.push({ level: diff > 0 ? 'warn' : 'ok', text: `Este mes gastarás aproximadamente un ${Math.abs(diff)} % ${diff > 0 ? 'más' : 'menos'} que el mes pasado (${Math.round(projectedMonth)} € frente a ${Math.round(prevMonth)} €).` });
  }
  const nextWeek = L.pendingBills(user, t, D.addDays(t, 7));
  if (nextWeek.length >= 2) out.push({ level: 'info', text: `Tienes ${nextWeek.length} pagos la próxima semana por ${sum(nextWeek).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €.` });
  if (month.length && L.of(db.accounts, user.id).length) out.push({ level: 'info', text: `Si mantienes tu ritmo de gasto, terminarás el mes con unos ${Math.round(month[month.length - 1].realistic)} €.` });
  const days = month.length;
  if (p.rate.perDay > 0 && days > 3) out.push({ level: 'ok', text: `Puedes ahorrar aproximadamente ${Math.round(p.rate.perDay * 0.15 * days)} € de aquí a fin de mes si reduces un 15 % tus gastos variables.` });
  return { list: out, projectedMonth, spentMonth, prevMonth };
}

function forecast(user, { horizon = 185 } = {}) {
  const p = project(user, { horizon });
  const conf = confidence(user, p.rate, p.plan);
  const moves = L.movements(user);
  const hasAcc = L.of(db.accounts, user.id).length > 0;
  const history = hasAcc ? [...Array(61)].map((_, i) => { const d = D.ymd(D.addDays(p.t, i - 60)); return { date: d, balance: L.balanceAt(user, d, moves) }; }) : [];
  const min = p.series.reduce((m, x) => (x.realistic < m.realistic ? x : m), p.series[0]);
  const a = alerts(user, p);
  return {
    today: D.ymd(p.t),
    hasAccounts: hasAcc,
    balance: p.money.balance,
    money: p.money,
    variablePerDay: p.rate.perDay,
    historyDays: p.rate.days,
    incomePlan: p.plan,
    confidence: conf,
    checkpoints: checkpoints(p.series, p.t),
    minimum: { date: min.date, balance: min.realistic },
    series: p.series.map(({ events, ...x }) => ({ ...x, hasEvents: events.length > 0 })),
    upcoming: p.events.filter((e) => e.date <= D.ymd(D.addDays(p.t, 31))).sort((x, y) => x.date.localeCompare(y.date)),
    history,
    alerts: a.list,
    projectedMonthSpend: a.projectedMonth,
    spentMonth: a.spentMonth,
    prevMonthSpend: a.prevMonth,
  };
}

// ¿Puedo permitirme esta compra?
function simulate(user, { name, price, date, monthly }) {
  const horizon = 185;
  const base = project(user, { horizon });
  const withP = project(user, { horizon, extra: [{ name, amount: price, date, monthly }] });
  const fin = L.financeOf(user);
  const d = D.parse(date);
  const eom = D.ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const at = (s, ds) => s.find((x) => x.date === ds) || s[s.length - 1];
  const before = at(base.series, D.ymd(D.addDays(d, -1)) < base.series[0].date ? base.series[0].date : D.ymd(D.addDays(d, -1)));
  const minOf = (s) => s.reduce((m, x) => (x.realistic < m.realistic ? x : m), s[0]);
  const minA = minOf(withP.series);
  const minPess = withP.series.reduce((m, x) => (x.pessimistic < m.pessimistic ? x : m), withP.series[0]);
  const general = L.budgetStatus(user, D.monthKey(d)).find((b) => !b.categoryId);
  const risk = minA.realistic < 0 ? 'alto' : minA.realistic < fin.lowBalance || minPess.pessimistic < 0 ? 'medio' : 'bajo';
  const saved = base.money.savedMonth;
  return {
    name, price, date, monthly: !!monthly,
    balanceBefore: before.realistic,
    balanceAfter: round(before.realistic - price),
    endOfMonthBefore: at(base.series, eom).realistic,
    endOfMonthAfter: at(withP.series, eom).realistic,
    minimumAfter: { date: minA.date, balance: minA.realistic },
    minimumPessimistic: { date: minPess.date, balance: minPess.pessimistic },
    budgetRemainingAfter: general ? round(general.remaining - (D.monthKey(d) === general.month ? price : 0)) : null,
    savingsGoal: fin.savingsGoal,
    savingsAffected: fin.savingsGoal ? at(withP.series, eom).realistic < fin.savingsGoal - saved : false,
    risk,
    verdict: risk === 'alto'
      ? 'No es recomendable: según la previsión te quedarías sin dinero en algún momento.'
      : risk === 'medio'
        ? 'Es posible, pero ajustado: tu saldo quedaría por debajo de tu margen de seguridad o en negativo en el escenario pesimista.'
        : 'Puedes permitírtela: tu saldo previsto se mantiene por encima de tu margen de seguridad.',
    hasAccounts: L.of(db.accounts, user.id).length > 0,
  };
}

module.exports = { forecast, simulate, project, variableRate, incomePlan };
