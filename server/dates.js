// Utilidades de fechas en formato local 'YYYY-MM-DD'
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parse(s));
function parse(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}
const today = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const diffDays = (a, b) => Math.round((b - a) / 86400000);
function weekStart(d) {
  const day = (d.getDay() + 6) % 7; // lunes = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
// Fecha de cobro de un gasto mensual en un mes concreto (si el día no existe, último día del mes)
function dueInMonth(day, y, m) {
  const first = new Date(y, m, 1);
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day, daysInMonth(first.getFullYear(), first.getMonth())));
}
// Próximo cobro pendiente de un gasto mensual
function nextDue(rec, from = today()) {
  let d = dueInMonth(rec.dayOfMonth, from.getFullYear(), from.getMonth());
  if (d < from || rec.lastPaidMonth === monthKey(d)) {
    d = dueInMonth(rec.dayOfMonth, from.getFullYear(), from.getMonth() + 1);
  }
  return d;
}
const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const fmtLong = (d) =>
  d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

module.exports = { pad, ymd, monthKey, isYmd, parse, today, addDays, diffDays, weekStart, dueInMonth, nextDue, DAY_NAMES, fmtLong };
