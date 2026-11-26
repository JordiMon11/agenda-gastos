// Lectura de extractos bancarios: CSV, Excel (XLSX y XLS antiguo), PDF con texto, texto de OCR,
// OFX/QFX, CAMT.053 (XML ISO 20022) y Norma 43 (formato AEB de los bancos españoles).
// Todo se procesa en memoria: el archivo original nunca se guarda en el servidor.
//
// Resultado: { format, bank, iban, currency, rows:[mov], headers, sample, mapping, needsMapping, needsOcr, warnings }
// mov = { line, date, valueDate, description, amount (+ entra / − sale), currency, ref, bankId, balance, bankCategory, kindHint, error }
const zlib = require('zlib');

const MAX_ROWS = 20000;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const round = (n) => Math.round(n * 100) / 100;

// ---------- Bancos ----------
// Código de entidad (dígitos 5-8 del IBAN español) y palabras que lo identifican
const BANKS = [
  { id: 'caixabank', name: 'CaixaBank', codes: ['2100'], words: [/caixabank/, /\bla caixa\b/, /imagin/] },
  { id: 'bbva', name: 'BBVA', codes: ['0182'], words: [/\bbbva\b/] },
  { id: 'santander', name: 'Santander', codes: ['0049', '0030'], words: [/santander/] },
  { id: 'sabadell', name: 'Banco Sabadell', codes: ['0081'], words: [/sabadell/] },
  { id: 'ing', name: 'ING', codes: ['1465'], words: [/\bing direct\b/, /\bing bank\b/, /^ing\b/, /\bing espana\b/] },
  { id: 'openbank', name: 'Openbank', codes: ['0073'], words: [/openbank/] },
  { id: 'bankinter', name: 'Bankinter', codes: ['0128'], words: [/bankinter/] },
  { id: 'unicaja', name: 'Unicaja', codes: ['2103'], words: [/unicaja/] },
  { id: 'abanca', name: 'Abanca', codes: ['2080'], words: [/abanca/] },
  { id: 'kutxabank', name: 'Kutxabank', codes: ['2095'], words: [/kutxabank/] },
  { id: 'ibercaja', name: 'Ibercaja', codes: ['2085'], words: [/ibercaja/] },
  { id: 'cajamar', name: 'Cajamar', codes: ['3058'], words: [/cajamar/] },
  { id: 'evo', name: 'EVO Banco', codes: ['0239'], words: [/evo banco/] },
  { id: 'revolut', name: 'Revolut', codes: [], words: [/revolut/] },
  { id: 'n26', name: 'N26', codes: [], words: [/\bn26\b/] },
];
const bankById = (id) => BANKS.find((b) => b.id === id) || null;
const IBAN_RE = /\bES\s?\d{2}[\s-]?(\d{4})[\s-]?\d{4}[\s-]?\d{2}[\s-]?\d{10}\b|\bES\d{2}(\d{4})\d{16}\b/;
function detectBank({ fileName = '', text = '', entity = '' }) {
  if (entity) {
    const b = BANKS.find((x) => x.codes.includes(entity));
    if (b) return { id: b.id, name: b.name, by: 'código de entidad' };
  }
  const m = IBAN_RE.exec(text.toUpperCase());
  const code = m && (m[1] || m[2]);
  if (code) {
    const b = BANKS.find((x) => x.codes.includes(code));
    if (b) return { id: b.id, name: b.name, by: 'IBAN' };
  }
  const f = norm(fileName.replace(/[_\-.]+/g, ' '));
  for (const b of BANKS) if (b.words.some((w) => w.test(f))) return { id: b.id, name: b.name, by: 'nombre del archivo' };
  const t = norm(text.slice(0, 20000));
  for (const b of BANKS) if (b.words.some((w) => w.test(t))) return { id: b.id, name: b.name, by: 'contenido del extracto' };
  return null;
}
function findIban(text) {
  const m = /\bES\s?\d{2}(?:[\s-]?\d{4}){5}\b/.exec(String(text).toUpperCase());
  return m ? m[0].replace(/[\s-]/g, '') : '';
}

// ---------- Números y fechas (formatos españoles y europeos) ----------
// Pista de separador decimal de una columna: ',' si algún valor acaba en ,dd ; '.' si acaba en .dd
function decimalHint(values) {
  let comma = 0, dot = 0;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const s = v.replace(/[^\d.,]/g, '');
    if (/,\d{1,2}$/.test(s)) comma++;
    else if (/\.\d{1,2}$/.test(s)) dot++;
  }
  return comma >= dot ? ',' : '.';
}
function parseAmount(v, hint = ',') {
  if (typeof v === 'number') return Number.isFinite(v) ? round(v) : null;
  let s = String(v ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/−|–/g, '-').replace(/eur(os)?|€|\s| /gi, '');
  if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
  if (/^[+-]/.test(s)) { if (s[0] === '-') neg = !neg; s = s.slice(1); }
  if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return null;
  s = s.replace(/'/g, '');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let dec = null;
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastComma >= 0) dec = /^\d{1,3}(,\d{3}){2,}$/.test(s) ? null : (/^\d{1,3},\d{3}$/.test(s) && hint === '.') ? null : ',';
  else if (lastDot >= 0) dec = /^\d{1,3}(\.\d{3})+$/.test(s) && hint !== '.' ? null : (s.split('.').length > 2 ? null : '.');
  let n;
  if (dec === ',') n = Number(s.replace(/\./g, '').replace(',', '.'));
  else if (dec === '.') n = Number(s.replace(/,/g, ''));
  else n = Number(s.replace(/[.,]/g, ''));
  if (!Number.isFinite(n) || n > 1e9) return null;
  return round(neg ? -n : n);
}
const MONTHS = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
function validYmd(y, m, d) {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}
const fullYear = (y) => (y < 100 ? (y > 70 ? 1900 + y : 2000 + y) : y);
// order: 'dmy' (España) o 'mdy' si el archivo lo usa
function parseDate(v, { order = 'dmy', year = null } = {}) {
  if (v instanceof Date && !isNaN(v)) return validYmd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) { // número de serie de Excel
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    if (v > 19900101 && v < 21001231) v = String(v);
    else return null;
  }
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})(\d{2})(\d{2})(?:\d{6})?(?:\.\d+)?(?:\[.*\])?$/.exec(s))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(s))) {
    let a = +m[1], b = +m[2];
    const y = fullYear(+m[3]);
    if (order === 'mdy' || (a <= 12 && b > 12)) [a, b] = [b, a];
    return validYmd(y, b, a);
  }
  if ((m = /^(\d{1,2})[-/. ]+([a-z]{3})[a-z]*\.?[-/. ]+(\d{2,4})\b/.exec(s)) && MONTHS[m[2]]) return validYmd(fullYear(+m[3]), MONTHS[m[2]], +m[1]);
  if (year && (m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(s))) return validYmd(year, +m[2], +m[1]);
  if (year && (m = /^(\d{1,2})[-/. ]+([a-z]{3})[a-z]*\.?$/.exec(s)) && MONTHS[m[2]]) return validYmd(year, MONTHS[m[2]], +m[1]);
  return null;
}
// ¿Las fechas del archivo son día/mes o mes/día? Si alguna tiene el primer número > 12 es día/mes.
function dateOrder(values) {
  let dmy = 0, mdy = 0;
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(String(v ?? '').trim());
    if (!m) continue;
    if (+m[1] > 12) dmy++;
    if (+m[2] > 12) mdy++;
  }
  return mdy > dmy ? 'mdy' : 'dmy';
}

// ---------- Texto y codificación ----------
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// ---------- CSV ----------
function splitCsv(text, delim) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell.trim() === '') { q = true; cell = ''; }
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length > MAX_ROWS + 200) break;
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}
function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 40);
  let best = ';', score = -1;
  for (const d of [';', ',', '\t', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1).filter((n) => n > 0);
    if (!counts.length) continue;
    const freq = {};
    for (const n of counts) freq[n] = (freq[n] || 0) + 1;
    const top = Math.max(...Object.values(freq));
    const s = top * 10 + counts.length;
    if (s > score) { score = s; best = d; }
  }
  return best;
}

// ---------- Columnas: reconocer encabezados de cualquier banco ----------
const FIELDS = {
  date: ['dia', 'fecha operacion', 'fecha de operacion', 'f operacion', 'f oper', 'fecha oper', 'f operativa', 'fecha operativa', 'fecha', 'fecha movimiento', 'fecha contable', 'f contable', 'fecha transaccion', 'fecha de la operacion', 'date', 'booking date', 'transaction date', 'fecha cargo'],
  valueDate: ['fecha valor', 'f valor', 'fecha de valor', 'value date', 'valor'],
  description: ['concepto', 'descripcion', 'concepto comun', 'movimiento', 'detalle', 'description', 'operacion', 'texto', 'concepto operacion', 'descripcion operacion', 'nombre', 'comercio', 'establecimiento', 'payee', 'beneficiario', 'ordenante'],
  extra: ['mas datos', 'concepto ampliado', 'observaciones', 'informacion adicional', 'detalles', 'comentario', 'notas', 'referencia ampliada', 'concepto propio', 'memo'],
  amount: ['importe', 'importe eur', 'importe euros', 'importe e', 'cantidad', 'amount', 'importe operacion', 'monto', 'importe movimiento', 'valor movimiento'],
  debit: ['debe', 'cargo', 'cargos', 'salidas', 'debito', 'adeudo', 'importe cargo', 'gasto', 'gastos', 'retiradas'],
  credit: ['haber', 'abono', 'abonos', 'entradas', 'credito', 'importe abono', 'ingreso', 'ingresos'],
  balance: ['saldo', 'saldo disponible', 'saldo contable', 'balance', 'saldo tras operacion', 'saldo posterior', 'disponible', 'saldo e', 'saldo eur'],
  currency: ['divisa', 'moneda', 'currency'],
  ref: ['referencia', 'ref', 'referencia 1', 'n operacion', 'numero operacion', 'numero de operacion', 'codigo operacion', 'id operacion', 'id', 'num operacion', 'referencia operacion', 'n documento'],
  sign: ['d/h', 'dh', 'debe/haber', 'cargo/abono', 'signo'],
  kind: ['tipo', 'tipo movimiento', 'tipo de movimiento', 'tipo operacion', 'clase'],
  bankCategory: ['categoria', 'subcategoria', 'category'],
};
const FIELD_LABELS = {
  ignore: 'No usar', date: 'Fecha', valueDate: 'Fecha valor', description: 'Descripción', extra: 'Más detalles', amount: 'Importe (con signo)',
  debit: 'Gasto / Debe', credit: 'Ingreso / Haber', balance: 'Saldo', currency: 'Moneda', ref: 'Referencia', sign: 'Signo (D/H)', kind: 'Tipo', bankCategory: 'Categoría del banco',
};
function headerField(h) {
  const n = norm(h).replace(/\b(eur|euros|e)\b$/, '').trim() || norm(h);
  for (const [f, list] of Object.entries(FIELDS)) if (list.includes(n) || list.includes(norm(h))) return f;
  for (const [f, list] of Object.entries(FIELDS)) if (list.some((a) => a.length > 3 && n.startsWith(a + ' '))) return f;
  return null;
}
// Mapeo automático: { colIndex: field }. Si hay varias columnas de descripción, la primera es la descripción y el resto «más detalles».
function autoMapping(headers) {
  const map = {};
  const used = {};
  headers.forEach((h, i) => {
    let f = headerField(h);
    if (!f) return;
    if (f === 'description' && used.description) f = 'extra';
    if (['date', 'valueDate', 'amount', 'balance', 'currency', 'ref', 'debit', 'credit', 'sign', 'kind'].includes(f) && used[f]) {
      if (f === 'date' && !used.valueDate) f = 'valueDate';
      else return;
    }
    used[f] = true;
    map[i] = f;
  });
  return map;
}
const mappingOk = (map) => {
  const f = new Set(Object.values(map));
  return (f.has('date') || f.has('valueDate')) && (f.has('amount') || f.has('debit') || f.has('credit')) && (f.has('description') || f.has('extra'));
};
// Fila de encabezados: la primera de las 40 primeras con al menos 3 columnas reconocidas
function findHeaderRow(rows) {
  let best = -1, bestScore = 1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const s = rows[i].filter((c) => headerField(c)).length;
    if (s > bestScore) { best = i; bestScore = s; }
    if (s >= 4) break;
  }
  return best;
}
const signature = (headers) => headers.map((h) => norm(h)).join('|').slice(0, 500);

// Filas de una tabla → movimientos
function rowsFromTable(table, { mapping, headerIndex }) {
  const body = table.slice(headerIndex + 1);
  const col = (f) => Object.keys(mapping).filter((k) => mapping[k] === f).map(Number);
  const one = (f) => col(f)[0];
  const cAmount = one('amount'), cDebit = one('debit'), cCredit = one('credit'), cDate = one('date'), cValue = one('valueDate');
  const hint = decimalHint(body.flatMap((r) => [r[cAmount], r[cDebit], r[cCredit], r[one('balance')]]).filter((x) => x !== undefined).slice(0, 2000));
  const order = dateOrder(body.flatMap((r) => [r[cDate], r[cValue]]).slice(0, 2000));
  const out = [];
  body.forEach((r, i) => {
    if (out.length >= MAX_ROWS) return;
    const cell = (c) => (c === undefined ? '' : r[c]);
    const text = (cs) => cs.map((c) => clean(cell(c))).filter(Boolean).join(' · ');
    let amount = null;
    if (cAmount !== undefined) amount = parseAmount(cell(cAmount), hint);
    if (amount === null && (cDebit !== undefined || cCredit !== undefined)) {
      const d = parseAmount(cell(cDebit), hint), c = parseAmount(cell(cCredit), hint);
      if (d) amount = -Math.abs(d);
      else if (c) amount = Math.abs(c);
      else if (d === 0 || c === 0) amount = 0;
    }
    const sign = norm(cell(one('sign')));
    if (amount !== null && sign) {
      if (/^(d|debe|cargo|debito|-)$/.test(sign)) amount = -Math.abs(amount);
      else if (/^(h|haber|abono|credito|\+)$/.test(sign)) amount = Math.abs(amount);
    }
    const kindTxt = clean(cell(one('kind')));
    if (amount !== null && kindTxt && cAmount !== undefined && !/^[+-]/.test(String(cell(cAmount)).trim()) && typeof cell(cAmount) !== 'number') {
      const k = norm(kindTxt);
      if (/^(cargo|adeudo|debe|gasto|pago)\b/.test(k)) amount = -Math.abs(amount);
      else if (/^(abono|haber|ingreso)\b/.test(k)) amount = Math.abs(amount);
    }
    const rawDate = cell(cDate !== undefined ? cDate : cValue);
    const date = parseDate(rawDate, { order });
    const description = text(col('description')) || text(col('extra'));
    if (!description && amount === null && !date) return; // fila vacía o de totales
    if (!date && amount === null) return;
    if (/^(total|saldo (inicial|final|anterior)|suma)/.test(norm(description)) && !date) return;
    const extra = col('description').length ? text(col('extra')) : '';
    out.push({
      line: headerIndex + 2 + i,
      date,
      valueDate: cValue !== undefined ? parseDate(cell(cValue), { order }) : null,
      description: clean([description, extra].filter(Boolean).join(' · ')).slice(0, 300),
      amount,
      currency: clean(cell(one('currency'))).toUpperCase().slice(0, 3) || 'EUR',
      ref: clean(cell(one('ref'))).slice(0, 80),
      bankId: '',
      balance: one('balance') !== undefined ? parseAmount(cell(one('balance')), hint) : null,
      bankCategory: text(col('bankCategory')).slice(0, 80),
      kindHint: kindTxt.slice(0, 60),
      error: !date ? `Fecha no válida (${clean(rawDate).slice(0, 20) || 'vacía'})` : amount === null ? 'Importe no válido' : amount === 0 ? 'Importe 0' : '',
    });
  });
  return out;
}

function fromTable(table, ctx, { savedMapping } = {}) {
  const hi = findHeaderRow(table);
  const headerIndex = hi >= 0 ? hi : 0;
  const headers = (table[headerIndex] || []).map((h, i) => clean(h) || `Columna ${i + 1}`);
  const width = Math.max(headers.length, ...table.slice(headerIndex, headerIndex + 30).map((r) => r.length));
  while (headers.length < width) headers.push(`Columna ${headers.length + 1}`);
  const sig = signature(headers);
  let mapping = ctx.mapping || (savedMapping && savedMapping(sig)) || autoMapping(headers);
  if (hi < 0 && !ctx.mapping) mapping = {};
  const metaText = table.slice(0, headerIndex).map((r) => r.join(' ')).join('\n');
  const base = {
    headers, signature: sig, mapping, headerIndex,
    sample: table.slice(headerIndex + 1, headerIndex + 6).map((r) => headers.map((_, i) => clean(r[i]).slice(0, 60))),
    metaText,
  };
  if (!mappingOk(mapping)) return { ...base, needsMapping: true, rows: [] };
  return { ...base, needsMapping: false, rows: rowsFromTable(table, { mapping, headerIndex }) };
}

// ---------- Excel XLSX (exceljs) ----------
// Comprueba el ZIP antes de abrirlo: evita «bombas zip» (archivos que ocupan GB al descomprimir)
function zipUncompressedSize(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('El archivo Excel está dañado');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16), total = 0;
  if (n > 2000) throw bad('El archivo Excel tiene demasiadas partes');
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('El archivo Excel está dañado');
    total += buf.readUInt32LE(p + 24);
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return total;
}
async function xlsxTables(buf) {
  if (zipUncompressedSize(buf) > 150 * 1024 * 1024) throw bad('El archivo Excel es demasiado grande al descomprimirlo');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const tables = [];
  wb.eachSheet((ws) => {
    const t = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (t.length > MAX_ROWS + 200) return;
      const r = [];
      row.eachCell({ includeEmpty: true }, (c, i) => {
        let v = c.value;
        if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join('') : '');
        r[i - 1] = v instanceof Date || typeof v === 'number' ? v : String(v ?? '');
      });
      for (let i = 0; i < r.length; i++) if (r[i] === undefined) r[i] = '';
      t.push(r);
    });
    tables.push(t);
  });
  return tables;
}

// ---------- Excel XLS antiguo (BIFF8 dentro de un archivo OLE) ----------
function oleStream(buf, names) {
  if (buf.length < 512) throw bad('Archivo XLS dañado');
  const secSize = 1 << buf.readUInt16LE(0x1e);
  const miniSize = 1 << buf.readUInt16LE(0x20);
  const nFat = buf.readUInt32LE(0x2c);
  const dirStart = buf.readInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readInt32LE(0x3c);
  let difatSec = buf.readInt32LE(0x44);
  const off = (s) => 512 + s * secSize;
  const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(buf.readInt32LE(0x4c + i * 4));
  let guard = 0;
  while (fatSecs.length < nFat && difatSec >= 0 && guard++ < 1000) {
    for (let i = 0; i < secSize / 4 - 1 && fatSecs.length < nFat; i++) fatSecs.push(buf.readInt32LE(off(difatSec) + i * 4));
    difatSec = buf.readInt32LE(off(difatSec) + secSize - 4);
  }
  const fat = [];
  for (const s of fatSecs) for (let i = 0; i < secSize / 4; i++) { const o = off(s) + i * 4; fat.push(o + 4 <= buf.length ? buf.readInt32LE(o) : -2); }
  const chain = (start, table, max = 1e6) => {
    const out = [];
    for (let s = start; s >= 0 && out.length < max; s = table[s]) { if (out.includes(s) && out.length > 50000) break; out.push(s); }
    return out;
  };
  const readChain = (start) => Buffer.concat(chain(start, fat).map((s) => buf.subarray(off(s), off(s) + secSize)));
  const dir = readChain(dirStart);
  const entries = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nl = dir.readUInt16LE(p + 0x40);
    entries.push({ name: dir.toString('utf16le', p, p + Math.max(0, nl - 2)), type: dir[p + 0x42], start: dir.readInt32LE(p + 0x74), size: dir.readUInt32LE(p + 0x78) });
  }
  const e = entries.find((x) => x.type === 2 && names.includes(x.name));
  if (!e) throw bad('El archivo XLS no contiene una hoja de cálculo');
  if (e.size >= cutoff) return readChain(e.start).subarray(0, e.size);
  const root = entries.find((x) => x.type === 5);
  const mini = readChain(root.start);
  const miniFatBuf = readChain(miniFatStart);
  const miniFat = [];
  for (let i = 0; i + 4 <= miniFatBuf.length; i += 4) miniFat.push(miniFatBuf.readInt32LE(i));
  return Buffer.concat(chain(e.start, miniFat).map((s) => mini.subarray(s * miniSize, (s + 1) * miniSize))).subarray(0, e.size);
}
function xlsTables(buf) {
  const wb = oleStream(buf, ['Workbook', 'Book']);
  const recs = [];
  for (let p = 0; p + 4 <= wb.length;) {
    const type = wb.readUInt16LE(p), len = wb.readUInt16LE(p + 2);
    recs.push({ type, data: wb.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  // Cadenas compartidas (SST), que pueden continuar en registros CONTINUE
  const sst = [];
  const readStrings = (parts, count) => {
    let pi = 0, p = 0;
    const cur = () => parts[pi];
    const need = () => { if (p >= cur().length && pi < parts.length - 1) { pi++; p = 0; return true; } return false; };
    for (let k = 0; k < count && pi < parts.length; k++) {
      need();
      if (p + 3 > cur().length) break;
      let cch = cur().readUInt16LE(p); let flags = cur()[p + 2]; p += 3;
      let runs = 0, ext = 0;
      if (flags & 8) { runs = cur().readUInt16LE(p); p += 2; }
      if (flags & 4) { ext = cur().readUInt32LE(p); p += 4; }
      let s = '';
      while (cch > 0) {
        if (p >= cur().length) { if (!need()) break; flags = cur()[p]; p += 1; }
        const wide = flags & 1;
        const avail = Math.floor((cur().length - p) / (wide ? 2 : 1));
        const n = Math.min(cch, avail);
        s += wide ? cur().toString('utf16le', p, p + n * 2) : cur().toString('latin1', p, p + n);
        p += n * (wide ? 2 : 1); cch -= n;
        if (n === 0 && !need()) break;
      }
      let skip = runs * 4 + ext;
      while (skip > 0) { if (p >= cur().length && !need()) break; const n = Math.min(skip, cur().length - p); p += n; skip -= n; }
      sst.push(s);
    }
  };
  const rk = (v) => {
    let n = v & 2 ? v >> 2 : (() => { const b = Buffer.alloc(8); b.writeUInt32LE(v & 0xfffffffc, 4); return b.readDoubleLE(0); })();
    return v & 1 ? n / 100 : n;
  };
  const tables = [];
  let t = null, inSheet = false, pendingStr = null;
  const set = (r, c, v) => { if (!t || r > MAX_ROWS + 200 || c > 200) return; (t[r] ||= [])[c] = v; };
  for (let i = 0; i < recs.length; i++) {
    const { type, data } = recs[i];
    if (type === 0x0809) { inSheet = data.length >= 4 && data.readUInt16LE(2) === 0x10; if (inSheet) t = []; continue; }
    if (type === 0x000a) { if (inSheet && t) tables.push(t); inSheet = false; t = null; continue; }
    if (type === 0x00fc) {
      const parts = [data.subarray(8)];
      while (recs[i + 1]?.type === 0x003c) parts.push(recs[++i].data);
      readStrings(parts, data.readUInt32LE(4));
      continue;
    }
    if (!inSheet || data.length < 6) continue;
    const r = data.readUInt16LE(0), c = data.readUInt16LE(2);
    if (type === 0x00fd && data.length >= 10) set(r, c, sst[data.readUInt32LE(6)] ?? '');
    else if (type === 0x0203 && data.length >= 14) set(r, c, data.readDoubleLE(6));
    else if (type === 0x027e && data.length >= 10) set(r, c, rk(data.readInt32LE(6)));
    else if (type === 0x00bd) {
      const last = data.readUInt16LE(data.length - 2);
      for (let k = 0, cc = c; cc <= last && 4 + k * 6 + 6 <= data.length - 2; k++, cc++) set(r, cc, rk(data.readInt32LE(4 + k * 6 + 2)));
    } else if (type === 0x0204 && data.length >= 9) {
      const cch = data.readUInt16LE(6), wide = data[8] & 1;
      set(r, c, wide ? data.toString('utf16le', 9, 9 + cch * 2) : data.toString('latin1', 9, 9 + cch));
    } else if (type === 0x0006 && data.length >= 14) {
      if (data.readUInt16LE(12) === 0xffff) { if (data[6] === 0) pendingStr = [r, c]; }
      else set(r, c, data.readDoubleLE(6));
    } else if (type === 0x0207 && pendingStr) {
      const cch = data.readUInt16LE(0), wide = data[2] & 1;
      set(pendingStr[0], pendingStr[1], wide ? data.toString('utf16le', 3, 3 + cch * 2) : data.toString('latin1', 3, 3 + cch));
      pendingStr = null;
    }
  }
  return tables.map((tb) => {
    const out = [];
    for (let r = 0; r < tb.length; r++) {
      const row = tb[r] || [];
      const arr = [];
      for (let c = 0; c < row.length; c++) arr.push(row[c] ?? '');
      out.push(arr);
    }
    return out.filter((r) => r.some((x) => x !== ''));
  });
}

// ---------- HTML y «XML Spreadsheet 2003» (algunos bancos los guardan con extensión .xls) ----------
const decodeEntities = (s) => String(s).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(+n, 0x10ffff))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)));
const stripTags = (s) => clean(decodeEntities(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')));
function htmlTables(text) {
  const tables = [];
  for (const tm of text.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const t = [];
    for (const rm of tm[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const row = [...rm[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]));
      if (row.some(Boolean)) t.push(row);
      if (t.length > MAX_ROWS + 200) break;
    }
    if (t.length) tables.push(t);
  }
  return tables;
}
function xmlSpreadsheetTables(text) {
  const tables = [];
  for (const wm of text.matchAll(/<(?:ss:)?Worksheet[\s\S]*?<\/(?:ss:)?Worksheet>/gi)) {
    const t = [];
    for (const rm of wm[0].matchAll(/<(?:ss:)?Row[^>]*?(?:\/>|>([\s\S]*?)<\/(?:ss:)?Row>)/gi)) {
      const row = [];
      for (const cm of (rm[1] || '').matchAll(/<(?:ss:)?Cell([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:ss:)?Cell>)/gi)) {
        const idx = /(?:ss:)?Index="(\d+)"/i.exec(cm[1]);
        if (idx) while (row.length < +idx[1] - 1) row.push('');
        const dm = /<(?:ss:)?Data[^>]*?(?:ss:)?Type="(\w+)"[^>]*>([\s\S]*?)<\/(?:ss:)?Data>/i.exec(cm[2] || '');
        let v = dm ? stripTags(dm[2]) : '';
        if (dm && dm[1] === 'Number' && v !== '') v = Number(v);
        else if (dm && dm[1] === 'DateTime') v = v.slice(0, 10);
        row.push(v);
      }
      if (row.some((x) => x !== '')) t.push(row);
    }
    tables.push(t);
  }
  return tables;
}

// ---------- OFX / QFX ----------
function ofxRows(text) {
  const tag = (block, name) => {
    const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
    return m ? decodeEntities(m[1]).trim() : '';
  };
  const rows = [];
  let i = 0;
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)) {
    if (rows.length >= MAX_ROWS) break;
    const b = m[1];
    const amount = parseAmount(tag(b, 'TRNAMT'), '.');
    const date = parseDate(tag(b, 'DTPOSTED').slice(0, 8)) || parseDate(tag(b, 'DTUSER').slice(0, 8));
    const description = clean([tag(b, 'NAME') || tag(b, 'PAYEE'), tag(b, 'MEMO')].filter(Boolean).join(' · '));
    rows.push({
      line: ++i, date, valueDate: parseDate(tag(b, 'DTAVAIL').slice(0, 8)), description: description.slice(0, 300), amount,
      currency: (tag(b, 'CURRENCY') || tag(text, 'CURDEF') || 'EUR').slice(0, 3).toUpperCase(),
      ref: tag(b, 'REFNUM') || tag(b, 'CHECKNUM'), bankId: tag(b, 'FITID').slice(0, 120), balance: null, bankCategory: '', kindHint: tag(b, 'TRNTYPE'),
      error: !date ? 'Fecha no válida' : amount === null ? 'Importe no válido' : '',
    });
  }
  return { rows, entity: tag(text, 'BANKID').slice(0, 4), iban: tag(text, 'ACCTID'), currency: tag(text, 'CURDEF') || 'EUR', org: tag(text, 'ORG') };
}

// ---------- CAMT.053 (ISO 20022) ----------
function camtRows(text) {
  if (/<!ENTITY/i.test(text)) throw bad('El archivo XML contiene construcciones no permitidas');
  const first = (block, path) => {
    let cur = block;
    for (const p of path) {
      const m = new RegExp(`<(?:\\w+:)?${p}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${p}>`, 'i').exec(cur);
      if (!m) return '';
      cur = m[1];
    }
    return decodeEntities(cur.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  };
  const rows = [];
  let i = 0;
  for (const m of text.matchAll(/<(?:\w+:)?Ntry(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Ntry>/gi)) {
    if (rows.length >= MAX_ROWS) break;
    const b = m[1];
    const amt = /<(?:\w+:)?Amt[^>]*?(?:Ccy="(\w+)")?[^>]*>([^<]+)<\/(?:\w+:)?Amt>/i.exec(b);
    let amount = amt ? parseAmount(amt[2], '.') : null;
    if (amount !== null && /DBIT/i.test(first(b, ['CdtDbtInd']))) amount = -Math.abs(amount);
    const credit = /CRDT/i.test(first(b, ['CdtDbtInd']));
    const date = parseDate((first(b, ['BookgDt', 'Dt']) || first(b, ['BookgDt', 'DtTm'])).slice(0, 10));
    const party = credit ? first(b, ['RltdPties', 'Dbtr', 'Nm']) : first(b, ['RltdPties', 'Cdtr', 'Nm']);
    const ustrd = [...b.matchAll(/<(?:\w+:)?Ustrd>([^<]*)<\/(?:\w+:)?Ustrd>/gi)].map((x) => decodeEntities(x[1]).trim()).join(' ');
    const description = clean([party, ustrd, first(b, ['AddtlNtryInf'])].filter(Boolean).join(' · '));
    rows.push({
      line: ++i, date, valueDate: parseDate((first(b, ['ValDt', 'Dt']) || '').slice(0, 10)), description: description.slice(0, 300), amount,
      currency: (amt && amt[1]) || 'EUR', ref: first(b, ['NtryRef']) || first(b, ['EndToEndId']), bankId: (first(b, ['AcctSvcrRef']) || first(b, ['TxId'])).slice(0, 120),
      balance: null, bankCategory: '', kindHint: first(b, ['BkTxCd', 'Prtry', 'Cd']).slice(0, 40),
      error: !date ? 'Fecha no válida' : amount === null ? 'Importe no válido' : '',
    });
  }
  const iban = first(text, ['Acct', 'Id', 'IBAN']);
  return { rows, iban, entity: /^ES\d{2}(\d{4})/.exec(iban)?.[1] || '' };
}

// ---------- Norma 43 (cuaderno 43 de la AEB) ----------
function n43Rows(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  let entity = '', currency = 'EUR', cur = null;
  const ymd6 = (s) => validYmd(2000 + +s.slice(0, 2), +s.slice(2, 4), +s.slice(4, 6));
  for (const l of lines) {
    const t = l.slice(0, 2);
    if (t === '11') { entity = l.slice(2, 6); currency = { '978': 'EUR', '840': 'USD', '826': 'GBP' }[l.slice(47, 50)] || 'EUR'; }
    else if (t === '22') {
      const amount = round((+l.slice(28, 42) / 100) * (l[27] === '1' ? -1 : 1));
      cur = { line: rows.length + 1, date: ymd6(l.slice(10, 16)), valueDate: ymd6(l.slice(16, 22)), description: '', amount: Number.isFinite(amount) ? amount : null, currency, ref: clean(l.slice(42, 52)), bankId: clean(l.slice(52, 80)), balance: null, bankCategory: '', kindHint: l.slice(22, 24), error: '' };
      cur.error = !cur.date ? 'Fecha no válida' : cur.amount === null ? 'Importe no válido' : '';
      rows.push(cur);
      if (rows.length >= MAX_ROWS) break;
    } else if (t === '23' && cur) cur.description = clean(`${cur.description} ${l.slice(4, 42)} ${l.slice(42, 80)}`).slice(0, 300);
  }
  const COMMON = { '01': 'Talones / reintegros', '02': 'Abonarés / ingresos', '03': 'Recibo / domiciliación', '04': 'Giros / transferencias', '06': 'Remesa de efectos', '12': 'Tarjetas', '15': 'Nómina', '17': 'Gastos / comisiones' };
  for (const r of rows) if (!r.description) r.description = COMMON[r.kindHint] || 'Movimiento';
  return { rows, entity };
}
const isN43 = (text) => /^11\d{18}/.test(text) && /^22/m.test(text) && /^33/m.test(text);

// ---------- Texto libre: PDF con texto o resultado del OCR ----------
const AMOUNT_TOKEN = /[+-−]?\(?\d{1,3}(?:[.\s]\d{3})*,\d{2}\)?-?(?:\s?€|\s?EUR)?|[+-]?\d+\.\d{2}(?=\s|$)/g;
const DATE_START = /^\s*(\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[a-zA-Z]{3}\.?(?:\s+\d{2,4})?)\b/;
const SKIP_LINE = /^(saldo (anterior|inicial|final)|total|suma y sigue|pagina|hoja|fecha\s+(operacion|valor)|movimientos|extracto|titular|iban|bic|swift|periodo|n[ºo°] de cuenta)/;
function textRows(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const years = {};
  for (const m of String(text).matchAll(/\b\d{1,2}[/.-]\d{1,2}[/.-](20\d{2})\b/g)) years[m[1]] = (years[m[1]] || 0) + 1;
  const year = +Object.keys(years).sort((a, b) => years[b] - years[a])[0] || new Date().getFullYear();
  const rows = [];
  let last = null;
  for (const l of lines) {
    if (rows.length >= MAX_ROWS) break;
    const nl = norm(l);
    const dm = DATE_START.exec(l);
    if (!dm) {
      if (last && !SKIP_LINE.test(nl) && !(l.match(AMOUNT_TOKEN) || []).length && l.length < 120 && last.continuations++ < 2) last.description = clean(`${last.description} ${l}`).slice(0, 300);
      continue;
    }
    let rest = l.slice(dm[0].length).trim();
    const d1 = parseDate(dm[1], { year });
    let d2 = null;
    const dm2 = DATE_START.exec(rest);
    if (dm2) { d2 = parseDate(dm2[1], { year }); rest = rest.slice(dm2[0].length).trim(); }
    const amounts = [...rest.matchAll(AMOUNT_TOKEN)];
    if (!amounts.length || !d1) { last = null; continue; }
    // Los importes van al final de la línea: el último puede ser el saldo
    const tail = amounts.filter((a) => a.index >= rest.length * 0.25 || amounts.length === 1);
    const vals = tail.map((a) => ({ txt: a[0], v: parseAmount(a[0].replace(/\s(?=\d{3})/g, '.'), ',') })).filter((x) => x.v !== null);
    if (!vals.length) { last = null; continue; }
    const descEnd = tail[0].index;
    const description = clean(rest.slice(0, descEnd).replace(/\s[DH]$/, ''));
    if (!description || SKIP_LINE.test(norm(description))) { last = null; continue; }
    const signed = (x) => /^[+-−]|-$|^\(/.test(x.txt.trim());
    let amount, balance = null;
    if (vals.length >= 2) { amount = vals[vals.length - 2]; balance = vals[vals.length - 1].v; }
    else amount = vals[0];
    const dh = / ([DH])\b/.exec(rest.slice(descEnd));
    let v = amount.v;
    if (dh) v = dh[1] === 'D' ? -Math.abs(v) : Math.abs(v);
    last = { line: rows.length + 1, date: d1, valueDate: d2, description: description.slice(0, 300), amount: v, currency: 'EUR', ref: '', bankId: '', balance, bankCategory: '', kindHint: '', unsigned: !signed(amount) && !dh, error: '', continuations: 0 };
    rows.push(last);
  }
  // Signo por la evolución del saldo cuando el extracto no lo indica (columnas Debe/Haber en el PDF)
  const withBal = rows.filter((r) => r.balance !== null);
  if (withBal.length >= 2) {
    let asc = 0, desc = 0;
    for (let i = 1; i < withBal.length; i++) {
      const a = withBal[i - 1], b = withBal[i];
      if (Math.abs(round(b.balance - a.balance)) === Math.abs(b.amount)) asc++;
      if (Math.abs(round(a.balance - b.balance)) === Math.abs(a.amount)) desc++;
    }
    for (let i = 0; i < withBal.length; i++) {
      const r = withBal[i];
      let delta = null;
      if (asc >= desc && i > 0) delta = round(r.balance - withBal[i - 1].balance);
      else if (desc > asc && i < withBal.length - 1) delta = round(r.balance - withBal[i + 1].balance);
      if (delta !== null && Math.abs(delta) === Math.abs(r.amount)) { r.amount = delta; r.unsigned = false; }
    }
  }
  for (const r of rows) {
    if (r.unsigned) {
      // Sin signo ni saldo: se decide por las palabras, y se marca para revisar
      r.amount = /abono|ingreso|nomina|transferencia (recibida|a su favor)|devolucion|reembolso|bizum (de|recibido)|intereses a su favor/.test(norm(r.description)) ? Math.abs(r.amount) : -Math.abs(r.amount);
      r.signGuessed = true;
    }
    delete r.unsigned;
    delete r.continuations;
  }
  return rows;
}

// ---------- PDF ----------
let pdfjs = null;
async function pdfText(buf) {
  pdfjs ||= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
  const pages = Math.min(doc.numPages, 200);
  const out = [];
  try {
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const lines = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const x = it.transform[4], y = it.transform[5];
        let line = lines.find((l) => Math.abs(l.y - y) < 3);
        if (!line) lines.push((line = { y, parts: [] }));
        line.parts.push({ x, w: it.width || 0, s: it.str });
      }
      lines.sort((a, b) => b.y - a.y);
      for (const l of lines) {
        l.parts.sort((a, b) => a.x - b.x);
        let s = '', end = null;
        for (const pt of l.parts) {
          if (end !== null && pt.x - end > 1.5) s += pt.x - end > 12 ? '   ' : ' ';
          s += pt.s;
          end = pt.x + pt.w;
        }
        out.push(s);
      }
      out.push('');
    }
  } finally {
    await doc.destroy();
  }
  return { text: out.join('\n'), pages: doc.numPages };
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// ---------- Entrada principal ----------
const EXT = /\.(csv|txt|tsv|xls|xlsx|pdf|ofx|qfx|xml|camt|053|n43|aeb|q43|htm|html)$/i;
function sniff(buf, name) {
  const h = buf.subarray(0, 8);
  if (h.toString('latin1', 0, 4) === '%PDF') return 'pdf';
  if (h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04) return 'xlsx';
  if (h.readUInt32BE(0) === 0xd0cf11e0) return 'xls';
  if (h[0] === 0xff && h[1] === 0xd8) return 'image';
  if (h.toString('latin1', 1, 4) === 'PNG') return 'image';
  if (h.toString('latin1', 0, 2) === 'MZ' || h.toString('latin1', 1, 4) === 'ELF') return 'binary';
  if (buf.subarray(0, 4096).includes(0) && !(buf[0] === 0xff && buf[1] === 0xfe) && !(buf[0] === 0xfe && buf[1] === 0xff)) return 'binary';
  return 'text';
}

/**
 * Analiza un extracto.
 * @param {{ name: string, buffer: Buffer, text?: string, mapping?: object, savedMapping?: (sig)=>object }} f
 */
async function parse({ name = '', buffer, text: ocrText, mapping, savedMapping }) {
  const warnings = [];
  const ctx = { mapping: mapping && Object.keys(mapping).length ? mapping : null };
  let format, rows = [], bank = null, iban = '', entity = '', extraText = '', tableInfo = null, needsOcr = false;

  if (typeof ocrText === 'string') {
    format = 'ocr';
    rows = textRows(ocrText);
    extraText = ocrText;
    warnings.push('Datos leídos con OCR desde una imagen: revisa fechas e importes antes de importar.');
  } else {
    if (!buffer?.length) throw bad('El archivo está vacío');
    const kind = sniff(buffer, name);
    if (kind === 'binary') throw bad('Este archivo no es un extracto válido');
    if (kind === 'image') throw bad('Las fotos se leen con OCR en tu dispositivo: vuelve a subirla desde la pantalla de importación');
    if (kind === 'text' && !EXT.test(name) && name) warnings.push('La extensión del archivo no es habitual; se ha leído como texto.');
    if (kind === 'pdf') {
      format = 'pdf';
      let pt;
      try { pt = await pdfText(buffer); } catch (e) {
        if (/password/i.test(e?.name || e?.message || '')) throw bad('El PDF está protegido con contraseña. Descárgalo sin contraseña desde tu banco.');
        throw bad('No se ha podido leer el PDF');
      }
      extraText = pt.text;
      rows = textRows(pt.text);
      if (pt.text.replace(/\s/g, '').length < 40 * pt.pages || rows.length === 0) {
        needsOcr = true;
        format = 'pdf-escaneado';
      }
    } else if (kind === 'xlsx' || kind === 'xls') {
      format = kind;
      let tables;
      try { tables = kind === 'xlsx' ? await xlsxTables(buffer) : xlsTables(buffer); } catch (e) {
        throw bad(e.status ? e.message : 'No se ha podido leer el archivo Excel');
      }
      const t = tables.find((x) => findHeaderRow(x) >= 0) || tables.find((x) => x.length) || [];
      tableInfo = fromTable(t, ctx, { savedMapping });
      rows = tableInfo.rows;
      extraText = tableInfo.metaText;
    } else {
      const text = decodeText(buffer);
      const head = text.slice(0, 3000);
      if (/OFXHEADER|<OFX>/i.test(head)) {
        format = /\.qfx$/i.test(name) ? 'qfx' : 'ofx';
        const r = ofxRows(text);
        rows = r.rows; entity = r.entity; iban = r.iban; extraText = r.org;
      } else if (/camt\.05[234]|<BkToCstmrStmt|<(\w+:)?Ntry>/i.test(text.slice(0, 20000))) {
        format = 'camt.053';
        const r = camtRows(text);
        rows = r.rows; iban = r.iban; entity = r.entity;
      } else if (isN43(text)) {
        format = 'norma43';
        const r = n43Rows(text);
        rows = r.rows; entity = r.entity;
      } else if (/urn:schemas-microsoft-com:office:spreadsheet/i.test(head)) {
        format = 'xml-excel';
        const t = xmlSpreadsheetTables(text).find((x) => findHeaderRow(x) >= 0) || [];
        tableInfo = fromTable(t, ctx, { savedMapping });
        rows = tableInfo.rows; extraText = tableInfo.metaText;
      } else if (/<table/i.test(text.slice(0, 50000))) {
        format = 'html';
        const t = htmlTables(text).find((x) => findHeaderRow(x) >= 0) || htmlTables(text).sort((a, b) => b.length - a.length)[0] || [];
        tableInfo = fromTable(t, ctx, { savedMapping });
        rows = tableInfo.rows; extraText = stripTags(text.slice(0, 20000));
      } else if (/^\s*</.test(text)) {
        throw bad('Este XML no es un extracto CAMT.053 ni una hoja de Excel');
      } else {
        // CSV o texto copiado
        const delim = detectDelimiter(text);
        const table = splitCsv(text, delim);
        if (findHeaderRow(table) >= 0 || ctx.mapping || table.filter((r) => r.length >= 3).length > table.length * 0.6) {
          format = 'csv';
          tableInfo = fromTable(table, ctx, { savedMapping });
          rows = tableInfo.rows; extraText = tableInfo.metaText;
        } else {
          format = 'texto';
          rows = textRows(text);
          extraText = text.slice(0, 5000);
        }
      }
    }
  }

  iban = iban || findIban(extraText);
  bank = detectBank({ fileName: name, text: `${iban} ${extraText}`, entity });
  if (rows.length >= MAX_ROWS) warnings.push(`Se han leído los primeros ${MAX_ROWS} movimientos.`);
  if (rows.some((r) => r.signGuessed)) warnings.push('En algunos movimientos el extracto no indica si es cargo o abono: se ha deducido y conviene revisarlo.');
  const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];
  if (currencies.some((c) => c !== 'EUR')) warnings.push(`Hay movimientos en otra moneda (${currencies.filter((c) => c !== 'EUR').join(', ')}): se importan con su importe sin convertir.`);
  return {
    format,
    bank,
    iban: iban ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}` : '',
    rows,
    needsOcr,
    needsMapping: !!tableInfo?.needsMapping,
    headers: tableInfo?.headers || null,
    sample: tableInfo?.sample || null,
    mapping: tableInfo?.mapping || null,
    signature: tableInfo?.signature || null,
    warnings,
  };
}

module.exports = { parse, parseAmount, parseDate, detectBank, textRows, autoMapping, splitCsv, detectDelimiter, BANKS, bankById, FIELD_LABELS, norm, xlsTables, ofxRows, camtRows, n43Rows };
