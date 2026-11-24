// Pagos que se repiten: diarios, semanales, quincenales, mensuales, trimestrales, semestrales, anuales o personalizados.
// Calcula las fechas de cada cobro (teniendo en cuenta meses cortos y años bisiestos) y si ya están pagados.
const D = require('./dates');

const FREQS = {
  daily: { days: 1, label: 'Diario' },
  weekly: { days: 7, label: 'Semanal' },
  biweekly: { days: 14, label: 'Quincenal' },
  monthly: { months: 1, label: 'Mensual' },
  quarterly: { months: 3, label: 'Trimestral' },
  semiannual: { months: 6, label: 'Semestral' },
  yearly: { months: 12, label: 'Anual' },
  custom: { label: 'Personalizado' },
};

// Paso de la repetición: { days } o { months }
function stepOf(rec) {
  const f = FREQS[rec.frequency] ? rec.frequency : 'monthly';
  if (f !== 'custom') return FREQS[f];
  const n = Math.max(1, Math.min(365, Number(rec.every) || 1));
  return rec.unit === 'days' ? { days: n } : { months: n };
}

// Primera fecha de cobro. Los gastos antiguos (solo mensuales) no tenían anchorDate.
function anchorOf(rec) {
  if (D.isYmd(rec.anchorDate)) return D.parse(rec.anchorDate);
  const start = D.isYmd(rec.startDate) ? D.parse(rec.startDate) : D.today();
  let d = D.dueInMonth(rec.dayOfMonth || start.getDate(), start.getFullYear(), start.getMonth());
  if (d < start && rec.lastPaidMonth !== D.monthKey(d)) d = D.dueInMonth(rec.dayOfMonth || start.getDate(), start.getFullYear(), start.getMonth() + 1);
  return d;
}

// Fechas de cobro entre from y to (ambas incluidas)
function occurrences(rec, from, to, max = 500) {
  const out = [];
  const A = anchorOf(rec);
  const st = stepOf(rec);
  if (to < A) return out;
  if (st.days) {
    const k0 = Math.max(0, Math.ceil(D.diffDays(A, from) / st.days));
    for (let k = k0; out.length < max; k++) {
      const d = D.addDays(A, k * st.days);
      if (d > to) break;
      if (d >= from) out.push(d);
    }
  } else {
    const day = rec.dayOfMonth || A.getDate();
    const a = A.getFullYear() * 12 + A.getMonth();
    const f = from.getFullYear() * 12 + from.getMonth();
    let k = Math.max(0, Math.floor((f - a) / st.months) - 1);
    for (; out.length < max; k++) {
      const mi = a + k * st.months;
      const d = D.dueInMonth(day, Math.floor(mi / 12), mi % 12);
      if (d > to) break;
      if (d >= from && d >= A) out.push(d);
    }
  }
  return out;
}

const isMonthly = (rec) => !rec.frequency || rec.frequency === 'monthly';
function isPaid(rec, due) {
  const k = D.ymd(due);
  if ((rec.paid || []).includes(k)) return true;
  return isMonthly(rec) && rec.lastPaidMonth === D.monthKey(due);
}
function markPaid(rec, due) {
  rec.paid = [...(rec.paid || []).filter((x) => x !== D.ymd(due)), D.ymd(due)].sort().slice(-40);
  if (isMonthly(rec)) rec.lastPaidMonth = D.monthKey(due);
}

// Estado actual: próximo cobro, si está atrasado y si el último ya se pagó
function status(rec, t = D.today()) {
  if (!rec.active) {
    const next = occurrences(rec, t, D.addDays(t, 800), 1)[0] || null;
    return { state: 'paused', nextDue: next, daysLeft: next ? D.diffDays(t, next) : null, paidThisPeriod: false };
  }
  const past = occurrences(rec, D.addDays(t, -45), D.addDays(t, -1));
  const overdue = rec.autoAdd ? null : [...past].reverse().find((d) => !isPaid(rec, d) && D.ymd(d) >= (rec.startDate || '0000'));
  const upcoming = occurrences(rec, t, D.addDays(t, 800), 6);
  const next = overdue || upcoming.find((d) => !isPaid(rec, d)) || upcoming[0] || null;
  const last = [...past, ...upcoming.filter((d) => D.ymd(d) === D.ymd(t))].pop();
  const paidThisPeriod = !!last && isPaid(rec, last) && !overdue;
  return {
    state: overdue ? 'overdue' : paidThisPeriod ? 'paid' : 'pending',
    nextDue: next,
    daysLeft: next ? D.diffDays(t, next) : null,
    paidThisPeriod,
  };
}

// Importe equivalente al mes (para comparar pagos con distinta frecuencia)
function monthlyAmount(rec) {
  const st = stepOf(rec);
  const f = st.days ? 30.4375 / st.days : 1 / st.months;
  return Math.round(rec.amount * f * 100) / 100;
}
function freqLabel(rec) {
  if (rec.frequency === 'custom') {
    const st = stepOf(rec);
    return st.days ? `Cada ${st.days} días` : `Cada ${st.months} meses`;
  }
  return (FREQS[rec.frequency] || FREQS.monthly).label;
}

module.exports = { FREQS, occurrences, isPaid, markPaid, status, monthlyAmount, freqLabel, anchorOf };
