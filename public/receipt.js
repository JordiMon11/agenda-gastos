/* Escáner de tickets: lee la foto (con IA si el servidor la tiene, o gratis en el dispositivo con OCR),
   detecta total, tienda, categoría, fecha, IVA, forma de pago y productos, y muestra una pantalla de revisión.
   El gasto solo se guarda (con la foto como justificante) cuando el usuario lo confirma. */

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
    html: `<p class="set-desc">Haz la foto al ticket <b>entero</b>, recto y con buena luz. Revisarás los datos antes de guardarlos.</p>
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
  const parsed = parseReceipt(data.text || '');
  // Confianza: la del propio lector, rebajada si el total no estaba claro o no se encontró
  const confidence = Math.round(Math.max(5, Math.min(98, (data.confidence || 60) - (parsed.uncertain ? 20 : 0) - (parsed.total ? 0 : 35))));
  return { source: 'ocr', ...parsed, ...receiptExtras(data.text || '', parsed.total), confidence };
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

// Datos extra del ticket: CIF/NIF, hora, IVA, base, forma de pago, nº de ticket y dirección.
// Si algo no aparece se deja vacío: nunca se inventa.
function receiptExtras(text, total) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const U = lines.map(norm);
  const full = U.join('\n');
  const taxId = (/\b(?:C\.?I\.?F|N\.?I\.?F)\.?:?\s*([A-HJ-NP-SUVW][-\s]?\d{7}[0-9A-J]|\d{8}[-\s]?[A-Z])\b/.exec(full) || [])[1]?.replace(/[-\s]/g, '') || '';
  const time = (/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/.exec(full) || []).slice(1, 3).join(':');
  let taxAmount = null;
  const cuota = U.filter((l) => /CUOTA|I\.?V\.?A\.? ?(TOTAL|\d{1,2} ?%)|TOTAL I\.?V\.?A/.test(l) && !/BASE IMPONIBLE.*CUOTA/.test(l)).flatMap(amountsIn).filter((a) => !total || a < total * 0.3);
  if (cuota.length) taxAmount = Math.round(Math.max(...cuota) * 100) / 100;
  const card = /TARJETA|VISA|MASTERCARD|MAESTRO|CONTACTLESS|DATAFONO|TPV|AMEX|APPLE PAY|GOOGLE PAY/.test(full);
  const cash = /EFECTIVO|ENTREGADO|CAMBIO|METALICO/.test(full);
  const paymentMethod = card ? 'tarjeta' : cash ? 'efectivo' : null;
  const ticketNumber = (/(?:TICKET|FACTURA(?: SIMPLIFICADA)?|FRA\.?|N[º°O]\.? ?(?:DE )?(?:TICKET|FACTURA|OPERACION)|NUM\.? ?(?:TICKET|FACTURA)?)\s*(?:N[º°O]\.?|NUM\.?)?\s*:?\s*([A-Z0-9][A-Z0-9/\-]{3,20})/.exec(full) || [])[1] || '';
  const address = lines.find((l, i) => i < 10 && /^(C\/|CALLE|AVDA|AVENIDA|PLAZA|PZA|CTRA|CARRETERA|PASEO|P\.º|RONDA|CAMINO|PG\.?|POL[IÍ]GONO)\b/i.test(l)) || '';
  return { taxId, time, taxAmount, paymentMethod, ticketNumber: /\d/.test(ticketNumber) ? ticketNumber : '', address: address.slice(0, 120) };
}

// ---------- Flujo completo ----------
let lastScanFile = null;
async function processReceipt(file) {
  if (!/^image\//.test(file.type)) return toast('Elige una foto del ticket (JPG, PNG o HEIC si tu móvil lo permite)', true);
  lastScanFile = file;
  const preview = URL.createObjectURL(file);
  showScanProgress(preview);
  try {
    const bitmap = await loadBitmap(file).catch(() => { throw new Error('Este formato de foto no se puede abrir en este navegador. Prueba con JPG o PNG.'); });
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
    // Foto comprimida para guardarla como justificante
    const photo = drawScaled(bitmap, 1400).toDataURL('image/jpeg', 0.72);
    setTimeout(() => reviewReceipt(result, photo), 120);
  } catch (e) {
    closeModal();
    toast('No se pudo leer el ticket: ' + e.message, true);
  } finally {
    setTimeout(() => URL.revokeObjectURL(preview), 5000);
  }
}

// Pantalla de revisión: nada se guarda hasta que el usuario lo confirma
async function reviewReceipt(r, photo) {
  closeModal();
  const today = ymd(todayD());
  const ticketDate = r.date && r.date !== today ? r.date : null;
  const conf = Math.max(0, Math.min(100, Math.round(r.confidence ?? (r.total ? 70 : 30))));
  const confTxt = conf >= 75 ? 'Alta' : conf >= 50 ? 'Media' : 'Baja';
  const items = (r.items || []).slice(0, 30);
  const notes = items.length ? ('Artículos: ' + items.slice(0, 12).map((i) => `${i.quantity > 1 ? i.quantity + '× ' : ''}${i.name} (${eur(i.amount)})`).join(', ')).slice(0, 500) : '';
  const info = [
    r.taxId && ['CIF/NIF', esc(r.taxId)], r.time && ['Hora', esc(r.time)], r.taxAmount && ['IVA', eur(r.taxAmount)],
    r.ticketNumber && ['Nº ticket', esc(r.ticketNumber)], r.address && ['Dirección', esc(r.address)],
  ].filter(Boolean);
  openModal({
    title: 'Revisa el ticket',
    icon: 'scan-line',
    okText: 'Guardar gasto',
    html: `<div class="review">
      <div class="review-img"><img src="${photo}" alt="Foto del ticket"></div>
      <div class="review-data">
        <div class="conf conf-${confTxt.toLowerCase()}"><span>${ic(conf >= 75 ? 'circle-check' : 'triangle-alert', 'sm')}Confianza de lectura: <b>${confTxt}</b> (${conf} %) · ${r.source === 'ai' ? 'leído con IA' : 'leído en tu dispositivo'}</span><div class="progress thin"><div style="width:${conf}%"></div></div></div>
        ${!r.total ? `<div class="notice warn">${ic('triangle-alert', 'sm')}<span>No he podido leer el total. Escríbelo tú.</span></div>` : r.uncertain ? `<div class="notice warn">${ic('triangle-alert', 'sm')}<span>Comprueba el importe: no estaba del todo claro.</span></div>` : ''}
        <div id="dupWarn"></div>
        <label class="field">Importe<div class="input-money"><input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required value="${r.total ?? ''}" placeholder="0,00"><span>€</span></div></label>
        <label class="field">Establecimiento<input name="name" required maxlength="100" value="${esc(r.merchant || '')}" placeholder="Nombre de la tienda"></label>
        ${catPicker(r.categoryId)}
        <div class="row">
          <label class="field">Fecha<input name="date" type="date" required value="${today}"></label>
          <label class="field">Método de pago<select name="paymentMethod"><option value="">—</option>${Object.entries(PAY_METHODS).map(([k, l]) => `<option value="${k}" ${r.paymentMethod === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        ${ticketDate ? `<div class="scan-date">${ic('calendar-days', 'sm')}<span>El ticket es del <b>${fmtDate(ticketDate, { day: 'numeric', month: 'long', year: 'numeric' })}</b></span><button type="button" class="btn sm" id="useTicketDate">Usar esa fecha</button></div>` : ''}
        ${accountSelect('')}
        ${info.length ? `<div class="facts small">${info.map(([l, v]) => `<div><small>${l}</small><b>${v}</b></div>`).join('')}</div>` : ''}
        ${items.length ? `<details class="more-fields"><summary>${ic('chevron-down', 'sm')}Productos detectados (${items.length})</summary><div class="items">${items.map((i) => `<div><span>${i.quantity > 1 ? i.quantity + ' × ' : ''}${esc(i.name)}</span><b>${eur(i.amount)}</b></div>`).join('')}</div></details>` : ''}
        <label class="field">Notas<textarea name="notes" maxlength="500">${esc(notes)}</textarea></label>
        <button type="button" class="btn sm ghost" id="rescan">${ic('rotate-ccw', 'sm')}Volver a escanear</button>
      </div></div>`,
    onSubmit: async (d) => {
      const expense = { name: d.name, amount: Number(d.amount), categoryId: d.categoryId, date: d.date, place: d.name, notes: d.notes, paymentMethod: d.paymentMethod, accountId: d.accountId || '' };
      const receipt = { merchant: d.name, date: r.date || d.date, time: r.time, total: r.total, taxAmount: r.taxAmount, taxId: r.taxId, ticketNumber: r.ticketNumber, paymentMethod: r.paymentMethod, items, source: r.source, confidence: conf };
      await api('/receipts', { method: 'POST', body: { expense, receipt, image: photo } });
      toast('Gasto guardado desde el ticket');
      route();
      refreshNotifs();
    },
  });
  bindCatPicker($('#modalBody'));
  $('#modalBody').classList.add('wide');
  $('#useTicketDate')?.addEventListener('click', (e) => {
    $('#modalBody input[name=date]').value = ticketDate;
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Fecha cambiada';
    checkDup();
  });
  $('#rescan').onclick = () => { closeModal(); pickReceipt(); };
  // Aviso de posible duplicado (no bloquea: puede ser una compra legítima repetida)
  const checkDup = async () => {
    const amount = Number($('#modalBody input[name=amount]')?.value);
    if (!(amount > 0)) return;
    try {
      const dups = await api('/receipts/duplicates', { method: 'POST', body: { amount, date: $('#modalBody input[name=date]').value, merchant: $('#modalBody input[name=name]').value, ticketNumber: r.ticketNumber } });
      const w = $('#dupWarn');
      if (w) w.innerHTML = dups.length ? `<div class="notice warn">${ic('copy', 'sm')}<span><b>Posible duplicado.</b> Ya tienes ${dups.map((x) => `«${esc(x.name)}» de ${eur(x.amount)} el ${fmtDate(x.date)} (${esc(x.reason.toLowerCase())})`).join('; ')}. Puedes guardarlo igualmente si es otra compra.</span></div>` : '';
    } catch {}
  };
  $('#modalBody input[name=amount]').addEventListener('change', checkDup);
  checkDup();
}

$('#btnScan').onclick = pickReceipt;
$('#btnScanMobile').onclick = pickReceipt;
