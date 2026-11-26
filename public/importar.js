/* Agenda de Gastos · importar movimientos desde el extracto del banco (CSV, Excel, PDF, OFX, CAMT.053, Norma 43 y fotos) */
(() => {
  const IMP = { tab: 'importar', step: 'pick', accountId: '', file: null, an: null, rows: [], filter: 'all', q: '', sort: 'date', dir: -1, shown: 200, result: null, mapping: null, cfg: null };
  const TYPES = { expense: 'Gasto', card: 'Pago con tarjeta', bill: 'Recibo', fee: 'Comisión', cash_withdrawal: 'Retirada efectivo', income: 'Ingreso', refund: 'Devolución', cash_deposit: 'Ingreso efectivo', transfer: 'Transferencia' };
  const OUT = ['expense', 'card', 'bill', 'fee', 'cash_withdrawal', 'transfer'];
  const IN = ['income', 'refund', 'cash_deposit', 'transfer'];
  const STATUS = { new: ['Nuevo', 'ok'], possible: ['¿Duplicado?', 'warn'], duplicate: ['Ya importado', ''], review: ['Revisar', 'primary'] };
  const ACCEPT = '.csv,.txt,.tsv,.xls,.xlsx,.pdf,.ofx,.qfx,.xml,.n43,.aeb,.q43,.html,.htm,image/jpeg,image/png,image/webp';
  const dmyTxt = (s) => (s ? s.split('-').reverse().join('/') : '—');
  const r2 = (n) => Math.round(n * 100) / 100;

  // ---------- Pantalla principal ----------
  async function renderImport(el) {
    if (!IMP.cfg) IMP.cfg = await api('/imports/config').catch(() => ({ maxMb: 10 }));
    if (!accs.length) await loadAccounts();
    if (!IMP.accountId || !accOf(IMP.accountId)) IMP.accountId = (accs.find((a) => a.isDefault) || accs[0])?.id || '';
    const tab = (k, i, t) => `<button data-t="${k}" class="${IMP.tab === k ? 'on' : ''}">${ic(i, 'sm')}${t}</button>`;
    el.innerHTML = `<div class="tabs-bar"><div class="seg" id="impTabs">${tab('importar', 'upload', 'Importar')}${tab('historial', 'history', 'Historial')}${tab('reglas', 'sliders-horizontal', 'Reglas')}</div></div><div id="impBody"></div>`;
    $$('#impTabs button').forEach((b) => (b.onclick = () => { IMP.tab = b.dataset.t; renderImport(el); }));
    const body = $('#impBody');
    if (IMP.tab === 'historial') return renderHistory(body);
    if (IMP.tab === 'reglas') return renderRules(body);
    if (IMP.step === 'review' && IMP.an) return renderReview(body);
    if (IMP.step === 'mapping' && IMP.an) return renderMapping(body);
    if (IMP.step === 'done' && IMP.result) return renderDone(body);
    renderPick(body);
  }

  function renderPick(el) {
    if (!accs.length) {
      el.innerHTML = `<div class="card">${emptyHtml('landmark', 'Primero añade tu cuenta', 'Los movimientos se importan en una cuenta, para que el saldo cuadre con el del banco.', '<button class="btn primary" id="impNewAcc">Añadir cuenta</button>')}</div>`;
      hydrate(el);
      $('#impNewAcc').onclick = () => accountForm();
      return;
    }
    el.innerHTML = `
    <div class="card imp-pick">
      <div class="imp-steps"><span class="on">1 · Archivo y cuenta</span><span>2 · Revisar</span><span>3 · Importar</span></div>
      <label class="field">Cuenta del banco<select id="impAcc">${accs.map((a) => `<option value="${a.id}" ${a.id === IMP.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="imp-drop" id="impDrop">
        <input type="file" id="impFile" accept="${ACCEPT}" hidden>
        <span class="ichip">${ic('file-up')}</span>
        <b>Arrastra aquí el extracto o pulsa para elegirlo</b>
        <small>CSV, Excel (XLS/XLSX), PDF, OFX/QFX, CAMT.053 (XML), Norma 43 o una foto · máximo ${IMP.cfg.maxMb} MB</small>
      </label>
      <div id="impProgress" class="hidden"><div class="scan-status"><span id="impMsg">Leyendo…</span><span id="impPct"></span></div><div class="progress"><div id="impBar" style="width:5%"></div></div></div>
      <div class="notice" style="margin-top:14px">${ic('shield-check', 'sm')}<span><b>Tu extracto no se guarda.</b> Se lee en memoria para sacar los movimientos y se descarta. Nada se apunta hasta que revises y confirmes.<small>Reconoce CaixaBank, BBVA, Santander, Sabadell, ING, Openbank, Bankinter, Unicaja, Abanca y cualquier otro banco.</small></span></div>
      <p class="set-desc" style="margin:12px 0 0">${ic('info', 'sm')} Descarga el extracto desde la web o la app de tu banco, en el apartado de movimientos (botón «Exportar» o «Descargar»). La conexión directa con el banco llegará más adelante.</p>
    </div>`;
    hydrate(el);
    $('#impAcc').onchange = (e) => { IMP.accountId = e.target.value; };
    const input = $('#impFile');
    input.onchange = () => input.files[0] && startFile(input.files[0]);
    const drop = $('#impDrop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) startFile(e.dataTransfer.files[0]); });
  }
  const progress = (msg, pct) => {
    $('#impProgress')?.classList.remove('hidden');
    if ($('#impMsg')) $('#impMsg').textContent = msg;
    if ($('#impBar') && pct != null) $('#impBar').style.width = Math.max(4, Math.min(100, pct)) + '%';
    if ($('#impPct')) $('#impPct').textContent = pct != null ? Math.round(pct) + '%' : '';
  };
  const toBase64 = (file) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(new Error('No se ha podido leer el archivo'));
    fr.readAsDataURL(file);
  });

  async function startFile(file) {
    if (file.size > IMP.cfg.maxMb * 1024 * 1024) return toast(`El archivo supera el máximo de ${IMP.cfg.maxMb} MB`, true);
    if (!file.size) return toast('El archivo está vacío', true);
    IMP.file = file;
    IMP.mapping = null;
    try {
      if (/^image\//.test(file.type)) {
        const text = await ocrImages([await loadBitmap(file)]);
        return await analyze({ text });
      }
      progress('Leyendo el archivo…', 15);
      IMP.data = await toBase64(file);
      await analyze({});
    } catch (e) {
      progress(e.message, 0);
      toast(e.message, true);
    }
  }
  async function analyze(extra) {
    progress('Buscando los movimientos…', 40);
    const body = { fileName: IMP.file.name, accountId: IMP.accountId, ...(extra.text !== undefined ? { text: extra.text } : { data: IMP.data }), ...(extra.mapping ? { mapping: extra.mapping, saveMapping: extra.saveMapping } : {}) };
    const an = await api('/imports/analyze', { method: 'POST', body });
    if (an.needsOcr) {
      progress('El PDF es una imagen escaneada: leyendo el texto en tu dispositivo…', 45);
      const text = await ocrPdf(IMP.file);
      return analyze({ text });
    }
    IMP.an = an;
    if (an.needsMapping) { IMP.step = 'mapping'; IMP.mapping = { ...(an.mapping || {}) }; return route(); }
    IMP.data = extra.text !== undefined ? null : IMP.data;
    IMP.rows = an.rows.map((r) => ({ ...r, orig: { categoryId: r.categoryId, type: r.type }, dupAction: r.status === 'possible' || r.status === 'duplicate' ? 'skip' : null }));
    IMP.filter = an.rows.some((r) => r.status === 'review') ? 'all' : 'all';
    IMP.q = '';
    IMP.shown = 200;
    IMP.step = 'review';
    route();
  }

  // ---------- OCR en el dispositivo (fotos y PDF escaneados) ----------
  let ocr = null;
  async function ocrImages(sources) {
    progress('Cargando el lector de texto (solo tarda la primera vez)…', 10);
    await loadTesseract();
    ocr ||= await Tesseract.createWorker('spa', 1, { workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract-core', langPath: '/vendor/tessdata', workerBlobURL: false, gzip: true });
    let text = '';
    for (let i = 0; i < sources.length; i++) {
      progress(`Leyendo el texto${sources.length > 1 ? ` (página ${i + 1} de ${sources.length})` : ''}…`, 20 + (i / sources.length) * 70);
      const src = sources[i];
      const canvas = src instanceof HTMLCanvasElement ? src : drawScaled(src, 2600, 1600);
      const { data } = await ocr.recognize(canvas);
      text += (data.text || '') + '\n';
    }
    return text;
  }
  async function ocrPdf(file) {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const pages = [];
    for (let p = 1; p <= Math.min(doc.numPages, 15); p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 2 });
      const c = document.createElement('canvas');
      c.width = vp.width;
      c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      pages.push(c);
    }
    await doc.destroy();
    return ocrImages(pages);
  }

  // ---------- Columnas desconocidas: mapeo manual ----------
  function renderMapping(el) {
    const an = IMP.an;
    const fields = IMP.cfg.fields || {};
    const opts = (i) => Object.entries(fields).map(([k, l]) => `<option value="${k}" ${(IMP.mapping[i] || 'ignore') === k ? 'selected' : ''}>${l}</option>`).join('');
    el.innerHTML = `<div class="card">
      <div class="imp-steps"><span class="on">1 · Columnas</span><span>2 · Revisar</span><span>3 · Importar</span></div>
      <h3 style="margin:0 0 4px">¿Qué hay en cada columna?</h3>
      <p class="set-desc">No conocemos el formato de este archivo${an.bank ? ` de ${esc(an.bank.name)}` : ''}. Indica qué es cada columna: como mínimo la <b>fecha</b>, la <b>descripción</b> y el <b>importe</b> (o las columnas de gasto e ingreso).</p>
      <div class="xl-wrap"><table class="xl imp-map"><thead><tr>${an.headers.map((h, i) => `<th><div class="muted" style="font-weight:600;margin-bottom:6px">${esc(h)}</div><select data-col="${i}">${opts(i)}</select></th>`).join('')}</tr></thead>
      <tbody>${(an.sample || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <label class="switch-row" style="margin-top:14px"><span class="ichip sm">${ic('star', 'sm')}</span><span class="txt"><b>Recordar estas columnas</b><small>La próxima vez que importes un archivo igual de este banco se usarán solas</small></span><span class="switch"><input type="checkbox" id="mapSave" checked><span></span></span></label>
      <div class="imp-actions"><button class="btn" id="mapBack">${ic('chevron-left', 'sm')}Otro archivo</button><button class="btn primary" id="mapGo">Continuar${ic('chevron-right', 'sm')}</button></div>
    </div>`;
    hydrate(el);
    $$('.imp-map select').forEach((s) => (s.onchange = () => { IMP.mapping[s.dataset.col] = s.value; }));
    $('#mapBack').onclick = reset;
    $('#mapGo').onclick = async () => {
      const f = new Set(Object.values(IMP.mapping));
      if (!(f.has('date') || f.has('valueDate')) || !(f.has('amount') || f.has('debit') || f.has('credit')) || !(f.has('description') || f.has('extra'))) return toast('Indica al menos la fecha, la descripción y el importe', true);
      try { await analyze({ mapping: IMP.mapping, saveMapping: $('#mapSave').checked }); } catch (e) { toast(e.message, true); }
    };
  }
  function reset() {
    Object.assign(IMP, { step: 'pick', an: null, rows: [], data: null, result: null, mapping: null });
    route();
  }

  // ---------- Revisión ----------
  const isOut = (r) => r.amount < 0;
  const willImport = (r) => r.selected || r.dupAction === 'link';
  function catOptions(r) {
    if (r.type === 'transfer' || (r.amount > 0 && r.type !== 'refund')) return '';
    const sug = r.suggestedCategory && !cats.some((c) => c.name.toLowerCase() === r.suggestedCategory.toLowerCase()) ? `<option value="new:${esc(r.suggestedCategory)}" ${r.categoryId === 'new:' + r.suggestedCategory ? 'selected' : ''}>+ Crear «${esc(r.suggestedCategory)}»</option>` : '';
    return `<select data-f="categoryId"><option value="">Sin categoría</option>${sug}${cats.map((c) => `<option value="${c.id}" ${c.id === r.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
  }
  function rowHtml(r) {
    const types = (isOut(r) ? OUT : IN).map((t) => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${TYPES[t]}</option>`).join('');
    const needsCp = ['transfer', 'cash_withdrawal', 'cash_deposit'].includes(r.type);
    const cp = needsCp ? `<select data-f="counterpartId" class="imp-cp"><option value="">${r.type === 'transfer' ? 'A otra persona / externa' : 'Sin cuenta de efectivo'}</option>${accs.filter((a) => a.id !== IMP.accountId).map((a) => `<option value="${a.id}" ${a.id === r.counterpartId ? 'selected' : ''}>${isOut(r) ? '→ ' : '← '}${esc(a.name)}</option>`).join('')}</select>` : '';
    const dup = r.status === 'possible' || r.status === 'duplicate'
      ? `<select data-f="dupAction" class="imp-dup"><option value="skip" ${r.dupAction === 'skip' ? 'selected' : ''}>No importar</option>${r.status === 'possible' ? `<option value="link" ${r.dupAction === 'link' ? 'selected' : ''}>Es el mismo: vincular</option>` : ''}<option value="import" ${r.dupAction === 'import' ? 'selected' : ''}>Importar igualmente</option></select>` : '';
    const [st, cls] = STATUS[r.status] || STATUS.new;
    const conf = Math.round((r.confidence || 0) * 100);
    return `<tr data-i="${r.i}" class="${willImport(r) ? '' : 'off'}">
      <td><input type="checkbox" data-f="selected" ${r.selected ? 'checked' : ''} ${r.error && !D_OK(r.date) ? 'disabled' : ''} aria-label="Importar"></td>
      <td><input type="date" data-f="date" value="${esc(r.date || '')}" class="imp-date ${r.date ? '' : 'bad'}"></td>
      <td class="imp-desc"><input data-f="description" value="${esc(r.description)}" maxlength="300">
        <small>${r.merchant ? `${ic('store', 'sm')}${esc(r.merchant)}` : ''}${r.notes.length ? ` · ${esc(r.notes.join(' · '))}` : ''}${r.dupOf ? ` <span class="muted">(${esc(r.dupOf.name)} · ${dmyTxt(r.dupOf.date)} · ${eur(Math.abs(r.dupOf.amount))})</span>` : ''}</small></td>
      <td>${catOptions(r)}</td>
      <td><select data-f="type">${types}</select>${cp}</td>
      <td class="num nowrap">${signed(r.amount)}</td>
      <td><span class="badge ${cls}">${st}</span>${dup}</td>
      <td class="num"><span class="conf ${conf >= 80 ? 'conf-alta' : conf >= 50 ? 'conf-media' : 'conf-baja'}" title="${esc(r.reason || '')}">${conf}%</span></td>
    </tr>`;
  }
  const D_OK = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  function filtered() {
    const q = IMP.q.toLowerCase();
    let list = IMP.rows.filter((r) => (IMP.filter === 'all' || (IMP.filter === 'dup' ? r.status === 'possible' || r.status === 'duplicate' : r.status === IMP.filter)) && (!q || `${r.description} ${r.merchant}`.toLowerCase().includes(q)));
    const k = IMP.sort, d = IMP.dir;
    list = [...list].sort((a, b) => (k === 'amount' ? (a.amount - b.amount) * d : k === 'description' ? a.description.localeCompare(b.description) * d : k === 'confidence' ? (a.confidence - b.confidence) * d : String(a.date || '').localeCompare(String(b.date || '')) * d) || a.i - b.i);
    return list;
  }
  function summary() {
    const R = IMP.rows;
    const sel = R.filter((r) => r.selected);
    const tr = (r) => ['transfer', 'cash_withdrawal', 'cash_deposit'].includes(r.type) && r.counterpartId;
    return {
      total: R.length, fresh: R.filter((r) => r.status === 'new').length, dup: R.filter((r) => r.status === 'possible' || r.status === 'duplicate').length, review: R.filter((r) => r.status === 'review').length,
      // Las devoluciones restan de los gastos (igual que en el resto de la app)
      sel: sel.length, income: r2(sel.filter((r) => r.amount > 0 && !tr(r) && r.type !== 'refund').reduce((a, r) => a + r.amount, 0)), expense: r2(sel.filter((r) => (r.amount < 0 || r.type === 'refund') && !tr(r)).reduce((a, r) => a - r.amount, 0)), transfers: sel.filter(tr).length,
    };
  }
  function paintSummary() {
    const s = summary();
    $('#impSum').innerHTML = `<div><small>Detectados</small><b>${s.total}</b></div><div><small>Nuevos</small><b>${s.fresh}</b></div><div><small>Posibles duplicados</small><b>${s.dup}</b></div><div><small>Por revisar</small><b>${s.review}</b></div>
      <div><small>Ingresos</small><b class="pos">${eur(s.income)}</b></div><div><small>Gastos</small><b class="neg">${eur(s.expense)}</b></div><div><small>Transferencias</small><b>${s.transfers}</b></div>`;
    $('#impGo').innerHTML = `${ic('check', 'sm')}CONFIRMAR E IMPORTAR ${s.sel} MOVIMIENTO${s.sel === 1 ? '' : 'S'}`;
    $('#impGo').disabled = !s.sel && !IMP.rows.some((r) => r.dupAction === 'link');
    hydrate($('#impGo'));
  }
  function renderReview(el) {
    const an = IMP.an;
    const cnt = (f) => (f === 'all' ? IMP.rows.length : f === 'dup' ? IMP.rows.filter((r) => r.status === 'possible' || r.status === 'duplicate').length : IMP.rows.filter((r) => r.status === f).length);
    const fb = (k, t) => `<button data-fl="${k}" class="${IMP.filter === k ? 'on' : ''}">${t} <span class="muted">${cnt(k)}</span></button>`;
    const th = (k, t, cls = '') => `<th class="${cls} sortable" data-s="${k}">${t}${IMP.sort === k ? (IMP.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
    el.innerHTML = `
    <div class="card">
      <div class="imp-steps"><span class="done">1 · Archivo</span><span class="on">2 · Revisar</span><span>3 · Importar</span></div>
      <div class="imp-file">${ic('file-text')}<div><b>${esc(an.fileName)}</b><small>${esc((an.format || '').toUpperCase())}${an.bank ? ` · ${esc(an.bank.name)} <span class="muted">(por ${esc(an.bank.by)})</span>` : ' · Banco no identificado'}${an.iban ? ` · ${esc(an.iban)}` : ''} · Cuenta: <b>${esc(accOf(IMP.accountId)?.name || '')}</b></small></div><button class="btn sm" id="impOther">Cambiar archivo</button></div>
      ${(an.warnings || []).map((w) => `<div class="notice warn" style="margin-bottom:10px">${ic('triangle-alert', 'sm')}<span>${esc(w)}</span></div>`).join('')}
      <div class="summary-strip imp-sum" id="impSum"></div>
      <div class="toolbar imp-tools">
        <div class="seg sm" id="impFl">${fb('all', 'Todos')}${fb('new', 'Nuevos')}${fb('dup', 'Duplicados')}${fb('review', 'Revisar')}</div>
        <div class="input-icon grow">${ic('search')}<input type="search" id="impQ" placeholder="Buscar en la descripción…" value="${esc(IMP.q)}"></div>
        <div class="btn-group"><button class="btn sm" id="impAll">Seleccionar todos</button><button class="btn sm" id="impNone">Ninguno</button></div>
      </div>
      <div class="xl-wrap imp-wrap"><table class="xl imp-table"><thead><tr><th></th>${th('date', 'Fecha')}${th('description', 'Descripción')}<th>Categoría</th><th>Tipo</th>${th('amount', 'Importe', 'num')}<th>Estado</th>${th('confidence', 'Confianza', 'num')}</tr></thead><tbody id="impRows"></tbody></table></div>
      <div id="impMore"></div>
      <div class="imp-actions sticky"><button class="btn" id="impCancel">Cancelar</button><button class="btn primary big" id="impGo"></button></div>
      <p class="set-desc" style="margin:8px 0 0">Nada se guarda hasta que pulses el botón. Las categorías que cambies se recordarán para la próxima importación.</p>
    </div>`;
    hydrate(el);
    paintRows();
    paintSummary();
    $('#impOther').onclick = reset;
    $('#impCancel').onclick = reset;
    $$('#impFl button').forEach((b) => (b.onclick = () => { IMP.filter = b.dataset.fl; IMP.shown = 200; renderReview(el); }));
    $('#impQ').oninput = (e) => { IMP.q = e.target.value; IMP.shown = 200; paintRows(); };
    const setAll = (v) => { for (const r of filtered()) if (!r.error || D_OK(r.date)) { r.selected = v; if (v && r.dupAction === 'skip') r.dupAction = 'import'; if (!v && r.dupAction === 'import') r.dupAction = 'skip'; } paintRows(); paintSummary(); };
    $('#impAll').onclick = () => setAll(true);
    $('#impNone').onclick = () => setAll(false);
    $$('.imp-table th.sortable').forEach((t) => (t.onclick = () => { IMP.dir = IMP.sort === t.dataset.s ? -IMP.dir : t.dataset.s === 'date' ? -1 : 1; IMP.sort = t.dataset.s; renderReview(el); }));
    $('#impGo').onclick = commit;
  }
  function paintRows() {
    const list = filtered();
    $('#impRows').innerHTML = list.slice(0, IMP.shown).map(rowHtml).join('') || `<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">No hay movimientos con este filtro</td></tr>`;
    hydrate($('#impRows'));
    $('#impMore').innerHTML = list.length > IMP.shown ? `<button class="btn sm" id="impShowMore" style="margin-top:10px">Mostrar ${Math.min(500, list.length - IMP.shown)} más (de ${list.length})</button>` : '';
    if ($('#impShowMore')) $('#impShowMore').onclick = () => { IMP.shown += 500; paintRows(); };
  }
  // Cambios en la tabla (delegados)
  document.addEventListener('change', (e) => {
    const tr = e.target.closest?.('#impRows tr[data-i]');
    if (!tr) return;
    const r = IMP.rows[+tr.dataset.i];
    const f = e.target.dataset.f;
    if (!r || !f) return;
    if (f === 'selected') { r.selected = e.target.checked; if (r.dupAction) r.dupAction = r.selected ? 'import' : 'skip'; }
    else if (f === 'dupAction') { r.dupAction = e.target.value; r.selected = r.dupAction === 'import'; }
    else if (f === 'date') { r.date = e.target.value; if (D_OK(r.date) && r.error?.startsWith('Fecha')) { r.error = ''; r.notes = r.notes.filter((n) => !n.startsWith('Fecha')); r.selected = true; } }
    else if (f === 'type') { r.type = e.target.value; if (!['transfer', 'cash_withdrawal', 'cash_deposit'].includes(r.type)) r.counterpartId = null; }
    else r[f] = e.target.value || null;
    if (f === 'description') r.description = e.target.value;
    if (['type', 'selected', 'dupAction', 'date'].includes(f)) { const nr = document.createElement('tbody'); nr.innerHTML = rowHtml(r); hydrate(nr); tr.replaceWith(nr.firstElementChild); }
    else tr.classList.toggle('off', !willImport(r));
    paintSummary();
  });

  async function commit() {
    const an = IMP.an;
    const rows = IMP.rows.map((r) => {
      const action = r.dupAction === 'link' ? 'link' : r.selected ? 'import' : r.status === 'possible' || r.status === 'duplicate' ? 'skip' : 'exclude';
      const learn = r.selected && r.key && (r.categoryId !== r.orig.categoryId || r.type !== r.orig.type);
      const { orig, notes, reason, ...rest } = r;
      return { ...rest, action, learn };
    });
    const btn = $('#impGo');
    btn.disabled = true;
    btn.textContent = 'Importando…';
    try {
      IMP.result = await api('/imports/commit', { method: 'POST', body: { accountId: IMP.accountId, fileName: an.fileName, format: an.format, bank: an.bank?.name || '', detected: IMP.rows.length, rows } });
      await Promise.all([loadAccounts(), api('/categories').then((c) => { cats.length = 0; cats.push(...c); }).catch(() => {})]);
      IMP.step = 'done';
      IMP.an = null;
      IMP.rows = [];
      toast(`${IMP.result.imported} movimientos importados`);
      route();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      paintSummary();
    }
  }

  // ---------- Resultado ----------
  function renderDone(el) {
    const r = IMP.result;
    const nextMonth = (s) => { const d = parse(s); return ymd(dueInMonth(d.getDate(), d.getFullYear(), d.getMonth() + 1)); };
    el.innerHTML = `<div class="card">
      <div class="imp-steps"><span class="done">1 · Archivo</span><span class="done">2 · Revisar</span><span class="on">3 · Importado</span></div>
      <div class="imp-done">${ic('circle-check')}<div><h3>Importación completada</h3><p class="muted">Ya aparece en el panel, el calendario, los presupuestos, los informes y las previsiones.</p></div></div>
      <div class="summary-strip"><div><small>Importados</small><b>${r.imported}</b></div><div><small>Ingresos</small><b class="pos">${r.incomes} · ${eur(r.incomeTotal)}</b></div><div><small>Gastos</small><b class="neg">${r.expenses} · ${eur(r.expenseTotal)}</b></div><div><small>Transferencias</small><b>${r.transfers}</b></div><div><small>Duplicados omitidos</small><b>${r.duplicatesSkipped}</b></div><div><small>Excluidos</small><b>${r.excluded}</b></div><div><small>Errores</small><b>${r.errors.length}</b></div></div>
      ${r.errors.length ? `<div class="notice danger">${ic('circle-alert', 'sm')}<span>${r.errors.slice(0, 8).map((e) => `Línea ${esc(e.line ?? '?')}: ${esc(e.error)}`).join('<br>')}</span></div>` : ''}
      ${r.newCategories.length ? `<div class="notice ok" style="margin-top:10px">${ic('tag', 'sm')}<span>Categorías nuevas: ${r.newCategories.map(esc).join(', ')}</span></div>` : ''}
      ${r.recurringSuggestions.length ? `<div class="mini-label" style="margin-top:16px">Parecen pagos fijos: añádelos para recibir avisos</div><div class="list">${r.recurringSuggestions.map((s, i) => `<div class="li"><span class="ichip sm">${ic('repeat', 'sm')}</span><div style="flex:1;min-width:0"><b>${esc(s.name)}</b><small class="muted" style="display:block">${eur(s.amount)} cada mes · ${s.count} cargos, el último el ${dmyTxt(s.lastDate)}</small></div><button class="btn sm" data-rec="${i}">Crear pago fijo</button></div>`).join('')}</div>` : ''}
      <div class="imp-actions"><a class="btn" href="#/gastos">Ver gastos</a><button class="btn" id="doneHist">${ic('history', 'sm')}Historial</button><button class="btn primary" id="doneMore">${ic('upload', 'sm')}Importar otro archivo</button></div>
    </div>`;
    hydrate(el);
    $('#doneMore').onclick = reset;
    $('#doneHist').onclick = () => { IMP.tab = 'historial'; reset(); };
    $$('[data-rec]').forEach((b) => (b.onclick = async () => {
      const s = r.recurringSuggestions[+b.dataset.rec];
      try {
        await api('/recurring', { method: 'POST', body: { name: s.name, amount: s.amount, categoryId: s.categoryId, frequency: 'monthly', dayOfMonth: s.dayOfMonth, anchorDate: nextMonth(s.lastDate), autoAdd: false, remindDaysBefore: 2, accountId: s.accountId } });
        b.outerHTML = `<span class="badge ok">${ic('check', 'sm')}Añadido</span>`;
        hydrate(el);
      } catch (e) { toast(e.message, true); }
    }));
  }

  // ---------- Historial ----------
  async function renderHistory(el) {
    const list = await api('/imports');
    if (!list.length) {
      el.innerHTML = `<div class="card">${emptyHtml('history', 'Aún no has importado nada', 'Aquí verás cada extracto que importes, y podrás revisarlo o deshacerlo.')}</div>`;
      return hydrate(el);
    }
    const st = (s) => (s === 'completada' ? '<span class="badge ok">Completada</span>' : s === 'revertida' ? '<span class="badge red">Revertida</span>' : `<span class="badge">${esc(s)}</span>`);
    el.innerHTML = `<div class="card"><div class="xl-wrap"><table class="xl imp-hist"><thead><tr><th>Archivo</th><th>Banco</th><th>Cuenta</th><th>Fecha</th><th class="num">Detectados</th><th class="num">Importados</th><th class="num">Duplicados</th><th>Estado</th><th>Usuario</th></tr></thead><tbody>
      ${list.map((i) => `<tr data-id="${i.id}" class="click"><td><b>${esc(i.fileName)}</b></td><td>${esc(i.bank || '—')}</td><td>${esc(i.accountName || '')}</td><td class="nowrap">${new Date(i.createdAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</td><td class="num">${i.detected}</td><td class="num">${i.imported}</td><td class="num">${i.duplicatesSkipped}</td><td>${st(i.status)}</td><td>${esc(i.by || '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
    hydrate(el);
    $$('.imp-hist tr[data-id]').forEach((tr) => (tr.onclick = () => openImportDetail(tr.dataset.id, el)));
  }
  async function openImportDetail(id, el) {
    const d = await api('/imports/' + id);
    const STATE = { 'sin cambios': '', modificado: 'warn', eliminado: 'red', vinculado: 'primary' };
    openModal({
      title: d.fileName,
      icon: 'history',
      actions: false,
      html: `<div class="mini-stats"><div><b>${d.detected}</b><small>Detectados</small></div><div><b>${d.imported}</b><small>Importados</small></div><div><b>${d.duplicatesSkipped}</b><small>Duplicados</small></div><div><b>${d.excluded}</b><small>Excluidos</small></div></div>
        <p class="set-desc">${esc(d.bank || 'Banco no identificado')} · ${esc(d.accountName || '')} · ${new Date(d.createdAt).toLocaleString('es-ES')} · por ${esc(d.by || '')}</p>
        <div class="mini-label">Movimientos</div>
        <div class="list imp-det">${d.movements.slice(0, 300).map((m) => `<div class="li"><div style="flex:1;min-width:0"><b>${esc(m.name || 'Movimiento eliminado')}</b><small class="muted" style="display:block">${dmyTxt(m.date)}${m.category ? ' · ' + esc(m.category) : ''}</small></div>${m.amount != null ? signed(m.amount) : ''}<span class="badge ${STATE[m.state] ?? ''}">${esc(m.state)}</span></div>`).join('') || '<p class="muted">Sin movimientos</p>'}</div>
        <div class="mini-label" style="margin-top:14px">Registro</div>
        <div class="list">${d.events.map((ev) => `<div class="li"><span class="ichip sm">${ic(ev.action === 'Reversión' ? 'undo-2' : 'upload', 'sm')}</span><div style="flex:1"><b>${esc(ev.action)}</b><small class="muted" style="display:block">${new Date(ev.at).toLocaleString('es-ES')} · ${esc(ev.by || '')} · ${esc(ev.detail || '')}</small></div></div>`).join('')}</div>
        ${d.status === 'completada' ? (d.canRevert
          ? `<button class="btn danger" id="impRevert" style="margin-top:14px;width:100%">${ic('undo-2', 'sm')}Revertir importación</button><p class="set-desc" style="margin-top:6px">Elimina los ${d.imported} movimientos que se crearon con este archivo. Lo que ya tenías antes no se toca.</p>`
          : `<div class="notice warn" style="margin-top:14px">${ic('triangle-alert', 'sm')}<span>No se puede revertir: has modificado ${d.modified} de estos movimientos después de importarlos.</span></div>`) : ''}`,
    });
    if ($('#impRevert')) $('#impRevert').onclick = () => openModal({
      title: '¿Revertir la importación?',
      icon: 'undo-2',
      danger: true,
      okText: 'Revertir',
      html: `<p style="margin:0;color:var(--text-2)">Se eliminarán los <b>${d.imported}</b> movimientos importados desde «${esc(d.fileName)}». Quedará constancia en el historial. Esta acción no se puede deshacer.</p>`,
      onSubmit: async () => {
        const r = await api(`/imports/${id}/revert`, { method: 'POST', body: { confirm: true } });
        await loadAccounts();
        toast(`Importación revertida: ${r.removed} movimientos eliminados`);
        setTimeout(() => renderHistory(el), 50);
      },
    });
  }

  // ---------- Reglas aprendidas y columnas guardadas ----------
  async function renderRules(el) {
    const { rules, mappings } = await api('/imports-rules');
    el.innerHTML = `<div class="grid g2">
      <div class="card"><div class="card-head"><h3>${ic('tag', 'sm')} Reglas de clasificación</h3></div>
        <p class="set-desc">Se crean solas cuando corriges una categoría al importar.</p>
        <div class="list">${rules.map((r) => `<div class="li"><div style="flex:1;min-width:0"><b>${esc(r.key)}</b><small class="muted" style="display:block">${esc(r.category || 'Sin categoría')}${r.type ? ' · ' + esc(TYPES[r.type] || r.type) : ''}</small></div><button class="icon-btn" data-del="${r.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></div>`).join('') || '<p class="muted">Todavía no hay reglas.</p>'}</div></div>
      <div class="card"><div class="card-head"><h3>${ic('table', 'sm')} Columnas guardadas</h3></div>
        <p class="set-desc">Formatos de archivo que ya sabes importar sin indicar las columnas.</p>
        <div class="list">${mappings.map((m) => `<div class="li"><div style="flex:1;min-width:0"><b>${esc(m.bank || 'Formato propio')}</b><small class="muted" style="display:block">${esc((m.headers || []).join(' · '))}</small></div><button class="icon-btn" data-del="${m.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></div>`).join('') || '<p class="muted">Ninguna todavía.</p>'}</div></div>
    </div>`;
    hydrate(el);
    $$('[data-del]').forEach((b) => (b.onclick = async () => { await api('/imports-rules/' + b.dataset.del, { method: 'DELETE' }); renderRules(el); }));
  }

  // Acceso directo desde el panel, los gastos y las cuentas
  window.renderImport = renderImport;
  window.openImport = (accountId) => { if (accountId) IMP.accountId = accountId; IMP.tab = 'importar'; if (IMP.step === 'done') IMP.step = 'pick'; location.hash = '#/importar'; };
})();
