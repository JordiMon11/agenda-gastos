/* Escáner de tickets: lee la foto (con IA si el servidor la tiene, o gratis en el dispositivo con OCR),
   detecta total, tienda, categoría y fecha, guarda el gasto de hoy y lo abre para poder cambiarlo. */

let aiScan = null;
async function scanStatus() {
  if (aiScan === null) {
    try { aiScan = (await api('/receipts/status')).ai; } catch { aiScan = false; }
  }
  return aiScan;
}

// ---------- Elegir la foto ----------
function pickReceipt() {
  const choose = (capture) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    if (capture) inp.capture = 'environment';
    inp.onchange = () => { if (inp.files[0]) processReceipt(inp.files[0]); };
    inp.click();
  };
  if (!matchMedia('(pointer: coarse)').matches) return choose(false);
  openModal({
    title: 'Escanear ticket',
    icon: 'scan-line',
    actions: false,
    html: `<p class="set-desc">Haz la foto al ticket <b>entero</b>, recto y con buena luz. Se guardará como gasto de hoy y luego podrás cambiar lo que quieras.</p>
      <div class="action-list">
        <button type="button" id="scCam">${ic('camera')}<span>Hacer una foto<small>Abre la cámara</small></span></button>
        <button type="button" id="scGal">${ic('image')}<span>Elegir de la galería<small>Una foto que ya tengas</small></span></button>
      </div>`,
  });
  $('#scCam').onclick = () => { closeModal(); choose(true); };
  $('#scGal').onclick = () => { closeModal(); choose(false); };
}

// ---------- Ventana de progreso ----------
function showScanProgress(previewUrl) {
  openModal({
    title: 'Leyendo el ticket',
    icon: 'scan-line',
    actions: false,
    locked: true,
    html: `<div class="scan-box"><img src="${previewUrl}" alt="Foto del ticket"><div class="scan-line"></div></div>
      <div class="scan-status"><span id="scanTxt">Preparando la foto…</span><b id="scanPct">0%</b></div>
      <div class="progress"><div id="scanBar" style="width:2%"></div></div>`,
  });
}
function updateScan(txt, pct) {
  if ($('#scanTxt')) $('#scanTxt').textContent = txt;
  if ($('#scanPct')) $('#scanPct').textContent = `${Math.min(100, Math.round(pct))}%`;
  if ($('#scanBar')) $('#scanBar').style.width = `${Math.min(100, pct)}%`;
}

// ---------- Imagen ----------
async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('No se pudo abrir la foto')); img.src = url; });
    return img;
  }
}
function drawScaled(src, maxSide, minSide = 0) {
  const w0 = src.width, h0 = src.height;
  let k = Math.min(1, maxSide / Math.max(w0, h0));
  if (minSide && Math.min(w0, h0) * k < minSide) k = Math.min(maxSide / Math.max(w0, h0) * 1.5, minSide / Math.min(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k);
  c.height = Math.round(h0 * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
// Escala de grises con más contraste: ayuda mucho al OCR con tickets térmicos
function preprocessForOcr(src) {
  const c = drawScaled(src, 2200, 1200);
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    v = Math.max(0, Math.min(255, (v - 128) * 1.5 + 140));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------- OCR gratuito en el dispositivo ----------
let ocrWorker = null;
async function loadTesseract() {
  if (window.Tesseract) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '/vendor/tesseract/tesseract.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('No se pudo cargar el lector de tickets'));
    document.head.appendChild(s);
  });
}
async function ocrReceipt(bitmap) {
  updateScan('Cargando el lector (solo tarda la primera vez)…', 8);
  await loadTesseract();
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker('spa', 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract-core',
      langPath: '/vendor/tessdata',
      workerBlobURL: false,
      gzip: true,
      logger: (m) => {
        if (m.status === 'recognizing text') updateScan('Leyendo el texto del ticket…', 40 + m.progress * 55);
        else if (typeof m.progress === 'number') updateScan('Preparando el lector…', 10 + m.progress * 28);
      },
    });
  }
  updateScan('Leyendo el texto del ticket…', 40);
  const { data } = await ocrWorker.recognize(preprocessForOcr(bitmap));
  return { source: 'ocr', ...parseReceipt(data.text || '') };
}

// ---------- Interpretar el texto del ticket ----------
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const STORES = [
  ['Facturas', /\b(ENDESA|IBERDROLA|NATURGY|HOLALUZ|TOTALENERGIES|CANAL DE ISABEL|AIGUES|MOVISTAR|VODAFONE|ORANGE|YOIGO|DIGI|MASMOVIL|PEPEPHONE|LOWI|SIMYO)\b/],
  ['Supermercado', /\b(MERCADONA|LIDL|CARREFOUR|DIA|ALDI|EROSKI|ALCAMPO|CONSUM|CAPRABO|BONPREU|BON PREU|CONDIS|HIPERCOR|SUPERCOR|AHORRAMAS|GADIS|FROIZ|SIMPLY|COVIRAN|SPAR|ALIMERKA|LUPA|HIPERDINO|BM SUPERMERCADOS|MAS Y MAS|SUPERMERCADO|SUPERMERCAT|HIPERMERCADO|FRUTERIA|CARNICERIA|PESCADERIA)\b/],
  ['Transporte', /\b(REPSOL|CEPSA|MOEVE|BP|GALP|SHELL|PETRONOR|PLENOIL|BALLENOIL|PETROPRIX|GASOLINERA|ESTACION DE SERVICIO|GASOLEO|DIESEL|SIN PLOMO|RENFE|METRO|TMB|EMT|ALSA|CABIFY|UBER|BOLT|PARKING|APARCAMIENTO|PEAJE|AUTOPISTA|TAXI|VUELING|RYANAIR|IBERIA)\b/],
  ['Salud', /\b(FARMACIA|PARAFARMACIA|FARMACIA|CLINICA|DENTAL|OPTICA|HOSPITAL|FISIOTERAPIA)\b/],
  ['Comida', /\b(MCDONALD'?S?|BURGER KING|KFC|TELEPIZZA|DOMINO'?S|STARBUCKS|100 MONTADITOS|MONTADITOS|FOSTER'?S|TACO BELL|VIPS|GOIKO|RODILLA|FIVE GUYS|TGB|RESTAURANTE|RESTAURANT|CAFETERIA|CAFE|BAR|TABERNA|PIZZERIA|BRASERIA|ASADOR|MESON|CERVECERIA|HELADERIA|PANADERIA|PASTELERIA|FORN|HORNO|GLOVO|JUST EAT|SUSHI|KEBAB|WOK)\b/],
  ['Casa', /\b(IKEA|LEROY MERLIN|BRICOMART|BRICODEPOT|BAUHAUS|AKI|FERRETERIA|CONFORAMA|JYSK|MAISONS DU MONDE|KIABI HOME)\b/],
  ['Ocio', /\b(CINESA|YELMO|KINEPOLIS|OCINE|CINE|CINES|TEATRO|TICKETMASTER|BOLERA|MUSEO|GAME|STEAM|PLAYSTATION|NINTENDO)\b/],
  ['Compras', /\b(ZARA|H ?& ?M|PRIMARK|MANGO|DECATHLON|EL CORTE INGLES|CORTE INGLES|PULL ?& ?BEAR|BERSHKA|STRADIVARIUS|LEFTIES|SPRINGFIELD|CORTEFIEL|FNAC|MEDIA ?MARKT|PCCOMPONENTES|AMAZON|ALIEXPRESS|SHEIN|PRIMOR|DRUNI|SEPHORA|DOUGLAS|TIGER|ACTION|NORMAL|KIKO|MERCERIA|LIBRERIA|PAPELERIA|JUGUETERIA)\b/],
];
const GENERIC = /^(SUPERMERCADO|SUPERMERCAT|HIPERMERCADO|RESTAURANTE|RESTAURANT|CAFETERIA|CAFE|BAR|FARMACIA|PARAFARMACIA|GASOLINERA|ESTACION DE SERVICIO|PANADERIA|PASTELERIA|TABERNA|PIZZERIA|FRUTERIA|CARNICERIA|PESCADERIA|CINE|CINES|TAXI|PARKING|APARCAMIENTO|FERRETERIA|LIBRERIA|PAPELERIA|MERCERIA|HORNO|FORN|HELADERIA|CERVECERIA|ASADOR|MESON|BRASERIA|SUSHI|KEBAB|WOK|GASOLEO|DIESEL|SIN PLOMO|PEAJE|AUTOPISTA|METRO|CLINICA|DENTAL|OPTICA|HOSPITAL|FISIOTERAPIA|GAME|MUSEO|TEATRO|BOLERA|AGUA)$/;
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'&.-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\bH & M\b/i, 'H&M');

const AMT_RE = /(?<![\d.,])(\d{1,3}(?:[.\s]\d{3})+|\d{1,5})\s?[,.]\s?(\d{2})(?![\d])/g;
function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(AMT_RE)) {
    const n = parseFloat(m[1].replace(/[.\s]/g, '') + '.' + m[2]);
    if (n > 0 && n < 100000) out.push(n);
  }
  return out;
}
const NOT_ITEM = /TOTAL|IVA|I\.V\.A|BASE|CUOTA|TARJETA|VISA|MASTERCARD|EFECTIVO|ENTREGADO|CAMBIO|DEVOLUCION|A PAGAR|IMPORTE|CIF|NIF|TEL|FACTURA|DTO|DESCUENTO|AHORRO|PUNTOS|SALDO|AUTORIZ|OPERACION|COMERCIO|TERMINAL|NUM\.|N\.?º|CONTACTLESS|REDONDEO/;

// Busca la tienda primero en la cabecera del ticket; en el resto ignora palabras ambiguas («menú del día», «bar»…)
const AMBIG = /^(DIA|BAR|CAFE|METRO|BP|ACTION|NORMAL|GAME|CINE|CINES|AGUA|TIGER|SPAR|LUPA|HORNO|FORN|SIMPLY|TAXI|UBER|BOLT|ORANGE|DIGI|WOK)$/;
function detectStore(U) {
  const firstPriced = U.findIndex((l) => amountsIn(l).length);
  const headEnd = Math.min(6, firstPriced < 0 ? U.length : Math.max(1, firstPriced));
  const parts = [[U.slice(0, headEnd).join('\n'), true], [U.slice(headEnd).join('\n'), false]];
  for (const [txt, allowAmbig] of parts) {
    for (const [cat, re] of STORES) {
      let generic = false;
      for (const m of txt.matchAll(new RegExp(re.source, 'g'))) {
        const w = m[1];
        if (!allowAmbig && AMBIG.test(w)) continue;
        if (GENERIC.test(w)) { generic = true; continue; }
        return { cat, merchant: titleCase(w) };
      }
      if (generic) return { cat, merchant: '' };
    }
  }
  return { cat: '', merchant: '' };
}

function parseReceipt(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1);
  const U = lines.map(norm);
  const full = U.join('\n');

  // Total: líneas con TOTAL (no subtotal, ni IVA, ni bases)
  let totals = [];
  U.forEach((l, i) => {
    if (/\bTOTAL\b|A PAGAR|TOTAL COMPRA|IMPORTE TOTAL/.test(l) && !/SUB ?TOTAL|IVA(?! ?INC)|BASE|CUOTA|DTO|DESCUENTO|AHORRO|PUNTOS|ARTICULOS|UNIDADES|ITEMS|ARTS?\b/.test(l)) {
      let a = amountsIn(l);
      if (!a.length && U[i + 1]) a = amountsIn(U[i + 1]);
      totals.push(...a);
    }
  });
  let total = totals.length ? Math.max(...totals) : null;
  let uncertain = false;
  if (!total) {
    const paid = U.filter((l) => /TARJETA|VISA|MASTERCARD|IMPORTE|PAGADO|CONTACTLESS/.test(l)).flatMap(amountsIn);
    if (paid.length) total = Math.max(...paid);
  }
  if (!total) {
    const all = U.filter((l) => !/EFECTIVO|ENTREGADO|CAMBIO|CIF|NIF|TEL/.test(l)).flatMap(amountsIn);
    if (all.length) { total = Math.max(...all); uncertain = true; }
  }

  // Fecha
  let date = null;
  for (const m of full.matchAll(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/g)) {
    let [, d, mo, y] = m.map(Number);
    if (y < 100) y += 2000;
    const now = new Date();
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= now.getFullYear() + 1) {
      const dt = new Date(y, mo - 1, d);
      if (dt.getMonth() === mo - 1 && dt <= addDays(todayD(), 1)) { date = ymd(dt); break; }
    }
  }

  // Tienda y categoría
  let { merchant, cat: catName } = detectStore(U);
  if (!merchant) {
    const skip = /CIF|NIF|N\.I\.F|C\.I\.F|TEL|TLF|TELF|FAX|C\/|CALLE|AVDA|AVENIDA|PLAZA|CTRA|FACTURA|TICKET|FRA\b|WWW|HTTP|@|\d{5}|\d{2}[/\-.]\d{2}|BIENVENID|GRACIAS|SIMPLIFICADA|COPIA|CLIENTE/;
    for (const [i, l] of U.slice(0, 7).entries()) {
      const letters = (l.match(/\p{L}/gu) || []).length;
      if (letters >= 3 && letters / l.replace(/\s/g, '').length > 0.6 && !skip.test(l)) {
        merchant = titleCase(lines[i].replace(/\b(S\.?A\.?U?|S\.?L\.?U?|S\.?COOP\.?)\b\.?/g, '').replace(/[^\p{L}\d\s'&.-]/gu, '').trim()).slice(0, 60);
        break;
      }
    }
  }

  // Artículos
  const items = [];
  lines.forEach((l, i) => {
    if (items.length >= 15 || NOT_ITEM.test(U[i])) return;
    const a = amountsIn(l);
    const name = l.replace(AMT_RE, '').replace(/\b\d+\s?[xX*]\s?/g, '').replace(/[€*]|EUR|\bKG\b/gi, '').replace(/\s+/g, ' ').trim().replace(/^\d+\s+/, '');
    if (a.length && (name.match(/\p{L}/gu) || []).length >= 3 && a[a.length - 1] !== total) items.push({ name: titleCase(name).slice(0, 60), amount: a[a.length - 1] });
  });

  // Categoría del usuario con ese nombre
  const nn = (s) => norm(s).trim();
  const cat = catName ? cats.find((c) => nn(c.name) === nn(catName)) : null;
  return { isReceipt: !!(total || items.length), merchant, total, date, categoryId: cat?.id || null, items, uncertain };
}

// ---------- Flujo completo ----------
async function processReceipt(file) {
  if (!/^image\//.test(file.type)) return toast('Elige una foto del ticket', true);
  const preview = URL.createObjectURL(file);
  showScanProgress(preview);
  try {
    const bitmap = await loadBitmap(file);
    let result = null;
    if (await scanStatus()) {
      updateScan('La IA está leyendo el ticket…', 25);
      const t = setInterval(() => { const p = parseFloat($('#scanPct')?.textContent) || 25; if (p < 90) updateScan('La IA está leyendo el ticket…', p + 4); }, 600);
      try {
        result = await api('/receipts/scan', { method: 'POST', body: { image: drawScaled(bitmap, 1600).toDataURL('image/jpeg', 0.85) } });
      } catch (e) {
        console.warn('IA no disponible, se usa el lector del dispositivo:', e.message);
      } finally {
        clearInterval(t);
      }
    }
    if (!result) result = await ocrReceipt(bitmap);
    updateScan('¡Listo!', 100);
    await finishScan(result);
  } catch (e) {
    closeModal();
    toast('No se pudo leer el ticket: ' + e.message, true);
  } finally {
    setTimeout(() => URL.revokeObjectURL(preview), 5000);
  }
}

async function finishScan(r) {
  closeModal();
  const today = ymd(todayD());
  const name = r.merchant ? r.merchant : 'Compra con ticket';
  const notes = r.items?.length ? ('Artículos: ' + r.items.slice(0, 12).map((i) => `${i.name} (${eur(i.amount)})`).join(', ')).slice(0, 500) : '';
  const scan = { source: r.source, ticketDate: r.date && r.date !== today ? r.date : null, uncertain: !!r.uncertain };
  if (r.total && r.isReceipt !== false) {
    const saved = await api('/expenses', { method: 'POST', body: { name, amount: r.total, categoryId: r.categoryId || '', date: today, place: r.merchant || '', notes, scanned: true } });
    toast('Gasto añadido desde el ticket');
    route();
    setTimeout(() => expenseForm(saved, {}, { scan: { ...scan, saved: true } }), 150);
  } else {
    setTimeout(() => expenseForm({}, { date: today, categoryId: r.categoryId }, { scan: { ...scan, saved: false }, prefill: { name: r.merchant || '', place: r.merchant || '', notes } }), 80);
  }
}

$('#btnScan').onclick = pickReceipt;
$('#btnScanMobile').onclick = pickReceipt;
