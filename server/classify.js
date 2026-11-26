// Motor de clasificación de movimientos: comercio, tipo de movimiento, categoría, subcategoría y confianza.
// Se usa para todo: extractos importados, bancos conectados, gastos manuales, tickets, ingresos y devoluciones.
// Orden de prioridad: tus reglas > tu historial > tu diccionario > diccionario general > IA (opcional) > sin clasificar.
// Nunca se inventa un establecimiento: solo se usa texto que aparece en la descripción.
const { norm } = require('./statements');

const up = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// Prefijos que los bancos añaden y no forman parte del nombre del comercio
const NOISE = [
  /\b(COMPRA|PAGO)\s+(CON\s+)?(TARJ(ETA)?\.?|TJ\.?)(\s+(CREDITO|DEBITO|CRED\.?|DEB\.?))?(\s+EN)?\b/g,
  /\b(DEVOLUCION|REEMBOLSO|ANULACION|RETROCESION|ABONO)(\s+(DE|DEL))?(\s+(LA\s+)?COMPRA)?(\s+(EN|DE))?\b/g,
  /\bCOMPRA\s+(EN|INTERNET( EN)?|ONLINE)\b/g, /^\s*COMPRA\b/g, /\bPAGO\s+(MOVIL|MOVIL EN|EN|CONTACTLESS|APPLE PAY|GOOGLE PAY)\b/g,
  /\bCON LA TARJETA\b.*?\bEN\b/g, /\bTARJ(ETA)?\.?\s*(\d|X|\*){4,}[\dX*\s]*/g, /\b\d{4}[*X]{4,}\d{0,4}\b/g, /[*X]{4,}\d{2,4}/g,
  /\b(RECIBO|ADEUDO|CARGO|DOMICILIACION|SEPA|CORE|B2B|COBRO)\b/g, /\b(TRANSFERENCIA|TRANSF\.?|TRF\.?|TRASPASO)\s+(A FAVOR DE|DE|A|RECIBIDA|EMITIDA|INMEDIATA|SEPA)?\b/g,
  /\bBIZUM\s+(ENVIADO|RECIBIDO|A|DE)?\b/g, /\b(FECHA|F\.?)\s*OPER\.?\b.*$/g, /\bREF[.:]?\s*\S+/g, /\b\d{2}[/.-]\d{2}([/.-]\d{2,4})?\b/g, /\b\d{2}:\d{2}\b/g,
  /\bES\d{2}[\dX\s]{10,}\b/g, /\b\d{5,}\b/g, /\bEUR\b|€/g, /[·|]/g,
];
const GENERIC = new Set(['', 'MOVIMIENTO', 'OPERACION', 'PAGO', 'COMPRA', 'VARIOS', 'CARGO', 'ABONO', 'EN', 'DE', 'A', 'SL', 'SA']);
function merchantOf(description) {
  let s = up(description).split('·')[0];
  for (const re of NOISE) s = s.replace(re, ' ');
  s = s.replace(/\b(WWW\.)?([A-Z0-9-]+)\.(COM|ES|NET|ORG|EU|IO|AI)\b\S*/g, '$2').replace(/[^A-Z0-9&'.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^((A|DE|DEL|EN|PARA|POR|RECIBIDA|EMITIDA|ENVIADO|RECIBIDO|FAVOR)\s+)+/, ''); // «BIZUM ENVIADO A JUAN» → «JUAN»
  // Fuera códigos de tienda y ciudades pegadas al final («MERCADONA 0452 VALENCIA» → «MERCADONA»)
  const keep = [];
  for (const w of s.split(' ')) {
    if (!w || /^[.\-]+$/.test(w)) continue;
    if (/^\d+$/.test(w)) { if (keep.length) break; continue; }
    if (keep.length >= 4 || (keep.length >= 2 && /\.|^(HELP|WWW|ES|MADRID|BARCELONA|VALENCIA|SEVILLA)$/.test(w))) break;
    keep.push(w);
  }
  const name = keep.join(' ').replace(/\b(S\.?L\.?U?|S\.?A\.?U?)\.?$/, '').trim();
  if (GENERIC.has(name)) return '';
  return name.split(' ').map((w) => (w.length <= 3 && /^[A-Z]+$/.test(w) && !['BAR', 'DIA', 'BP'].includes(w) ? w : w[0] + w.slice(1).toLowerCase())).join(' ').slice(0, 60);
}
// Clave para reglas y duplicados: las dos primeras palabras útiles del comercio
function keyOf(description) {
  const w = norm(merchantOf(description) || description).split(' ').filter((x) => x.length > 1 && !/^\d+$/.test(x));
  return (w[0] && w[0].length >= 5 ? w.slice(0, 1) : w.slice(0, 2)).join(' ');
}

// ---------- Tipos de movimiento ----------
// sign: -1 solo cargos, 1 solo abonos, 0 ambos. stats: si cuenta como gasto/ingreso en las estadísticas
const TYPES = {
  expense: { label: 'Gasto', sign: -1 },
  card: { label: 'Compra con tarjeta', sign: -1 },
  bill: { label: 'Recibo domiciliado', sign: -1 },
  subscription: { label: 'Suscripción', sign: -1 },
  fee: { label: 'Comisión bancaria', sign: -1 },
  cash_withdrawal: { label: 'Retirada de efectivo', sign: -1 },
  transfer_out: { label: 'Transferencia a otra persona', sign: -1 },
  card_settlement: { label: 'Pago de tarjeta de crédito', sign: -1 },
  income: { label: 'Ingreso', sign: 1 },
  refund: { label: 'Devolución', sign: 1 },
  cash_deposit: { label: 'Ingreso de efectivo', sign: 1 },
  transfer: { label: 'Transferencia entre mis cuentas', sign: 0 },
};
const U = (s) => ' ' + up(s).replace(/[^A-Z0-9&%+]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
const has = (txt, re) => re.test(txt);
function typeOf(description, amount, kindHint = '') {
  const t = U(`${description} ${kindHint}`);
  const out = amount < 0;
  if (out && has(t, / (LIQUIDACION|LIQ) (DE )?(LA )?TARJ| PAGO (DE )?(LA )?TARJETA (DE )?CREDITO| CARGO (DE )?(LA )?TARJETA (DE )?CREDITO| AMORTIZACION TARJETA| RECIBO TARJETA CREDITO| LIQUIDACION CREDITO/)) return 'card_settlement';
  if (out && has(t, / COMISION| COM MANT| CUOTA (ANUAL )?TARJETA| INTERESES DEUDORES| GASTOS (DE )?MANTENIMIENTO| COMISION DESCUBIERTO/)) return 'fee';
  if (out && has(t, / REINTEGRO| RETIRADA( DE)? EFECTIVO| RETIRADA CAJERO| DISPOSICION( DE)? EFECTIVO| CAJERO | ATM /)) return 'cash_withdrawal';
  if (!out && has(t, / INGRESO( EN)? EFECTIVO| INGRESO( EN)? CAJERO| IMPOSICION| DEPOSITO EFECTIVO/)) return 'cash_deposit';
  if (!out && has(t, / DEVOLUCION| REEMBOLSO| ANULACION| RETROCESION| REFUND | ABONO COMPRA/)) return 'refund';
  if (has(t, / TRASPASO| TRANSFERENCIA (ENTRE CUENTAS|PROPIA|INTERNA)| ENTRE MIS CUENTAS| CUENTA PROPIA| A CUENTA (DE )?AHORRO| DESDE CUENTA| A HUCHA| DE HUCHA| HUCHA | ESPACIO (DE )?AHORRO| APORTACION (A )?(OBJETIVO|HUCHA)/)) return 'transfer';
  if (out) {
    if (has(t, / BIZUM (ENVIADO|A) | TRANSFERENCIA (A FAVOR DE|EMITIDA|A) | TRANSF (EMITIDA|A FAVOR)| TRF (A|EMITIDA) /)) return 'transfer_out';
    if (has(t, / RECIBO| ADEUDO| DOMICILIA| SEPA | CARGO (DE )?RECIBO| DD /)) return 'bill';
    if (has(t, / COMPRA| TARJ| TJ | PAGO MOVIL| APPLE PAY| GOOGLE PAY| CONTACTLESS| POS | DEBIT CARD| CARD PAYMENT/)) return 'card';
    return 'expense';
  }
  return 'income';
}
// Persona o empresa al otro lado (transferencias, bizum, nóminas)
function counterpartyOf(description) {
  const t = up(description).replace(/\s+/g, ' ');
  const m = /(?:A FAVOR DE|BIZUM (?:ENVIADO A|RECIBIDO DE|A|DE)|TRANSFERENCIA (?:DE|A|RECIBIDA DE|EMITIDA A)|TRANSF\.? (?:DE|A)|ORDENANTE:?|BENEFICIARIO:?|NOMINA(?: DE)?|DE:)\s+([A-Z][A-Z .,&'-]{2,40})/.exec(t);
  if (!m) return '';
  return m[1].replace(/\b(CONCEPTO|REF|FECHA|S\.?L\.?|S\.?A\.?)\b.*$/, '').replace(/[.,\s]+$/, '').trim().split(' ').slice(0, 4).map((w) => w[0] + w.slice(1).toLowerCase()).join(' ');
}
const paymentMethodOf = (type, description) => {
  const t = up(description);
  if (/BIZUM/.test(t)) return 'bizum';
  return { card: 'tarjeta', bill: 'domiciliacion', subscription: /TARJ|COMPRA/.test(t) ? 'tarjeta' : 'domiciliacion', cash_withdrawal: 'efectivo', fee: 'otro', transfer_out: 'transferencia' }[type] || (/TRANSF|TRF/.test(t) ? 'transferencia' : null);
};

// ---------- Diccionario general de comercios y palabras (España) ----------
// Cada entrada: palabras (se buscan como palabras completas), categoría y subcategoría propuestas,
// nombres de categoría del usuario que encajan (por orden de preferencia) y, si hace falta, el tipo.
// Se puede ampliar o cambiar desde Ajustes → Clasificación (el diccionario del usuario tiene prioridad).
const W = (s) => s.split('|').map((x) => x.trim()).filter(Boolean);
const DICTIONARY = [
  { id: 'nomina', words: W('NOMINA|NOMINAS|PAYROLL|SALARIO|PAGA EXTRA|ABONO NOMINA'), category: 'Ingresos por nómina', subcategory: 'Nómina', prefs: [], income: 'nomina' },
  { id: 'pension', words: W('PENSION|PRESTACION|SEPE|SUBSIDIO|INSS'), category: 'Ingresos', subcategory: 'Pensión o prestación', prefs: [], income: 'otros' },
  { id: 'supermercado', words: W('MERCADONA|CARREFOUR|LIDL|ALDI|DIA|EROSKI|CONSUM|ALCAMPO|HIPERCOR|SUPERCOR|AHORRAMAS|BONPREU|BONAREA|CAPRABO|GADIS|FROIZ|MAS Y MAS|SUPERMERCADO|SUPERMERCADOS|SUPERMERCAT|CONDIS|SPAR|COVIRAN|LUPA|MAKRO|BM SUPERMERCADOS|EL ARBOL|SIMPLY|SUPECO|ALIMERKA|HIPERDINO|FAMILY CASH|COALIMENT|SORLI|DIA %|LA SIRENA|AMETLLER|VEritas|ECOVERITAS'), category: 'Alimentación', subcategory: 'Supermercado', prefs: ['alimentacion', 'supermercado', 'compra', 'super', 'comida'] },
  { id: 'tiendas-alimentacion', words: W('FRUTERIA|CARNICERIA|PANADERIA|PESCADERIA|FORN|HORNO|PASTELERIA|MERCADO MUNICIPAL'), category: 'Alimentación', subcategory: 'Tiendas de alimentación', prefs: ['alimentacion', 'supermercado', 'comida'] },
  { id: 'gasolina', words: W('REPSOL|CEPSA|MOEVE|BP|GALP|SHELL|PETRONOR|PLENOIL|BALLENOIL|PETROPRIX|GASOLINERA|ESTACION DE SERVICIO|ESTACION SERVICIO|CARBURANTE|CARBURANTES|AVIA|PETROCAT|DISA|LOW COST GAS|ES REPSOL|E S'), category: 'Gasolina', subcategory: 'Combustible', prefs: ['gasolina', 'combustible', 'carburante', 'coche', 'vehiculo', 'transporte'] },
  { id: 'suscripciones', words: W('NETFLIX|SPOTIFY|HBO|HBOMAX|HBO MAX|MAX COM|DISNEY|DISNEY PLUS|PRIME VIDEO|AMAZON PRIME|PRIMEVIDEO|APPLE COM BILL|APPLE COM|ITUNES|ICLOUD|YOUTUBE PREMIUM|YOUTUBE|DAZN|FILMIN|MOVISTAR PLUS|PATREON|OPENAI|CHATGPT|ANTHROPIC|CLAUDE AI|MICROSOFT 365|XBOX|PLAYSTATION|PLAYSTATION NETWORK|NINTENDO|AUDIBLE|KINDLE UNLIMITED|GOOGLE ONE|GOOGLE PLAY|GOOGLE STORAGE|ADOBE|CANVA|DROPBOX|TWITCH|CRUNCHYROLL|ATRESPLAYER|SKYSHOWTIME|STORYTEL|TINDER|DUOLINGO|LINKEDIN PREMIUM|NOTION'), category: 'Suscripciones', subcategory: 'Plataformas y apps', prefs: ['suscripciones', 'servicios', 'ocio'], type: 'subscription' },
  { id: 'electricidad', words: W('ENDESA|IBERDROLA|NATURGY|REPSOL LUZ|REPSOL ELECTRICIDAD|TOTALENERGIES|TOTAL ENERGIES|HOLALUZ|OCTOPUS|OCTOPUS ENERGY|EDP|LUCERA|FACTOR ENERGIA|PODO|CURENERGIA|COMERCIALIZADORA REGULADA|BASER|NIBA|ENERGIA XXI|ELECTRICIDAD|LUZ'), category: 'Electricidad', subcategory: 'Luz', prefs: ['electricidad', 'luz', 'energia', 'suministros', 'facturas', 'casa', 'hogar'] },
  { id: 'agua-gas', words: W('AGUA|AGUAS|CANAL DE ISABEL II|CANAL ISABEL|AGBAR|AIGUES|AQUALIA|EMASESA|EMAYA|EMIVASA|AQUONA|GAS NATURAL|NEDGIA|BUTANO|NORTEGAS|MADRILENA RED DE GAS'), category: 'Suministros', subcategory: 'Agua y gas', prefs: ['agua', 'gas', 'suministros', 'facturas', 'casa', 'hogar'] },
  { id: 'telefonia', words: W('MOVISTAR|TELEFONICA|VODAFONE|ORANGE|YOIGO|MASMOVIL|MAS MOVIL|PEPEPHONE|DIGI|LOWI|JAZZTEL|SIMYO|O2|FINETWORK|AVATEL|EUSKALTEL|R CABLE|TELECABLE|ADAMO|GUUK|VIRGIN TELCO|PARLEM'), category: 'Telefonía e internet', subcategory: 'Móvil y fibra', prefs: ['telefonia', 'internet', 'telefono', 'movil', 'telecomunicaciones', 'facturas'] },
  { id: 'salud', words: W('FARMACIA|PARAFARMACIA|CLINICA|DENTAL|DENTISTA|HOSPITAL|SANITAS|ADESLAS|DKV|ASISA|QUIRON|QUIRONSALUD|VITHAS|HM HOSPITALES|OPTICA|GENERAL OPTICA|MULTIOPTICAS|ALAIN AFFLELOU|FISIOTERAPIA|FISIO|PSICOLOGO|PSICOLOGIA|LABORATORIO|MEDICO|PODOLOGO'), category: 'Salud', subcategory: 'Farmacia y médicos', prefs: ['salud', 'farmacia', 'medico', 'sanidad'] },
  { id: 'veterinario', words: W('VETERINARIO|VETERINARIA|CLINICA VETERINARIA|KIWOKO|TIENDANIMAL'), category: 'Mascotas', subcategory: 'Veterinario y tienda', prefs: ['mascotas', 'mascota', 'animales', 'salud', 'otros'] },
  { id: 'restaurantes', words: W('UBER EATS|UBEREATS|JUST EAT|JUSTEAT|GLOVO|DELIVEROO|TELEPIZZA|DOMINOS|DOMINO S|BURGER KING|MCDONALDS|MC DONALDS|MCDONALD S|KFC|TGB|FOSTERS HOLLYWOOD|FOSTER S|RESTAURANTE|RESTAURANT|BAR|CAFETERIA|CAFE|STARBUCKS|100 MONTADITOS|MONTADITOS|VIPS|GOIKO|LA TAGLIATELLA|GINOS|PIZZERIA|KEBAB|SUSHI|TABERNA|CERVECERIA|ASADOR|MESON|BRASERIA|PANS COMPANY|RODILLA|TIM HORTONS|FIVE GUYS|POPEYES|WOK|TAPAS|TELEPI|PAPA JOHNS|HELADERIA'), category: 'Restaurantes y comida a domicilio', subcategory: 'Restaurantes', prefs: ['restaurantes', 'restauracion', 'comida', 'comer fuera', 'ocio'] },
  { id: 'transporte', words: W('RENFE|METRO|EMT|TMB|CABIFY|UBER|BOLT|FREENOW|FREE NOW|BLABLACAR|ALSA|AVANZA|IRYO|OUIGO|BICING|TAXI|BONOMETRO|TARJETA TRANSPORTE|CRTM|FGC|EUSKOTREN|TRAM'), category: 'Transporte', subcategory: 'Transporte público y taxi', prefs: ['transporte', 'viajes'] },
  { id: 'coche', words: W('PARKING|APARCAMIENTO|AUTOPISTA|PEAJE|VIA T|ITV|TALLER|NEUMATICOS|NORAUTO|FEU VERT|MIDAS|EMPARK|TELPARK|SABA|DGT|LAVADO'), category: 'Transporte', subcategory: 'Coche', prefs: ['coche', 'vehiculo', 'transporte'] },
  { id: 'viajes', words: W('VUELING|IBERIA|RYANAIR|AIR EUROPA|EASYJET|BOOKING|AIRBNB|HOTEL|EDREAMS|LASTMINUTE|EXPEDIA|DESPEGAR|TRIVAGO|NH HOTELES|MELIA'), category: 'Viajes', subcategory: 'Vuelos y alojamiento', prefs: ['viajes', 'vacaciones', 'ocio', 'transporte'] },
  { id: 'vivienda', words: W('ALQUILER|HIPOTECA|PRESTAMO HIPOTECARIO|COMUNIDAD DE PROPIETARIOS|COMUNIDAD PROPIETARIOS|CUOTA COMUNIDAD|IBI|INMOBILIARIA|ARRENDAMIENTO|RENTA VIVIENDA'), category: 'Vivienda', subcategory: 'Alquiler e hipoteca', prefs: ['vivienda', 'casa', 'hogar', 'alquiler'] },
  { id: 'hogar', words: W('IKEA|LEROY MERLIN|BRICOMART|BRICO DEPOT|BAUHAUS|AKI|FERRETERIA|CONFORAMA|JYSK|MAISONS DU MONDE'), category: 'Compras', subcategory: 'Hogar y bricolaje', prefs: ['hogar', 'casa', 'compras'] },
  { id: 'seguros', words: W('SEGURO|SEGUROS|MAPFRE|MUTUA MADRILENA|MUTUA|LINEA DIRECTA|ALLIANZ|AXA|GENERALI|SANTALUCIA|OCASO|REALE|PELAYO|VERTI|RACE|ZURICH|HELVETIA|CASER|LIBERTY|OCCIDENT|CATALANA OCCIDENTE|DIRECT SEGUROS'), category: 'Seguros', subcategory: 'Seguros', prefs: ['seguros', 'seguro', 'casa', 'facturas'] },
  { id: 'impuestos', words: W('AEAT|AGENCIA TRIBUTARIA|HACIENDA|AYUNTAMIENTO|AJUNTAMENT|TASA|TASAS|IMPUESTO|SEGURIDAD SOCIAL|SEG SOCIAL|TGSS|CUOTA AUTONOMO|MULTA|DIPUTACION'), category: 'Impuestos', subcategory: 'Impuestos y tasas', prefs: ['impuestos', 'tasas', 'administracion', 'facturas', 'otros'] },
  { id: 'educacion', words: W('COLEGIO|ACADEMIA|UNIVERSIDAD|UNIVERSITAT|MATRICULA|LIBRERIA|ESCUELA|GUARDERIA|UDEMY|COURSERA|DOMESTIKA|FORMACION|AUTOESCUELA|UNED'), category: 'Educación', subcategory: 'Estudios', prefs: ['educacion', 'formacion', 'estudios', 'colegio'] },
  { id: 'deporte', words: W('GIMNASIO|BASIC FIT|BASICFIT|MCFIT|MC FIT|GO FIT|GOFIT|ALTAFIT|VIVAGYM|DREAMFIT|SMARTFIT|SMART FIT|ANYTIME FITNESS|DIR|PADEL|PISCINA|POLIDEPORTIVO'), category: 'Ocio', subcategory: 'Deporte', prefs: ['deporte', 'gimnasio', 'ocio'] },
  { id: 'ocio', words: W('CINE|CINES|CINESA|YELMO|KINEPOLIS|OCINE|TEATRO|TICKETMASTER|ENTRADAS|ATRAPALO|STEAM|EPIC GAMES|MUSEO|CONCIERTO|PARQUE|LOTERIA|LOTERIAS|ONCE|BOLERA'), category: 'Ocio', subcategory: 'Ocio y cultura', prefs: ['ocio', 'entretenimiento'] },
  { id: 'tecnologia', words: W('PCCOMPONENTES|MEDIA MARKT|MEDIAMARKT|WORTEN|APPLE STORE|XIAOMI|FNAC|BACKMARKET|BACK MARKET'), category: 'Compras', subcategory: 'Tecnología', prefs: ['tecnologia', 'electronica', 'compras'] },
  { id: 'ropa', words: W('ZARA|INDITEX|PRIMARK|H&M|H M|MANGO|PULL&BEAR|PULL BEAR|BERSHKA|STRADIVARIUS|LEFTIES|SPRINGFIELD|CORTEFIEL|MASSIMO DUTTI|OYSHO|UNIQLO|SHEIN|KIABI|C&A|DECATHLON|SPRINTER|JD SPORTS|FOOT LOCKER|ZAPATERIA'), category: 'Compras', subcategory: 'Ropa y calzado', prefs: ['ropa', 'compras', 'tiendas'] },
  { id: 'compras', words: W('AMAZON|AMZN|AMAZON ES|AMAZON MKTPLACE|EL CORTE INGLES|ALIEXPRESS|WALLAPOP|VINTED|TEMU|ETSY|DRUNI|PRIMOR|SEPHORA|DOUGLAS|TIGER|ACTION|KIKO|NORMAL|ALE HOP|CASA DEL LIBRO|TOYS R US|JUGUETTOS|PERFUMERIA|MIRAVIA'), category: 'Compras', subcategory: 'Compras generales', prefs: ['compras', 'tiendas', 'shopping'] },
  { id: 'comisiones', words: W('COMISION|COMISIONES|INTERESES DEUDORES|CUOTA TARJETA|CUOTA ANUAL TARJETA|MANTENIMIENTO CUENTA|COMISION MANTENIMIENTO'), category: 'Comisiones bancarias', subcategory: 'Comisiones', prefs: ['comisiones', 'banco', 'gastos bancarios', 'otros'], type: 'fee' },
  { id: 'efectivo', words: W('REINTEGRO|RETIRADA EFECTIVO|RETIRADA DE EFECTIVO|CAJERO|DISPOSICION EFECTIVO'), category: 'Efectivo', subcategory: 'Retirada de efectivo', prefs: ['efectivo', 'otros'], type: 'cash_withdrawal' },
];
const ENTRY_BY_ID = new Map(DICTIONARY.map((e) => [e.id, e]));
// Pone cada palabra en forma comparable (mayúsculas, sin tildes, sin signos)
const wordKey = (w) => U(w).trim();
function matchWords(text, words) {
  let best = null;
  for (const w of words) {
    const k = wordKey(w);
    if (k && text.includes(` ${k} `) && (!best || k.length > best.length)) best = k;
  }
  return best;
}

// ---------- Confianza ----------
// Medida con scripts/calibrar-clasificacion.js sobre test/fixtures/clasificacion-control.json (66 movimientos que
// NO se usan para ajustar el diccionario). Resultado: 56/56 aciertos del diccionario. Con 0 fallos en 56 casos,
// la precisión real es ≥ 94,6 % con un 95 % de seguridad (regla de tres: 1 − 3/56), así que se usa 0,94 y no 1.
// Ojo: ese conjunto lo he escrito yo imitando extractos reales; con tus movimientos reales puede ser algo menor.
// Las coincidencias por palabras de 3 letras o menos (BAR, DIA, BP…) solo tienen 3 casos: se dejan en «revisar».
const CONFIDENCE = {
  rule: 0.97, // tu regla: la decisión es tuya (solo falla si la regla es demasiado amplia)
  history: 0.9, // has clasificado igual ese comercio al menos 2 veces y sin dudas (≥75 %)
  userDictionary: 0.92,
  dictionary: 0.94, // diccionario general, límite inferior medido en el conjunto de control
  dictionaryLoose: 0.7, // palabra corta y ambigua: se clasifica pero se marca para revisar
  ai: 0.7, // IA: siempre se revisa
  income: 0.9,
  typeOnly: 0.6,
  unknown: 0.2,
};
const HIGH = 0.85, MEDIUM = 0.6;
const reviewState = (c) => (c >= HIGH ? 'auto' : c >= MEDIUM ? 'review' : 'pending');

const catNorm = (s) => norm(s).replace(/\s+/g, ' ');
function matchCategory(cats, prefs) {
  for (const p of prefs) {
    const c = cats.find((x) => catNorm(x.name) === p) || (p.length >= 5 && cats.find((x) => catNorm(x.name).startsWith(p))) || cats.find((x) => catNorm(x.name).split(' ').includes(p));
    if (c) return c;
  }
  return null;
}

/**
 * Contexto del usuario para clasificar (se construye una vez por lote).
 * rules: [{match:'merchant'|'contains'|'counterparty', pattern, categoryId, subcategory, type, incomeSource}]
 * dictionary: entradas propias [{words, categoryId, subcategory, type, overrides, disabled}]
 * history: Map(clave de comercio → categoryId) con al menos 2 movimientos coincidentes
 */
function buildContext({ cats = [], rules = [], dictionary = [], history = new Map() } = {}) {
  const disabled = new Set(dictionary.filter((d) => d.disabled && d.overrides).map((d) => d.overrides));
  const overridden = new Map(dictionary.filter((d) => !d.disabled && d.overrides).map((d) => [d.overrides, d]));
  return { cats, rules, own: dictionary.filter((d) => !d.disabled && !d.overrides && d.words?.length), disabled, overridden, history };
}

function ruleMatches(r, { key, text, counterparty }) {
  const p = wordKey(r.pattern || r.key || '');
  if (!p) return false;
  if ((r.match || 'merchant') === 'merchant') return norm(key) === norm(r.pattern || r.key) || text.startsWith(` ${p} `) || text.includes(` ${p} `) && p.split(' ').length > 1;
  if (r.match === 'contains') return text.includes(` ${p} `);
  if (r.match === 'counterparty') return !!counterparty && wordKey(counterparty).includes(p);
  return false;
}
const typeFits = (type, amount) => type && TYPES[type] && (TYPES[type].sign === 0 || TYPES[type].sign === Math.sign(amount));

/**
 * Clasifica un movimiento { description, amount (+/−), kindHint?, bankCategory? }.
 * Devuelve { merchant, key, counterparty, type, categoryId, suggestedCategory, subcategory, incomeSource,
 *            rule (texto: qué lo ha clasificado), source, confidence (0-1), review ('auto'|'review'|'pending'), reason }
 */
function classify(row, ctx) {
  const description = String(row.description || '');
  const merchant = merchantOf(description);
  const key = keyOf(description);
  const counterparty = counterpartyOf(description);
  const text = U(`${description} ${row.bankCategory || ''}`);
  let type = typeOf(description, row.amount, row.kindHint);
  const base = { merchant, key, counterparty, type, categoryId: null, suggestedCategory: '', subcategory: '', incomeSource: null };
  const done = (o) => {
    const confidence = o.confidence;
    return { ...base, ...o, review: reviewState(confidence), reason: o.reason || o.rule };
  };

  // 1) Reglas del usuario (prioridad máxima). Si dos reglas se contradicen, se pide revisión.
  const hits = ctx.rules.filter((r) => ruleMatches(r, { key, text, counterparty }));
  if (hits.length) {
    const cats = new Set(hits.map((r) => r.categoryId || '').filter(Boolean));
    const r = hits.sort((a, b) => (b.match === 'merchant') - (a.match === 'merchant') || (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
    const cat = r.categoryId && ctx.cats.find((c) => c.id === r.categoryId);
    const t = typeFits(r.type, row.amount) ? r.type : type;
    const label = r.match === 'contains' ? `Tu regla: contiene «${r.pattern}»` : r.match === 'counterparty' ? `Tu regla: de/para «${r.pattern}»` : `Tu regla para ${merchant || r.pattern || r.key}`;
    if (cats.size > 1) return done({ type: t, categoryId: cat ? cat.id : null, subcategory: r.subcategory || '', incomeSource: r.incomeSource || null, rule: 'Reglas contradictorias', source: 'rule', confidence: 0.6, reason: 'Hay varias reglas tuyas que no coinciden: revísalo' });
    return done({ type: t, categoryId: cat ? cat.id : null, subcategory: r.subcategory || '', incomeSource: r.incomeSource || null, rule: label, source: 'rule', confidence: CONFIDENCE.rule });
  }

  // 2) Ingresos: no llevan categoría de gasto, pero sí origen (nómina, prestación…)
  if (row.amount > 0 && ['income', 'cash_deposit', 'transfer'].includes(type)) {
    const e = ['nomina', 'pension'].map((id) => ENTRY_BY_ID.get(id)).find((x) => !ctx.disabled.has(x.id) && matchWords(text, x.words));
    if (e) return done({ type, subcategory: e.subcategory, incomeSource: e.income, rule: `Diccionario: ${e.category}`, source: 'dictionary', confidence: CONFIDENCE.income });
    return done({ type, rule: type === 'income' ? 'Abono en cuenta' : TYPES[type].label, source: 'type', confidence: type === 'income' ? 0.75 : CONFIDENCE.income, reason: counterparty ? `Ingreso de ${counterparty}` : '' });
  }

  // 3) Tu historial: si ya has clasificado igual ese comercio
  const hist = key && ctx.history.get(key);
  if (hist && ctx.cats.some((c) => c.id === hist)) return done({ categoryId: hist, rule: 'Como tus otros movimientos de este comercio', source: 'history', confidence: CONFIDENCE.history });

  // 4) Tu diccionario (palabras añadidas en Ajustes)
  for (const d of ctx.own) {
    if (matchWords(text, d.words)) {
      const cat = ctx.cats.find((c) => c.id === d.categoryId);
      return done({ type: typeFits(d.type, row.amount) ? d.type : type, categoryId: cat ? cat.id : null, subcategory: d.subcategory || '', rule: `Tu diccionario: ${d.words.slice(0, 3).join(', ')}`, source: 'userDictionary', confidence: CONFIDENCE.userDictionary });
    }
  }

  // 5) Diccionario general (con tus cambios de categoría, si has editado alguna entrada)
  let best = null;
  for (const e of DICTIONARY) {
    if (e.income || ctx.disabled.has(e.id)) continue;
    const w = matchWords(text, e.words);
    if (w && (!best || w.length > best.w.length)) best = { e, w };
  }
  if (best) {
    const { e, w } = best;
    const ov = ctx.overridden.get(e.id);
    const cat = ov?.categoryId ? ctx.cats.find((c) => c.id === ov.categoryId) : matchCategory(ctx.cats, e.prefs);
    const t = e.type === 'subscription' ? (['card', 'bill', 'expense'].includes(type) ? 'subscription' : type) : typeFits(e.type, row.amount) && !['transfer_out', 'card_settlement'].includes(type) ? e.type : type;
    const loose = w.replace(/ /g, '').length <= 3;
    return done({
      type: t, categoryId: cat ? cat.id : null, suggestedCategory: cat ? '' : e.category, subcategory: ov?.subcategory || e.subcategory,
      rule: `Diccionario: ${w.toLowerCase()} → ${cat ? cat.name : e.category}`, source: 'dictionary', confidence: loose ? CONFIDENCE.dictionaryLoose : cat ? CONFIDENCE.dictionary : CONFIDENCE.dictionary - 0.15,
    });
  }

  // 6) Solo el tipo (transferencias, efectivo, pago de tarjeta…): no necesitan categoría
  if (['transfer', 'card_settlement', 'cash_withdrawal'].includes(type)) return done({ rule: TYPES[type].label, source: 'type', confidence: CONFIDENCE.typeOnly, reason: type === 'transfer' ? 'Parece un traspaso entre tus cuentas: confírmalo' : TYPES[type].label });
  if (type === 'transfer_out') return done({ rule: TYPES[type].label, source: 'type', confidence: CONFIDENCE.typeOnly, reason: counterparty ? `Transferencia a ${counterparty}: elige la categoría` : 'Transferencia: elige la categoría' });
  return done({ rule: 'Sin reconocer', source: 'none', confidence: CONFIDENCE.unknown, reason: 'No reconocido: elige la categoría' });
}

// ---------- IA opcional para descripciones desconocidas ----------
// Solo se usa con ANTHROPIC_API_KEY y si el usuario lo activa. Se envía ÚNICAMENTE la descripción limpia
// (sin números, IBAN ni importes) y la lista de categorías. El resultado siempre queda para revisar.
const cleanForAi = (s) => up(s).replace(/ES\d{2}[\dX\s]{10,}/g, '').replace(/\d+/g, ' ').replace(/[^A-Z&. ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
let aiClient = null;
async function aiClassify(descriptions, cats) {
  if (!process.env.ANTHROPIC_API_KEY || !descriptions.length || !cats.length) return [];
  const list = [...new Set(descriptions.map(cleanForAi).filter((d) => d.length >= 3))].slice(0, 60);
  if (!list.length) return [];
  try {
    const AnthropicModule = require('@anthropic-ai/sdk');
    const Anthropic = AnthropicModule.default || AnthropicModule;
    aiClient ||= new Anthropic();
    const names = cats.map((c) => c.name);
    const schema = {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, category: { type: 'string', enum: [...names, 'DESCONOCIDO'] } }, required: ['text', 'category'], additionalProperties: false } } },
      required: ['items'], additionalProperties: false,
    };
    const r = await aiClient.beta.messages.create({
      model: process.env.CLASSIFY_MODEL || process.env.ASSISTANT_MODEL || 'claude-opus-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: 'Clasificas descripciones de movimientos bancarios españoles en una de las categorías dadas. Si no hay pistas claras en el texto, responde DESCONOCIDO. No inventes comercios.',
      messages: [{ role: 'user', content: `Categorías: ${names.join(', ')}\n\nDescripciones:\n${list.map((d) => `- ${d}`).join('\n')}` }],
    });
    const data = JSON.parse(r.content.find((b) => b.type === 'text')?.text || '{"items":[]}');
    return data.items.filter((i) => i.category !== 'DESCONOCIDO').map((i) => ({ text: i.text, categoryId: cats.find((c) => c.name === i.category)?.id })).filter((i) => i.categoryId);
  } catch (e) {
    console.error('[clasificación] IA no disponible:', e.message);
    return [];
  }
}

module.exports = { classify, buildContext, merchantOf, keyOf, typeOf, counterpartyOf, paymentMethodOf, TYPES, DICTIONARY, CONFIDENCE, HIGH, MEDIUM, reviewState, aiClassify, cleanForAi, matchWords, U };
