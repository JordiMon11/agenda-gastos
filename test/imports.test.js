// Pruebas de la importación de extractos bancarios (formatos, clasificación, duplicados, importación y reversión)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-import-'));
process.env.DATA_DIR = DIR;
process.env.APP_SECRET = 'clave-de-pruebas';
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.BREVO_API_KEY;
delete process.env.SMTP_HOST;

const D = require('../server/dates');
const St = require('../server/statements');
let server, base, A, B, acc, savings, cash, cats;

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
const b64 = (s) => Buffer.from(s).toString('base64');
const dmy = (n) => D.ymd(D.addDays(D.today(), -n)).split('-').reverse().join('/');
const ymdAgo = (n) => D.ymd(D.addDays(D.today(), -n));
const analyze = (c, fileName, content, extra = {}) => c('/imports/analyze', { method: 'POST', body: { fileName, data: Buffer.isBuffer(content) ? content.toString('base64') : b64(content), accountId: acc.id, ...extra } });
// Envía a importar lo que la revisión deja seleccionado (como haría la pantalla)
const commit = (c, an, opts = {}) => c('/imports/commit', {
  method: 'POST',
  body: {
    accountId: opts.accountId || acc.id, fileName: an.fileName, format: an.format, bank: an.bank?.name || '', detected: an.rows.length,
    rows: an.rows.map((r) => ({ ...r, ...(opts.edit?.(r) || {}), action: opts.action?.(r) || (r.selected ? 'import' : r.status === 'duplicate' || r.status === 'possible' ? 'skip' : 'exclude') })),
  },
});

// PDF mínimo con texto seleccionable (una línea por movimiento)
function makePdf(lines) {
  const content = ['BT', '/F1 9 Tf', '40 800 Td', '12 TL', ...lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) '`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

before(async () => {
  const { start } = require('../server/index');
  server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
  A = client();
  B = client();
  await A('/auth/register', { method: 'POST', body: { name: 'Ana', email: 'ana@prueba.test', password: 'Clave-segura-91' } });
  await B('/auth/register', { method: 'POST', body: { name: 'Beto', email: 'beto@prueba.test', password: 'Otra-clave-segura-72' } });
  acc = await A('/accounts', { method: 'POST', body: { name: 'CaixaBank nómina', type: 'corriente', initialBalance: 1000, balanceDate: ymdAgo(60) } });
  savings = await A('/accounts', { method: 'POST', body: { name: 'Ahorro', type: 'ahorro', initialBalance: 0, balanceDate: ymdAgo(60) } });
  cash = await A('/accounts', { method: 'POST', body: { name: 'Cartera', type: 'efectivo', initialBalance: 0, balanceDate: ymdAgo(60) } });
  cats = await A('/categories');
});
after(() => { server?.close(); setTimeout(() => process.exit(0), 50); });
const cat = (n) => cats.find((c) => c.name === n)?.id;

test('números y fechas en formato español', () => {
  assert.equal(St.parseAmount('1.250,50 €'), 1250.5);
  assert.equal(St.parseAmount('-45,90 €'), -45.9);
  assert.equal(St.parseAmount('+2.000,00 €'), 2000);
  assert.equal(St.parseAmount('45,90-'), -45.9);
  assert.equal(St.parseAmount('(12,00)'), -12);
  assert.equal(St.parseAmount('12.50', '.'), 12.5);
  assert.equal(St.parseDate('05/01/2026'), '2026-01-05');
  assert.equal(St.parseDate('31/02/2026'), null);
  assert.equal(St.parseDate('12 ene 2026'), '2026-01-12');
  assert.equal(St.parseDate(46027), '2026-01-05');
});

test('CSV: banco, columnas, signos, clasificación, transferencias y devoluciones', async () => {
  const csv = [
    'Titular: ANA; Cuenta: ES91 2100 0418 4502 0005 1332', '',
    'Fecha;Fecha valor;Movimiento;Más datos;Importe;Saldo',
    `${dmy(20)};${dmy(20)};NOMINA EMPRESA SL;;2.000,00;3.000,00`,
    `${dmy(18)};${dmy(18)};COMPRA TARJ. 5402XXXXXXXX1234 MERCADONA 0452;VALENCIA;-45,90;2.954,10`,
    `${dmy(17)};${dmy(17)};REPSOL ESTACION 1234;;-50,00;2.904,10`,
    `${dmy(16)};${dmy(16)};NETFLIX.COM;;-12,99;2.891,11`,
    `${dmy(15)};${dmy(15)};COMPRA AMAZON.ES;;-30,00;2.861,11`,
    `${dmy(12)};${dmy(12)};DEVOLUCION COMPRA AMAZON;;30,00;2.891,11`,
    `${dmy(10)};${dmy(10)};TRASPASO A CUENTA AHORRO;;-200,00;2.691,11`,
    `${dmy(9)};${dmy(9)};REINTEGRO CAJERO 1234;;-60,00;2.631,11`,
    `${dmy(8)};${dmy(8)};COMISION MANTENIMIENTO;;-3,00;2.628,11`,
    `32/13/2026;;MOVIMIENTO CON FECHA ROTA;;-1,00;2.627,11`,
    `${dmy(5)};${dmy(5)};TIENDA RARA XJ;;-7,00;2.621,11`,
  ].join('\r\n');
  const an = await analyze(A, 'movimientos.csv', csv);
  assert.equal(an.format, 'csv');
  assert.equal(an.bank.name, 'CaixaBank');
  assert.equal(an.iban, 'ES91 •••• 1332');
  assert.equal(an.rows.length, 11);
  const by = (t) => an.rows.find((r) => r.description.includes(t));
  assert.equal(by('NOMINA').amount, 2000);
  assert.equal(by('NOMINA').type, 'income');
  assert.equal(by('MERCADONA').amount, -45.9);
  assert.equal(by('MERCADONA').merchant, 'Mercadona');
  assert.equal(by('MERCADONA').categoryId, cat('Supermercado'));
  assert.equal(by('MERCADONA').type, 'card');
  assert.equal(by('REPSOL').suggestedCategory || by('REPSOL').categoryId, cat('Transporte'));
  assert.equal(by('NETFLIX').categoryId, cat('Suscripciones'));
  assert.equal(by('DEVOLUCION').type, 'refund');
  assert.equal(by('TRASPASO').type, 'transfer');
  assert.equal(by('TRASPASO').counterpartId, savings.id);
  assert.equal(by('REINTEGRO').type, 'cash_withdrawal');
  assert.equal(by('REINTEGRO').counterpartId, cash.id);
  assert.equal(by('COMISION').type, 'fee');
  assert.equal(by('FECHA ROTA').status, 'review');
  assert.match(by('FECHA ROTA').error, /Fecha no válida/);
  assert.equal(by('FECHA ROTA').selected, false);
  assert.ok(by('TIENDA RARA').confidence < 0.5);

  // El usuario corrige la tienda desconocida: se guarda como regla
  const res = await commit(A, an, { edit: (r) => (r.description.includes('TIENDA RARA') ? { categoryId: cat('Compras'), learn: true } : null) });
  assert.equal(res.imported, 10);
  assert.equal(res.incomes, 1);
  assert.equal(res.transfers, 2);
  assert.equal(res.excluded, 1);
  assert.equal(res.rulesLearned, 1);
  assert.equal(res.incomeTotal, 2000);

  const exps = await A('/expenses');
  const refund = exps.find((e) => e.refund);
  assert.equal(refund.amount, -30);
  assert.ok(refund.refundOf, 'la devolución queda enlazada con la compra');
  assert.equal(exps.find((e) => /tienda rara/i.test(e.name)).categoryId, cat('Compras'));
  const transfers = await A('/transfers');
  assert.ok(transfers.some((t) => t.fromId === acc.id && t.toId === savings.id && t.amount === 200));
  assert.ok(transfers.some((t) => t.toId === cash.id && t.amount === 60));

  // Integración: saldos, panel, calendario, presupuestos e informes usan los mismos datos
  const accounts = await A('/accounts');
  const bal = (id) => accounts.find((a) => a.id === id).balance;
  assert.equal(bal(acc.id), Math.round((1000 + 2000 - 45.9 - 50 - 12.99 - 30 + 30 - 200 - 60 - 3 - 7) * 100) / 100);
  assert.equal(bal(savings.id), 200);
  assert.equal(bal(cash.id), 60);
  const month = ymdAgo(18).slice(0, 7);
  const cal = await A('/calendar?month=' + month);
  assert.ok(JSON.stringify(cal).includes('Mercadona'));
  await A('/budgets', { method: 'POST', body: { categoryId: cat('Supermercado'), amount: 300, period: 'monthly' } });
  const bud = await A('/budgets?month=' + month);
  assert.equal(bud.budgets.find((x) => x.categoryId === cat('Supermercado')).spent, 45.9);
  const ov = await A('/overview');
  assert.ok(ov);
  const fc = await A('/forecast');
  assert.ok(fc.scenarios || fc.realistic || fc);

  // Reimportar el mismo archivo no crea nada nuevo (idempotente)
  const again = await analyze(A, 'movimientos.csv', csv);
  assert.equal(again.rows.filter((r) => r.status === 'duplicate').length, 10);
  assert.equal(again.rows.filter((r) => r.selected).length, 0);
  const res2 = await commit(A, again);
  assert.equal(res2.imported, 0);

  // La regla aprendida se aplica la próxima vez
  const rule = await analyze(A, 'otro.csv', `Fecha;Concepto;Importe\n${dmy(2)};TIENDA RARA XJ;-9,00\n`);
  assert.equal(rule.rows[0].categoryId, cat('Compras'));
  assert.equal(rule.rows[0].confidence, 0.97);

  // Otro usuario no puede importar en mis cuentas ni ver mi historial
  await assert.rejects(analyze(B, 'x.csv', csv), /cuenta/);
  assert.equal((await B('/imports')).length, 0);
});

test('duplicados con movimientos manuales y pagos fijos', async () => {
  const e = await A('/expenses', { method: 'POST', body: { name: 'Gimnasio', amount: 39.9, date: ymdAgo(4), categoryId: cat('Ocio'), accountId: acc.id } });
  const an = await analyze(A, 'dup.csv', `Fecha;Concepto;Importe\n${dmy(3)};RECIBO GIMNASIO BASIC FIT;-39,90\n${dmy(3)};CAFETERIA SOL;-2,50\n${dmy(3)};CAFETERIA SOL;-2,50\n`);
  const g = an.rows[0];
  assert.equal(g.status, 'possible');
  assert.equal(g.dupOf.id, e.id);
  assert.equal(g.selected, false);
  // Dos cafés iguales el mismo día son dos movimientos distintos
  assert.equal(an.rows.filter((r) => r.status === 'new').length, 2);
  assert.notEqual(an.rows[1].fp, an.rows[2].fp);
  // El usuario decide vincularlo: no se duplica y la siguiente vez se reconoce
  const res = await commit(A, an, { action: (r) => (r.status === 'possible' ? 'link' : 'import') });
  assert.equal(res.imported, 2);
  assert.equal(res.linked, 1);
  const again = await analyze(A, 'dup.csv', `Fecha;Concepto;Importe\n${dmy(3)};RECIBO GIMNASIO BASIC FIT;-39,90\n`);
  assert.equal(again.rows[0].status, 'duplicate');
  assert.equal((await A('/expenses')).filter((x) => x.amount === 39.9).length, 1, 'nunca se borra ni duplica lo que ya existía');
});

test('columnas desconocidas: mapeo manual guardado para la próxima vez', async () => {
  const csv = 'Momento;Texto libre;Cargo;Abono\n' + `${dmy(6)};PAGO LUZ;55,10;\n${dmy(6)};REGALO TIA;;100,00\n`;
  const an = await analyze(A, 'raro.csv', csv);
  assert.equal(an.needsMapping, true);
  assert.deepEqual(an.headers, ['Momento', 'Texto libre', 'Cargo', 'Abono']);
  const an2 = await analyze(A, 'raro.csv', csv, { mapping: { 0: 'date', 1: 'description', 2: 'debit', 3: 'credit' }, saveMapping: true });
  assert.equal(an2.rows.length, 2);
  assert.equal(an2.rows[0].amount, -55.1);
  assert.equal(an2.rows[1].amount, 100);
  const an3 = await analyze(A, 'raro-2.csv', csv);
  assert.equal(an3.needsMapping, false, 'usa el mapeo guardado');
  assert.equal(an3.savedMapping, true);
});

test('Excel XLSX con fechas reales y archivo grande', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Movimientos');
  ws.addRow(['BBVA - Extracto de movimientos']);
  ws.addRow([]);
  ws.addRow(['F.Valor', 'Fecha', 'Concepto', 'Movimiento', 'Importe', 'Divisa', 'Disponible', 'Divisa', 'Observaciones']);
  const start = D.addDays(D.today(), -400);
  for (let i = 0; i < 3000; i++) {
    const d = D.addDays(start, Math.floor(i / 8));
    const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    ws.addRow([dt, dt, `Compra en comercio ${i}`, 'Pago con tarjeta', -(1 + (i % 50)), 'EUR', 5000 - i, 'EUR', '']);
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const t0 = Date.now();
  const an = await analyze(A, 'extracto_bbva.xlsx', buf);
  assert.equal(an.format, 'xlsx');
  assert.equal(an.bank.name, 'BBVA');
  assert.equal(an.rows.length, 3000);
  assert.equal(an.rows[0].date, D.ymd(start));
  assert.equal(an.rows[0].amount, -1);
  assert.match(an.rows[0].description, /Compra en comercio 0 · Pago con tarjeta/);
  assert.ok(Date.now() - t0 < 15000);
});

test('PDF con texto, PDF escaneado y texto de OCR', async () => {
  const pdf = makePdf([
    'Banco Santander - Extracto de cuenta ES12 0049 1500 0512 3456 7892',
    'Fecha Operacion   Fecha Valor   Concepto   Importe   Saldo',
    `${dmy(7)}   ${dmy(7)}   RECIBO VODAFONE ESPANA   35,00   965,00`,
    `${dmy(6)}   ${dmy(6)}   TRANSFERENCIA RECIBIDA DE LUIS   150,00   1.115,00`,
    `${dmy(5)}   ${dmy(5)}   FARMACIA CENTRAL   12,40   1.102,60`,
  ]);
  const an = await analyze(A, 'extracto.pdf', pdf);
  assert.equal(an.format, 'pdf');
  assert.equal(an.bank.name, 'Santander');
  assert.equal(an.rows.length, 3);
  // Sin signo en el PDF: se deduce por la evolución del saldo
  assert.equal(an.rows[1].amount, 150);
  assert.equal(an.rows[2].amount, -12.4);
  assert.equal(an.rows[2].categoryId, cat('Salud'));

  const scanned = makePdf([]);
  const sc = await analyze(A, 'escaneado.pdf', scanned);
  assert.equal(sc.needsOcr, true);

  const ocr = await A('/imports/analyze', { method: 'POST', body: { fileName: 'foto.jpg', accountId: acc.id, text: `${dmy(3)} COMPRA LIDL 0021 -18,35\n${dmy(2)} BIZUM RECIBIDO MARTA +20,00\n` } });
  assert.equal(ocr.format, 'ocr');
  assert.equal(ocr.rows.length, 2);
  assert.equal(ocr.rows[0].amount, -18.35);
  assert.equal(ocr.rows[1].amount, 20);
});

test('OFX, CAMT.053 y Norma 43', async () => {
  const ofx = `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR<BANKACCTFROM><BANKID>1465<ACCTID>ES7614650100912345678901</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${ymdAgo(4).replace(/-/g, '')}<TRNAMT>-23.50<FITID>A1<NAME>UBER EATS</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>${ymdAgo(3).replace(/-/g, '')}<TRNAMT>1200.00<FITID>A2<NAME>NOMINA</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const o = await analyze(A, 'ing.ofx', ofx);
  assert.equal(o.format, 'ofx');
  assert.equal(o.bank.name, 'ING');
  assert.deepEqual(o.rows.map((r) => r.amount), [-23.5, 1200]);
  assert.equal(o.rows[0].categoryId, cat('Comida'));

  const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>ES9100811234561234567890</IBAN></Id></Acct>
<Ntry><Amt Ccy="EUR">64.20</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>${ymdAgo(5)}</Dt></BookgDt><AcctSvcrRef>REF-1</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><Cdtr><Nm>ENDESA ENERGIA</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Factura luz</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
  const c = await analyze(A, 'sabadell.xml', camt);
  assert.equal(c.format, 'camt.053');
  assert.equal(c.bank.name, 'Banco Sabadell');
  assert.equal(c.rows[0].amount, -64.2);
  assert.match(c.rows[0].description, /ENDESA/);
  assert.equal(c.rows[0].categoryId, cat('Facturas'));
  await assert.rejects(analyze(A, 'malo.xml', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Document><BkToCstmrStmt><Ntry></Ntry></BkToCstmrStmt></Document>'), /no permitidas/);

  const d6 = ymdAgo(2).slice(2).replace(/-/g, '');
  const n43 = [
    `11${'2100'}${'0418'}${'4502000513'}${d6}${d6}2${'00000000100000'}978${' '.repeat(30)}`,
    `22${'    '}${'0418'}${d6}${d6}${'12'}${'000'}1${'00000000004590'}${'0000000000'}${' '.repeat(28)}`,
    `23${'01'}${'MERCADONA VALENCIA'.padEnd(38)}${''.padEnd(38)}`,
    `33${'2100'}${'0418'}${'4502000513'}`,
    '88999999999999999999',
  ].join('\n');
  const n = await analyze(A, 'n43.txt', n43);
  assert.equal(n.format, 'norma43');
  assert.equal(n.bank.name, 'CaixaBank');
  assert.equal(n.rows[0].amount, -45.9);
});

test('archivos no válidos y límites', async () => {
  await assert.rejects(analyze(A, 'virus.exe', Buffer.from('MZ\x90\x00binario')), /no es un extracto/);
  await assert.rejects(analyze(A, 'vacio.csv', 'Fecha;Concepto;Importe\n'), /ningún movimiento|columnas/);
  const big = Buffer.alloc(11 * 1024 * 1024, 65);
  await assert.rejects(analyze(A, 'enorme.csv', big), (e) => e.status === 413);
});

test('historial y reversión controlada', async () => {
  const csv = `Fecha;Concepto;Importe\n${dmy(1)};PANADERIA LA ESPIGA;-3,20\n${dmy(1)};KIOSKO;-1,50\n`;
  const an = await analyze(A, 'revertir.csv', csv);
  const res = await commit(A, an);
  assert.equal(res.imported, 2);
  const list = await A('/imports');
  const imp = list.find((i) => i.id === res.id);
  assert.equal(imp.fileName, 'revertir.csv');
  assert.equal(imp.accountName, acc.name);
  assert.equal(imp.imported, 2);
  assert.equal(imp.by, 'Ana');
  const det = await A('/imports/' + res.id);
  assert.equal(det.canRevert, true);
  assert.equal(det.movements.length, 2);

  // Si se modifica un movimiento después, no se puede revertir
  const exp = (await A('/expenses')).find((e) => e.name === 'Kiosko');
  await A('/expenses/' + exp.id, { method: 'PUT', body: { ...exp, name: 'Kiosko editado' } });
  assert.equal((await A('/imports/' + res.id)).canRevert, false);
  await assert.rejects(A(`/imports/${res.id}/revert`, { method: 'POST', body: { confirm: true } }), (e) => e.status === 409);
  await A('/expenses/' + exp.id, { method: 'PUT', body: { ...exp } });

  await assert.rejects(A(`/imports/${res.id}/revert`, { method: 'POST', body: {} }), /Confirma/);
  await assert.rejects(B(`/imports/${res.id}/revert`, { method: 'POST', body: { confirm: true } }), (e) => e.status === 404);
  const rv = await A(`/imports/${res.id}/revert`, { method: 'POST', body: { confirm: true } });
  assert.equal(rv.removed, 2);
  const after = await A('/imports/' + res.id);
  assert.equal(after.status, 'revertida');
  assert.equal(after.events.length, 2, 'queda registro de auditoría');
  assert.ok(!(await A('/expenses')).some((e) => e.name.startsWith('Panaderia')));
  // Tras revertir se puede volver a importar
  const again = await analyze(A, 'revertir.csv', csv);
  assert.equal(again.rows.filter((r) => r.selected).length, 2);
});

test('pagos fijos detectados y marcados como pagados', async () => {
  const rec = await A('/recurring', { method: 'POST', body: { name: 'Spotify', amount: 10.99, categoryId: cat('Suscripciones'), frequency: 'monthly', dayOfMonth: +ymdAgo(1).slice(8), anchorDate: ymdAgo(1), autoAdd: false, remindDaysBefore: 1 } });
  const an = await analyze(A, 'spotify.csv', `Fecha;Concepto;Importe\n${dmy(1)};SPOTIFY P1234;-10,99\n`);
  assert.equal(an.rows[0].recurringMatch.id, rec.id);
  await commit(A, an);
  const r = (await A('/recurring')).find((x) => x.id === rec.id);
  assert.equal(r.state, 'paid');
  // Sugerencia de pago fijo: el mismo cargo cada mes
  const csv = `Fecha;Concepto;Importe\n${dmy(65)};RECIBO GYM PLUS;-29,00\n${dmy(35)};RECIBO GYM PLUS;-29,00\n${dmy(5)};RECIBO GYM PLUS;-29,00\n`;
  const res = await commit(A, await analyze(A, 'gym.csv', csv));
  assert.ok(res.recurringSuggestions.some((s) => /Gym/i.test(s.name) && s.amount === 29));
});
