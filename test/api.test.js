// Pruebas de la API completa: se arranca el servidor con una base de datos temporal.
// Ejecutar: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-test-'));
process.env.DATA_DIR = DIR;
process.env.APP_SECRET = 'clave-de-pruebas';
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.BREVO_API_KEY;
delete process.env.SMTP_HOST;

const D = require('../server/dates');
const R = require('../server/recurrence');
let server, base;

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, raw = false } = {}) => {
    const r = await fetch(base + '/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agenda', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc && /sid=[^;]+/.test(sc)) cookie = /sid=[^;]*/.exec(sc)[0];
    if (raw) return r;
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
    if (!r.ok) { const e = new Error(data?.error || r.status); e.status = r.status; throw e; }
    return data;
  };
}
const today = D.ymd(D.today());
const daysAgo = (n) => D.ymd(D.addDays(D.today(), -n));
let A, B;

before(async () => {
  const { start } = require('../server/index');
  server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
  A = client();
  B = client();
  await A('/auth/register', { method: 'POST', body: { name: 'Ana', email: 'ana@prueba.test', password: 'Clave-segura-91' } });
  await B('/auth/register', { method: 'POST', body: { name: 'Beto', email: 'beto@prueba.test', password: 'Otra-clave-segura-72' } });
});
after(() => { server?.close(); setTimeout(() => process.exit(0), 50); });

test('repeticiones: meses cortos, bisiestos, semanal y anual', () => {
  const m31 = { frequency: 'monthly', anchorDate: '2024-01-31', dayOfMonth: 31 };
  const ds = R.occurrences(m31, D.parse('2024-01-01'), D.parse('2024-04-30')).map(D.ymd);
  assert.deepEqual(ds, ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
  const y = { frequency: 'yearly', anchorDate: '2024-02-29', dayOfMonth: 29 };
  assert.deepEqual(R.occurrences(y, D.parse('2024-01-01'), D.parse('2026-12-31')).map(D.ymd), ['2024-02-29', '2025-02-28', '2026-02-28']);
  const w = { frequency: 'weekly', anchorDate: '2025-01-06' };
  assert.equal(R.occurrences(w, D.parse('2025-01-01'), D.parse('2025-01-31')).length, 4);
  const q = { frequency: 'quarterly', anchorDate: '2025-01-15', dayOfMonth: 15 };
  assert.deepEqual(R.occurrences(q, D.parse('2025-01-01'), D.parse('2025-12-31')).map(D.ymd), ['2025-01-15', '2025-04-15', '2025-07-15', '2025-10-15']);
  const c = { frequency: 'custom', every: 10, unit: 'days', anchorDate: '2025-01-01' };
  assert.equal(R.occurrences(c, D.parse('2025-01-01'), D.parse('2025-01-31')).length, 4);
  assert.equal(R.monthlyAmount({ amount: 120, frequency: 'yearly' }), 10);
});

test('cuentas, movimientos, transferencias y saldo', async () => {
  const acc = await A('/accounts', { method: 'POST', body: { name: 'Banco', type: 'corriente', initialBalance: 1000 } });
  const cash = await A('/accounts', { method: 'POST', body: { name: 'Cartera', type: 'efectivo', initialBalance: 50 } });
  assert.equal(acc.balance, 1000);
  await A('/expenses', { method: 'POST', body: { name: 'Super', amount: 40.5, date: today, accountId: acc.id, paymentMethod: 'tarjeta', tags: 'casa, semanal' } });
  await A('/incomes', { method: 'POST', body: { name: 'Nómina', amount: 1500, date: today, source: 'nomina', accountId: acc.id } });
  await A('/transfers', { method: 'POST', body: { fromId: acc.id, toId: cash.id, amount: 100, date: today } });
  const accs = await A('/accounts');
  assert.equal(accs.find((a) => a.id === acc.id).balance, 1000 - 40.5 + 1500 - 100);
  assert.equal(accs.find((a) => a.id === cash.id).balance, 150);
  // las transferencias no cuentan como ingreso ni gasto
  const ov = await A('/overview');
  assert.equal(ov.monthExpenses, 40.5);
  assert.equal(ov.monthIncomes, 1500);
  assert.equal(ov.money.balance, 2509.5);
  // ajuste de saldo
  await A('/transfers', { method: 'POST', body: { type: 'adjust', accountId: cash.id, newBalance: 140, date: today } });
  assert.equal((await A('/accounts')).find((a) => a.id === cash.id).balance, 140);
  const exps = await A('/expenses?tag=semanal');
  assert.equal(exps.length, 1);
  assert.deepEqual(exps[0].tags, ['casa', 'semanal']);
  const dup = await A(`/expenses/${exps[0].id}/duplicate`, { method: 'POST', body: {} });
  assert.equal(dup.amount, 40.5);
  await A('/expenses/' + dup.id, { method: 'DELETE' });
});

test('aislamiento entre usuarios', async () => {
  const accA = (await A('/accounts'))[0];
  await assert.rejects(B(`/accounts/${accA.id}`, { method: 'PUT', body: { name: 'hack' } }), { status: 404 });
  await assert.rejects(B(`/accounts/${accA.id}/movements`), { status: 404 });
  await assert.rejects(B('/expenses', { method: 'POST', body: { name: 'x', amount: 1, date: today, accountId: accA.id } }), { status: 400 });
  assert.equal((await B('/accounts')).length, 0);
  assert.equal((await B('/expenses')).length, 0);
  const r = await fetch(base + '/api/overview');
  assert.equal(r.status, 401);
});

test('pagos fijos: atrasado, pagar sin duplicar y semanal', async () => {
  const anchor = daysAgo(3);
  const rec = await A('/recurring', { method: 'POST', body: { name: 'Luz', amount: 60, frequency: 'monthly', anchorDate: anchor, remindDaysBefore: 3, autoAdd: false } });
  // creado hoy: el cobro de hace 3 días es anterior al alta, así que no cuenta como atrasado
  assert.notEqual(rec.state, 'overdue');
  const w = await A('/recurring', { method: 'POST', body: { name: 'Clases', amount: 20, frequency: 'weekly', anchorDate: D.ymd(D.addDays(D.today(), 2)), autoAdd: false } });
  assert.equal(w.daysLeft, 2);
  const paid = await A(`/recurring/${w.id}/pay`, { method: 'POST' });
  assert.equal(paid.expense.amount, 20);
  assert.equal(paid.recurring.daysLeft, 9);
  // pagar otra vez paga el siguiente cobro, nunca el mismo dos veces
  const again = await A(`/recurring/${w.id}/pay`, { method: 'POST' });
  assert.equal(again.expense.dueDate, D.ymd(D.addDays(D.today(), 9)));
  const auto = await A('/recurring', { method: 'POST', body: { name: 'Spotify', amount: 10.99, frequency: 'monthly', anchorDate: today, autoAdd: true } });
  const list = (await A('/expenses')).filter((e) => e.recurringId === auto.id);
  assert.equal(list.length, 1, 'el pago automático de hoy se registra una vez');
  await A('/recurring/' + auto.id, { method: 'PUT', body: { ...auto } });
  assert.equal((await A('/expenses')).filter((e) => e.recurringId === auto.id).length, 1, 'y no se duplica al editar');
});

test('presupuestos: porcentaje, nivel y alertas', async () => {
  const cats = await A('/categories');
  const food = cats.find((c) => c.name === 'Comida');
  await A('/budgets', { method: 'POST', body: { categoryId: food.id, amount: 100 } });
  await A('/budgets', { method: 'POST', body: { categoryId: null, amount: 2000 } });
  await assert.rejects(A('/budgets', { method: 'POST', body: { categoryId: food.id, amount: 50 } }), { status: 409 });
  await A('/expenses', { method: 'POST', body: { name: 'Cena', amount: 92, date: today, categoryId: food.id } });
  const b = await A('/budgets');
  const fb = b.budgets.find((x) => x.categoryId === food.id);
  assert.equal(fb.percent, 92);
  assert.equal(fb.level.key, 'alert');
  assert.equal(fb.remaining, 8);
  const n = await A('/notifications');
  assert.ok(n.list.some((x) => x.type === 'budget' && /92 %/.test(x.title)), 'aviso de presupuesto al 90 %');
  await A('/expenses', { method: 'POST', body: { name: 'Comida', amount: 20, date: today, categoryId: food.id } });
  assert.equal((await A('/budgets')).budgets.find((x) => x.categoryId === food.id).level.key, 'over');
});

test('previsión y simulador de compras', async () => {
  await A('/finance-settings', { method: 'PUT', body: { monthlyIncome: 1500, payday: 28, lowBalance: 100, savingsGoal: 200 } });
  const fc = await A('/forecast');
  assert.ok(fc.series.length > 150);
  assert.equal(fc.series[0].date, today);
  assert.ok(['Alta', 'Media', 'Baja'].includes(fc.confidence.label));
  for (const p of fc.series) assert.ok(p.optimistic >= p.realistic - 0.01 && p.realistic >= p.pessimistic - 0.01, 'orden de escenarios');
  const small = await A('/forecast/simulate', { method: 'POST', body: { name: 'Auriculares', price: 50, date: today } });
  const big = await A('/forecast/simulate', { method: 'POST', body: { name: 'Coche', price: 50000, date: today } });
  assert.equal(Math.round((small.balanceBefore - small.balanceAfter) * 100) / 100, 50);
  assert.equal(big.risk, 'alto');
  await assert.rejects(A('/forecast/simulate', { method: 'POST', body: { price: 10, date: daysAgo(5) } }), { status: 400 });
});

test('asistente: responde con cifras reales y no inventa', async () => {
  const exps = await A('/expenses');
  const month = exps.filter((e) => e.date.startsWith(today.slice(0, 7))).reduce((a, e) => a + e.amount, 0);
  const r = await A('/assistant/ask', { method: 'POST', body: { question: '¿Cuánto he gastado este mes?' } });
  assert.match(r.answer, new RegExp(month.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace('.', '\\.')));
  const food = await A('/assistant/ask', { method: 'POST', body: { question: '¿Cuánto llevo gastado en restaurantes?' } });
  assert.match(food.answer, /112,00/);
  const buy = await A('/assistant/ask', { method: 'POST', body: { question: '¿Puedo comprar algo de 900 euros?' } });
  assert.equal(buy.intent, 'simulate');
  for (const q of ['¿Cuánto puedo gastar esta semana?', '¿Cuánto dinero tendré a final de mes?', '¿Qué facturas tengo pendientes?', '¿Cuáles son mis gastos fijos?', '¿Cómo puedo ahorrar 200 euros al mes?', '¿Qué categoría ha aumentado más?', '¿Cuánto dinero he ahorrado?', '¿Cuánto dinero me queda después de pagar mis facturas?', '¿Qué gastos puedo reducir?', '¿Cuánto he gastado en gasolina este año?']) {
    const x = await A('/assistant/ask', { method: 'POST', body: { question: q } });
    assert.notEqual(x.intent, 'unknown', q);
  }
  const unk = await A('/assistant/ask', { method: 'POST', body: { question: 'qwerty asdf' } });
  assert.equal(unk.intent, 'unknown');
});

test('tickets: guardar con foto, duplicados, historial y fotos privadas', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const saved = await A('/receipts', { method: 'POST', body: { expense: { name: 'Mercadona', amount: 17.19, date: today, place: 'Mercadona' }, receipt: { merchant: 'Mercadona', total: 17.19, date: today, ticketNumber: 'T-1', items: [{ name: 'Leche', quantity: 2, amount: 1.9 }], source: 'ocr', confidence: 80 }, image: png } });
  assert.ok(saved.expense.receiptId);
  const dups = await A('/receipts/duplicates', { method: 'POST', body: { amount: 17.19, date: today, merchant: 'Mercadona', ticketNumber: 'T-1' } });
  assert.ok(dups.length >= 1);
  const list = await A('/receipts?q=merca');
  assert.equal(list.length, 1);
  assert.equal(list[0].items[0].name, 'Leche');
  const img = await A(`/receipts/${saved.receipt.id}/image`, { raw: true });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const other = await B(`/receipts/${saved.receipt.id}/image`, { raw: true });
  assert.equal(other.status, 404, 'otro usuario no puede ver la foto');
  await A(`/receipts/${saved.receipt.id}?withExpense=1`, { method: 'DELETE' });
  assert.equal((await A('/receipts')).length, 0);
  assert.ok(!(await A('/expenses')).some((e) => e.id === saved.expense.id));
});

test('anomalías: duplicado detectado y descartado', async () => {
  await A('/expenses', { method: 'POST', body: { name: 'Gasolinera', amount: 55, date: today, place: 'Repsol' } });
  await A('/expenses', { method: 'POST', body: { name: 'Gasolinera', amount: 55, date: today, place: 'Repsol' } });
  const ins = await A('/insights');
  const dup = ins.anomalies.find((a) => a.type === 'duplicate' && /Gasolinera/.test(a.text));
  assert.ok(dup);
  await A('/insights/anomalies/dismiss', { method: 'POST', body: { key: dup.key } });
  assert.ok(!(await A('/insights')).anomalies.some((a) => a.key === dup.key));
  // no se borra ningún gasto automáticamente
  assert.equal((await A('/expenses')).filter((e) => e.name === 'Gasolinera').length, 2);
});

test('informes, exportaciones y datos de demostración', async () => {
  const mr = await A('/reports/month?month=' + today.slice(0, 7));
  assert.ok(mr.expenses > 0 && Array.isArray(mr.byCategory));
  const csv = await A('/export.csv', { raw: true });
  const txt = await csv.text();
  assert.match(txt, /Fecha;Tipo;Concepto/);
  assert.match(txt, /Transferencia/);
  const x = await A('/export.xlsx', { raw: true });
  assert.equal(x.status, 200);
  const before = (await B('/expenses')).length;
  const d = await B('/demo', { method: 'POST' });
  assert.ok(d.created > 50);
  assert.ok((await B('/forecast')).series.length > 0);
  await B('/demo', { method: 'DELETE' });
  assert.equal((await B('/expenses')).length, before, 'al borrar la demo no queda nada');
  assert.equal((await B('/accounts')).length, 0);
});

test('exportar y borrar la propia cuenta', async () => {
  const data = await B('/me/export');
  assert.equal(data.user.email, 'beto@prueba.test');
  await assert.rejects(B('/me/delete', { method: 'POST', body: { password: 'mala' } }), { status: 401 });
  await B('/me/delete', { method: 'POST', body: { password: 'Otra-clave-segura-72' } });
  await assert.rejects(B('/me'), { status: 401 });
});
