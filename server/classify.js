// Interpretación de las descripciones bancarias: establecimiento, tipo de movimiento y categoría.
// Gratis y en el servidor: reglas del usuario > su propio historial > diccionario de comercios españoles.
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
const TYPES = {
  expense: { label: 'Gasto', sign: -1 },
  card: { label: 'Pago con tarjeta', sign: -1 },
  bill: { label: 'Recibo', sign: -1 },
  fee: { label: 'Comisión bancaria', sign: -1 },
  cash_withdrawal: { label: 'Retirada de efectivo', sign: -1 },
  income: { label: 'Ingreso', sign: 1 },
  refund: { label: 'Devolución', sign: 1 },
  cash_deposit: { label: 'Ingreso de efectivo', sign: 1 },
  transfer: { label: 'Transferencia', sign: 0 },
};
function typeOf(description, amount, kindHint = '') {
  const t = up(`${description} ${kindHint}`);
  const out = amount < 0;
  if (/COMISION|COM\.? MANT|CUOTA (ANUAL )?TARJETA|INTERESES DEUDORES|GASTOS (DE )?MANTENIMIENTO|COMISION DESCUBIERTO/.test(t) && out) return 'fee';
  if (/REINTEGRO|RETIRADA|DISPOSICION (DE )?EFECTIVO|CAJERO|\bATM\b/.test(t) && out) return 'cash_withdrawal';
  if (/INGRESO (EN )?EFECTIVO|INGRESO (EN )?CAJERO|IMPOSICION|DEPOSITO EFECTIVO/.test(t) && !out) return 'cash_deposit';
  if (/DEVOLUCION|REEMBOLSO|ANULACION|RETROCESION|\bREFUND\b|ABONO COMPRA/.test(t) && !out) return 'refund';
  if (/TRASPASO|TRANSFERENCIA (ENTRE CUENTAS|PROPIA|INTERNA)|ENTRE MIS CUENTAS|CUENTA PROPIA|A CUENTA DE AHORRO|DESDE CUENTA/.test(t)) return 'transfer';
  if (out) {
    if (/RECIBO|ADEUDO|DOMICILIA|\bSEPA\b|CARGO (DE )?RECIBO|\bDD\b/.test(t)) return 'bill';
    if (/COMPRA|TARJ|\bTJ\b|PAGO MOVIL|APPLE PAY|GOOGLE PAY|CONTACTLESS|\bPOS\b|DEBIT CARD|CARD PAYMENT/.test(t)) return 'card';
    return 'expense';
  }
  return 'income';
}
const paymentMethodOf = (type, description) => {
  const t = up(description);
  if (/BIZUM/.test(t)) return 'bizum';
  return { card: 'tarjeta', bill: 'domiciliacion', cash_withdrawal: 'efectivo', fee: 'otro' }[type] || (/TRANSF|TRF/.test(t) ? 'transferencia' : null);
};

// ---------- Diccionario de comercios (España) ----------
// [concepto, expresión, categorías del usuario que encajan (por orden de preferencia), categoría sugerida si no existe]
const CONCEPTS = [
  ['income', /NOMINA|SALARIO|\bPAGA (EXTRA)?\b|PENSION|PRESTACION|\bSEPE\b|SUBSIDIO/, [], 'Nómina'],
  ['fees', /COMISION|INTERESES DEUDORES|CUOTA (ANUAL )?TARJETA|MANTENIMIENTO CUENTA/, ['comisiones', 'banco', 'gastos bancarios', 'otros'], 'Comisiones'],
  ['subscriptions', /NETFLIX|SPOTIFY|\bHBO\b|HBOMAX|\bMAX\.COM|DISNEY|PRIME VIDEO|AMAZON PRIME|PRIMEVIDEO|APPLE\.COM|ITUNES|ICLOUD|YOUTUBE|DAZN|FILMIN|MOVISTAR ?\+|PATREON|OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI|MICROSOFT|XBOX|PLAYSTATION|NINTENDO|AUDIBLE|KINDLE|GOOGLE ?\*?(PLAY|ONE|STORAGE)|ADOBE|CANVA|DROPBOX|TWITCH|CRUNCHYROLL|ATRESPLAYER|SKYSHOWTIME|STORYTEL|TINDER/, ['suscripciones', 'servicios', 'ocio'], 'Suscripciones'],
  ['restaurants', /UBER ?EATS|JUST ?EAT|GLOVO|DELIVEROO|TELEPIZZA|DOMINO|BURGER KING|MC ?DONALD|\bKFC\b|\bTGB\b|FOSTER|RESTAURANT|\bBAR\b|CAFETERIA|CAFE\b|STARBUCKS|MONTADITOS|\bVIPS\b|GOIKO|TAGLIATELLA|GINOS|PIZZA|KEBAB|SUSHI|TABERNA|CERVECERIA|ASADOR|MESON|BRASERIA|PANS & COMPANY|RODILLA|TIM HORTONS|FIVE GUYS|POPEYES|WOK|TAPAS/, ['restaurantes', 'restauracion', 'comida', 'comer fuera', 'ocio'], 'Restaurantes'],
  ['groceries', /MERCADONA|CARREFOUR|\bLIDL\b|\bALDI\b|\bDIA\b|DIA %|EROSKI|CONSUM|ALCAMPO|HIPERCOR|SUPERCOR|AHORRAMAS|BONPREU|BONAREA|CAPRABO|\bGADIS\b|FROIZ|MAS Y MAS|SUPERMERCADO|SUPERMERCAT|\bCONDIS\b|\bSPAR\b|COVIRAN|\bLUPA\b|MAKRO|\bBM\b|EL ARBOL|HIPER ?USERA|MERCADO|FRUTERIA|CARNICERIA|PANADERIA|PESCADERIA|SIMPLY|SUPECO|LA PLAZA|DELIKIA|HIBER|CASH FRESH|FAMILIA|COALIMENT|SORLI/, ['supermercado', 'alimentacion', 'compra', 'super', 'comida'], 'Supermercado'],
  ['fuel', /REPSOL(?! (LUZ|ELECTRICIDAD|GAS NATURAL))|CEPSA|\bMOEVE\b|\bBP\b|\bGALP\b|\bSHELL\b|PETRONOR|PLENOIL|BALLENOIL|PETROPRIX|GASOLINERA|ESTACION (DE )?SERVICIO|\bE\.?S\.? |CARBURANTE|AVIA\b|PETROCAT|DISA\b|LOW ?COST GAS/, ['gasolina', 'combustible', 'carburante', 'coche', 'vehiculo', 'transporte'], 'Gasolina'],
  ['electricity', /ENDESA|IBERDROLA|NATURGY|REPSOL (LUZ|ELECTRICIDAD)|TOTALENERGIES|HOLALUZ|OCTOPUS|\bEDP\b|LUCERA|FACTOR ENERGIA|PODO|ENERGIA|ELECTRICA|CURENERGIA|COMERCIALIZADORA REGULADA|BASER|NIBA/, ['electricidad', 'luz', 'energia', 'suministros', 'facturas', 'casa', 'hogar'], 'Electricidad'],
  ['water', /\bAGUAS?\b|CANAL (DE )?ISABEL|AGBAR|AQUALIA|EMASESA|EMAYA|EMIVASA|AQUONA|GAS NATURAL|NEDGIA|BUTANO|NORTEGAS|MADRILENA RED DE GAS/, ['agua', 'gas', 'suministros', 'facturas', 'casa', 'hogar'], 'Suministros'],
  ['telecom', /MOVISTAR|TELEFONICA|VODAFONE|ORANGE|YOIGO|MASMOVIL|MAS MOVIL|PEPEPHONE|\bDIGI\b|\bLOWI\b|JAZZTEL|SIMYO|\bO2\b|FINETWORK|AVATEL|EUSKALTEL|\bR CABLE\b|TELECABLE|ADAMO|\bGUUK\b/, ['internet', 'telefono', 'telefonia', 'movil', 'telecomunicaciones', 'facturas'], 'Internet y teléfono'],
  ['health', /FARMACIA|PARAFARMACIA|CLINICA|DENTAL|DENTIST|HOSPITAL|SANITAS|ADESLAS|\bDKV\b|\bASISA\b|QUIRON|VITHAS|HM HOSPITALES|OPTICA|GENERAL OPTICA|MULTIOPTICAS|ALAIN AFFLELOU|FISIO|PSICOLOG|VETERINAR|LABORATORIO|MEDIC/, ['salud', 'farmacia', 'medico', 'sanidad'], 'Salud'],
  ['transport', /RENFE|\bMETRO\b|\bEMT\b|\bTMB\b|CABIFY|\bUBER\b(?! ?EATS)|\bBOLT\b|FREE ?NOW|BLABLACAR|\bALSA\b|AVANZA|PARKING|APARCAMIENTO|AUTOPISTA|PEAJE|VIA-?T|\bIRYO\b|OUIGO|VUELING|IBERIA|RYANAIR|AIR EUROPA|EASYJET|BICING|\bTAXI\b|\bITV\b|TALLER|NEUMATIC|NORAUTO|FEU VERT|MIDAS|TRANSPORTE|EMPARK|TELPARK|SABA|BONOMETRO|TARJETA TRANSPORTE|DGT/, ['transporte', 'coche', 'vehiculo', 'viajes'], 'Transporte'],
  ['housing', /ALQUILER|HIPOTECA|COMUNIDAD (DE )?PROPIETARIOS|\bIBI\b|INMOBILIARIA|ARRENDAMIENTO|LEROY MERLIN|BRICOMART|BRICO DEPOT|BAUHAUS|IKEA|FERRETERIA/, ['casa', 'hogar', 'vivienda', 'alquiler'], 'Casa'],
  ['insurance', /SEGURO|MAPFRE|MUTUA|LINEA DIRECTA|ALLIANZ|\bAXA\b|GENERALI|SANTALUCIA|OCASO|REALE|PELAYO|VERTI|\bRACE\b|ZURICH|HELVETIA|CASER|LIBERTY/, ['seguros', 'seguro', 'casa', 'facturas'], 'Seguros'],
  ['taxes', /\bAEAT\b|AGENCIA TRIBUTARIA|HACIENDA|AYUNTAMIENTO|AJUNTAMENT|\bTASA\b|IMPUESTO|SEG(URIDAD)? SOCIAL|\bTGSS\b|CUOTA AUTONOMO|MULTA/, ['impuestos', 'tasas', 'administracion', 'facturas', 'otros'], 'Impuestos'],
  ['education', /COLEGIO|ACADEMIA|UNIVERSIDAD|UNIVERSITAT|MATRICULA|LIBRERIA|ESCUELA|GUARDERIA|UDEMY|COURSERA|DOMESTIKA|FORMACION|AUTOESCUELA/, ['educacion', 'formacion', 'estudios', 'colegio'], 'Educación'],
  ['leisure', /\bCINE|CINESA|YELMO|KINEPOLIS|OCINE|TEATRO|TICKETMASTER|ENTRADAS|ATRAPALO|STEAM|EPIC GAMES|GIMNASIO|BASIC ?FIT|MC ?FIT|GO ?FIT|ALTAFIT|VIVAGYM|DREAMFIT|SMART ?FIT|ANYTIME FITNESS|\bDIR\b|PADEL|MUSEO|CONCIERTO|PARQUE|LOTERIA|BOOKING|AIRBNB|HOTEL|EDREAMS|LASTMINUTE|EXPEDIA|DESPEGAR/, ['ocio', 'deporte', 'gimnasio', 'viajes', 'entretenimiento'], 'Ocio'],
  ['shopping', /AMAZON|\bAMZN\b|ZARA|INDITEX|PRIMARK|H&M|\bH ?& ?M\b|MANGO|DECATHLON|EL CORTE INGLES|MEDIA ?MARKT|\bFNAC\b|ALIEXPRESS|SHEIN|PULL ?& ?BEAR|BERSHKA|STRADIVARIUS|LEFTIES|SPRINGFIELD|CORTEFIEL|PCCOMPONENTES|WALLAPOP|VINTED|\bTEMU\b|\bETSY\b|SPRINTER|JD SPORTS|FOOT LOCKER|DRUIDA|PRIMOR|SEPHORA|DOUGLAS|NOVA ?ICARIA|WORTEN|APPLE STORE|XIAOMI|ACTION\b|TIGER|KIKO|MASSIMO DUTTI|OYSHO|UNIQLO|NORMAL\b|ALE-HOP|CASA DEL LIBRO|TOYS|JUGUETTOS|PERFUMERIA|ROPA|ZAPATERIA/, ['compras', 'ropa', 'tiendas', 'shopping'], 'Compras'],
  ['cash', /REINTEGRO|RETIRADA (DE )?EFECTIVO|CAJERO|DISPOSICION EFECTIVO/, ['efectivo', 'otros'], 'Efectivo'],
];
const catNorm = (s) => norm(s).replace(/\s+/g, ' ');
function matchCategory(cats, prefs) {
  for (const p of prefs) {
    const c = cats.find((x) => catNorm(x.name) === p) || cats.find((x) => catNorm(x.name).startsWith(p)) || cats.find((x) => catNorm(x.name).split(' ').includes(p));
    if (c) return c;
  }
  return null;
}

/**
 * Clasifica un movimiento.
 * ctx = { cats, rules: Map(key→{categoryId,type}), history: Map(key→categoryId) }
 * Devuelve { merchant, key, type, categoryId, suggestedCategory, confidence (0-1), reason }
 */
function classify(row, ctx) {
  const merchant = merchantOf(row.description);
  const key = keyOf(row.description);
  let type = typeOf(row.description, row.amount, row.kindHint);
  const U = up(`${row.description} ${row.bankCategory || ''}`);
  const rule = key && ctx.rules.get(key);
  if (rule) {
    const okType = rule.type && TYPES[rule.type] && (TYPES[rule.type].sign === 0 || TYPES[rule.type].sign === Math.sign(row.amount));
    const cat = rule.categoryId && ctx.cats.find((c) => c.id === rule.categoryId);
    return { merchant, key, type: okType ? rule.type : type, categoryId: cat ? cat.id : null, suggestedCategory: '', confidence: 0.98, reason: 'Tu regla para este comercio' };
  }
  if (row.amount > 0 && ['income', 'cash_deposit', 'transfer'].includes(type)) {
    // Los ingresos no llevan categoría de gasto
    const concept = CONCEPTS.find(([id, re]) => id === 'income' && re.test(U));
    return { merchant, key, type, categoryId: null, suggestedCategory: '', incomeSource: concept ? 'nomina' : null, confidence: concept || type !== 'income' ? 0.9 : 0.7, reason: concept ? 'Nómina o prestación' : type === 'income' ? 'Abono en cuenta' : TYPES[type].label };
  }
  const hist = key && ctx.history.get(key);
  if (hist && ctx.cats.some((c) => c.id === hist)) return { merchant, key, type, categoryId: hist, suggestedCategory: '', confidence: 0.9, reason: 'Como tus otros gastos aquí' };
  for (const [id, re, prefs, suggestion] of CONCEPTS) {
    if (id === 'income') continue;
    if (re.test(U)) {
      const c = matchCategory(ctx.cats, prefs);
      return { merchant, key, type, categoryId: c ? c.id : null, suggestedCategory: c ? '' : suggestion, confidence: c ? 0.8 : 0.6, reason: `Reconocido como ${suggestion.toLowerCase()}` };
    }
  }
  if (type === 'transfer') return { merchant, key, type, categoryId: null, suggestedCategory: '', confidence: 0.6, reason: 'Parece un traspaso entre cuentas' };
  return { merchant, key, type, categoryId: null, suggestedCategory: '', confidence: merchant ? 0.3 : 0.1, reason: 'No reconocido: elige la categoría' };
}

module.exports = { classify, merchantOf, keyOf, typeOf, paymentMethodOf, TYPES, CONCEPTS };
