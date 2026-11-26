// Pruebas del motor de clasificación, la revisión inteligente, el patrimonio (Mi dinero) y la conexión con bancos
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-patrimonio-'));
process.env.DATA_DIR = DIR;
process.env.APP_SECRET = 'clave-de-pruebas';
process.env.OPENBANKING_PROVIDER = 'demo';
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ENABLEBANKING_APP_ID;
delete process.env.BREVO_API_KEY;
delete process.env.SMTP_HOST;

const D = require('../server/dates');
const C = require('../server/classify');
let server, base, A, B, cats, main, savingsAcc;

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body } = {}) => {
    const r = await fetch(base + '/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agenda', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc && /sid=[^;]+/.test(sc)) cookie = /sid=[^;]*/.exec(sc)[0];
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
    if (!r.ok) { const e = new Error(data?.error || r.status); e.status = r.status; throw e; }
    return data;
  };
}
const ago = (n) => D.ymd(D.addDays(D.today(), -n));
const cat = (n) => cats.find((c) => c.name === n)?.id;
// Conecta un banco de demostración siguiendo la redirección como haría el navegador
async function connectDemo(c, bank, simulate) {
  const { url, connectionId } = await c('/banks/connect', { method: 'POST', body: { provider: 'demo', bank, simulate } });
  const r = await fetch(base + url, { redirect: 'manual' });
  assert.equal(r.status, 302);
  return { connectionId, location: r.headers.get('location') };
}

before(async () => {
  const { start } = require('../server/index');
  server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
  A = client();
  B = client();
  await A('/auth/register', { method: 'POST', body: { name: 'Ana', email: 'ana@prueba.test', password: 'Clave-segura-91' } });
  await B('/auth/register', { method: 'POST', body: { name: 'Beto', email: 'beto@prueba.test', password: 'Otra-clave-segura-72' } });
  cats = await A('/categories');
  main = await A('/accounts', { method: 'POST', body: { name: 'Principal', type: 'corriente', initialBalance: 2000, balanceDate: ago(40), isDefault: true } });
  savingsAcc = await A('/accounts', { method: 'POST', body: { name: 'Mi ahorro', type: 'ahorro', initialBalance: 3000, balanceDate: ago(40) } });
});
after(() => { server?.close(); setTimeout(() => process.exit(0), 50); });

test('1. comercios conocidos: precisión medida en el conjunto de control ≥ confianza declarada', () => {
  const { measure, FIX } = require('../scripts/calibrar-clasificacion');
  const m = measure(FIX('clasificacion-control.json'));
  assert.ok(m.precision.dictionary.precision >= C.CONFIDENCE.dictionary, `precisión ${m.precision.dictionary.precision}`);
  assert.ok(m.auto.precision >= C.HIGH, 'lo que se clasifica solo acierta al menos tanto como el umbral de confianza alta');
  assert.ok(m.typeAccuracy >= 0.95);
  const ctx = C.buildContext({ cats });
  const r = C.classify({ description: 'COMPRA TARJ. MERCADONA 0452', amount: -40 }, ctx);
  assert.equal(r.categoryId, cat('Supermercado'));
  assert.equal(r.review, 'auto');
  assert.equal(r.subcategory, 'Supermercado');
  assert.match(r.rule, /Diccionario/);
  assert.equal(C.classify({ description: 'LIQUIDACION TARJETA CREDITO', amount: -300 }, ctx).type, 'card_settlement');
  assert.equal(C.classify({ description: 'BIZUM ENVIADO A JUAN', amount: -10 }, ctx).type, 'transfer_out');
  assert.equal(C.classify({ description: 'NETFLIX.COM', amount: -12.99 }, ctx).type, 'subscription');
});

test('2. comercios desconocidos quedan pendientes, sin inventar categoría', async () => {
  const e = await A('/expenses', { method: 'POST', body: { name: 'Tienda Rara XJ', amount: 9, date: ago(3) } });
  assert.equal(e.categoryId, null);
  assert.equal(e.review, 'pending');
  const m = await A('/expenses', { method: 'POST', body: { name: 'Mercadona', amount: 30, date: ago(3) } });
  assert.equal(m.categoryId, cat('Supermercado'), 'sin categoría elegida, se clasifica sola');
  assert.equal(m.review, 'auto');
  const own = await A('/expenses', { method: 'POST', body: { name: 'Mercadona', amount: 12, date: ago(2), categoryId: cat('Comida') } });
  assert.equal(own.categoryId, cat('Comida'), 'lo que eliges tú se respeta');
  assert.equal(own.review, 'confirmed');
});

test('3. aprende de tus correcciones (Amazon → Tecnología) y crea reglas de varios tipos', async () => {
  const tech = await A('/categories', { method: 'POST', body: { name: 'Tecnología', icon: 'laptop', color: '#2563eb' } });
  cats = await A('/categories');
  const a1 = await A('/expenses', { method: 'POST', body: { name: 'AMAZON.ES', amount: 25, date: ago(5) } });
  await A('/expenses', { method: 'POST', body: { name: 'AMAZON MKTPLACE', amount: 40, date: ago(4) } });
  assert.equal(a1.categoryId, cat('Compras'));
  const upd = await A('/expenses/' + a1.id, { method: 'PUT', body: { ...a1, categoryId: tech.id } });
  assert.ok(upd.suggestRule, 'pregunta si aplicar la regla');
  assert.equal(upd.suggestRule.pattern, 'amazon');
  assert.equal(upd.suggestRule.others, 1);
  const preview = await A('/rules/preview', { method: 'POST', body: upd.suggestRule });
  assert.equal(preview.count, 1);
  const r = await A('/rules', { method: 'POST', body: { ...upd.suggestRule, applyToExisting: true } });
  assert.equal(r.applied, 1);
  assert.ok((await A('/expenses')).filter((e) => /amazon/i.test(e.name)).every((e) => e.categoryId === tech.id));
  const next = await A('/expenses', { method: 'POST', body: { name: 'AMAZON EU SARL', amount: 15, date: ago(1) } });
  assert.equal(next.categoryId, tech.id);
  assert.match(next.cls.rule, /Tu regla/);
  // Regla «contiene» y regla de ingresos por pagador
  await A('/rules', { method: 'POST', body: { match: 'contains', pattern: 'GIMNASIO', categoryId: cat('Ocio') } });
  assert.equal((await A('/classify', { method: 'POST', body: { description: 'CUOTA GIMNASIO MUNICIPAL', amount: -20 } })).categoryId, cat('Ocio'));
  await A('/rules', { method: 'POST', body: { match: 'counterparty', pattern: 'ACME', incomeSource: 'nomina', type: 'income' } });
  const inc = await A('/classify', { method: 'POST', body: { description: 'TRANSFERENCIA DE ACME SOLUTIONS', amount: 1500 } });
  assert.equal(inc.incomeSource, 'nomina');
  // Reglas contradictorias → revisión
  await A('/rules', { method: 'POST', body: { match: 'contains', pattern: 'EU SARL', categoryId: cat('Otros') } });
  const contra = await A('/classify', { method: 'POST', body: { description: 'AMAZON EU SARL', amount: -10 } });
  assert.equal(contra.review, 'review');
  // Diccionario editable: palabra nueva y cambio de una entrada general
  const d = await A('/dictionary', { method: 'POST', body: { words: 'PELUQUERIA, BARBERIA', categoryId: cat('Otros'), subcategory: 'Cuidado personal' } });
  assert.equal(d.entry.words.length, 2);
  assert.equal((await A('/classify', { method: 'POST', body: { description: 'PELUQUERIA ANA', amount: -18 } })).subcategory, 'Cuidado personal');
  await A('/dictionary/general/gasolina', { method: 'PUT', body: { categoryId: cat('Casa') } });
  assert.equal((await A('/classify', { method: 'POST', body: { description: 'REPSOL ESTACION', amount: -50 } })).categoryId, cat('Casa'));
  await A('/dictionary/general/gasolina', { method: 'PUT', body: { reset: true } });
  const dict = await A('/dictionary');
  assert.ok(dict.general.length > 20 && dict.own.length === 1);
  // Otro usuario no ve ni usa mis reglas
  assert.equal((await B('/rules')).length, 0);
  assert.notEqual((await B('/classify', { method: 'POST', body: { description: 'AMAZON EU SARL', amount: -10 } })).rule, next.cls.rule);
});

test('4. transferencias entre mis cuentas: no son gasto ni ingreso', async () => {
  const before = await A('/overview');
  const e = await A('/expenses', { method: 'POST', body: { name: 'TRASPASO A MI AHORRO', amount: 300, date: ago(2), accountId: main.id, categoryId: cat('Otros') } });
  const i = await A('/incomes', { method: 'POST', body: { name: 'TRASPASO RECIBIDO', amount: 300, date: ago(2), accountId: savingsAcc.id, source: 'otros' } });
  const rv = await A('/review');
  const pair = rv.ownTransfers.find((p) => p.expense.id === e.id);
  assert.ok(pair, 'detecta el par');
  assert.equal(pair.sure, true);
  const w0 = await A('/wealth');
  await A('/review/own-transfer', { method: 'POST', body: { expenseId: e.id, incomeId: i.id } });
  const w1 = await A('/wealth');
  assert.equal(w1.total, w0.total, 'el dinero total no cambia');
  const after = await A('/overview');
  assert.equal(after.monthExpenses, before.monthExpenses, 'el gasto del mes no aumenta');
  assert.equal(after.monthIncomes, before.monthIncomes, 'los ingresos del mes no aumentan');
  assert.ok((await A('/transfers')).some((t) => t.fromId === main.id && t.toId === savingsAcc.id && t.amount === 300));
});

test('5. pagos duplicados en la revisión inteligente', async () => {
  await A('/expenses', { method: 'POST', body: { name: 'Cena', amount: 44, date: ago(6), categoryId: cat('Comida') } });
  await A('/expenses', { method: 'POST', body: { name: 'Cena', amount: 44, date: ago(6), categoryId: cat('Comida') } });
  const rv = await A('/review');
  assert.ok(rv.counts.duplicates >= 1);
  assert.ok(rv.counts.pending >= 1);
  assert.ok(rv.rules.length >= 3, 'reglas aprendidas recientemente');
});

test('6. devoluciones: tipo y signo correctos', () => {
  const ctx = C.buildContext({ cats });
  const r = C.classify({ description: 'DEVOLUCION COMPRA ZARA', amount: 25 }, ctx);
  assert.equal(r.type, 'refund');
  assert.equal(C.classify({ description: 'DEVOLUCION COMPRA ZARA', amount: -25 }, ctx).type !== 'refund', true, 'un cargo nunca es una devolución');
});

test('7-9. conectar dos bancos, varios saldos y detección de cuentas de ahorro y huchas', async () => {
  const st = await A('/banks/status');
  assert.ok(st.available && st.providers.some((p) => p.id === 'demo'));
  const banks = await A('/banks/list?provider=demo');
  assert.equal(banks.length, 2);
  const uno = await connectDemo(A, 'demo-uno');
  assert.match(uno.location, /#\/cuentas\?banco=/);
  let conns = (await A('/banks/status')).connections;
  let c1 = conns.find((c) => c.id === uno.connectionId);
  assert.equal(c1.status, 'elegir');
  assert.equal(c1.accounts.length, 3);
  assert.deepEqual(c1.accounts.map((a) => a.type), ['corriente', 'ahorro', 'ahorro'], 'detecta la cuenta de ahorro y la hucha');
  assert.match(c1.accounts[0].iban, /^ES76 •••• 6789$/);
  const res = await A(`/banks/connections/${uno.connectionId}/accounts`, { method: 'POST', body: { accounts: c1.accounts.map((a) => ({ externalId: a.externalId, include: true, accountId: 'new', type: a.type })) } });
  assert.equal(res.connection.status, 'activa');
  assert.equal(res.sync.status, 'ok');
  assert.equal(res.sync.accounts, 3);
  assert.ok(res.sync.imported >= 10);
  const dos = await connectDemo(A, 'demo-dos');
  const c2 = (await A('/banks/status')).connections.find((c) => c.id === dos.connectionId);
  await A(`/banks/connections/${dos.connectionId}/accounts`, { method: 'POST', body: { accounts: c2.accounts.map((a) => ({ externalId: a.externalId, include: true, accountId: 'new', type: a.type })) } });
  const accs = await A('/accounts');
  const byName = (n) => accs.find((a) => a.name === n);
  assert.equal(byName('Cuenta Nómina').balance, 2350, 'saldo comunicado por el banco');
  assert.equal(byName('Cuenta Nómina').balances.available, 2310);
  assert.equal(byName('Cuenta Nómina').balances.pending, 40);
  assert.equal(byName('Cuenta Nómina').confirmed, true);
  assert.equal(byName('Cuenta Nómina').bankName, 'Banco Demo Uno');
  assert.equal(byName('Cuenta Nómina').reconcile, 0, 'el historial cuadra con el saldo del banco');
  assert.equal(byName('Hucha Vacaciones').type, 'ahorro');
  assert.equal(byName('Tarjeta Oro').balance, -230.4);
  const w = await A('/wealth');
  assert.equal(w.debt, -230.4, 'deuda de la tarjeta');
  assert.ok(w.accounts.length >= 7);
  // La transferencia a la cuenta de ahorro del mismo banco se reconoce como traspaso propio (no gasto)
  const transfers = await A('/transfers');
  assert.ok(transfers.some((t) => t.amount === 300 && accs.find((a) => a.id === t.toId)?.type === 'ahorro'));
  // El pago de la tarjeta de crédito va a la cuenta de la tarjeta: no se cuenta dos veces
  assert.ok(transfers.some((t) => t.amount === 230.4 && accs.find((a) => a.id === t.toId)?.type === 'credito'));
  const exps = await A('/expenses');
  assert.ok(!exps.some((e) => /LIQUIDACION TARJETA/i.test(e.notes || '')));
  // Otro usuario no ve mis conexiones
  assert.equal((await B('/banks/status')).connections.length, 0);
  await assert.rejects(B(`/banks/connections/${uno.connectionId}/sync`, { method: 'POST' }), (e) => e.status === 404);
});

test('10. huchas virtuales: se reservan y no se suman dos veces', async () => {
  const w0 = await A('/wealth');
  const h = await A('/savings', { method: 'POST', body: { name: 'Emergencias', initial: 500, location: 'virtual', accountId: main.id } });
  const w1 = await A('/wealth');
  assert.equal(w1.total, w0.total, 'una hucha dentro de una cuenta no cambia el total');
  assert.equal(w1.piggyTotal, w0.piggyTotal + 500);
  assert.equal(w1.spendable, Math.round((w0.spendable - 500) * 100) / 100, 'se descuenta de lo disponible');
  assert.equal(w1.accounts.find((a) => a.id === main.id).reserved, 500);
  await A('/savings', { method: 'POST', body: { name: 'Hucha de casa', initial: 100, location: 'separada' } });
  const w2 = await A('/wealth');
  assert.equal(w2.total, Math.round((w1.total + 100) * 100) / 100, 'una hucha aparte sí se suma');
  assert.ok(w2.evolution.length === 6);
  assert.ok(h.id);
});

test('11. actualización del saldo real y saldo estimado', async () => {
  const before = (await A('/accounts')).find((a) => a.id === main.id);
  assert.equal(before.balances.source, 'calculado');
  assert.equal(before.stale, true, 'sin dato del banco: puede estar desfasado');
  const upd = await A(`/accounts/${main.id}/bank-balance`, { method: 'POST', body: { booked: 1900, available: 1850, at: ago(1) } });
  assert.equal(upd.balances.booked, 1900);
  assert.equal(upd.balances.source, 'manual');
  assert.ok(upd.reconcile !== undefined);
  await A('/expenses', { method: 'POST', body: { name: 'Café', amount: 2, date: D.ymd(D.today()), accountId: main.id, categoryId: cat('Comida') } });
  const now = (await A('/accounts')).find((a) => a.id === main.id);
  assert.equal(now.balance, 1898, 'referencia del banco + movimientos posteriores');
  assert.equal(now.confirmed, false, 'hay movimientos después del dato del banco: es estimado');
  await assert.rejects(A(`/accounts/${main.id}/bank-balance`, { method: 'POST', body: { booked: 1, at: D.ymd(D.addDays(D.today(), 2)) } }), /futura/);
});

test('12. caducidad, renovación y desconexión', async () => {
  const exp = await connectDemo(A, 'demo-uno', 'caducado');
  let c = (await A('/banks/status')).connections.find((x) => x.id === exp.connectionId);
  const res = await A(`/banks/connections/${exp.connectionId}/accounts`, { method: 'POST', body: { accounts: [{ externalId: c.accounts[0].externalId, include: true, accountId: 'new', type: 'corriente' }] } });
  assert.equal(res.sync.status, 'caducada');
  c = (await A('/banks/status')).connections.find((x) => x.id === exp.connectionId);
  assert.equal(c.status, 'caducada');
  const notifs = await A('/notifications');
  assert.ok(notifs.list.some((n) => /Renueva la conexión/.test(n.title)));
  // Renovar: nuevo permiso, mismas cuentas enlazadas
  const { url } = await A(`/banks/connections/${exp.connectionId}/renew`, { method: 'POST' });
  await fetch(base + url, { redirect: 'manual' });
  c = (await A('/banks/status')).connections.find((x) => x.id === exp.connectionId);
  assert.equal(c.status, 'activa');
  assert.ok(c.accounts[0].accountId, 'la cuenta sigue enlazada');
  // Desconectar y borrar lo que vino del banco
  const conns = (await A('/banks/status')).connections;
  const dos = conns.find((x) => x.bank === 'Banco Demo Dos');
  const expBefore = (await A('/expenses')).length;
  const del = await A(`/banks/connections/${dos.id}?deleteData=1`, { method: 'DELETE' });
  assert.ok(del.removed > 0);
  assert.ok((await A('/expenses')).length < expBefore);
  const st = await A('/banks/status');
  assert.ok(!st.connections.some((x) => x.id === dos.id));
  assert.ok(st.syncs.some((s) => s.status === 'desconectada'), 'historial de sincronizaciones');
  assert.ok((await A('/accounts')).some((a) => a.name === 'Cuenta Online' && !a.connectionId), 'la cuenta se queda como manual');
});

test('13. sincronizado con presupuestos y previsiones', async () => {
  await A('/budgets', { method: 'POST', body: { categoryId: cat('Supermercado'), amount: 400, period: 'monthly' } }).catch(() => {});
  const month = ago(25).slice(0, 7);
  const bud = await A('/budgets?month=' + month);
  assert.ok(bud.budgets.find((b) => b.categoryId === cat('Supermercado')).spent > 0, 'los movimientos del banco cuentan en el presupuesto');
  const fc = await A('/forecast');
  assert.ok(Number.isFinite(fc.balance));
  const ov = await A('/overview');
  assert.ok(ov.money.netWorth > 0);
});

test('14. el asistente responde con los saldos reales y avisa si están desfasados', async () => {
  const ask = (q) => A('/assistant/ask', { method: 'POST', body: { question: q } });
  const w = await A('/wealth');
  const total = await ask('¿Cuánto dinero tengo en total?');
  assert.equal(total.intent, 'networth');
  assert.ok(total.answer.includes(new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(w.total)));
  assert.ok(total.note);
  assert.equal((await ask('¿Cuánto puedo gastar sin tocar mis ahorros?')).intent, 'spendable-safe');
  assert.equal((await ask('¿Cuánto tengo en mis huchas?')).intent, 'piggies');
  assert.equal((await ask('¿Cuánto tengo ahorrado?')).intent, 'saved-stock');
  assert.equal((await ask('¿Cuánto tengo en mi cuenta principal?')).intent, 'account');
  assert.equal((await ask('¿Cuánto pago al mes en suscripciones?')).intent, 'fixed');
  assert.equal((await ask('¿Puedo permitirme comprar algo de 500 €?')).intent, 'simulate');
  assert.equal((await ask('¿Cuánto dinero tendré dentro de 30 días?')).intent, 'forecast');
  assert.equal((await ask('¿Cuánto he gastado en gasolina este mes?')).intent, 'spent');
  assert.ok(/ahorro/.test((await ask('¿Cuánto dinero he conseguido ahorrar este año?')).answer));
});

test('15. errores y conexiones incompletas', async () => {
  const inc = await connectDemo(A, 'demo-uno', 'incompleto');
  const c = (await A('/banks/status')).connections.find((x) => x.id === inc.connectionId);
  const res = await A(`/banks/connections/${inc.connectionId}/accounts`, { method: 'POST', body: { accounts: c.accounts.map((a) => ({ externalId: a.externalId, include: true, accountId: 'new', type: a.type })) } });
  assert.equal(res.sync.status, 'incompleta');
  assert.ok(res.sync.errors.some((e) => /saldo/.test(e)));
  // Estado no válido o caducado en la vuelta del banco
  const r = await fetch(base + '/banco-conectado?state=inventado&code=demo:demo-uno', { redirect: 'manual' });
  assert.match(r.headers.get('location'), /banco=error/);
  await assert.rejects(A('/banks/connect', { method: 'POST', body: { provider: 'enablebanking', bank: 'BBVA' } }), /no está disponible/);
  await assert.rejects(A('/banks/connect', { method: 'POST', body: { provider: 'demo', bank: 'no-existe' } }));
  await assert.rejects(A(`/banks/connections/${inc.connectionId}/accounts`, { method: 'POST', body: { accounts: c.accounts.map((a) => ({ externalId: a.externalId, include: false })) } }), /al menos una/);
  // El identificador de la sesión con el banco se guarda cifrado y nunca sale por la API
  const raw = fs.readFileSync(path.join(DIR, 'db.json'), 'utf8');
  assert.ok(!/demo-session:/.test(raw), 'sesión cifrada en la base de datos');
  assert.ok(!JSON.stringify(await A('/banks/status')).includes('session'));
});
