// Análisis financiero: estadísticas, consejos, anomalías, sugerencias de presupuesto, informes y avisos.
// Todo se calcula con reglas sobre los datos reales del usuario (sin inventar cifras).
const store = require('./db');
const { db } = store;
const D = require('./dates');
const L = require('./ledger');
const R = require('./recurrence');
const { catInfo } = require('./summary');

const { round, sum, of } = L;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const monthsBack = (t, n) => [...Array(n)].map((_, k) => D.monthKey(new Date(t.getFullYear(), t.getMonth() - n + k, 1))); // sin el mes actual
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const fmt = (n) => `${Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const monthLabel = (mk) => { const s = D.parse(mk + '-01').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1); };

// ---------- Estadísticas ----------
function byCategory(user, list) {
  const m = new Map();
  for (const e of list) {
    const c = catInfo(user.id, e.categoryId);
    const k = c.id || 'none';
    const cur = m.get(k) || { id: c.id, name: c.name, color: c.color, icon: c.icon, total: 0, count: 0 };
    cur.total = round(cur.total + e.amount);
    cur.count++;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}
function monthSeries(user, n = 12, t = D.today()) {
  const exps = of(db.expenses, user.id);
  const incs = of(db.incomes, user.id);
  return [...monthsBack(t, n - 1), D.monthKey(t)].map((mk) => {
    const e = sum(exps.filter((x) => x.date.startsWith(mk)));
    const i = sum(incs.filter((x) => x.date.startsWith(mk)));
    return { month: mk, label: monthLabel(mk), expenses: e, incomes: i, balance: round(i - e), savingsRate: i > 0 ? Math.round(((i - e) / i) * 100) : null };
  });
}
// Comparación de cada categoría: este mes, mes pasado y medias de 3, 6 y 12 meses
function categoryComparison(user, t = D.today()) {
  const exps = of(db.expenses, user.id);
  const mk = D.monthKey(t);
  const prev = monthsBack(t, 1)[0];
  const cats = byCategory(user, exps.filter((e) => e.date >= D.ymd(new Date(t.getFullYear(), t.getMonth() - 12, 1))));
  const dim = D.daysInMonth(t.getFullYear(), t.getMonth());
  // Las medias solo cuentan meses completos en los que ya usabas la app (el primer mes suele estar a medias)
  const first = exps.reduce((m, e) => (e.date < m ? e.date : m), '9999');
  const usable = (m) => first.slice(0, 7) < m;
  return cats.map((c) => {
    const mine = exps.filter((e) => (e.categoryId || null) === c.id);
    const mt = (m) => sum(mine.filter((e) => e.date.startsWith(m)));
    const avg = (n) => { const ms = monthsBack(t, n).filter(usable); return ms.length ? round(ms.reduce((a, m) => a + mt(m), 0) / ms.length) : 0; };
    const current = mt(mk);
    const fixed = sum(mine.filter((e) => e.date.startsWith(mk) && e.recurringId));
    const projected = t.getDate() >= 7 ? round(fixed + ((current - fixed) / t.getDate()) * dim) : null;
    return { ...c, current, projected, previous: mt(prev), avg3: avg(3), avg6: avg(6), avg12: avg(12) };
  });
}
function merchants(user, list) {
  const m = new Map();
  for (const e of list) {
    const k = (e.place || '').trim();
    if (!k) continue;
    const cur = m.get(norm(k)) || { name: k, total: 0, count: 0 };
    cur.total = round(cur.total + e.amount);
    cur.count++;
    m.set(norm(k), cur);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}
function subscriptions(user) {
  return of(db.recurring, user.id).filter((r) => r.active).map((r) => ({
    id: r.id, name: r.name, amount: r.amount, monthly: R.monthlyAmount(r), frequency: R.freqLabel(r), category: catInfo(user.id, r.categoryId),
    isSubscription: /suscrip|stream|netflix|spotify|hbo|disney|prime|gimnas|gym|icloud|google one|youtube/i.test(`${catInfo(user.id, r.categoryId).name} ${r.name}`),
  })).sort((a, b) => b.monthly - a.monthly);
}

// ---------- Anomalías ----------
function anomalies(user, { includeDismissed = false } = {}) {
  const t = D.today();
  const dismissed = new Set(user.dismissedAnomalies || []);
  const exps = of(db.expenses, user.id);
  const recent = exps.filter((e) => e.date >= D.ymd(D.addDays(t, -60)));
  const out = [];
  // Posibles duplicados: mismo importe, mismo día y mismo concepto o lugar
  const seen = new Map();
  for (const e of [...recent].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))) {
    const keys = [`${e.date}|${e.amount}|${norm(e.name)}`, e.place ? `${e.date}|${e.amount}|p:${norm(e.place)}` : null].filter(Boolean);
    const prev = keys.map((k) => seen.get(k)).find(Boolean);
    if (prev && !(prev.recurringId && e.recurringId)) out.push({ key: `dup:${prev.id}:${e.id}`, type: 'duplicate', level: 'warn', title: 'Posible gasto duplicado', text: `«${e.name}» de ${fmt(e.amount)} aparece dos veces el ${D.parse(e.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}.`, expenseIds: [prev.id, e.id] });
    for (const k of keys) if (!seen.has(k)) seen.set(k, e);
  }
  // Gastos muy por encima de lo habitual en su categoría
  const hist = exps.filter((e) => e.date >= D.ymd(D.addDays(t, -365)));
  for (const e of recent) {
    const same = hist.filter((x) => (x.categoryId || null) === (e.categoryId || null) && x.id !== e.id && !x.recurringId);
    if (same.length < 5 || e.recurringId) continue;
    const med = median(same.map((x) => x.amount));
    if (e.amount >= Math.max(30, med * 3)) out.push({ key: `high:${e.id}`, type: 'high', level: e.amount >= med * 8 ? 'danger' : 'warn', title: 'Gasto superior a lo habitual', text: `«${e.name}» (${fmt(e.amount)}) es ${Math.round(e.amount / med)} veces tu gasto normal en ${catInfo(user.id, e.categoryId).name} (${fmt(med)}).`, expenseIds: [e.id] });
  }
  // Fechas futuras: posible error al apuntar
  for (const e of exps.filter((e) => e.date > D.ymd(D.addDays(t, 1)))) out.push({ key: `future:${e.id}`, type: 'future', level: 'info', title: 'Gasto con fecha futura', text: `«${e.name}» está apuntado el ${D.parse(e.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}. ¿Es correcto?`, expenseIds: [e.id] });
  // Subidas fuertes de una categoría este mes
  if (t.getDate() >= 10) for (const c of categoryComparison(user, t)) {
    if (c.projected && c.avg3 > 0 && c.projected > c.avg3 * 1.5 && c.projected - c.avg3 > 50) out.push({ key: `spike:${c.id || 'none'}:${D.monthKey(t)}`, type: 'spike', level: 'warn', title: `Subida en ${c.name}`, text: `A este ritmo gastarás ${fmt(c.projected)} en ${c.name} este mes, frente a una media de ${fmt(c.avg3)}.`, expenseIds: [] });
  }
  return out.filter((a) => includeDismissed || !dismissed.has(a.key)).map((a) => ({ ...a, expenses: a.expenseIds.map((id) => exps.find((e) => e.id === id)).filter(Boolean) }));
}

// ---------- Consejos ----------
function recommendations(user) {
  const t = D.today();
  const out = [];
  const exps = of(db.expenses, user.id);
  const last3 = monthsBack(t, 3);
  const months3 = exps.filter((e) => last3.some((m) => e.date.startsWith(m)));
  const firstM = exps.reduce((m, e) => (e.date < m ? e.date : m), '9999').slice(0, 7);
  const monthsWithData = last3.filter((m) => m > firstM).length || 1;
  const avgTotal = round(sum(months3.filter((e) => e.date.slice(0, 7) > firstM)) / monthsWithData);
  const comp = categoryComparison(user, t);

  for (const c of comp) {
    if (c.projected && c.avg3 > 0 && c.projected >= c.avg3 * 1.25 && c.projected - c.avg3 >= 20) {
      const diff = round(c.projected - c.avg3);
      out.push({ id: `up:${c.id}`, title: `Tu gasto en ${c.name} está subiendo`, text: `Al ritmo actual este mes gastarás un ${Math.round((c.projected / c.avg3 - 1) * 100)} % más de lo normal en ${c.name}. Volver a tu media te ahorraría la diferencia.`, evidence: [`Este mes llevas ${fmt(c.current)} (previsión ${fmt(c.projected)})`, `Media de los últimos 3 meses: ${fmt(c.avg3)}`], potential: diff, priority: diff > 100 ? 'alta' : 'media', action: { label: 'Poner un presupuesto', href: '#/presupuestos' } });
    }
  }
  const leisure = comp.filter((c) => /comida|restaur|ocio|bar|caf|cena|copas|delivery|glovo/i.test(c.name));
  const leisureAvg = round(leisure.reduce((a, c) => a + c.avg3, 0));
  if (avgTotal > 0 && leisureAvg / avgTotal > 0.2) {
    out.push({ id: 'leisure', title: 'Reduce comidas fuera y ocio', text: `Comer fuera y el ocio suponen el ${Math.round((leisureAvg / avgTotal) * 100)} % de tu gasto. Bajarlo un 20 % es uno de los ahorros más fáciles.`, evidence: [`${leisure.map((c) => c.name).join(', ')}: ${fmt(leisureAvg)} al mes de media`, `Gasto medio total: ${fmt(avgTotal)} al mes`], potential: round(leisureAvg * 0.2), priority: leisureAvg / avgTotal > 0.3 ? 'alta' : 'media', action: { label: 'Ver categorías', href: '#/informes' } });
  }
  const subs = subscriptions(user).filter((s) => s.isSubscription);
  if (subs.length >= 2) {
    const total = round(subs.reduce((a, s) => a + s.monthly, 0));
    out.push({ id: 'subs', title: 'Revisa tus suscripciones', text: `Pagas ${subs.length} suscripciones. Cancelar la que menos uses es un ahorro inmediato y sin esfuerzo.`, evidence: [`${subs.map((s) => `${s.name} (${fmt(s.monthly)}/mes)`).join(', ')}`, `Total: ${fmt(total)} al mes`], potential: round(total / subs.length), priority: total > 40 ? 'media' : 'baja', action: { label: 'Ver pagos fijos', href: '#/mensuales' } });
  }
  const small = exps.filter((e) => e.date >= D.ymd(D.addDays(t, -30)) && e.amount < 10 && !e.recurringId);
  if (small.length >= 10) {
    const s = sum(small);
    out.push({ id: 'small', title: 'Cuidado con las compras pequeñas', text: 'Muchas compras de menos de 10 € pasan desapercibidas pero suman. Planificarlas evita compras impulsivas.', evidence: [`${small.length} compras de menos de 10 € en los últimos 30 días`, `Suman ${fmt(s)}`], potential: round(s * 0.3), priority: s > 100 ? 'media' : 'baja', action: { label: 'Ver gastos', href: '#/gastos' } });
  }
  const incs = of(db.incomes, user.id).filter((i) => last3.some((m) => i.date.startsWith(m)));
  const avgInc = round(sum(incs.filter((i) => i.date.slice(0, 7) > firstM)) / monthsWithData);
  if (avgInc > 0) {
    const rate = (avgInc - avgTotal) / avgInc;
    if (rate < 0.1) out.push({ id: 'rate', title: 'Aumenta tu capacidad de ahorro', text: rate < 0 ? 'En los últimos meses has gastado más de lo que has ingresado. Revisa tus gastos fijos y pon un presupuesto general.' : `Estás ahorrando el ${Math.round(rate * 100)} % de lo que ingresas. Lo recomendable es al menos un 10-20 %.`, evidence: [`Ingresos medios: ${fmt(avgInc)} al mes`, `Gastos medios: ${fmt(avgTotal)} al mes`], potential: round(avgInc * 0.1 - (avgInc - avgTotal)), priority: rate < 0 ? 'alta' : 'media', action: { label: 'Crear presupuesto', href: '#/presupuestos' } });
  }
  const fin = L.financeOf(user);
  if (!fin.savingsGoal && !of(db.savings, user.id).length) {
    out.push({ id: 'goal', title: 'Ponte un objetivo de ahorro', text: 'Tener una meta concreta (un viaje, un colchón para imprevistos…) hace mucho más fácil ahorrar cada mes.', evidence: ['Todavía no tienes huchas ni objetivo mensual de ahorro'], potential: null, priority: 'baja', action: { label: 'Crear hucha', href: '#/ahorros' } });
  }
  const prevMonth = monthsBack(t, 1)[0];
  const over = L.budgetStatus(user, prevMonth).filter((b) => b.percent >= 100);
  if (over.length) out.push({ id: 'over', title: 'Ajusta tus presupuestos', text: 'El mes pasado superaste algunos presupuestos. Ajústalos a la realidad o recorta en esas categorías.', evidence: over.map((b) => `${b.categoryId ? catInfo(user.id, b.categoryId).name : 'Presupuesto general'}: ${fmt(b.spent)} de ${fmt(b.amount)}`), potential: round(over.reduce((a, b) => a + (b.spent - b.amount), 0)), priority: 'media', action: { label: 'Ver presupuestos', href: '#/presupuestos' } });
  if (!of(db.budgets, user.id).length && exps.length >= 15) out.push({ id: 'budgets', title: 'Crea tus primeros presupuestos', text: 'Con tus datos ya podemos proponerte límites razonables para cada categoría.', evidence: [`Tienes ${exps.length} gastos apuntados`], potential: null, priority: 'media', action: { label: 'Ver propuestas', href: '#/presupuestos' } });
  const dups = anomalies(user).filter((a) => a.type === 'duplicate');
  if (dups.length) out.push({ id: 'dups', title: 'Revisa posibles duplicados', text: 'Hay gastos que parecen apuntados dos veces. Si lo son, tus cifras están infladas.', evidence: dups.slice(0, 3).map((a) => a.text), potential: null, priority: 'alta', action: { label: 'Revisar', href: '#/asistente' } });
  const P = { alta: 0, media: 1, baja: 2 };
  return out.sort((a, b) => P[a.priority] - P[b.priority] || (b.potential || 0) - (a.potential || 0));
}

// ---------- Sugerencias de presupuesto ----------
function budgetSuggestions(user) {
  const t = D.today();
  const last = monthsBack(t, 6);
  const exps = of(db.expenses, user.id);
  const firstM = exps.reduce((m, e) => (e.date < m ? e.date : m), '9999').slice(0, 7);
  let months = last.filter((m) => m > firstM).slice(-3);
  if (!months.length) months = last.filter((m) => exps.some((e) => e.date.startsWith(m))).slice(-1);
  if (!months.length) return [];
  const have = new Set(of(db.budgets, user.id).map((b) => b.categoryId || 'general'));
  const up = (n, step) => Math.max(step, Math.ceil((n * 1.05) / step) * step);
  const list = [];
  const avgTotal = sum(exps.filter((e) => months.some((m) => e.date.startsWith(m)))) / months.length;
  if (!have.has('general') && avgTotal > 0) list.push({ categoryId: null, name: 'Presupuesto general', average: round(avgTotal), suggested: up(avgTotal, 50), months: months.length });
  for (const c of byCategory(user, exps.filter((e) => months.some((m) => e.date.startsWith(m))))) {
    if (!c.id || have.has(c.id)) continue;
    const avg = c.total / months.length;
    if (avg < 10) continue;
    list.push({ categoryId: c.id, name: c.name, icon: c.icon, color: c.color, average: round(avg), suggested: up(avg, 10), months: months.length });
  }
  return list;
}

// ---------- Informes ----------
function periodReport(user, from, to) {
  const exps = of(db.expenses, user.id).filter((e) => e.date >= from && e.date <= to);
  const incs = of(db.incomes, user.id).filter((e) => e.date >= from && e.date <= to);
  const moves = of(db.savingMoves, user.id).filter((e) => e.date >= from && e.date <= to);
  const te = sum(exps);
  const ti = sum(incs);
  const len = D.diffDays(D.parse(from), D.parse(to)) + 1;
  const pFrom = D.ymd(D.addDays(D.parse(from), -len));
  const pTo = D.ymd(D.addDays(D.parse(from), -1));
  const pExp = sum(of(db.expenses, user.id).filter((e) => e.date >= pFrom && e.date <= pTo));
  const pInc = sum(of(db.incomes, user.id).filter((e) => e.date >= pFrom && e.date <= pTo));
  const yFrom = `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`;
  const yTo = `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
  const yExp = sum(of(db.expenses, user.id).filter((e) => e.date >= yFrom && e.date <= yTo));
  const months = [...new Set([...exps, ...incs].map((x) => x.date.slice(0, 7)))].sort();
  return {
    from, to,
    expenses: te,
    incomes: ti,
    balance: round(ti - te),
    savingsRate: ti > 0 ? Math.round(((ti - te) / ti) * 100) : null,
    saved: sum(moves, (m) => (m.type === 'in' ? m.amount : -m.amount)),
    count: exps.length,
    previous: { from: pFrom, to: pTo, expenses: pExp, incomes: pInc },
    lastYear: { from: yFrom, to: yTo, expenses: yExp },
    byCategory: byCategory(user, exps),
    byMerchant: merchants(user, exps).slice(0, 10),
    byMonth: months.map((m) => ({ month: m, label: monthLabel(m), expenses: sum(exps.filter((e) => e.date.startsWith(m))), incomes: sum(incs.filter((e) => e.date.startsWith(m))) })),
    top: [...exps].sort((a, b) => b.amount - a.amount).slice(0, 5).map((e) => ({ ...e, category: catInfo(user.id, e.categoryId) })),
    recurring: subscriptions(user),
    recurringTotal: round(subscriptions(user).reduce((a, s) => a + s.monthly, 0)),
  };
}
function monthlyReport(user, month) {
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = D.ymd(new Date(y, m, 0));
  const r = periodReport(user, from, to);
  const t = D.today();
  // Comparación con el mes anterior: completo, o hasta el mismo día si este mes aún no ha terminado
  const isCurrent = month === D.monthKey(t);
  const pFrom = D.ymd(new Date(y, m - 2, 1));
  const pTo = D.ymd(new Date(y, m - 2, isCurrent ? Math.min(t.getDate(), D.daysInMonth(y, m - 2)) : D.daysInMonth(y, m - 2)));
  const inP = (x) => x.date >= pFrom && x.date <= pTo;
  r.previous = { from: pFrom, to: pTo, expenses: sum(of(db.expenses, user.id).filter(inP)), incomes: sum(of(db.incomes, user.id).filter(inP)) };
  const budgets = L.budgetStatus(user, month);
  const prevMonths = [...Array(6)].map((_, k) => D.monthKey(new Date(y, m - 1 - 6 + k, 1)));
  const exps = of(db.expenses, user.id);
  const incs = of(db.incomes, user.id);
  return {
    ...r,
    month,
    label: monthLabel(month),
    complete: to < D.ymd(t),
    budgets: budgets.map((b) => ({ ...b, name: b.categoryId ? catInfo(user.id, b.categoryId).name : 'Presupuesto general' })),
    budgetsMet: budgets.filter((b) => b.percent < 100).length,
    budgetsOver: budgets.filter((b) => b.percent >= 100).length,
    history: [...prevMonths, month].map((mk) => ({ month: mk, label: monthLabel(mk), expenses: sum(exps.filter((e) => e.date.startsWith(mk))), incomes: sum(incs.filter((e) => e.date.startsWith(mk))) })),
    categoryChanges: categoryComparisonFor(user, month),
    recommendations: recommendations(user).slice(0, 4),
  };
}
function categoryComparisonFor(user, month) {
  const [y, m] = month.split('-').map(Number);
  const prev = D.monthKey(new Date(y, m - 2, 1));
  const exps = of(db.expenses, user.id);
  const cur = byCategory(user, exps.filter((e) => e.date.startsWith(month)));
  const pre = byCategory(user, exps.filter((e) => e.date.startsWith(prev)));
  const ids = new Set([...cur, ...pre].map((c) => c.id || 'none'));
  return [...ids].map((k) => {
    const a = cur.find((c) => (c.id || 'none') === k);
    const b = pre.find((c) => (c.id || 'none') === k);
    const base = a || b;
    return { id: base.id, name: base.name, color: base.color, icon: base.icon, current: a?.total || 0, previous: b?.total || 0, change: b?.total ? Math.round(((a?.total || 0) / b.total - 1) * 100) : null };
  }).sort((x, z) => z.current - x.current);
}

// ---------- Avisos dentro de la app ----------
const NOTIFY_DEFAULTS = { bills: true, budgets: true, anomalies: true, forecast: true, weekly: true, monthly: true, goals: true };
const prefsOf = (user) => ({ ...NOTIFY_DEFAULTS, ...(user.notifyApp || {}) });
function push(user, n) {
  if (db.notifications.some((x) => x.userId === user.id && x.key === n.key)) return false;
  db.notifications.push({ id: store.id(), userId: user.id, read: false, createdAt: new Date().toISOString(), level: 'info', ...n });
  const mine = db.notifications.filter((x) => x.userId === user.id);
  if (mine.length > 80) {
    const drop = new Set(mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, mine.length - 80).map((x) => x.id));
    db.notifications = db.notifications.filter((x) => !drop.has(x.id));
  }
  return true;
}
function refreshNotifications(user) {
  const t = D.today();
  const p = prefsOf(user);
  let changed = false;
  const add = (n) => { if (push(user, n)) changed = true; };
  const mk = D.monthKey(t);
  if (p.bills) for (const r of of(db.recurring, user.id).filter((r) => r.active)) {
    const st = R.status(r, t);
    if (!st.nextDue) continue;
    const due = D.ymd(st.nextDue);
    if (st.state === 'overdue') add({ key: `overdue:${r.id}:${due}`, type: 'bill', level: 'danger', title: `${r.name}: pago atrasado`, body: `Vencía el ${st.nextDue.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })} (${fmt(r.amount)}). Márcalo como pagado si ya lo has hecho.`, link: '#/mensuales' });
    else if (st.daysLeft <= (r.remindDaysBefore ?? 3) && !r.autoAdd) add({ key: `bill:${r.id}:${due}`, type: 'bill', level: 'warn', title: `${r.name}: ${st.daysLeft === 0 ? 'se paga hoy' : st.daysLeft === 1 ? 'se paga mañana' : `se paga en ${st.daysLeft} días`}`, body: `${fmt(r.amount)} el ${st.nextDue.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}.`, link: '#/mensuales' });
  }
  if (p.budgets) {
    const th = L.financeOf(user).thresholds;
    for (const b of L.budgetStatus(user, mk)) {
      const name = b.categoryId ? catInfo(user.id, b.categoryId).name : 'general';
      const level = b.percent >= 100 ? 100 : b.percent >= th[2] ? th[2] : b.percent >= th[1] ? th[1] : null;
      if (level) add({ key: `budget:${b.id}:${mk}:${level}`, type: 'budget', level: level === 100 ? 'danger' : 'warn', title: level === 100 ? `Presupuesto ${b.categoryId ? 'de ' + name : 'general'} superado` : `Has usado el ${b.percent} % del presupuesto ${b.categoryId ? 'de ' + name : 'general'}`, body: level === 100 ? `Llevas ${fmt(b.spent)} de ${fmt(b.amount)} (${fmt(-b.remaining)} por encima).` : `Te quedan ${fmt(b.remaining)} para lo que resta de mes.`, link: '#/presupuestos' });
      if (!b.categoryId && b.pace && b.pace > 1.15 && t.getDate() >= 7 && b.percent < 100) add({ key: `pace:${mk}`, type: 'budget', level: 'warn', title: 'Vas demasiado rápido este mes', body: `A este ritmo gastarás unos ${fmt(b.projected)} y tu presupuesto es de ${fmt(b.amount)}.`, link: '#/presupuestos' });
    }
  }
  if (p.anomalies) for (const a of anomalies(user)) add({ key: `anom:${a.key}`, type: 'anomaly', level: a.level, title: a.title, body: a.text, link: '#/asistente?tab=alertas' });
  if (p.forecast && of(db.accounts, user.id).length) {
    try {
      const fc = require('./forecast').forecast(user, { horizon: 40 });
      const low = fc.series.find((x) => x.realistic < L.financeOf(user).lowBalance);
      if (low) add({ key: `low:${mk}`, type: 'forecast', level: low.realistic < 0 ? 'danger' : 'warn', title: 'Previsión de saldo bajo', body: `Tu saldo podría bajar a ${fmt(low.realistic)} el ${D.parse(low.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}.`, link: '#/previsiones' });
    } catch (e) { console.error('[avisos] previsión', e.message); }
  }
  if (p.weekly && t.getDay() === 1 && of(db.expenses, user.id).length) add({ key: `weekly:${D.ymd(t)}`, type: 'weekly', title: 'Tu resumen semanal está listo', body: 'Mira cuánto gastaste e ingresaste la semana pasada.', link: '#/semanal' });
  const prevMk = monthsBack(t, 1)[0];
  if (p.monthly && t.getDate() <= 5 && of(db.expenses, user.id).some((e) => e.date.startsWith(prevMk))) add({ key: `monthly:${prevMk}`, type: 'monthly', title: `Informe de ${monthLabel(prevMk).toLowerCase()}`, body: 'Ya puedes consultar tu informe mensual con la evolución, los presupuestos y consejos.', link: `#/informes?mes=${prevMk}` });
  if (p.goals) for (const s of of(db.savings, user.id).filter((s) => s.goal)) {
    const bal = sum(db.savingMoves.filter((m) => m.savingId === s.id), (m) => (m.type === 'in' ? m.amount : -m.amount));
    if (bal >= s.goal) add({ key: `goal:${s.id}:${s.goal}`, type: 'goal', level: 'ok', title: `¡Objetivo conseguido: ${s.name}!`, body: `Ya tienes ${fmt(bal)} de ${fmt(s.goal)}.`, link: '#/ahorros' });
  }
  if (changed) store.save();
  return changed;
}

module.exports = {
  byCategory, monthSeries, categoryComparison, merchants, subscriptions, anomalies, recommendations, budgetSuggestions,
  periodReport, monthlyReport, refreshNotifications, prefsOf, NOTIFY_DEFAULTS, norm, monthLabel, fmt,
};
