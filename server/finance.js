// Ingresos (cobros), ahorros (huchas y movimientos) y exportación a Excel
const express = require('express');
const ExcelJS = require('exceljs');
const store = require('./db');
const { db } = store;
const D = require('./dates');
const { HttpError } = require('./auth');
const { round, catInfo } = require('./summary');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();
const mine = (list, req) => list.filter((x) => x.userId === req.user.id);
function findMine(list, req, id = req.params.id) {
  const item = list.find((x) => x.id === id && x.userId === req.user.id);
  if (!item) throw new HttpError(404, 'No encontrado');
  return item;
}
const ICON_RE = /^[a-z0-9-]{1,40}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const money = (v, msg = 'El importe debe ser mayor que 0') => {
  const n = Number(v);
  if (!(n > 0) || n > 1e9) throw new HttpError(400, msg);
  return round(n);
};

// ---------- Ingresos ----------
const SOURCES = {
  nomina: 'Nómina', freelance: 'Trabajo extra', ventas: 'Ventas', inversiones: 'Inversiones',
  alquiler: 'Alquiler', regalos: 'Regalos', devoluciones: 'Devoluciones', otros: 'Otros',
};
function cleanIncome(b) {
  const name = String(b?.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'El ingreso necesita un concepto');
  if (!D.isYmd(b.date)) throw new HttpError(400, 'Fecha no válida');
  return { name, amount: money(b.amount), date: b.date, source: SOURCES[b.source] ? b.source : 'otros', notes: String(b.notes || '').slice(0, 500) };
}
router.get('/incomes', (req, res) => {
  const { from, to, source, q } = req.query;
  let list = mine(db.incomes, req);
  if (from) list = list.filter((e) => e.date >= from);
  if (to) list = list.filter((e) => e.date <= to);
  if (source) list = list.filter((e) => e.source === source);
  if (q) { const s = String(q).toLowerCase(); list = list.filter((e) => `${e.name} ${e.notes}`.toLowerCase().includes(s)); }
  res.json(list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '')));
});
router.post('/incomes', h(async (req, res) => {
  const e = { id: store.id(), userId: req.user.id, ...cleanIncome(req.body), createdAt: new Date().toISOString() };
  db.incomes.push(e);
  store.save();
  res.json(e);
}));
router.put('/incomes/:id', h(async (req, res) => {
  const e = findMine(db.incomes, req);
  Object.assign(e, cleanIncome(req.body));
  store.save();
  res.json(e);
}));
router.delete('/incomes/:id', h(async (req, res) => {
  const e = findMine(db.incomes, req);
  db.incomes.splice(db.incomes.indexOf(e), 1);
  store.save();
  res.json({ ok: true });
}));

// ---------- Ahorros ----------
function savingView(s) {
  const moves = db.savingMoves.filter((m) => m.savingId === s.id);
  const mk = D.monthKey(D.today());
  const balance = round(moves.reduce((a, m) => a + (m.type === 'in' ? m.amount : -m.amount), 0));
  const month = round(moves.filter((m) => m.date.startsWith(mk)).reduce((a, m) => a + (m.type === 'in' ? m.amount : -m.amount), 0));
  return { ...s, balance, month, moves: moves.length };
}
function cleanSaving(b) {
  const name = String(b?.name || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'La hucha necesita un nombre');
  const goal = b.goal === '' || b.goal == null ? null : money(b.goal, 'El objetivo debe ser mayor que 0');
  return { name, goal, icon: ICON_RE.test(b.icon || '') ? b.icon : 'piggy-bank', color: COLOR_RE.test(b.color || '') ? b.color : '#16a34a' };
}
router.get('/savings', (req, res) => res.json(mine(db.savings, req).map(savingView)));
router.post('/savings', h(async (req, res) => {
  const s = { id: store.id(), userId: req.user.id, ...cleanSaving(req.body), createdAt: new Date().toISOString() };
  db.savings.push(s);
  const initial = Number(req.body?.initial);
  if (initial > 0) db.savingMoves.push({ id: store.id(), userId: req.user.id, savingId: s.id, type: 'in', amount: money(initial), date: D.ymd(D.today()), note: 'Saldo inicial', createdAt: new Date().toISOString() });
  store.save();
  res.json(savingView(s));
}));
router.put('/savings/:id', h(async (req, res) => {
  const s = findMine(db.savings, req);
  Object.assign(s, cleanSaving(req.body));
  store.save();
  res.json(savingView(s));
}));
router.delete('/savings/:id', h(async (req, res) => {
  const s = findMine(db.savings, req);
  db.savings.splice(db.savings.indexOf(s), 1);
  db.savingMoves = db.savingMoves.filter((m) => m.savingId !== s.id);
  store.save();
  res.json({ ok: true });
}));
router.get('/saving-moves', (req, res) => {
  let list = mine(db.savingMoves, req);
  if (req.query.savingId) list = list.filter((m) => m.savingId === req.query.savingId);
  res.json(list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '')));
});
router.post('/saving-moves', h(async (req, res) => {
  const s = findMine(db.savings, req, req.body?.savingId);
  const type = req.body?.type === 'out' ? 'out' : 'in';
  const amount = money(req.body?.amount);
  if (!D.isYmd(req.body?.date)) throw new HttpError(400, 'Fecha no válida');
  if (type === 'out' && amount > savingView(s).balance) throw new HttpError(400, 'No puedes retirar más de lo que hay en la hucha');
  const m = { id: store.id(), userId: req.user.id, savingId: s.id, type, amount, date: req.body.date, note: String(req.body?.note || '').slice(0, 200), createdAt: new Date().toISOString() };
  db.savingMoves.push(m);
  store.save();
  res.json({ move: m, saving: savingView(s) });
}));
router.delete('/saving-moves/:id', h(async (req, res) => {
  const m = findMine(db.savingMoves, req);
  db.savingMoves.splice(db.savingMoves.indexOf(m), 1);
  store.save();
  res.json({ ok: true });
}));

// ---------- Exportación a Excel ----------
const EUR = '#,##0.00 "€";[Red]-#,##0.00 "€"';
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0FF' } };
const toDate = (s) => { const d = D.parse(s); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); };
const colLetter = (n) => String.fromCharCode(64 + n);

function sheet(wb, name, columns, rows, { totalCols = [], tabColor } = {}) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }], properties: { tabColor: tabColor ? { argb: tabColor } : undefined } });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16, style: c.money ? { numFmt: EUR } : c.date ? { numFmt: 'dd/mm/yyyy' } : {} }));
  for (const r of rows) ws.addRow(r);
  const head = ws.getRow(1);
  head.height = 24;
  head.eachCell((cell) => {
    cell.fill = HEAD_FILL;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle' };
  });
  if (rows.length) ws.autoFilter = { from: 'A1', to: `${colLetter(columns.length)}1` };
  if (totalCols.length && rows.length) {
    const r = ws.addRow({});
    r.getCell(1).value = 'TOTAL';
    for (const key of totalCols) {
      const idx = columns.findIndex((c) => c.key === key) + 1;
      const L = colLetter(idx);
      r.getCell(idx).value = { formula: `SUBTOTAL(9,${L}2:${L}${rows.length + 1})` };
      r.getCell(idx).numFmt = EUR;
    }
    r.eachCell({ includeEmpty: true }, (cell, i) => { if (i <= columns.length) { cell.fill = TOTAL_FILL; cell.font = { bold: true }; } });
  }
  return ws;
}

router.get('/export.xlsx', h(async (req, res) => {
  const from = D.isYmd(req.query.from) ? req.query.from : '0000-01-01';
  const to = D.isYmd(req.query.to) ? req.query.to : '9999-12-31';
  const inRange = (x) => x.date >= from && x.date <= to;
  const incomes = mine(db.incomes, req).filter(inRange).sort((a, b) => a.date.localeCompare(b.date));
  const expenses = mine(db.expenses, req).filter(inRange).sort((a, b) => a.date.localeCompare(b.date));
  const moves = mine(db.savingMoves, req).filter(inRange).sort((a, b) => a.date.localeCompare(b.date));
  const savings = mine(db.savings, req).map(savingView);
  const savingName = (id) => savings.find((s) => s.id === id)?.name || '—';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Agenda de Gastos';
  wb.created = new Date();

  // Resumen mensual con fórmulas
  const months = [...new Set([...incomes, ...expenses, ...moves].map((x) => x.date.slice(0, 7)))].sort();
  const monthRows = months.map((m) => {
    const inc = round(incomes.filter((x) => x.date.startsWith(m)).reduce((a, x) => a + x.amount, 0));
    const exp = round(expenses.filter((x) => x.date.startsWith(m)).reduce((a, x) => a + x.amount, 0));
    const sav = round(moves.filter((x) => x.date.startsWith(m)).reduce((a, x) => a + (x.type === 'in' ? x.amount : -x.amount), 0));
    const label = D.parse(m + '-01').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    return { mes: label.charAt(0).toUpperCase() + label.slice(1), ingresos: inc, gastos: exp, ahorro: sav };
  });
  const ws = sheet(wb, 'Resumen', [
    { header: 'Mes', key: 'mes', width: 22 },
    { header: 'Ingresos', key: 'ingresos', money: true },
    { header: 'Gastos', key: 'gastos', money: true },
    { header: 'Balance', key: 'balance', money: true },
    { header: 'Ahorro aportado', key: 'ahorro', money: true, width: 18 },
  ], monthRows, { totalCols: ['ingresos', 'gastos', 'balance', 'ahorro'], tabColor: 'FF4F46E5' });
  monthRows.forEach((_, i) => { ws.getCell(`D${i + 2}`).value = { formula: `B${i + 2}-C${i + 2}` }; });

  sheet(wb, 'Ingresos', [
    { header: 'Fecha', key: 'date', date: true, width: 13 },
    { header: 'Concepto', key: 'name', width: 30 },
    { header: 'Origen', key: 'source', width: 18 },
    { header: 'Importe', key: 'amount', money: true },
    { header: 'Notas', key: 'notes', width: 36 },
  ], incomes.map((x) => ({ date: toDate(x.date), name: x.name, source: SOURCES[x.source] || 'Otros', amount: x.amount, notes: x.notes })), { totalCols: ['amount'], tabColor: 'FF16A34A' });

  sheet(wb, 'Gastos', [
    { header: 'Fecha', key: 'date', date: true, width: 13 },
    { header: 'Concepto', key: 'name', width: 30 },
    { header: 'Categoría', key: 'cat', width: 18 },
    { header: 'Lugar', key: 'place', width: 22 },
    { header: 'Importe', key: 'amount', money: true },
    { header: 'Notas', key: 'notes', width: 36 },
  ], expenses.map((x) => ({ date: toDate(x.date), name: x.name, cat: catInfo(req.user.id, x.categoryId).name, place: x.place, amount: x.amount, notes: x.notes })), { totalCols: ['amount'], tabColor: 'FFDC2626' });

  sheet(wb, 'Movimientos de ahorro', [
    { header: 'Fecha', key: 'date', date: true, width: 13 },
    { header: 'Hucha', key: 'saving', width: 24 },
    { header: 'Tipo', key: 'type', width: 14 },
    { header: 'Importe', key: 'amount', money: true },
    { header: 'Nota', key: 'note', width: 36 },
  ], moves.map((m) => ({ date: toDate(m.date), saving: savingName(m.savingId), type: m.type === 'in' ? 'Aportación' : 'Retirada', amount: m.type === 'in' ? m.amount : -m.amount, note: m.note })), { totalCols: ['amount'], tabColor: 'FF0891B2' });

  const hs = sheet(wb, 'Huchas', [
    { header: 'Hucha', key: 'name', width: 26 },
    { header: 'Saldo actual', key: 'balance', money: true },
    { header: 'Objetivo', key: 'goal', money: true },
    { header: '% del objetivo', key: 'pct', width: 16 },
  ], savings.map((s) => ({ name: s.name, balance: s.balance, goal: s.goal ?? null, pct: null })), { totalCols: ['balance'], tabColor: 'FFCA8A04' });
  savings.forEach((s, i) => {
    if (s.goal) { const c = hs.getCell(`D${i + 2}`); c.value = { formula: `IF(C${i + 2}>0,B${i + 2}/C${i + 2},"")` }; c.numFmt = '0%'; }
  });

  const name = `agenda-gastos-${D.ymd(D.today())}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}));

module.exports = { router, SOURCES };
