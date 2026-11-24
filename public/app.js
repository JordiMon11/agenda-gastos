/* Agenda de Gastos · interfaz (web, móvil y escritorio) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
store.set('agenda_gastos_token', null); // la sesión ahora va en una cookie protegida
let me = null;
let cats = [];
let charts = [];

// ---------- Utilidades ----------
const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
const eurShort = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekStart = (d) => addDays(d, -((d.getDay() + 6) % 7));
const todayD = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const sum = (l) => Math.round(l.reduce((a, e) => a + e.amount, 0) * 100) / 100;
const fmtDate = (s, opts = { day: 'numeric', month: 'short' }) => parse(s).toLocaleDateString('es-ES', opts);
const monthName = (d, year = true) => d.toLocaleDateString('es-ES', year ? { month: 'long', year: 'numeric' } : { month: 'long' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dueInMonth = (day, y, m) => { const f = new Date(y, m, 1); return new Date(f.getFullYear(), f.getMonth(), Math.min(day, new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate())); };
const daysTxt = (n) => (n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : `En ${n} días`);
const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);

// ---------- Iconos ----------
const ic = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${window.ICONS[name] || window.ICONS.tag}</svg>`;
function hydrate(root = document) {
  $$('i[data-i]', root).forEach((el) => (el.outerHTML = ic(el.dataset.i, el.className)));
}
const NO_CAT = { id: null, name: 'Sin categoría', color: '#94a3b8', icon: 'package' };
const catOf = (id) => cats.find((c) => c.id === id) || NO_CAT;
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#94a3b8');
const catIc = (c, cls = '') => `<span class="cat-ic ${cls}" style="--c:${safeColor(c.color)}">${ic(c.icon)}</span>`;
const catTag = (c) => `<span class="cat-tag" style="--c:${safeColor(c.color)}">${ic(c.icon)}${esc(c.name)}</span>`;
const trendHtml = (p, suffix = '', upIsGood = false) =>
  p === null ? '' : `<span class="trend ${(p > 0) !== upIsGood ? 'up' : 'down'}">${ic(p > 0 ? 'trending-up' : 'trending-down', 'xs')}${Math.abs(p).toFixed(0)}%</span>${suffix}`;
const emptyHtml = (icon, title, text, action = '') =>
  `<div class="empty"><span class="ichip">${ic(icon, 'lg')}</span><b>${title}</b>${text ? `<p>${text}</p>` : ''}${action}</div>`;

function toast(msg, isError = false) {
  const t = $('#toast');
  t.className = isError ? 'err' : '';
  t.innerHTML = ic(isError ? 'triangle-alert' : 'circle-check') + `<span>${esc(msg)}</span>`;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agenda' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Sin conexión con el servidor');
  }
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (r.status === 401 && me && !path.startsWith('/auth') && !path.startsWith('/me/') && !path.startsWith('/2fa')) { showAuth(); throw new Error('Tu sesión ha caducado'); }
  if (!r.ok) { const err = new Error(data?.error || 'No se pudo conectar con el servidor'); err.code = data?.code; throw err; }
  return data;
}
// Descarga un archivo de la API (p. ej. el Excel) usando la sesión
async function download(path, fallbackName) {
  const r = await fetch('/api' + path, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('No se pudo generar el archivo');
  const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); toast('Copiado'); } catch { toast('No se pudo copiar', true); } };
function ago(ts) {
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return 'ahora mismo';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) return `hace ${Math.round(s / 86400)} días`;
  return new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}
// Fuerza de la contraseña (0-4)
function pwScore(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^a-zA-Z0-9]/.test(pw)) s++;
  if (pw.length < 8 || !/\d/.test(pw) || !/[a-zA-Z]/.test(pw)) s = Math.min(s, 1);
  return Math.max(1, s);
}
const PW_TXT = ['', 'Débil: usa 8+ caracteres con letras y números', 'Aceptable', 'Buena', 'Muy segura'];
function paintMeter(el, pw) {
  if (!el) return;
  if (!pw) { el.innerHTML = ''; return; }
  const l = pwScore(pw);
  el.dataset.l = l;
  el.innerHTML = `<div class="pw-bars"><span></span><span></span><span></span><span></span></div><small>${PW_TXT[l]}</small>`;
}
// Botones de mostrar/ocultar contraseña
document.addEventListener('click', (e) => {
  const b = e.target.closest('.pw-eye');
  if (!b) return;
  const input = b.parentElement.querySelector('input');
  input.type = input.type === 'password' ? 'text' : 'password';
  b.innerHTML = ic(input.type === 'password' ? 'eye' : 'eye-off');
});
// Acciones declarativas (la política de seguridad no permite onclick en el HTML)
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'new-expense') expenseForm();
  if (act === 'new-income') incomeForm();
  if (act === 'new-saving') savingForm();
  if (act === 'retry') route();
  if (act === 'onboarding') onboarding();
});

// ---------- Tema ----------
const THEME_KEY = 'agenda_tema';
const themePref = () => store.get(THEME_KEY) || 'system';
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme(pref) {
  store.set(THEME_KEY, pref === 'system' ? null : pref);
  if (pref === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  $('#themeBtn').innerHTML = ic(isDark() ? 'sun' : 'moon');
  document.querySelector('meta[name=theme-color]').content = isDark() ? '#0c0e17' : '#1e3a8a';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'system') { applyTheme('system'); route(); } });

// ---------- Gráficos ----------
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function chart(canvas, config) {
  if (!window.Chart || !canvas) return;
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--border');
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.plugins.tooltip.backgroundColor = '#14162a';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 10;
  Chart.defaults.plugins.tooltip.displayColors = false;
  charts.push(new Chart(canvas, config));
}
const moneyTooltip = { callbacks: { label: (c) => ` ${eur(c.parsed.y ?? c.parsed)}` } };
const moneyAxis = { ticks: { callback: (v) => eurShort(v), maxTicksLimit: 5 }, beginAtZero: true, border: { display: false }, grid: { color: () => cssVar('--border') } };
const barOpts = { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: moneyTooltip }, scales: { y: moneyAxis, x: { grid: { display: false }, border: { display: false } } } };
function donut(canvas, items) {
  chart(canvas, {
    type: 'doughnut',
    data: { labels: items.map((x) => x.name), datasets: [{ data: items.map((x) => x.total), backgroundColor: items.map((x) => safeColor(x.color)), borderWidth: 3, borderColor: cssVar('--surface'), hoverOffset: 6 }] },
    options: { maintainAspectRatio: false, cutout: '72%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${eur(c.parsed)}` } } } },
  });
}
const legendHtml = (items, total) =>
  `<div class="legend">${items.slice(0, 6).map((x) => `<div class="lg"><span class="swatch" style="background:${safeColor(x.color)}"></span><span class="n">${esc(x.name)}</span><b>${eur(x.total)}</b><em>${total ? Math.round((x.total / total) * 100) : 0}%</em></div>`).join('')}</div>`;

// ---------- Modal / hoja ----------
let modalSubmit = null;
let modalLocked = false;
function openModal({ title, icon = '', html, onSubmit, okText = 'Guardar', danger = false, actions = true, locked = false }) {
  modalLocked = locked;
  $('#modalBody').className = '';
  $('#modalClose').classList.toggle('hidden', locked);
  $('#modalTitle').textContent = title;
  $('#modalIcon').innerHTML = icon ? `<span class="ichip sm ${danger ? 'red' : ''}">${ic(icon)}</span>` : '';
  $('#modalBody').innerHTML = html;
  $('#modalError').textContent = '';
  $('#modalOk').textContent = okText;
  $('#modalOk').className = 'btn ' + (danger ? 'danger solid' : 'primary');
  $('#modalActions').classList.toggle('hidden', !actions);
  $('#modalCancel').classList.toggle('hidden', locked);
  hydrate($('#modalBody'));
  modalSubmit = onSubmit;
  $('#modal').showModal();
  if (matchMedia('(min-width: 901px)').matches) setTimeout(() => $('#modalBody input:not([type=hidden]), #modalBody select')?.focus(), 40);
}
const closeModal = () => { modalLocked = false; $('#modal').close(); };
$('#modal').addEventListener('cancel', (e) => { if (modalLocked) e.preventDefault(); });
$('#modalCancel').onclick = closeModal;
$('#modalClose').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal') && !modalLocked) closeModal(); });
$('#modalForm').onsubmit = async (ev) => {
  ev.preventDefault();
  if (!modalSubmit) return;
  const data = {};
  for (const el of ev.target.elements) if (el.name) data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  $('#modalOk').disabled = true;
  try {
    await modalSubmit(data);
    closeModal();
  } catch (e) {
    $('#modalError').textContent = e.message;
  } finally {
    $('#modalOk').disabled = false;
  }
};
const confirmModal = (title, text, onOk) => openModal({ title, icon: 'trash-2', html: `<p style="margin:0 0 6px;color:var(--text-2)">${text}</p>`, onSubmit: onOk, okText: 'Eliminar', danger: true });

// Selector de categoría en forma de chips
function catPicker(selected) {
  return `<div class="mini-label">Categoría</div><input type="hidden" name="categoryId" value="${esc(selected || '')}">
    <div class="cat-pick">${[NO_CAT, ...cats].map((c) => `<button type="button" data-id="${c.id || ''}" class="${(c.id || '') === (selected || '') ? 'on' : ''}" style="--c:${safeColor(c.color)}">${ic(c.icon)}${esc(c.id ? c.name : 'Ninguna')}</button>`).join('')}</div>`;
}
function bindCatPicker(root) {
  const box = $('.cat-pick', root);
  if (!box) return;
  box.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', box).forEach((x) => x.classList.toggle('on', x === b));
    $('input[name=categoryId]', root).value = b.dataset.id;
  };
}

async function loadPlaces() {
  try { $('#placesList').innerHTML = (await api('/places')).map((p) => `<option value="${esc(p)}">`).join(''); } catch {}
}

// ---------- Formularios ----------
function expenseForm(exp = {}, preset = {}) {
  loadPlaces();
  const more = !!(exp.accountId || exp.paymentMethod || exp.tags?.length || exp.notes);
  openModal({
    title: exp.id ? 'Editar gasto' : 'Nuevo gasto',
    icon: exp.id ? 'pencil' : 'receipt-text',
    html: `${!exp.id ? `<button type="button" class="btn full scan-btn" id="scanInForm">${ic('scan-line', 'sm')}Escanear un ticket con la cámara</button>` : ''}
      ${exp.receiptId ? `<div class="notice ok" style="margin-bottom:14px">${ic('receipt', 'sm')}<span>Gasto creado desde un ticket escaneado. <a href="#/tickets" id="goTickets">Ver el ticket</a></span></div>` : ''}
      ${exp.demo ? `<div class="notice warn" style="margin-bottom:14px">${ic('flask-conical', 'sm')}<span>Dato de demostración</span></div>` : ''}
      <label class="field">Importe
        <div class="input-money"><input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required value="${exp.amount ?? ''}" placeholder="0,00"><span>€</span></div>
      </label>
      <label class="field">Concepto<input name="name" required maxlength="100" value="${esc(exp.name || '')}" placeholder="Ej: Compra semanal"></label>
      ${catPicker(exp.categoryId ?? preset.categoryId)}
      <div class="row">
        <label class="field">Fecha<input name="date" type="date" required value="${exp.date || preset.date || ymd(todayD())}"></label>
        <label class="field">¿Dónde?<div class="input-icon"><i data-i="map-pin"></i><input name="place" list="placesList" maxlength="100" value="${esc(exp.place || '')}" placeholder="Tienda, web, lugar…"></div></label>
      </div>
      <details class="more-fields" ${more ? 'open' : ''}><summary>${ic('chevron-down', 'sm')}Más detalles: cuenta, método de pago, etiquetas y notas</summary>
        <div class="row">
          ${accountSelect(exp.accountId || '')}
          <label class="field">Método de pago<select name="paymentMethod"><option value="">—</option>${Object.entries(PAY_METHODS).map(([k, l]) => `<option value="${k}" ${exp.paymentMethod === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <label class="field">Etiquetas<input name="tags" maxlength="200" value="${esc((exp.tags || []).join(', '))}" placeholder="Ej: vacaciones, trabajo (separadas por comas)"></label>
        <label class="field">Notas<textarea name="notes" maxlength="500" placeholder="Opcional">${esc(exp.notes || '')}</textarea></label>
      </details>
      ${exp.id ? `<div class="form-extra"><button type="button" class="btn sm" id="dupInModal">${ic('copy-plus', 'sm')}Duplicar</button><button type="button" class="btn danger sm" id="delInModal">${ic('trash-2', 'sm')}Eliminar gasto</button></div>` : ''}`,
    onSubmit: async (d) => {
      d.amount = Number(d.amount);
      if (exp.id) await api('/expenses/' + exp.id, { method: 'PUT', body: d });
      else await api('/expenses', { method: 'POST', body: d });
      toast(exp.id ? 'Gasto actualizado' : 'Gasto añadido');
      route();
      refreshNotifs();
    },
  });
  bindCatPicker($('#modalBody'));
  $('#delInModal')?.addEventListener('click', () => deleteExpense(exp));
  $('#dupInModal')?.addEventListener('click', async () => {
    try { await api(`/expenses/${exp.id}/duplicate`, { method: 'POST', body: { date: ymd(todayD()) } }); closeModal(); toast('Gasto duplicado con fecha de hoy'); route(); } catch (e) { toast(e.message, true); }
  });
  $('#goTickets')?.addEventListener('click', closeModal);
  $('#scanInForm')?.addEventListener('click', () => { closeModal(); pickReceipt(); });
}

function recurringForm(rec = {}) {
  loadPlaces();
  const freq = rec.frequency || 'monthly';
  openModal({
    title: rec.id ? 'Editar pago fijo' : 'Nuevo pago fijo',
    icon: 'repeat',
    html: `
      <label class="field">Importe
        <div class="input-money"><input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required value="${rec.amount ?? ''}" placeholder="0,00"><span>€</span></div>
      </label>
      <label class="field">Concepto<input name="name" required maxlength="100" value="${esc(rec.name || '')}" placeholder="Alquiler, luz, seguro, Netflix…"></label>
      ${catPicker(rec.categoryId)}
      <div class="row">
        <label class="field">Se repite<select name="frequency" id="recFreq">${FREQ_OPTS.map(([k, l]) => `<option value="${k}" ${freq === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">${rec.id ? 'Fecha de referencia' : 'Primer cobro'}<input name="anchorDate" type="date" required value="${rec.anchorDate || rec.nextDue || ymd(todayD())}"></label>
      </div>
      <div class="row ${freq === 'custom' ? '' : 'hidden'}" id="recCustom">
        <label class="field">Cada<input name="every" type="number" min="1" max="365" value="${rec.every || 2}"></label>
        <label class="field">Unidad<select name="unit"><option value="months" ${rec.unit !== 'days' ? 'selected' : ''}>meses</option><option value="days" ${rec.unit === 'days' ? 'selected' : ''}>días</option></select></label>
      </div>
      <p class="set-desc" style="margin-top:-6px">Si el día no existe en un mes (p. ej. el 31), se cobra el último día de ese mes.</p>
      <div class="row">
        <label class="field">Avisar<select name="remindDaysBefore">${[[0, 'El mismo día'], [1, 'Un día antes'], [3, 'Tres días antes'], [7, 'Una semana antes']].map(([v, l]) => `<option value="${v}" ${(rec.remindDaysBefore ?? 3) === v ? 'selected' : ''}>${l}</option>`).join('')}
          ${![0, 1, 3, 7].includes(rec.remindDaysBefore ?? 3) ? `<option value="${rec.remindDaysBefore}" selected>${rec.remindDaysBefore} días antes</option>` : ''}</select></label>
        ${accountSelect(rec.accountId || '') || `<label class="field">¿Quién cobra?<div class="input-icon"><i data-i="store"></i><input name="place" list="placesList" maxlength="100" value="${esc(rec.place || '')}" placeholder="Banco, Netflix…"></div></label>`}
      </div>
      ${accs.length ? `<label class="field">¿Quién cobra?<div class="input-icon"><i data-i="store"></i><input name="place" list="placesList" maxlength="100" value="${esc(rec.place || '')}" placeholder="Banco, Netflix…"></div></label>` : ''}
      <label class="switch-row"><span class="ichip sm amber">${ic('zap', 'sm')}</span><span class="txt"><b>Registro automático</b><small>Se añade a tus gastos el día del cobro (domiciliaciones)</small></span>
        <span class="switch"><input type="checkbox" name="autoAdd" ${rec.autoAdd ?? true ? 'checked' : ''}><span></span></span></label>
      <label class="switch-row"><span class="ichip sm green">${ic('circle-check', 'sm')}</span><span class="txt"><b>Activo</b><small>Desactívalo si lo pausas o lo cancelas</small></span>
        <span class="switch"><input type="checkbox" name="active" ${rec.active ?? true ? 'checked' : ''}><span></span></span></label>`,
    onSubmit: async (d) => {
      d.amount = Number(d.amount);
      d.remindDaysBefore = Number(d.remindDaysBefore);
      d.every = Number(d.every);
      if (rec.id) await api('/recurring/' + rec.id, { method: 'PUT', body: d });
      else await api('/recurring', { method: 'POST', body: d });
      toast('Pago fijo guardado');
      route();
    },
  });
  bindCatPicker($('#modalBody'));
  $('#recFreq').onchange = (e) => $('#recCustom').classList.toggle('hidden', e.target.value !== 'custom');
}

const PALETTE = ['#f97316', '#ef4444', '#db2777', '#9333ea', '#7c3aed', '#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#65a30d', '#ca8a04', '#a16207', '#64748b'];
function categoryForm(cat = {}) {
  let color = cat.color || '#4f46e5';
  let icon = cat.icon || 'tag';
  openModal({
    title: cat.id ? 'Editar categoría' : 'Nueva categoría',
    icon: 'tag',
    html: `
      <div class="cat-preview" id="catPrev"></div>
      <input type="hidden" name="color" value="${esc(color)}"><input type="hidden" name="icon" value="${esc(icon)}">
      <label class="field">Nombre<input name="name" required maxlength="40" value="${esc(cat.name || '')}" placeholder="Ej: Mascotas"></label>
      <div class="mini-label">Color</div>
      <div class="color-picker" id="colPick">${PALETTE.map((c) => `<button type="button" data-c="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('')}
        <input type="color" id="colCustom" value="${esc(color)}" title="Otro color"></div>
      <div class="mini-label">Icono</div>
      <div class="icon-picker" id="icPick">${window.CATEGORY_ICONS.map((n) => `<button type="button" data-n="${n}" title="${n}">${ic(n)}</button>`).join('')}</div>`,
    onSubmit: async (d) => {
      if (cat.id) await api('/categories/' + cat.id, { method: 'PUT', body: d });
      else await api('/categories', { method: 'POST', body: d });
      cats = await api('/categories');
      toast('Categoría guardada');
      route();
    },
  });
  const root = $('#modalBody');
  const paint = () => {
    $('input[name=color]', root).value = color;
    $('input[name=icon]', root).value = icon;
    $('#catPrev').innerHTML = catIc({ color, icon }) + `<div><b>${esc($('input[name=name]', root).value || 'Nueva categoría')}</b><div>${catTag({ color, icon, name: 'Así se verá' })}</div></div>`;
    $$('#colPick button').forEach((b) => b.classList.toggle('on', b.dataset.c === color));
    $$('#icPick button').forEach((b) => { b.classList.toggle('on', b.dataset.n === icon); b.style.setProperty('--c', color); });
  };
  $('#colPick').onclick = (e) => { const b = e.target.closest('button'); if (b) { color = b.dataset.c; paint(); } };
  $('#colCustom').oninput = (e) => { color = e.target.value; paint(); };
  $('#icPick').onclick = (e) => { const b = e.target.closest('button'); if (b) { icon = b.dataset.n; paint(); } };
  $('input[name=name]', root).oninput = paint;
  paint();
}

function deleteExpense(e) {
  confirmModal('Eliminar gasto', `¿Seguro que quieres eliminar <b>${esc(e.name)}</b> (${eur(e.amount)})? No se puede deshacer.`, async () => {
    await api('/expenses/' + e.id, { method: 'DELETE' });
    toast('Gasto eliminado');
    route();
  });
}

const expenseRow = (e, { actions = false, date = true } = {}) => {
  const c = catOf(e.categoryId);
  const meta = [date ? fmtDate(e.date) : '', esc(c.name), e.place ? `${ic('map-pin')}${esc(e.place)}` : '', e.recurringId ? `${ic('repeat')}Fijo` : '', e.scanned ? `${ic('scan-line')}Ticket` : '', e.accountId && typeof accOf === 'function' && accOf(e.accountId) ? `${ic('landmark')}${esc(accOf(e.accountId).name)}` : '', ...(e.tags || []).slice(0, 3).map((t) => `#${esc(t)}`), e.demo ? '<span class="badge warn sm">Demo</span>' : '']
    .filter(Boolean)
    .join('<span class="dot-sep"></span>');
  return `<div class="li click" data-id="${e.id}">
    ${catIc(c, 'sm')}
    <div class="main"><b>${esc(e.name)}</b><small>${meta}</small></div>
    <div class="amt">${eur(e.amount)}</div>
    ${actions ? `<div class="row-actions"><button class="icon-btn sm" data-edit="${e.id}" title="Editar">${ic('pencil', 'sm')}</button><button class="icon-btn sm danger" data-del="${e.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></div>` : ''}
  </div>`;
};
function bindExpenseClicks(root, list) {
  if (!root) return;
  root.addEventListener('click', (ev) => {
    const del = ev.target.closest('[data-del]');
    if (del) return deleteExpense(list.find((x) => x.id === del.dataset.del));
    const el = ev.target.closest('[data-id]');
    const e = el && list.find((x) => x.id === el.dataset.id);
    if (e) expenseForm(e);
  });
}

// ---------- Avisos del sistema ----------
function updateDueBadge(recs) {
  const n = recs.filter((r) => r.active && !r.paidThisMonth && r.daysLeft <= r.remindDaysBefore).length;
  const b = $('#dueCount');
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}
function notifyUpcoming(recs) {
  if (!('Notification' in window)) return;
  const due = recs.filter((r) => r.active && !r.paidThisMonth && r.daysLeft <= r.remindDaysBefore);
  if (!due.length) return;
  const go = () => {
    for (const r of due) {
      const key = `notified_${r.id}_${r.nextDue}`;
      try { if (sessionStorage.getItem(key)) continue; sessionStorage.setItem(key, '1'); } catch {}
      new Notification(`${r.name} · ${eur(r.amount)}`, { body: `${daysTxt(r.daysLeft)} (${fmtDate(r.nextDue, { day: 'numeric', month: 'long' })})`, icon: '/icons/icon-192.png' });
    }
  };
  if (Notification.permission === 'granted') go();
  else if (Notification.permission === 'default') Notification.requestPermission().then((p) => p === 'granted' && go());
}

// ================= VISTAS =================
const state = { month: monthKey(todayD()), cat: '', q: '', calMonth: monthKey(todayD()), calSel: ymd(todayD()), week: ymd(todayD()) };

// ---------- Panel ----------
async function renderDashboard(el) {
  const t = todayD();
  const mk = monthKey(t);
  const [ov, exps, incs, recs] = await Promise.all([
    api('/overview'),
    api(`/expenses?from=${ymd(addDays(t, -40))}&to=${ymd(addDays(t, 60))}`),
    api(`/incomes?from=${ymd(addDays(t, -40))}&to=${ymd(t)}`),
    api('/recurring'),
  ]);
  updateDueBadge(recs);
  const m = ov.money;
  const prevD = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const diff = pct(ov.monthExpenses, ov.prevMonthExpenses);
  const monthExp = exps.filter((e) => e.date.startsWith(mk));
  const byCat = {};
  for (const e of monthExp) byCat[e.categoryId || ''] = (byCat[e.categoryId || ''] || 0) + e.amount;
  const catItems = Object.entries(byCat).map(([id, total]) => ({ ...catOf(id || null), total })).sort((a, b) => b.total - a.total);
  const activity = [...exps.filter((e) => e.date <= ymd(t)).map((e) => ({ ...e, kind: 'expense' })), ...incs.map((i) => ({ ...i, kind: 'income' }))]
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 8);
  const upcoming = recs.filter((r) => r.active && r.nextDue && r.daysLeft <= 31 && !(r.state === 'paid' && r.daysLeft > 20)).slice(0, 5);
  const eom = ov.endOfMonth;
  const general = ov.budgets.find((b) => !b.categoryId);

  el.innerHTML = `
  ${!ov.hasData && !m.hasAccounts ? `<div class="card welcome-card"><span class="ichip lg">${ic('rocket', 'lg')}</span><div><b>Empieza en 3 pasos</b><p>Añade tu cuenta con su saldo, apunta un gasto (o escanea un ticket) y registra tu nómina. También puedes probar con datos de demostración.</p></div>
    <div class="btns"><a class="btn primary sm" href="#/cuentas">${ic('landmark', 'sm')}Añadir cuenta</a><button class="btn sm" data-act="onboarding">${ic('sparkles', 'sm')}Asistente de inicio</button></div></div>` : ''}
  <div class="grid g3">
    <div class="hero span2">
      <div>
        <div class="label">${ic(m.hasAccounts ? 'landmark' : 'wallet', 'sm')}${m.hasAccounts ? 'Saldo total' : `Gastado en ${monthName(t, false)}`}</div>
        <div class="amount">${eur(m.hasAccounts ? m.balance : ov.monthExpenses)}</div>
        ${m.hasAccounts
          ? `<div class="pill">${ic('wallet', 'xs')}Puedes gastar ${eur(m.perDay)} al día hasta fin de mes</div>`
          : `<div class="pill">${diff === null ? `${ic('sparkles', 'xs')}Tu primer mes con datos` : `${ic(diff > 0 ? 'trending-up' : 'trending-down', 'xs')}${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(0)}% que en ${monthName(prevD, false)}`}</div>`}
      </div>
      <div class="foot">
        ${m.hasAccounts ? `<div><b>${eur(m.available)}</b>disponible</div><div><b>${eur(m.reservedBills)}</b>reservado para pagos</div>` : `<div><a href="#/cuentas" style="color:#fff;text-decoration:underline">Añade tus cuentas</a> para ver tu saldo</div>`}
        <div><b>${m.budgetRemaining === null ? '—' : eur(m.budgetRemaining)}</b>${m.budgetRemaining === null ? '<a href="#/presupuestos" style="color:#fff;text-decoration:underline">sin presupuesto</a>' : 'presupuesto restante'}</div>
        ${general ? `<div style="min-width:160px;flex:1;max-width:240px"><b>${general.percent}% <span style="font-weight:500;opacity:.8;font-size:13px">del presupuesto</span></b><div class="progress thin" style="margin-top:7px"><div style="width:${Math.min(100, general.percent)}%"></div></div></div>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('calendar-clock', 'sm')}Próximos pagos</h3><a class="link" href="#/mensuales">Ver todos${ic('chevron-right', 'xs')}</a></div>
      <div class="list">${upcoming.map((r) => { const c = catOf(r.categoryId); return `<div class="li">
        ${catIc(c, 'sm')}<div class="main"><b>${esc(r.name)}</b><small>${fmtDate(r.nextDue, { weekday: 'short', day: 'numeric', month: 'short' })}</small></div>
        <div style="text-align:right"><div class="amt">${eur(r.amount)}</div><span class="badge ${r.state === 'overdue' ? 'danger' : r.state === 'paid' ? 'ok' : r.daysLeft <= r.remindDaysBefore ? 'warn' : ''}" style="margin-top:3px">${r.state === 'overdue' ? 'Atrasado' : r.state === 'paid' ? 'Pagado' : daysTxt(r.daysLeft)}</span></div></div>`; }).join('')
        || emptyHtml('repeat', 'Sin pagos fijos', 'Añade alquiler, luz o suscripciones y te avisaremos antes de cada cobro.', `<a class="btn sm" href="#/mensuales">${ic('plus', 'sm')}Añadir</a>`)}</div>
    </div>
  </div>

  <div class="grid g4 stats">
    <a class="card stat" href="#/ingresos" style="color:inherit"><div class="top"><span class="label">Ingresos del mes</span><span class="ichip green">${ic('hand-coins')}</span></div>
      <div><div class="value">${eur(ov.monthIncomes)}</div><div class="sub">${cap(monthName(t, false))}</div></div></a>
    <a class="card stat" href="#/gastos" style="color:inherit"><div class="top"><span class="label">Gastos del mes</span><span class="ichip red">${ic('receipt-text')}</span></div>
      <div><div class="value">${eur(ov.monthExpenses)}</div><div class="sub">${trendHtml(diff, ` vs. ${monthName(prevD, false)}`) || `${monthExp.length} gastos`}</div></div></a>
    <div class="card stat"><div class="top"><span class="label">Ahorro mensual</span><span class="ichip">${ic('piggy-bank')}</span></div>
      <div><div class="value ${ov.monthSaving < 0 ? 'neg' : ''}">${eur(ov.monthSaving)}</div><div class="sub">${ov.savingsRate === null ? 'Ingresos − gastos' : `${ov.savingsRate} % de tus ingresos`}</div></div></div>
    <a class="card stat" href="#/previsiones" style="color:inherit"><div class="top"><span class="label">Previsión fin de mes</span><span class="ichip amber">${ic('chart-line')}</span></div>
      <div><div class="value ${eom && eom.realistic < 0 ? 'neg' : ''}">${eom ? eur(eom.realistic) : '—'}</div><div class="sub">Fiabilidad ${ov.confidence.label.toLowerCase()}</div></div></a>
  </div>

  ${ov.alerts.length || ov.tips.length ? `<div class="grid g3">
    <div class="card span2"><div class="card-head"><h3>${ic('lightbulb', 'sm')}Consejos para mejorar tus finanzas</h3><a class="link" href="#/asistente?tab=consejos">Ver todos${ic('chevron-right', 'xs')}</a></div>
      <div class="tips-mini">${ov.tips.map((r) => `<a href="${esc(r.action.href)}" class="tip-mini"><span class="ichip sm ${r.priority === 'alta' ? 'red' : r.priority === 'media' ? 'amber' : ''}">${ic('lightbulb', 'sm')}</span><span><b>${esc(r.title)}</b><small>${esc(r.evidence[0] || r.text)}</small></span>${r.potential ? `<em>≈ ${eurShort(r.potential)}/mes</em>` : ''}</a>`).join('') || emptyHtml('party-popper', 'Todo en orden', 'Cuando tengamos más datos te daremos consejos personalizados.')}</div></div>
    <div class="card"><div class="card-head"><h3>${ic('bell-ring', 'sm')}Previsiones</h3></div>
      <div class="alert-list">${ov.alerts.map((a) => `<div class="notice ${a.level === 'danger' ? 'danger' : a.level === 'warn' ? 'warn' : a.level === 'ok' ? 'ok' : ''}">${ic(a.level === 'danger' || a.level === 'warn' ? 'triangle-alert' : 'info', 'sm')}<span>${esc(a.text)}</span></div>`).join('') || emptyHtml('circle-check', 'Sin alertas', '')}</div></div>
  </div>` : ''}

  <div class="grid g3">
    <div class="card span2">
      <div class="card-head"><h3>${ic('chart-column', 'sm')}Ingresos y gastos</h3><span class="badge">Últimos 6 meses</span></div>
      <div class="chart-box"><canvas id="cMonths"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('chart-pie', 'sm')}Por categoría</h3><span class="badge">${cap(monthName(t, false))}</span></div>
      ${catItems.length ? `<div class="donut-wrap"><canvas id="cCat"></canvas><div class="donut-center"><div><b>${eurShort(ov.monthExpenses)}</b><small>total</small></div></div></div>${legendHtml(catItems, ov.monthExpenses)}`
        : emptyHtml('chart-pie', 'Sin datos este mes', 'Cuando añadas gastos verás aquí el reparto.')}
    </div>
  </div>

  <div class="grid g3">
    <div class="card span2">
      <div class="card-head"><h3>${ic('chart-line', 'sm')}Saldo: evolución y previsión</h3><a class="link" href="#/previsiones">Detalle${ic('chevron-right', 'xs')}</a></div>
      ${m.hasAccounts ? '<div class="chart-box sm"><canvas id="cBal"></canvas></div>' : emptyHtml('chart-line', 'Añade tus cuentas', 'Con el saldo de tus cuentas te mostramos cómo evolucionará.', `<a class="btn sm" href="#/cuentas">${ic('plus', 'sm')}Añadir cuenta</a>`)}
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('target', 'sm')}Presupuestos</h3><a class="link" href="#/presupuestos">Ver${ic('chevron-right', 'xs')}</a></div>
      <div class="list">${ov.budgets.map((b) => `<div class="li"><div class="main"><div class="bl-top"><b>${esc(b.category?.name || 'General')}</b><small>${eur(b.spent)} / ${eur(b.amount)}</small></div>${bar(b.percent, b.level.key)}</div></div>`).join('')
        || emptyHtml('target', 'Sin presupuestos', 'Pon límites a tus categorías.', `<a class="btn sm" href="#/presupuestos">${ic('plus', 'sm')}Crear</a>`)}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>${ic('clock', 'sm')}Actividad reciente</h3><a class="link" href="#/gastos">Ver todo${ic('chevron-right', 'xs')}</a></div>
    <div class="list" id="recent">${activity.map((x) => x.kind === 'income'
      ? `<div class="li click" data-inc="${x.id}"><span class="cat-ic sm" style="--c:#16a34a">${ic('hand-coins')}</span><div class="main"><b>${esc(x.name)}</b><small>${fmtDate(x.date)}<span class="dot-sep"></span>Ingreso</small></div><div class="amt pos">+${eur(x.amount)}</div></div>`
      : expenseRow(x)).join('')
      || emptyHtml('receipt-text', 'Todavía no hay movimientos', 'Pulsa «Nuevo gasto» o escanea un ticket.', `<button class="btn primary sm" data-act="new-expense">${ic('plus', 'sm')}Nuevo gasto</button>`)}</div>
  </div>`;

  $('#recent').addEventListener('click', (ev) => {
    const i = ev.target.closest('[data-inc]');
    if (i) return incomeForm(incs.find((x) => x.id === i.dataset.inc));
    const el2 = ev.target.closest('[data-id]');
    const e = el2 && exps.find((x) => x.id === el2.dataset.id);
    if (e) expenseForm(e);
  });
  if (catItems.length) donut($('#cCat'), catItems);
  chart($('#cMonths'), {
    type: 'bar',
    data: {
      labels: ov.months.map((x) => cap(parse(x.month + '-01').toLocaleDateString('es-ES', { month: 'short' }).replace('.', ''))),
      datasets: [
        { label: 'Ingresos', data: ov.months.map((x) => x.incomes), backgroundColor: cssVar('--success'), borderRadius: 6, maxBarThickness: 22 },
        { label: 'Gastos', data: ov.months.map((x) => x.expenses), backgroundColor: cssVar('--danger'), borderRadius: 6, maxBarThickness: 22 },
      ],
    },
    options: { ...barOpts, plugins: { ...barOpts.plugins, legend: { display: true, position: 'bottom', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${eur(c.parsed.y)}` } } } },
  });
  if (m.hasAccounts) {
    const hist = ov.history;
    const fut = ov.forecastSeries;
    const labels = [...hist.map((x) => x.date), ...fut.slice(1).map((x) => x.date)];
    chart($('#cBal'), {
      type: 'line',
      data: {
        labels: labels.map((d) => fmtDate(d)),
        datasets: [
          { label: 'Saldo', data: [...hist.map((x) => x.balance), ...fut.slice(1).map(() => null)], borderColor: cssVar('--text-2'), borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: 'Previsto', data: [...hist.slice(0, -1).map(() => null), fut[0]?.realistic ?? null, ...fut.slice(1).map((x) => x.realistic)], borderColor: cssVar('--primary'), borderDash: [6, 4], borderWidth: 2.5, pointRadius: 0, tension: 0.3 },
        ],
      },
      options: { ...barOpts, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => (c.parsed.y == null ? null : ` ${c.dataset.label}: ${eur(c.parsed.y)}`) } } }, scales: { y: { ...moneyAxis, beginAtZero: false }, x: { grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 7 } } } },
    });
  }
}

// ---------- Gastos ----------
async function renderExpenses(el) {
  const mDate = parse(state.month + '-01');
  el.innerHTML = `
  <div class="toolbar">
    <div class="month-nav"><button class="icon-btn" id="mPrev" title="Mes anterior">${ic('chevron-left')}</button><span class="lbl">${cap(monthName(mDate))}</span><button class="icon-btn" id="mNext" title="Mes siguiente">${ic('chevron-right')}</button></div>
    <select id="fCat"><option value="">Todas las categorías</option><option value="none">Sin categoría</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
    <div class="input-icon grow">${ic('search')}<input type="search" id="fQ" placeholder="Buscar concepto, lugar o nota…" value="${esc(state.q)}"></div>
    ${accs.length ? `<select id="fAcc"><option value="">Todas las cuentas</option>${accs.map((a) => `<option value="${a.id}" ${state.acc === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
    <button class="btn" id="btnCsv">${ic('file-spreadsheet', 'sm')}Exportar</button>
  </div>
  <div class="card"><div id="tbl"><div class="skeleton" style="height:240px"></div></div></div>`;
  $('#fCat').value = state.cat;
  let list = [];
  const load = async () => {
    const [y, m] = state.month.split('-').map(Number);
    const qs = new URLSearchParams({ from: `${y}-${pad(m)}-01`, to: ymd(new Date(y, m, 0)) });
    if (state.cat) qs.set('category', state.cat);
    if (state.acc) qs.set('account', state.acc);
    if (state.q) qs.set('q', state.q);
    list = await api('/expenses?' + qs);
    if (!list.length) {
      $('#tbl').innerHTML = emptyHtml('receipt-text', state.q || state.cat ? 'No hay resultados' : 'Sin gastos este mes', state.q || state.cat ? 'Prueba con otros filtros.' : 'Apunta un gasto y aparecerá aquí.',
        `<button class="btn primary sm" id="emptyAdd">${ic('plus', 'sm')}Nuevo gasto</button>`);
      $('#emptyAdd').onclick = () => expenseForm();
      return;
    }
    const total = sum(list);
    const top = list.reduce((a, b) => (b.amount > a.amount ? b : a));
    const groups = {};
    for (const e of list) (groups[e.date] ||= []).push(e);
    $('#tbl').innerHTML = `
      <div class="summary-strip">
        <div><small>Total</small><b>${eur(total)}</b></div>
        <div><small>Gastos</small><b>${list.length}</b></div>
        <div><small>Media por gasto</small><b>${eur(total / list.length)}</b></div>
        <div><small>Mayor gasto</small><b>${eur(top.amount)}</b></div>
      </div>
      ${Object.entries(groups).map(([d, items]) => `<div class="day-group">
        <div class="day-head"><span>${fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}</span><span>${eur(sum(items))}</span></div>
        <div class="list">${items.map((e) => expenseRow(e, { actions: true, date: false })).join('')}</div></div>`).join('')}`;
  };
  bindExpenseClicks($('#tbl'), { find: (fn) => list.find(fn) });
  const shift = (n) => { state.month = monthKey(new Date(mDate.getFullYear(), mDate.getMonth() + n, 1)); route(); };
  $('#mPrev').onclick = () => shift(-1);
  $('#mNext').onclick = () => shift(1);
  $('#fCat').onchange = (e) => { state.cat = e.target.value; load(); };
  let qt;
  $('#fQ').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value; load(); }, 250); };
  $('#btnCsv').onclick = exportModal;
  $('#fAcc')?.addEventListener('change', (e) => { state.acc = e.target.value; load(); });
  await load();
}

// ---------- Calendario ----------
const calF = { exp: true, inc: true, bills: true, rec: true, cat: '', acc: '', view: 'mes' };
async function renderCalendar(el) {
  const base = parse(state.calMonth + '-01');
  const y = base.getFullYear(), m = base.getMonth();
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const tStr = ymd(todayD());
  // En la vista semanal puede que la semana cruce de mes: se cargan los dos
  const weekFrom = weekStart(parse(state.calSel));
  const months = [...new Set([state.calMonth, monthKey(weekFrom), monthKey(addDays(weekFrom, 6))])];
  const parts = await Promise.all(months.map((mk) => api('/calendar?month=' + mk)));
  const data = { expenses: parts.flatMap((p) => p.expenses), incomes: parts.flatMap((p) => p.incomes), bills: parts.flatMap((p) => p.bills) };
  const exps = data.expenses.filter((e) => (!calF.cat || e.categoryId === calF.cat) && (!calF.acc || e.accountId === calF.acc));
  const by = (list) => { const o = {}; for (const x of list) (o[x.date] ||= []).push(x); return o; };
  const E = by(calF.exp ? exps : []);
  const I = by(calF.inc && !calF.cat ? data.incomes.filter((i) => !calF.acc || i.accountId === calF.acc) : []);
  const B = by(data.bills.filter((b) => (b.paid || b.auto ? calF.rec : calF.bills) && (!calF.cat || b.categoryId === calF.cat)));
  const max = Math.max(1, ...Object.values(E).map(sum));
  const lead = (first.getDay() + 6) % 7;
  const dayCell = (ds, d, extraCls = '') => {
    const list = E[ds] || [];
    const tot = sum(list);
    const inc = sum(I[ds] || []);
    const bills = B[ds] || [];
    return `<div class="day ${extraCls} ${ds === tStr ? 'today' : ''} ${ds === state.calSel ? 'sel' : ''}" data-date="${ds}">
      ${tot ? `<div class="heat" style="opacity:${0.04 + (tot / max) * 0.2}"></div>` : ''}
      <span class="n">${d}</span>
      ${tot ? `<span class="t">−${eurShort(tot)}</span>` : ''}
      ${inc ? `<span class="t inc">+${eurShort(inc)}</span>` : ''}
      ${bills.slice(0, 2).map((b) => `<span class="due ${b.paid || b.auto ? 'rec' : 'pend'} ${b.overdue ? 'late' : ''}" title="${esc(b.name)} · ${eur(b.amount)}">${ic(b.paid ? 'check' : b.auto ? 'repeat' : 'bell')}<span>${esc(b.name)}</span></span>`).join('')}
      <div class="dots">${list.slice(0, 6).map((e) => `<i style="background:${safeColor(catOf(e.categoryId).color)}"></i>`).join('')}</div>
    </div>`;
  };
  let cells = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((d) => `<div class="dow">${d}</div>`).join('');
  if (calF.view === 'mes') {
    cells += '<div class="day out"></div>'.repeat(lead);
    for (let d = 1; d <= last.getDate(); d++) cells += dayCell(`${y}-${pad(m + 1)}-${pad(d)}`, d);
  } else {
    for (let i = 0; i < 7; i++) { const dd = addDays(weekFrom, i); cells += dayCell(ymd(dd), dd.getDate(), 'tall'); }
  }
  const monthExp = sum(exps.filter((e) => e.date.startsWith(state.calMonth)));
  const monthInc = sum(data.incomes.filter((i) => i.date.startsWith(state.calMonth)));
  const pendingBills = data.bills.filter((b) => b.date.startsWith(state.calMonth) && !b.paid && !b.auto);
  const weekDays = [...Array(7)].map((_, i) => ymd(addDays(weekFrom, i)));
  const chip = (k, label, cls) => `<button class="fchip ${cls} ${calF[k] ? 'on' : ''}" data-f="${k}"><i></i>${label}</button>`;

  el.innerHTML = `
  <div class="toolbar cal-filters">
    <div class="seg sm" id="calView"><button data-v="mes" class="${calF.view === 'mes' ? 'on' : ''}">Mes</button><button data-v="semana" class="${calF.view === 'semana' ? 'on' : ''}">Semana</button></div>
    ${chip('exp', 'Gastos', 'red')}${chip('inc', 'Ingresos', 'green')}${chip('bills', 'Facturas pendientes', 'blue')}${chip('rec', 'Pagos recurrentes', 'orange')}
    <select id="calCat"><option value="">Todas las categorías</option>${cats.map((c) => `<option value="${c.id}" ${calF.cat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    ${accs.length ? `<select id="calAcc"><option value="">Todas las cuentas</option>${accs.map((a) => `<option value="${a.id}" ${calF.acc === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
  </div>
  <div class="grid g3">
    <div class="card span2">
      <div class="cal-head">
        <h2>${calF.view === 'mes' ? monthName(base) : `${fmtDate(weekDays[0], { day: 'numeric', month: 'short' })} – ${fmtDate(weekDays[6], { day: 'numeric', month: 'short', year: 'numeric' })}`}</h2>
        <button class="btn sm" id="todayM">Hoy</button>
        <div class="month-nav"><button class="icon-btn" id="prevM">${ic('chevron-left')}</button><button class="icon-btn" id="nextM">${ic('chevron-right')}</button></div>
      </div>
      <div class="cal ${calF.view === 'semana' ? 'week' : ''}" id="cal">${cells}</div>
      ${calF.view === 'semana' ? `<div class="week-table"><div class="xl-wrap"><table class="xl"><thead><tr><th>Día</th><th class="num">Ingresos</th><th class="num">Gastos</th><th class="num">Balance</th></tr></thead><tbody>
        ${weekDays.map((ds) => { const g = sum(E[ds] || []); const i = sum(I[ds] || []); return `<tr><td>${cap(fmtDate(ds, { weekday: 'short', day: 'numeric' }))}</td><td class="num pos">${i ? '+' + eur(i) : '—'}</td><td class="num">${g ? eur(g) : '—'}</td><td class="num">${signed(i - g)}</td></tr>`; }).join('')}
        <tr class="tot"><td>Semana</td><td class="num">${eur(sum(weekDays.flatMap((d) => I[d] || [])))}</td><td class="num">${eur(sum(weekDays.flatMap((d) => E[d] || [])))}</td><td class="num">${signed(sum(weekDays.flatMap((d) => I[d] || [])) - sum(weekDays.flatMap((d) => E[d] || [])))}</td></tr>
      </tbody></table></div></div>` : `
      <div class="cal-sum">
        <span>Gastos: <b>${eur(monthExp)}</b></span><span>Ingresos: <b class="pos">${eur(monthInc)}</b></span><span>Balance: <b>${signed(monthInc - monthExp)}</b></span>
        ${pendingBills.length ? `<span>Pendiente de pagar: <b>${eur(sum(pendingBills))}</b></span>` : ''}
      </div>`}
    </div>
    <div class="card" id="dayPanel"></div>
  </div>`;

  const showDay = (ds) => {
    state.calSel = ds;
    $$('.cal .day').forEach((c) => c.classList.toggle('sel', c.dataset.date === ds));
    const list = E[ds] || [];
    const incs = I[ds] || [];
    const bills = B[ds] || [];
    const g = sum(list), i = sum(incs);
    $('#dayPanel').innerHTML = `
      <div class="card-head" style="margin-bottom:6px"><h3>${ic('calendar-days', 'sm')}${cap(fmtDate(ds, { weekday: 'long', day: 'numeric', month: 'long' }))}</h3></div>
      <div class="day-sum"><div><small>Ingresos</small><b class="pos">${eur(i)}</b></div><div><small>Gastos</small><b>${eur(g)}</b></div><div><small>Balance</small><b>${signed(i - g)}</b></div></div>
      <div class="muted" style="font-size:13px;margin:10px 0 12px">${list.length + incs.length} movimiento${list.length + incs.length === 1 ? '' : 's'}${bills.length ? ` · ${bills.length} pago${bills.length === 1 ? '' : 's'} programado${bills.length === 1 ? '' : 's'}` : ''}</div>
      ${bills.length ? `<div class="bill-list">${bills.map((b) => `<div class="notice ${b.paid ? 'ok' : b.overdue ? 'danger' : b.auto ? 'orange' : 'blue'}">${ic(b.paid ? 'circle-check' : b.auto ? 'repeat' : 'bell', 'sm')}<span><b>${esc(b.name)}</b> · ${eur(b.amount)}<small>${b.paid ? 'Pagado' : b.overdue ? 'Atrasado' : b.auto ? 'Se registra solo' : 'Pendiente de pagar'} · ${esc(b.frequency)}</small></span>
        ${!b.paid && !b.auto && b.date <= ymd(addDays(todayD(), 45)) ? `<button class="btn sm" data-pay="${b.recurringId}" data-date="${b.date}">Pagar</button>` : ''}</div>`).join('')}</div>` : ''}
      <div class="list" id="dayList">
        ${incs.map((x) => `<div class="li click" data-inc="${x.id}"><span class="cat-ic sm" style="--c:#16a34a">${ic('hand-coins')}</span><div class="main"><b>${esc(x.name)}</b><small>Ingreso</small></div><div class="amt pos">+${eur(x.amount)}</div></div>`).join('')}
        ${list.map((e) => expenseRow(e, { date: false })).join('')}
        ${!list.length && !incs.length ? emptyHtml('calendar-check', 'Día sin movimientos', '') : ''}
      </div>
      <div class="day-btns"><button class="btn primary" id="addDay">${ic('plus', 'sm')}Gasto</button><button class="btn" id="addIncDay">${ic('hand-coins', 'sm')}Ingreso</button></div>`;
    hydrate($('#dayPanel'));
    $('#dayList').onclick = (ev) => {
      const ii = ev.target.closest('[data-inc]');
      if (ii) return incomeForm(incs.find((x) => x.id === ii.dataset.inc));
      const r = ev.target.closest('[data-id]');
      const e = r && list.find((x) => x.id === r.dataset.id);
      if (e) expenseForm(e);
    };
    $$('#dayPanel [data-pay]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/recurring/${b.dataset.pay}/pay`, { method: 'POST' }); toast('Pago registrado'); route(); } catch (e) { toast(e.message, true); }
    }));
    $('#addDay').onclick = () => expenseForm({}, { date: ds });
    $('#addIncDay').onclick = () => incomeForm({ date: ds });
  };
  $('#cal').onclick = (ev) => {
    const c = ev.target.closest('.day[data-date]');
    if (!c) return;
    showDay(c.dataset.date);
    if (matchMedia('(max-width: 900px)').matches) $('#dayPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const go = (n) => {
    if (calF.view === 'mes') { state.calMonth = monthKey(new Date(y, m + n, 1)); state.calSel = ymd(new Date(y, m + n, 1)); }
    else { state.calSel = ymd(addDays(weekFrom, 7 * n)); state.calMonth = monthKey(parse(state.calSel)); }
    route();
  };
  $('#prevM').onclick = () => go(-1);
  $('#nextM').onclick = () => go(1);
  $('#todayM').onclick = () => { state.calMonth = monthKey(todayD()); state.calSel = ymd(todayD()); route(); };
  $('#calView').onclick = (e) => { const b = e.target.closest('button'); if (b) { calF.view = b.dataset.v; route(); } };
  $$('.fchip').forEach((b) => b.addEventListener('click', () => { calF[b.dataset.f] = !calF[b.dataset.f]; route(); }));
  $('#calCat').onchange = (e) => { calF.cat = e.target.value; route(); };
  $('#calAcc')?.addEventListener('change', (e) => { calF.acc = e.target.value; route(); });
  showDay(calF.view === 'semana' || state.calSel.startsWith(state.calMonth) ? state.calSel : ymd(first));
}

// ---------- Gastos mensuales ----------
const FREQ_OPTS = [['weekly', 'Semanal'], ['biweekly', 'Quincenal (cada 14 días)'], ['monthly', 'Mensual'], ['quarterly', 'Trimestral'], ['semiannual', 'Semestral'], ['yearly', 'Anual'], ['daily', 'Diario'], ['custom', 'Personalizado']];
const STATE_BADGE = { overdue: ['danger', 'triangle-alert', 'Atrasado'], paid: ['ok', 'circle-check', 'Pagado'], pending: ['', 'clock', 'Pendiente'], paused: ['', 'pause', 'En pausa'] };
async function renderRecurring(el) {
  const recs = await api('/recurring');
  updateDueBadge(recs);
  const active = recs.filter((r) => r.active);
  const fixed = active.reduce((a, r) => a + r.monthly, 0);
  const t = todayD();
  const mk = monthKey(t);
  const cal = await api('/calendar?month=' + mk);
  const monthBills = cal.bills.filter((b) => active.some((r) => r.id === b.recurringId));
  const paid = sum(monthBills.filter((b) => b.paid));
  const pending = sum(monthBills.filter((b) => !b.paid));
  const overdue = recs.filter((r) => r.state === 'overdue');
  el.innerHTML = `
  <div class="grid g3">
    <div class="card stat"><div class="top"><span class="label">Gasto fijo al mes</span><span class="ichip">${ic('repeat')}</span></div>
      <div><div class="value">${eur(fixed)}</div><div class="sub">${active.length} pago${active.length === 1 ? '' : 's'} activo${active.length === 1 ? '' : 's'} (equivalente mensual)</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Pagado este mes</span><span class="ichip green">${ic('circle-check')}</span></div>
      <div><div class="value">${eur(paid)}</div><div class="progress" style="margin-top:10px"><div style="width:${paid + pending ? (paid / (paid + pending)) * 100 : 0}%"></div></div></div></div>
    <div class="card stat"><div class="top"><span class="label">Pendiente este mes</span><span class="ichip ${overdue.length ? 'red' : 'amber'}">${ic('hourglass')}</span></div>
      <div><div class="value">${eur(pending)}</div><div class="sub">${overdue.length ? `<span class="neg">${overdue.length} atrasado${overdue.length === 1 ? '' : 's'}</span>` : `${ic('mail', 'xs')}Avisos a ${esc(me.email)}`}</div></div></div>
  </div>
  <div class="toolbar" style="justify-content:space-between">
    <div class="muted" style="font-size:14px">Alquiler, recibos, seguros, suscripciones… con cualquier frecuencia. Te avisamos antes de cada cobro.</div>
    <button class="btn primary" id="addRec">${ic('plus', 'sm')}Nuevo pago fijo</button>
  </div>
  <div class="grid g3" id="recs">
    ${recs.map((r) => {
      const c = catOf(r.categoryId);
      const [bc, bi, bl] = STATE_BADGE[r.state] || STATE_BADGE.pending;
      const progress = r.daysLeft == null ? 0 : Math.max(4, Math.min(100, 100 - (r.daysLeft / 30) * 100));
      return `<div class="card rec-card ${r.active ? '' : 'inactive'} ${r.state === 'overdue' ? 'late' : ''}">
        <div class="top">${catIc(c)}<div class="main"><b>${esc(r.name)}</b><small>${esc(c.name)} · ${esc(r.frequencyLabel)}</small></div><div class="amount">${eur(r.amount)}</div></div>
        ${r.active ? `<div class="due-box">
          <div class="line"><span class="muted">${r.state === 'overdue' ? 'Vencía el' : 'Próximo cobro'}</span><b>${r.nextDue ? cap(fmtDate(r.nextDue, { weekday: 'short', day: 'numeric', month: 'short' })) : '—'}</b></div>
          <div class="progress thin"><div style="width:${progress}%"></div></div>
          <div class="line"><span class="badge ${r.state === 'overdue' ? 'danger' : r.daysLeft <= r.remindDaysBefore ? 'warn' : ''}">${ic('clock')}${r.state === 'overdue' ? 'Atrasado' : daysTxt(r.daysLeft)}</span>
            <span class="badge ${bc}">${ic(bi)}${bl}</span></div>
        </div>` : `<div class="due-box"><div class="line"><span class="badge">${ic('pause')}En pausa / cancelado</span></div></div>`}
        <div class="meta">
          <span class="badge">${ic('bell')}Aviso ${r.remindDaysBefore === 0 ? 'el mismo día' : `${r.remindDaysBefore} día${r.remindDaysBefore === 1 ? '' : 's'} antes`}</span>
          ${r.autoAdd ? `<span class="badge primary">${ic('zap')}Automático</span>` : ''}
          ${r.frequency !== 'monthly' ? `<span class="badge">≈ ${eur(r.monthly)}/mes</span>` : ''}
          ${r.accountId && accOf(r.accountId) ? `<span class="badge">${ic('landmark')}${esc(accOf(r.accountId).name)}</span>` : ''}
          ${r.demo ? '<span class="badge warn">Demo</span>' : ''}
        </div>
        <div class="btns">
          ${!r.active || (r.state === 'paid' && r.daysLeft > 7) || r.autoAdd ? `<button class="btn sm" data-edit="${r.id}">${ic('pencil', 'sm')}Editar</button>` : `<button class="btn sm primary" data-pay="${r.id}">${ic('check', 'sm')}Marcar pagado</button><button class="icon-btn sm" data-edit="${r.id}" title="Editar">${ic('pencil', 'sm')}</button>`}
          <button class="icon-btn sm danger" data-del="${r.id}" title="Eliminar">${ic('trash-2', 'sm')}</button>
        </div>
      </div>`;
    }).join('') || `<div class="card span2">${emptyHtml('repeat', 'Aún no tienes pagos fijos', 'Añade tu alquiler, la luz, internet, seguros o suscripciones y recibirás un aviso antes de cada cobro.', `<button class="btn primary sm" id="emptyRec">${ic('plus', 'sm')}Añadir el primero</button>`)}</div>`}
  </div>`;
  $('#addRec').onclick = () => recurringForm();
  $('#emptyRec')?.addEventListener('click', () => recurringForm());
  $('#recs').onclick = async (ev) => {
    const b = ev.target.closest('button[data-pay], button[data-edit], button[data-del]');
    if (!b) return;
    const r = recs.find((x) => x.id === (b.dataset.pay || b.dataset.edit || b.dataset.del));
    if (b.dataset.edit) recurringForm(r);
    if (b.dataset.del) confirmModal('Eliminar pago fijo', `¿Eliminar <b>${esc(r.name)}</b>? Dejarás de recibir sus avisos. Los gastos ya registrados se mantienen.`, async () => {
      await api('/recurring/' + r.id, { method: 'DELETE' });
      toast('Pago fijo eliminado');
      route();
    });
    if (b.dataset.pay) openModal({
      title: `Pagar ${r.name}`,
      icon: 'check',
      okText: 'Registrar pago',
      html: `<p class="set-desc">Se apuntará como gasto de hoy el cobro del <b>${fmtDate(r.nextDue, { day: 'numeric', month: 'long' })}</b>. No se duplicará.</p>
        <label class="field">Importe pagado<div class="input-money"><input name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" value="${r.amount}" required><span>€</span></div></label>`,
      onSubmit: async (d) => { await api(`/recurring/${r.id}/pay`, { method: 'POST', body: { amount: Number(d.amount) } }); toast('Pago registrado'); route(); },
    });
  };
}

// ---------- Resumen semanal ----------
async function renderWeekly(el) {
  const s = await api('/summary/week?date=' + state.week);
  const diff = pct(s.total, s.prevTotal);
  const isCurrent = s.from === ymd(weekStart(todayD()));
  const best = s.total ? s.byDay.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  el.innerHTML = `
  <div class="card" style="margin-bottom:18px">
    <div class="cal-head" style="margin:0;flex-wrap:wrap">
      <div class="month-nav"><button class="icon-btn" id="prevW">${ic('chevron-left')}</button><button class="icon-btn" id="nextW">${ic('chevron-right')}</button></div>
      <h2 style="font-size:17px">${fmtDate(s.from, { day: 'numeric', month: 'long' })} – ${fmtDate(s.to, { day: 'numeric', month: 'long', year: 'numeric' })} ${isCurrent ? '<span class="badge ok" style="vertical-align:middle;margin-left:6px">Esta semana</span>' : ''}</h2>
      <button class="btn sm" id="mailW">${ic('send', 'sm')}Enviármelo por correo</button>
    </div>
  </div>
  <div class="grid g4 stats">
    <div class="card stat"><div class="top"><span class="label">Total</span><span class="ichip">${ic('wallet')}</span></div>
      <div><div class="value">${eur(s.total)}</div><div class="sub">${trendHtml(diff, ' vs. anterior') || 'Sin semana anterior'}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Ingresos</span><span class="ichip green">${ic('hand-coins')}</span></div>
      <div><div class="value">${eur(s.incomeTotal)}</div><div class="sub">Balance: ${signed(s.balance)}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Media diaria</span><span class="ichip amber">${ic('activity')}</span></div>
      <div><div class="value">${eur(s.avgPerDay)}</div><div class="sub">${s.count} gastos${best ? ` · más el ${best.name.toLowerCase()}` : ''}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Mayor gasto</span><span class="ichip red">${ic('trophy')}</span></div>
      <div><div class="value">${s.top ? eur(s.top.amount) : '—'}</div><div class="sub">${s.top ? esc(s.top.name) : 'Sin gastos'}</div></div></div>
  </div>
  <div class="grid g3">
    <div class="card span2"><div class="card-head"><h3>${ic('receipt-text', 'sm')}Gasto por día</h3></div><div class="chart-box"><canvas id="cWDays"></canvas></div></div>
    <div class="card"><div class="card-head"><h3>${ic('chart-pie', 'sm')}Por categoría</h3></div>
      ${s.byCategory.length ? `<div class="donut-wrap"><canvas id="cWCat"></canvas><div class="donut-center"><div><b>${eurShort(s.total)}</b><small>semana</small></div></div></div>${legendHtml(s.byCategory, s.total)}`
        : emptyHtml('party-popper', 'Semana sin gastos', '')}</div>
  </div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h3>${ic('list', 'sm')}Desglose</h3></div><div class="list">
      ${s.byCategory.map((c) => `<div class="li">${catIc(c, 'sm')}<div class="main"><b>${esc(c.name)}</b><div class="progress thin" style="margin-top:6px"><div style="width:${(c.total / s.total) * 100}%;background:${safeColor(c.color)}"></div></div></div>
        <div style="text-align:right"><div class="amt">${eur(c.total)}</div><small class="muted">${c.count} gasto${c.count === 1 ? '' : 's'}</small></div></div>`).join('') || emptyHtml('party-popper', 'Nada que desglosar', '')}
      </div>
      ${s.byPlace.length ? `<div class="card-head" style="margin:22px 0 8px"><h3>${ic('map-pin', 'sm')}Dónde gastaste</h3></div><div class="list">${s.byPlace.map((p) => `<div class="li"><span class="ichip sm">${ic('store', 'sm')}</span><div class="main"><b>${esc(p.place)}</b></div><div class="amt">${eur(p.total)}</div></div>`).join('')}</div>` : ''}
    </div>
    <div class="card"><div class="card-head"><h3>${ic('clock', 'sm')}Gastos de la semana</h3></div><div class="list" id="wList">${s.expenses.map((e) => expenseRow(e)).join('') || emptyHtml('calendar-check', 'Nada por aquí', '')}</div></div>
  </div>`;
  bindExpenseClicks($('#wList'), s.expenses);
  const go = (n) => { state.week = ymd(addDays(parse(s.from), n * 7)); route(); };
  $('#prevW').onclick = () => go(-1);
  $('#nextW').onclick = () => go(1);
  $('#mailW').onclick = async () => {
    try {
      const r = await api('/summary/week/email', { method: 'POST', body: { date: s.from } });
      toast(r.simulated ? 'El correo no está configurado en el servidor' : `Resumen enviado a ${me.email}`, !!r.simulated);
    } catch (e) { toast(e.message, true); }
  };
  chart($('#cWDays'), {
    type: 'bar',
    data: { labels: s.byDay.map((d) => d.name.slice(0, 3)), datasets: [{ data: s.byDay.map((d) => d.total), backgroundColor: cssVar('--primary'), borderRadius: 8, maxBarThickness: 46 }] },
    options: barOpts,
  });
  if (s.byCategory.length) donut($('#cWCat'), s.byCategory);
}

// ---------- Ajustes ----------
async function renderSettings(el) {
  const [mail, fin] = await Promise.all([api('/mail/status'), financeSettingsHtml()]);
  const pref = themePref();
  el.innerHTML = `
  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>${ic('user', 'sm')}Perfil</h3></div>
      <p class="set-desc">Tu nombre y el correo vinculado.</p>
      <form id="profileForm">
        <label class="field">Nombre<input name="name" value="${esc(me.name)}" required maxlength="60"></label>
        <label class="field">Correo vinculado<div class="input-icon">${ic('mail')}<input value="${esc(me.email)}" disabled></div></label>
        <p class="set-desc" style="margin-top:-4px">La contraseña y la verificación en dos pasos están en <a href="#/seguridad">Seguridad</a>.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">${ic('check', 'sm')}Guardar cambios</button>
        <button type="button" class="btn danger" id="logout2">${ic('log-out', 'sm')}Cerrar sesión</button></div>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('bell', 'sm')}Notificaciones</h3></div>
      <p class="set-desc">Elige qué correos quieres recibir en ${esc(me.email)}.</p>
      <label class="switch-row"><span class="ichip sm amber">${ic('bell', 'sm')}</span><span class="txt"><b>Avisos de gastos mensuales</b><small>Un correo antes de cada cobro</small></span>
        <span class="switch"><input type="checkbox" id="nRem" ${me.notify?.reminders ? 'checked' : ''}><span></span></span></label>
      <label class="switch-row"><span class="ichip sm green">${ic('calendar-range', 'sm')}</span><span class="txt"><b>Resumen semanal</b><small>Cada lunes, lo que gastaste la semana anterior</small></span>
        <span class="switch"><input type="checkbox" id="nWeek" ${me.notify?.weekly ? 'checked' : ''}><span></span></span></label>
      <div class="notice ${mail.configured ? 'ok' : 'warn'}" style="margin:14px 0">${ic(mail.configured ? 'shield-check' : 'triangle-alert', 'sm')}<span>${mail.configured
        ? `El envío de correos está activo. Los avisos llegarán a <b>${esc(mail.to)}</b>.`
        : 'El envío de correos aún no está configurado en el servidor, así que por ahora los avisos no salen.'}</span></div>
      <button class="btn" id="testMail">${ic('send', 'sm')}Enviar correo de prueba</button>
    </div>
  </div>
  <div class="card" style="margin-bottom:18px">
    <div class="card-head"><h3>${ic('sun', 'sm')}Apariencia</h3></div>
    <p class="set-desc">Tema de la aplicación en este dispositivo.</p>
    <div class="seg" id="themeSeg">
      <button data-t="light" class="${pref === 'light' ? 'on' : ''}">${ic('sun', 'sm')}Claro</button>
      <button data-t="dark" class="${pref === 'dark' ? 'on' : ''}">${ic('moon', 'sm')}Oscuro</button>
      <button data-t="system" class="${pref === 'system' ? 'on' : ''}">${ic('monitor', 'sm')}Automático</button>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><h3>${ic('tag', 'sm')}Categorías</h3><span class="badge">${cats.length}</span></div>
    <p class="set-desc">Personaliza el nombre, el color y el icono de cada categoría.</p>
    <div class="cat-grid" id="catList">
      ${cats.map((c) => `<div class="cat-tile">${catIc(c, 'sm')}<b>${esc(c.name)}</b><div class="acts">
        <button class="icon-btn sm" data-edit="${c.id}" title="Editar">${ic('pencil', 'sm')}</button><button class="icon-btn sm danger" data-del="${c.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></div></div>`).join('')}
      <button class="cat-tile add" id="addCat">${ic('plus', 'sm')}Nueva categoría</button>
    </div>
  </div>`;
  $('#profileForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      me = await api('/me', { method: 'PUT', body: { name: f.get('name') } });
      setUser();
      toast('Perfil guardado');
    } catch (e) { toast(e.message, true); }
  };
  $('#logout2').onclick = logout;
  const saveNotify = async () => {
    try {
      me = await api('/me', { method: 'PUT', body: { notify: { reminders: $('#nRem').checked, weekly: $('#nWeek').checked } } });
      toast('Preferencias guardadas');
    } catch (e) { toast(e.message, true); }
  };
  $('#nRem').onchange = saveNotify;
  $('#nWeek').onchange = saveNotify;
  $('#testMail').onclick = async () => {
    try {
      const r = await api('/mail/test', { method: 'POST' });
      toast(r.simulated ? 'El correo no está configurado en el servidor' : `Correo de prueba enviado a ${me.email}`, !!r.simulated);
    } catch (e) { toast('No se pudo enviar: ' + e.message, true); }
  };
  $('#themeSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    applyTheme(b.dataset.t);
    route();
  };
  $('#addCat').onclick = () => categoryForm();
  el.insertAdjacentHTML('beforeend', fin.html);
  hydrate(el);
  bindFinanceSettings();
  $('#catList').onclick = (ev) => {
    const b = ev.target.closest('button[data-edit], button[data-del]');
    if (!b) return;
    const c = cats.find((x) => x.id === (b.dataset.edit || b.dataset.del));
    if (b.dataset.edit) categoryForm(c);
    if (b.dataset.del) confirmModal('Eliminar categoría', `¿Eliminar <b>${esc(c.name)}</b>? Sus gastos quedarán como «Sin categoría».`, async () => {
      await api('/categories/' + c.id, { method: 'DELETE' });
      cats = await api('/categories');
      toast('Categoría eliminada');
      route();
    });
  };
}

// ---------- Instalar / descargar ----------
const IS_ELECTRON = /Electron/i.test(navigator.userAgent);
const IS_STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;
let publicCfg = {};
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  renderAuthInstall();
  if (location.hash.startsWith('#/descargar')) route();
});
window.addEventListener('appinstalled', () => { installPrompt = null; toast('App instalada'); });
async function doInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  route();
  renderAuthInstall();
}
function renderAuthInstall() {
  const el = $('#authInstall');
  if (!el || IS_ELECTRON || IS_STANDALONE) return;
  el.innerHTML = [
    installPrompt ? `<button type="button" class="btn sm" id="authInstallBtn">${ic('smartphone', 'sm')}Instalar la app</button>` : '',
    publicCfg.downloadUrl ? `<a class="btn sm" href="${esc(publicCfg.downloadUrl)}">${ic('monitor', 'sm')}Descargar para Windows</a>` : '',
    IS_IOS ? `<small>En iPhone: Compartir → «Añadir a pantalla de inicio»</small>` : '',
  ].join('');
  $('#authInstallBtn')?.addEventListener('click', doInstall);
}

async function renderDownload(el) {
  el.innerHTML = `
  <div class="grid g3">
    <div class="card dl-card">
      <span class="ichip lg green">${ic('smartphone', 'xl')}</span><h3>Android</h3>
      <p>Se instala como una app normal desde el navegador, con su icono y a pantalla completa.</p>
      ${IS_STANDALONE ? `<span class="badge ok">${ic('circle-check')}Ya la usas como app</span>`
        : installPrompt ? `<button class="btn primary" id="dlInstall">${ic('download', 'sm')}Instalar ahora</button>`
        : '<ol class="steps"><li>Abre esta web en Chrome desde el móvil.</li><li>Toca el menú ⋮ de arriba a la derecha.</li><li>Elige «Instalar aplicación».</li></ol>'}
    </div>
    <div class="card dl-card">
      <span class="ichip lg">${ic('apple', 'xl')}</span><h3>iPhone y iPad</h3>
      <p>Funciona como una app más, con su icono en la pantalla de inicio.</p>
      <ol class="steps"><li>Abre esta web en Safari.</li><li>Toca el botón Compartir.</li><li>Elige «Añadir a pantalla de inicio».</li></ol>
    </div>
    <div class="card dl-card">
      <span class="ichip lg amber">${ic('laptop', 'xl')}</span><h3>Ordenador</h3>
      <p>App de escritorio para Windows, Mac y Linux, conectada a tu misma cuenta.</p>
      ${IS_ELECTRON ? `<span class="badge ok">${ic('circle-check')}Ya la estás usando</span>`
        : publicCfg.downloadUrl ? `<a class="btn primary" href="${esc(publicCfg.downloadUrl)}">${ic('download', 'sm')}Descargar para Windows</a>
          ${publicCfg.releasesUrl ? `<a href="${esc(publicCfg.releasesUrl)}" target="_blank" rel="noopener" class="hint">Versiones para Mac y Linux ${ic('arrow-up-right', 'xs')}</a>` : ''}
          <span class="hint">Si Windows avisa con «Windows protegió su PC», pulsa «Más información» y después «Ejecutar de todas formas».</span>`
        : '<span class="badge">Descarga aún no publicada</span>'}
      ${!IS_ELECTRON && installPrompt ? `<button class="btn sm" id="dlInstall2">${ic('monitor', 'sm')}O instalarla desde el navegador</button>` : ''}
    </div>
  </div>
  <div class="notice">${ic('info', 'sm')}<span>Todas las versiones usan <b>la misma cuenta y los mismos datos</b>: lo que apuntes en el móvil aparece al momento en el ordenador y en la web.</span></div>`;
  $('#dlInstall')?.addEventListener('click', doInstall);
  $('#dlInstall2')?.addEventListener('click', doInstall);
}

// ---------- Ingresos ----------
const SOURCES = {
  nomina: { name: 'Nómina', icon: 'briefcase', color: '#16a34a' },
  freelance: { name: 'Trabajo extra', icon: 'laptop', color: '#2563eb' },
  ventas: { name: 'Ventas', icon: 'store', color: '#f97316' },
  inversiones: { name: 'Inversiones', icon: 'trending-up', color: '#9333ea' },
  alquiler: { name: 'Alquiler', icon: 'house', color: '#0891b2' },
  regalos: { name: 'Regalos', icon: 'gift', color: '#db2777' },
  devoluciones: { name: 'Devoluciones', icon: 'receipt', color: '#ca8a04' },
  otros: { name: 'Otros', icon: 'banknote', color: '#64748b' },
};
const srcOf = (k) => ({ id: k, ...(SOURCES[k] || SOURCES.otros) });
const r2 = (n) => Math.round(n * 100) / 100;

function incomeForm(inc = {}) {
  const sel = inc.source || 'nomina';
  openModal({
    title: inc.id ? 'Editar ingreso' : 'Nuevo ingreso',
    icon: 'hand-coins',
    html: `
      <label class="field">Importe<div class="input-money"><input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required value="${inc.amount ?? ''}" placeholder="0,00"><span>€</span></div></label>
      <label class="field">Concepto<input name="name" required maxlength="100" value="${esc(inc.name || '')}" placeholder="Ej: Nómina de noviembre"></label>
      <div class="mini-label">Origen</div><input type="hidden" name="source" value="${sel}">
      <div class="cat-pick" id="srcPick">${Object.keys(SOURCES).map((k) => { const s = srcOf(k); return `<button type="button" data-id="${k}" class="${k === sel ? 'on' : ''}" style="--c:${s.color}">${ic(s.icon)}${s.name}</button>`; }).join('')}</div>
      <div class="row"><label class="field">Fecha<input name="date" type="date" required value="${inc.date || ymd(todayD())}"></label>${accountSelect(inc.accountId || '')}</div>
      <label class="field">Notas<textarea name="notes" maxlength="500" placeholder="Opcional">${esc(inc.notes || '')}</textarea></label>
      ${inc.id ? `<button type="button" class="btn danger sm" id="delInc">${ic('trash-2', 'sm')}Eliminar ingreso</button>` : ''}`,
    onSubmit: async (d) => {
      d.amount = Number(d.amount);
      if (inc.id) await api('/incomes/' + inc.id, { method: 'PUT', body: d });
      else await api('/incomes', { method: 'POST', body: d });
      toast(inc.id ? 'Ingreso actualizado' : 'Ingreso añadido');
      route();
      refreshNotifs();
    },
  });
  const box = $('#srcPick');
  box.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', box).forEach((x) => x.classList.toggle('on', x === b));
    $('#modalBody input[name=source]').value = b.dataset.id;
  };
  $('#delInc')?.addEventListener('click', () => deleteIncome(inc));
}
function deleteIncome(i) {
  confirmModal('Eliminar ingreso', `¿Eliminar <b>${esc(i.name)}</b> (${eur(i.amount)})? No se puede deshacer.`, async () => {
    await api('/incomes/' + i.id, { method: 'DELETE' });
    toast('Ingreso eliminado');
    route();
  });
}

function exportModal() {
  const t = todayD();
  openModal({
    title: 'Exportar movimientos',
    icon: 'file-spreadsheet',
    okText: 'Descargar',
    html: `
      <div class="mini-label">Formato</div>
      <div class="seg full" id="fmtSeg"><button type="button" data-f="xlsx" class="on">Excel (.xlsx)</button><button type="button" data-f="csv">CSV</button></div>
      <input type="hidden" name="fmt" value="xlsx">
      <p class="set-desc" style="margin-top:10px">El Excel trae 5 hojas con totales y filtros (resumen, ingresos, gastos, ahorro y huchas). El CSV lleva todos los movimientos con cuenta, método de pago y etiquetas.</p>
      <div class="mini-label">Periodo</div>
      <div class="seg full" id="expSeg"><button type="button" data-r="month" class="on">Este mes</button><button type="button" data-r="year">Este año</button><button type="button" data-r="all">Todo</button><button type="button" data-r="custom">Elegir</button></div>
      <input type="hidden" name="range" value="month">
      <div class="row hidden" id="expCustom"><label class="field">Desde<input type="date" name="from" value="${ymd(new Date(t.getFullYear(), 0, 1))}"></label><label class="field">Hasta<input type="date" name="to" value="${ymd(t)}"></label></div>`,
    onSubmit: async (d) => {
      let from = '', to = '';
      if (d.range === 'month') { from = ymd(new Date(t.getFullYear(), t.getMonth(), 1)); to = ymd(new Date(t.getFullYear(), t.getMonth() + 1, 0)); }
      if (d.range === 'year') { from = `${t.getFullYear()}-01-01`; to = `${t.getFullYear()}-12-31`; }
      if (d.range === 'custom') { from = d.from; to = d.to; if (!from || !to || from > to) throw new Error('Revisa las fechas'); }
      await download(`/export.${d.fmt}${from ? `?from=${from}&to=${to}` : ''}`, 'agenda-gastos.' + d.fmt);
      toast('Archivo descargado');
    },
  });
  $('#fmtSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#fmtSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#modalBody input[name=fmt]').value = b.dataset.f;
  };
  $('#expSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#expSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#modalBody input[name=range]').value = b.dataset.r;
    $('#expCustom').classList.toggle('hidden', b.dataset.r !== 'custom');
  };
}

const incState = { month: monthKey(todayD()), source: '', q: '', sort: 'date', dir: -1 };
async function renderIncomes(el) {
  const mDate = parse(incState.month + '-01');
  const start = new Date(mDate.getFullYear(), mDate.getMonth() - 5, 1);
  const end = new Date(mDate.getFullYear(), mDate.getMonth() + 1, 0);
  const [incs, exps] = await Promise.all([api(`/incomes?from=${ymd(start)}&to=${ymd(end)}`), api(`/expenses?from=${ymd(start)}&to=${ymd(end)}`)]);
  const mk = incState.month;
  const prevMk = monthKey(new Date(mDate.getFullYear(), mDate.getMonth() - 1, 1));
  const monthInc = incs.filter((i) => i.date.startsWith(mk));
  const totalInc = sum(monthInc);
  const totalExp = sum(exps.filter((e) => e.date.startsWith(mk)));
  const balance = r2(totalInc - totalExp);
  const rate = totalInc ? (balance / totalInc) * 100 : null;
  const months = [...Array(6)].map((_, i) => new Date(mDate.getFullYear(), mDate.getMonth() - 5 + i, 1));
  const bySrc = {};
  for (const i of monthInc) bySrc[i.source] = (bySrc[i.source] || 0) + i.amount;
  const srcItems = Object.entries(bySrc).map(([k, total]) => ({ ...srcOf(k), total })).sort((a, b) => b.total - a.total);

  el.innerHTML = `
  <div class="toolbar">
    <div class="month-nav"><button class="icon-btn" id="iPrev" title="Mes anterior">${ic('chevron-left')}</button><span class="lbl">${cap(monthName(mDate))}</span><button class="icon-btn" id="iNext" title="Mes siguiente">${ic('chevron-right')}</button></div>
    <select id="iSrc"><option value="">Todos los orígenes</option>${Object.keys(SOURCES).map((k) => `<option value="${k}">${SOURCES[k].name}</option>`).join('')}</select>
    <div class="input-icon grow">${ic('search')}<input type="search" id="iQ" placeholder="Buscar ingreso…" value="${esc(incState.q)}"></div>
    <button class="btn" id="iXls">${ic('file-spreadsheet', 'sm')}Exportar a Excel</button>
  </div>
  <div class="grid g4 stats">
    <div class="card stat"><div class="top"><span class="label">Ingresos</span><span class="ichip green">${ic('hand-coins')}</span></div>
      <div><div class="value">${eur(totalInc)}</div><div class="sub">${trendHtml(pct(totalInc, sum(incs.filter((i) => i.date.startsWith(prevMk)))), ' vs. mes anterior', true) || 'En ' + monthName(mDate, false)}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Gastos</span><span class="ichip red">${ic('receipt-text')}</span></div>
      <div><div class="value">${eur(totalExp)}</div><div class="sub">En el mismo mes</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Balance</span><span class="ichip ${balance >= 0 ? 'green' : 'red'}">${ic('scale')}</span></div>
      <div><div class="value" style="color:var(${balance >= 0 ? '--success' : '--danger'})">${balance >= 0 ? '+' : ''}${eur(balance)}</div><div class="sub">${balance >= 0 ? 'Te sobra dinero este mes' : 'Gastas más de lo que entra'}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Tasa de ahorro</span><span class="ichip">${ic('piggy-bank')}</span></div>
      <div><div class="value">${rate === null ? '—' : Math.round(rate) + '%'}</div><div class="sub">Del dinero que entra</div></div></div>
  </div>
  <div class="grid g3">
    <div class="card span2"><div class="card-head"><h3>${ic('chart-column', 'sm')}Ingresos y gastos</h3><span class="badge">Últimos 6 meses</span></div><div class="chart-box"><canvas id="cIvE"></canvas></div></div>
    <div class="card"><div class="card-head"><h3>${ic('chart-pie', 'sm')}Por origen</h3></div>
      ${srcItems.length ? `<div class="donut-wrap"><canvas id="cSrc"></canvas><div class="donut-center"><div><b>${eurShort(totalInc)}</b><small>ingresos</small></div></div></div>${legendHtml(srcItems, totalInc)}` : emptyHtml('hand-coins', 'Sin ingresos este mes', '')}</div>
  </div>
  <div class="card">
    <div class="card-head"><h3>${ic('file-spreadsheet', 'sm')}Tabla de ingresos</h3><button class="btn sm primary" data-act="new-income">${ic('plus', 'sm')}Nuevo ingreso</button></div>
    <div id="iTable"></div>
  </div>`;
  $('#iSrc').value = incState.source;

  const paintTable = () => {
    const q = incState.q.toLowerCase();
    const rows = monthInc.filter((i) => (!incState.source || i.source === incState.source) && (!q || `${i.name} ${i.notes}`.toLowerCase().includes(q)));
    const k = incState.sort;
    rows.sort((a, b) => {
      const va = k === 'source' ? srcOf(a.source).name : a[k];
      const vb = k === 'source' ? srcOf(b.source).name : b[k];
      return (va > vb ? 1 : va < vb ? -1 : 0) * incState.dir;
    });
    if (!rows.length) {
      $('#iTable').innerHTML = emptyHtml('hand-coins', monthInc.length ? 'No hay resultados' : 'Aún no hay ingresos este mes', monthInc.length ? 'Prueba con otros filtros.' : 'Apunta tu nómina, ventas o cualquier dinero que recibas.', `<button class="btn primary sm" data-act="new-income">${ic('plus', 'sm')}Nuevo ingreso</button>`);
      return;
    }
    const th = (key, label, cls = '') => `<th data-sort="${key}" class="${cls} ${incState.sort === key ? 'on' : ''}">${label}${ic(incState.sort === key ? (incState.dir > 0 ? 'arrow-up' : 'arrow-down') : 'arrow-up-down')}</th>`;
    $('#iTable').innerHTML = `<div class="xl-wrap"><table class="xl">
      <thead><tr>${th('date', 'Fecha')}${th('name', 'Concepto')}${th('source', 'Origen')}${th('amount', 'Importe', 'num')}<th>Notas</th><th></th></tr></thead>
      <tbody>${rows.map((i) => `<tr data-id="${i.id}">
        <td class="date">${fmtDate(i.date, { day: '2-digit', month: '2-digit', year: 'numeric' })}</td>
        <td><b>${esc(i.name)}</b></td><td>${catTag(srcOf(i.source))}</td>
        <td class="num income-amt">+${eur(i.amount)}</td><td class="muted">${esc(i.notes) || '—'}</td>
        <td class="acts"><button class="icon-btn sm" data-edit="${i.id}" title="Editar">${ic('pencil', 'sm')}</button><button class="icon-btn sm danger" data-del="${i.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">Total · ${rows.length} ingreso${rows.length === 1 ? '' : 's'}</td><td class="num">${eur(sum(rows))}</td><td colspan="2"></td></tr></tfoot>
    </table></div>`;
  };
  $('#iTable').onclick = (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      if (incState.sort === th.dataset.sort) incState.dir *= -1;
      else { incState.sort = th.dataset.sort; incState.dir = ['date', 'amount'].includes(th.dataset.sort) ? -1 : 1; }
      return paintTable();
    }
    const d = e.target.closest('[data-del]');
    if (d) return deleteIncome(monthInc.find((x) => x.id === d.dataset.del));
    const r = e.target.closest('tr[data-id]');
    if (r) incomeForm(monthInc.find((x) => x.id === r.dataset.id));
  };
  const shift = (n) => { incState.month = monthKey(new Date(mDate.getFullYear(), mDate.getMonth() + n, 1)); route(); };
  $('#iPrev').onclick = () => shift(-1);
  $('#iNext').onclick = () => shift(1);
  $('#iSrc').onchange = (e) => { incState.source = e.target.value; paintTable(); };
  $('#iQ').oninput = (e) => { incState.q = e.target.value; paintTable(); };
  $('#iXls').onclick = exportModal;
  paintTable();

  chart($('#cIvE'), {
    type: 'bar',
    data: {
      labels: months.map((d) => cap(d.toLocaleDateString('es-ES', { month: 'short' }).replace('.', ''))),
      datasets: [
        { label: 'Ingresos', data: months.map((d) => sum(incs.filter((i) => i.date.startsWith(monthKey(d))))), backgroundColor: cssVar('--success'), borderRadius: 6, maxBarThickness: 30 },
        { label: 'Gastos', data: months.map((d) => sum(exps.filter((e) => e.date.startsWith(monthKey(d))))), backgroundColor: cssVar('--danger'), borderRadius: 6, maxBarThickness: 30 },
      ],
    },
    options: { ...barOpts, plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3 } }, tooltip: { displayColors: true, callbacks: { label: (c) => ` ${c.dataset.label}: ${eur(c.parsed.y)}` } } } },
  });
  if (srcItems.length) donut($('#cSrc'), srcItems);
}

// ---------- Ahorros ----------
const SAVING_COLORS = ['#16a34a', '#0d9488', '#0891b2', '#2563eb', '#4f46e5', '#7c3aed', '#db2777', '#ef4444', '#f97316', '#ca8a04', '#64748b'];
const SAVING_ICONS = ['piggy-bank', 'plane', 'house', 'car', 'graduation-cap', 'heart', 'gift', 'shield-check', 'laptop', 'smartphone', 'baby', 'dog', 'bike', 'umbrella', 'landmark', 'coins', 'target', 'trophy', 'sparkles', 'gem'];
function savingForm(s = {}) {
  let color = s.color || '#16a34a';
  let icon = s.icon || 'piggy-bank';
  openModal({
    title: s.id ? 'Editar hucha' : 'Nueva hucha',
    icon: 'piggy-bank',
    html: `
      <div class="cat-preview" id="savPrev"></div>
      <input type="hidden" name="color"><input type="hidden" name="icon">
      <label class="field">Nombre<input name="name" required maxlength="60" value="${esc(s.name || '')}" placeholder="Ej: Vacaciones, Fondo de emergencia…"></label>
      <div class="row">
        <label class="field">Objetivo (opcional)<div class="input-money"><input name="goal" type="number" inputmode="decimal" step="0.01" min="0" value="${s.goal ?? ''}" placeholder="Sin objetivo"><span>€</span></div></label>
        ${s.id ? '' : `<label class="field">Ya tengo ahorrado<div class="input-money"><input name="initial" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0,00"><span>€</span></div></label>`}
      </div>
      <div class="mini-label">Color</div>
      <div class="color-picker" id="sColPick">${SAVING_COLORS.map((c) => `<button type="button" data-c="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('')}</div>
      <div class="mini-label">Icono</div>
      <div class="icon-picker" id="sIcPick">${SAVING_ICONS.map((n) => `<button type="button" data-n="${n}" title="${n}">${ic(n)}</button>`).join('')}</div>`,
    onSubmit: async (d) => {
      if (d.goal === '' || Number(d.goal) === 0) d.goal = null;
      if (s.id) await api('/savings/' + s.id, { method: 'PUT', body: d });
      else await api('/savings', { method: 'POST', body: d });
      toast('Hucha guardada');
      route();
    },
  });
  const root = $('#modalBody');
  const paint = () => {
    $('input[name=color]', root).value = color;
    $('input[name=icon]', root).value = icon;
    $('#savPrev').innerHTML = catIc({ color, icon }) + `<div><b>${esc($('input[name=name]', root).value || 'Nueva hucha')}</b><div class="muted" style="font-size:13px">Así se verá tu hucha</div></div>`;
    $$('#sColPick button').forEach((b) => b.classList.toggle('on', b.dataset.c === color));
    $$('#sIcPick button').forEach((b) => { b.classList.toggle('on', b.dataset.n === icon); b.style.setProperty('--c', color); });
  };
  $('#sColPick').onclick = (e) => { const b = e.target.closest('button'); if (b) { color = b.dataset.c; paint(); } };
  $('#sIcPick').onclick = (e) => { const b = e.target.closest('button'); if (b) { icon = b.dataset.n; paint(); } };
  $('input[name=name]', root).oninput = paint;
  paint();
}
function moveForm(s, type = 'in') {
  openModal({
    title: s.name,
    icon: s.icon,
    okText: 'Guardar movimiento',
    html: `
      <div class="seg full" id="mvSeg"><button type="button" data-t="in" class="${type === 'in' ? 'on' : ''}">${ic('arrow-down-left', 'sm')}Aportar</button><button type="button" data-t="out" class="${type === 'out' ? 'on' : ''}">${ic('arrow-up-right', 'sm')}Retirar</button></div>
      <input type="hidden" name="type" value="${type}"><input type="hidden" name="savingId" value="${s.id}">
      <p class="muted" style="margin:-4px 0 14px;font-size:13.5px">Saldo actual: <b style="color:var(--text)">${eur(s.balance)}</b></p>
      <label class="field">Importe<div class="input-money"><input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required placeholder="0,00"><span>€</span></div></label>
      <div class="row">
        <label class="field">Fecha<input name="date" type="date" required value="${ymd(todayD())}"></label>
        <label class="field">Nota<input name="note" maxlength="200" placeholder="Opcional"></label>
      </div>`,
    onSubmit: async (d) => {
      d.amount = Number(d.amount);
      await api('/saving-moves', { method: 'POST', body: d });
      toast(d.type === 'in' ? 'Aportación guardada' : 'Retirada guardada');
      route();
    },
  });
  $('#mvSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#mvSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#modalBody input[name=type]').value = b.dataset.t;
  };
}

async function renderSavings(el) {
  const [savs, moves] = await Promise.all([api('/savings'), api('/saving-moves')]);
  const total = r2(savs.reduce((a, s) => a + s.balance, 0));
  const month = r2(savs.reduce((a, s) => a + s.month, 0));
  const goals = savs.filter((s) => s.goal);
  const goalSum = goals.reduce((a, s) => a + s.goal, 0);
  const goalHave = goals.reduce((a, s) => a + Math.min(s.balance, s.goal), 0);
  const t = todayD();
  const months = [...Array(12)].map((_, i) => new Date(t.getFullYear(), t.getMonth() - 11 + i, 1));
  const cum = months.map((m) => { const endD = ymd(new Date(m.getFullYear(), m.getMonth() + 1, 0)); return r2(moves.filter((x) => x.date <= endD).reduce((a, x) => a + (x.type === 'in' ? x.amount : -x.amount), 0)); });
  const sv = (id) => savs.find((s) => s.id === id);

  el.innerHTML = `
  <div class="grid g3">
    <div class="hero green span2">
      <div>
        <div class="label">${ic('piggy-bank', 'sm')}Total ahorrado</div>
        <div class="amount">${eur(total)}</div>
        <div class="pill">${ic(month >= 0 ? 'trending-up' : 'trending-down', 'xs')}${month >= 0 ? '+' : '−'}${eur(Math.abs(month))} este mes</div>
      </div>
      <div class="foot">
        <div><b>${savs.length}</b>hucha${savs.length === 1 ? '' : 's'}</div>
        <div><b>${goals.length ? eur(goalSum) : '—'}</b>en objetivos</div>
        <div style="min-width:180px;flex:1;max-width:260px"><b>${goalSum ? Math.round((goalHave / goalSum) * 100) : 0}%</b>de tus objetivos conseguido
          <div class="progress thin" style="margin-top:7px"><div style="width:${goalSum ? (goalHave / goalSum) * 100 : 0}%"></div></div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('history', 'sm')}Últimos movimientos</h3></div>
      <div class="list" id="mvList">${moves.slice(0, 5).map((m) => { const s = sv(m.savingId); return `<div class="li">
        <span class="ev-ic ${m.type === 'in' ? 'good' : 'bad'}">${ic(m.type === 'in' ? 'arrow-down-left' : 'arrow-up-right', 'sm')}</span>
        <div class="main"><b>${esc(s?.name || '—')}</b><small>${fmtDate(m.date)}${m.note ? `<span class="dot-sep"></span>${esc(m.note)}` : ''}</small></div>
        <div class="amt ${m.type === 'in' ? 'move-in' : 'move-out'}">${m.type === 'in' ? '+' : '−'}${eur(m.amount)}</div>
        <button class="icon-btn sm danger" data-delmv="${m.id}" title="Borrar movimiento">${ic('x', 'sm')}</button></div>`; }).join('') || emptyHtml('history', 'Sin movimientos', 'Crea una hucha y haz tu primera aportación.')}</div>
    </div>
  </div>
  <div class="toolbar" style="justify-content:space-between">
    <div class="muted" style="font-size:14px">Separa tu dinero en huchas, cada una con su objetivo.</div>
    <button class="btn primary" data-act="new-saving">${ic('plus', 'sm')}Nueva hucha</button>
  </div>
  <div class="grid g3" id="savs">
    ${savs.map((s) => {
      const p = s.goal ? Math.min(100, (s.balance / s.goal) * 100) : 0;
      return `<div class="card saving-card">
        <div class="top">${catIc(s)}<div style="flex:1;min-width:0"><b>${esc(s.name)}</b><small>${s.moves} movimiento${s.moves === 1 ? '' : 's'}</small></div>
          <button class="icon-btn sm" data-edit="${s.id}" title="Editar">${ic('pencil', 'sm')}</button><button class="icon-btn sm danger" data-del="${s.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></div>
        <div>
          <div class="bal">${eur(s.balance)}</div>
          ${s.goal ? `<div class="progress" style="margin-top:10px"><div style="width:${p}%;background:${safeColor(s.color)}"></div></div>
            <div class="goal-line"><span>Objetivo: ${eur(s.goal)}</span><b>${Math.round(p)}%</b></div>` : '<div class="goal-line"><span>Sin objetivo</span></div>'}
        </div>
        <div class="meta" style="display:flex;gap:6px;flex-wrap:wrap">
          ${s.goal && s.balance >= s.goal ? `<span class="badge ok">${ic('trophy')}¡Objetivo conseguido!</span>` : s.goal ? `<span class="badge">${ic('target')}Faltan ${eur(s.goal - s.balance)}</span>` : ''}
          ${s.month ? `<span class="badge ${s.month > 0 ? 'ok' : 'warn'}">${s.month > 0 ? '+' : '−'}${eur(Math.abs(s.month))} este mes</span>` : ''}
        </div>
        <div class="btns"><button class="btn sm primary" data-in="${s.id}">${ic('arrow-down-left', 'sm')}Aportar</button><button class="btn sm" data-out="${s.id}" ${s.balance > 0 ? '' : 'disabled'}>${ic('arrow-up-right', 'sm')}Retirar</button></div>
      </div>`;
    }).join('') || `<div class="card span2">${emptyHtml('piggy-bank', 'Aún no tienes huchas', 'Crea una para tus vacaciones, un fondo de emergencia o lo que quieras conseguir.', `<button class="btn primary sm" data-act="new-saving">${ic('plus', 'sm')}Crear mi primera hucha</button>`)}</div>`}
  </div>
  ${moves.length ? `<div class="card"><div class="card-head"><h3>${ic('trending-up', 'sm')}Evolución del ahorro</h3><span class="badge">12 meses</span></div><div class="chart-box sm"><canvas id="cSav"></canvas></div></div>` : ''}`;

  $('#savs').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const s = sv(b.dataset.edit || b.dataset.del || b.dataset.in || b.dataset.out);
    if (!s) return;
    if (b.dataset.edit) savingForm(s);
    if (b.dataset.in) moveForm(s, 'in');
    if (b.dataset.out) moveForm(s, 'out');
    if (b.dataset.del) confirmModal('Eliminar hucha', `¿Eliminar <b>${esc(s.name)}</b> y sus ${s.moves} movimientos? No se puede deshacer.`, async () => {
      await api('/savings/' + s.id, { method: 'DELETE' });
      toast('Hucha eliminada');
      route();
    });
  };
  $('#mvList').onclick = async (e) => {
    const b = e.target.closest('[data-delmv]');
    if (!b) return;
    confirmModal('Borrar movimiento', '¿Borrar este movimiento? El saldo de la hucha se recalculará.', async () => {
      await api('/saving-moves/' + b.dataset.delmv, { method: 'DELETE' });
      toast('Movimiento borrado');
      route();
    });
  };
  if (moves.length) {
    const ctx = $('#cSav').getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 210);
    grad.addColorStop(0, cssVar('--success') + '55');
    grad.addColorStop(1, cssVar('--success') + '00');
    chart($('#cSav'), {
      type: 'line',
      data: { labels: months.map((d) => cap(d.toLocaleDateString('es-ES', { month: 'short' }).replace('.', ''))), datasets: [{ data: cum, borderColor: cssVar('--success'), backgroundColor: grad, fill: true, tension: 0.35, pointRadius: 3, borderWidth: 2.5 }] },
      options: barOpts,
    });
  }
}

// ---------- Seguridad ----------
function showRecoveryCodes(codes) {
  const txt = `Agenda de Gastos - Códigos de recuperación\nCuenta: ${me.email}\nGenerados: ${new Date().toLocaleString('es-ES')}\n\n${codes.join('\n')}\n\nCada código sirve una sola vez.`;
  openModal({
    title: 'Guarda tus códigos de recuperación',
    icon: 'key-round',
    okText: 'Ya los he guardado',
    html: `
      <div class="notice warn" style="margin-bottom:14px">${ic('triangle-alert', 'sm')}<span>Si pierdes el móvil, estos códigos son la <b>única forma</b> de entrar. Cada uno sirve una vez. Guárdalos en un lugar seguro: no los volverás a ver.</span></div>
      <div class="codes-grid">${codes.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn sm" id="rcCopy">${ic('copy', 'sm')}Copiar</button><button type="button" class="btn sm" id="rcDl">${ic('download', 'sm')}Descargar .txt</button></div>`,
    onSubmit: async () => route(),
  });
  $('#modalCancel').classList.add('hidden');
  $('#rcCopy').onclick = () => copyText(codes.join('\n'));
  $('#rcDl').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
    a.download = 'codigos-recuperacion-agenda-gastos.txt';
    a.click();
  };
}
async function enable2fa() {
  let r;
  try { r = await api('/2fa/setup', { method: 'POST' }); } catch (e) { return toast(e.message, true); }
  openModal({
    title: 'Activar verificación en dos pasos',
    icon: 'shield-check',
    okText: 'Activar',
    html: `
      <ol class="steps">
        <li>Instala una app autenticadora en tu móvil: <b>Google Authenticator</b>, <b>Microsoft Authenticator</b> o <b>Authy</b>.</li>
        <li>En la app, pulsa «+» y escanea este código QR.</li>
        <li>Escribe aquí el código de 6 cifras que te muestra la app.</li>
      </ol>
      <div class="qr-box" style="margin-top:16px"><img src="${r.qr}" alt="Código QR para la app autenticadora">
        <div><small class="muted">¿No puedes escanearlo? Escribe esta clave en la app:</small><div class="secret">${esc(r.secret)}</div>
        <button type="button" class="btn sm" id="cpSecret">${ic('copy', 'sm')}Copiar clave</button></div></div>
      <label class="field">Código de la app<input name="code" class="code-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required placeholder="000000"></label>`,
    onSubmit: async (d) => {
      const res = await api('/2fa/enable', { method: 'POST', body: { code: d.code } });
      me = res.user;
      setUser();
      toast('Verificación en dos pasos activada');
      setTimeout(() => showRecoveryCodes(res.recoveryCodes), 80);
    },
  });
  $('#cpSecret').onclick = () => copyText(r.secret.replace(/\s/g, ''));
}
function disable2fa() {
  openModal({
    title: 'Desactivar verificación en dos pasos',
    icon: 'shield-alert',
    danger: true,
    okText: 'Desactivar',
    html: `
      <div class="notice warn" style="margin-bottom:16px">${ic('triangle-alert', 'sm')}<span>Tu cuenta quedará protegida solo con la contraseña. No lo recomendamos.</span></div>
      <label class="field">Contraseña actual<div class="input-icon pw-wrap">${ic('lock')}<input name="password" type="password" required autocomplete="current-password"><button type="button" class="pw-eye" tabindex="-1">${ic('eye')}</button></div></label>
      <label class="field">Código de tu app<input name="code" class="code-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required placeholder="000000"></label>`,
    onSubmit: async (d) => {
      me = await api('/2fa/disable', { method: 'POST', body: d });
      setUser();
      toast('Verificación en dos pasos desactivada');
      route();
    },
  });
}
function regenCodes() {
  openModal({
    title: 'Nuevos códigos de recuperación',
    icon: 'key-round',
    okText: 'Generar',
    html: `<p class="set-desc">Los códigos anteriores dejarán de funcionar. Confirma con el código de tu app.</p>
      <label class="field">Código de tu app<input name="code" class="code-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required placeholder="000000"></label>`,
    onSubmit: async (d) => {
      const res = await api('/2fa/recovery', { method: 'POST', body: d });
      me = res.user;
      setTimeout(() => showRecoveryCodes(res.recoveryCodes), 80);
    },
  });
}
const EV_ICON = {
  login: ['log-in', ''], logout: ['log-out', ''], register: ['badge-check', 'good'], login_failed: ['shield-alert', 'bad'], login_2fa_failed: ['shield-alert', 'bad'],
  locked: ['lock-keyhole', 'bad'], login_recovery: ['key-round', ''], password_changed: ['key-round', 'good'], twofa_enabled: ['shield-check', 'good'],
  twofa_disabled: ['shield-alert', 'bad'], recovery_regenerated: ['key-round', ''], session_revoked: ['circle-x', ''],
};
const devIcon = (d) => (/Android|iPhone/.test(d) ? 'smartphone' : /escritorio/.test(d) ? 'monitor' : 'laptop');

async function renderSecurity(el) {
  const [user, sessions, log] = await Promise.all([api('/me'), api('/sessions'), api('/security-log')]);
  me = user;
  setUser();
  const pwDays = Math.floor((Date.now() - new Date(me.passwordChangedAt).getTime()) / 86400000);
  const checks = [
    [me.twoFactor, 'Verificación en dos pasos activada', 50],
    [me.twoFactor && me.recoveryLeft >= 3, 'Códigos de recuperación disponibles', 10],
    [sessions.length <= 3, 'Pocas sesiones abiertas', 10],
    [pwDays < 365, 'Contraseña renovada en el último año', 10],
    [!log.slice(0, 15).some((e) => e.type === 'locked' || e.type === 'login_2fa_failed'), 'Sin intentos sospechosos recientes', 10],
    [true, 'Conexión cifrada y sesión protegida', 10],
  ];
  const score = checks.reduce((a, [ok, , w]) => a + (ok ? w : 0), 0);
  const lvl = score >= 90 ? ['Excelente', '--success'] : score >= 60 ? ['Buena', '--primary'] : ['Mejorable', '--warn'];

  el.innerHTML = `
  <div class="card" style="margin-bottom:18px">
    <div class="level">
      <div class="ring" style="--p:${score};--lc:var(${lvl[1]})"><div>${score}</div></div>
      <div><h2>Seguridad ${lvl[0].toLowerCase()}</h2><div class="muted">${me.twoFactor ? 'Tu cuenta está muy bien protegida.' : 'Activa la verificación en dos pasos para proteger tu cuenta aunque alguien sepa tu contraseña.'}</div></div>
    </div>
    <div class="checklist">${checks.map(([ok, txt]) => `<div><span class="${ok ? 'ok' : 'no'}">${ic(ok ? 'circle-check' : 'circle-alert', 'sm')}</span>${txt}</div>`).join('')}</div>
  </div>

  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>${ic('fingerprint', 'sm')}Verificación en dos pasos</h3>${me.twoFactor ? `<span class="badge ok">${ic('circle-check')}Activada</span>` : '<span class="badge warn">Desactivada</span>'}</div>
      ${me.twoFactor ? `
        <p class="set-desc">Al entrar te pedimos la contraseña <b>y</b> un código de tu app autenticadora, que cambia cada 30 segundos.</p>
        <div class="notice ok" style="margin-bottom:16px">${ic('key-round', 'sm')}<span>Te quedan <b>${me.recoveryLeft}</b> código${me.recoveryLeft === 1 ? '' : 's'} de recuperación por si pierdes el móvil.${me.recoveryLeft < 3 ? ' Genera nuevos pronto.' : ''}</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="tfaCodes">${ic('key-round', 'sm')}Nuevos códigos de recuperación</button><button class="btn danger" id="tfaOff">${ic('shield-alert', 'sm')}Desactivar</button></div>`
      : `
        <p class="set-desc">Añade una segunda llave a tu cuenta: además de la contraseña, hará falta un código que solo genera tu móvil. Aunque alguien robe tu contraseña, no podrá entrar.</p>
        <ol class="steps" style="margin-bottom:18px"><li>Instala Google Authenticator, Microsoft Authenticator o Authy.</li><li>Escanea el código QR que te mostraremos.</li><li>Guarda los códigos de recuperación.</li></ol>
        <button class="btn primary" id="tfaOn">${ic('shield-check', 'sm')}Activar verificación en dos pasos</button>`}
    </div>

    <div class="card">
      <div class="card-head"><h3>${ic('key-round', 'sm')}Contraseña</h3><span class="badge">Cambiada ${ago(me.passwordChangedAt)}</span></div>
      <form id="pwForm">
        <label class="field">Contraseña actual<div class="input-icon pw-wrap">${ic('lock')}<input name="currentPassword" type="password" required autocomplete="current-password"><button type="button" class="pw-eye" tabindex="-1">${ic('eye')}</button></div></label>
        <label class="field">Nueva contraseña<div class="input-icon pw-wrap">${ic('lock')}<input name="newPassword" type="password" required autocomplete="new-password" placeholder="8+ caracteres, letras y números"><button type="button" class="pw-eye" tabindex="-1">${ic('eye')}</button></div></label>
        <div class="pw-meter" id="pwMeter"></div>
        <label class="field">Repite la nueva contraseña<div class="input-icon">${ic('lock')}<input name="confirm" type="password" required autocomplete="new-password"></div></label>
        ${me.twoFactor ? '<label class="field">Código de tu app<input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required placeholder="000000"></label>' : ''}
        <div class="error" id="pwError"></div>
        <button class="btn primary">${ic('check', 'sm')}Cambiar contraseña</button>
      </form>
    </div>
  </div>

  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>${ic('monitor', 'sm')}Sesiones abiertas</h3>${sessions.length > 1 ? `<button class="btn sm danger" id="revokeAll">${ic('log-out', 'sm')}Cerrar las demás</button>` : ''}</div>
      <p class="set-desc">Dispositivos donde tu cuenta está abierta ahora mismo.</p>
      <div class="list" id="sessList">${sessions.map((s) => `<div class="li">
        <span class="ev-ic ${s.current ? 'good' : ''}">${ic(devIcon(s.device), 'sm')}</span>
        <div class="main"><b>${esc(s.device)}</b><small>${s.current ? '<span class="badge ok" style="padding:1px 8px">Este dispositivo</span>' : `Activa ${ago(s.lastSeen)}`}<span class="dot-sep"></span>IP ${esc(s.ip || '—')}</small></div>
        ${s.current ? '' : `<button class="btn sm" data-revoke="${s.id}">Cerrar</button>`}</div>`).join('')}</div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('history', 'sm')}Actividad reciente</h3></div>
      <p class="set-desc">Te avisamos por correo de los accesos desde dispositivos nuevos.</p>
      <div class="list">${log.slice(0, 12).map((e) => { const [i, cls] = EV_ICON[e.type] || ['activity', '']; return `<div class="li">
        <span class="ev-ic ${cls}">${ic(i, 'sm')}</span>
        <div class="main"><b>${esc(e.text)}</b><small>${esc(e.device)}<span class="dot-sep"></span>${ago(e.at)}</small></div></div>`; }).join('') || emptyHtml('history', 'Sin actividad', '')}</div>
    </div>
  </div>`;

  $('#tfaOn')?.addEventListener('click', enable2fa);
  $('#tfaOff')?.addEventListener('click', disable2fa);
  $('#tfaCodes')?.addEventListener('click', regenCodes);
  const pwf = $('#pwForm');
  pwf.newPassword.oninput = () => paintMeter($('#pwMeter'), pwf.newPassword.value);
  pwf.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(pwf));
    $('#pwError').textContent = '';
    if (d.newPassword !== d.confirm) { $('#pwError').textContent = 'Las contraseñas nuevas no coinciden'; return; }
    try {
      me = await api('/me/password', { method: 'POST', body: d });
      toast('Contraseña cambiada. Se han cerrado tus otras sesiones.');
      route();
    } catch (e) { $('#pwError').textContent = e.message; }
  };
  $('#revokeAll')?.addEventListener('click', async () => {
    try { await api('/sessions/revoke-others', { method: 'POST' }); toast('Se han cerrado las demás sesiones'); route(); } catch (e) { toast(e.message, true); }
  });
  $('#sessList').onclick = async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    try { await api('/sessions/' + b.dataset.revoke, { method: 'DELETE' }); toast('Sesión cerrada'); route(); } catch (err) { toast(err.message, true); }
  };
}

// ---------- Administración ----------
const adminState = { tab: 'resumen', q: '', filter: '' };
const initialOf = (n) => esc((n || '?').trim()[0]?.toUpperCase() || '?');
function userStatus(u) {
  if (u.blocked) return `<span class="badge red">${ic('ban')}Desactivada</span>`;
  if (u.locked) return `<span class="badge warn">${ic('lock-keyhole')}Bloqueada 15 min</span>`;
  if (u.mustChangePassword) return `<span class="badge warn">${ic('key-round')}Contraseña temporal</span>`;
  return `<span class="badge ok">${ic('circle-check')}Activa</span>`;
}

async function renderAdmin(el) {
  let stats;
  try {
    stats = await api('/admin/stats');
  } catch (e) {
    if (e.code === 'admin_2fa') {
      el.innerHTML = `<div class="card">${emptyHtml('shield-alert', 'Activa la verificación en dos pasos', 'Por seguridad, la administración solo está disponible para administradores con el 2FA activado. Así nadie puede tomar el control de la app solo con tu contraseña.', `<a class="btn primary sm" href="#/seguridad">${ic('shield-check', 'sm')}Ir a Seguridad</a>`)}</div>`;
      return;
    }
    throw e;
  }
  const tabs = [['resumen', 'layout-dashboard', 'Resumen'], ['usuarios', 'users', 'Usuarios'], ['actividad', 'clipboard-list', 'Registro de acciones'], ['ajustes', 'settings', 'Ajustes de la app']];
  el.innerHTML = `<div class="tabs-bar"><div class="seg" id="admTabs">${tabs.map(([k, i, t]) => `<button data-t="${k}" class="${adminState.tab === k ? 'on' : ''}">${ic(i, 'sm')}${t}</button>`).join('')}</div></div><div id="admBody"></div>`;
  $('#admTabs').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    adminState.tab = b.dataset.t;
    route();
  };
  const body = $('#admBody');
  if (adminState.tab === 'resumen') return adminSummary(body, stats);
  if (adminState.tab === 'usuarios') return adminUsers(body);
  if (adminState.tab === 'actividad') return adminLog(body);
  return adminSettings(body, stats.settings);
}

function adminSummary(el, s) {
  const pct2fa = s.users ? Math.round((s.twoFactor / s.users) * 100) : 0;
  const sys = [
    [s.mailConfigured, 'Envío de correos', s.mailConfigured ? 'Funcionando' : 'Sin configurar'],
    [s.encrypted, 'Cifrado de secretos 2FA', s.encrypted ? 'Activo (AES-256)' : 'Falta APP_SECRET'],
    [s.settings.registrationOpen !== false, 'Registro de nuevos usuarios', s.settings.registrationOpen !== false ? 'Abierto' : 'Cerrado'],
    [true, 'Conexión y sesiones', 'HTTPS, cookies protegidas y CSRF'],
  ];
  el.innerHTML = `
  <div class="grid g4 stats">
    <div class="card stat"><div class="top"><span class="label">Usuarios</span><span class="ichip">${ic('users')}</span></div>
      <div><div class="value">${s.users}</div><div class="sub">${ic('user-plus', 'xs')}${s.newWeek} esta semana · ${s.newMonth} este mes</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Activos (7 días)</span><span class="ichip green">${ic('activity')}</span></div>
      <div><div class="value">${s.active7}</div><div class="sub">${s.users ? Math.round((s.active7 / s.users) * 100) : 0}% del total</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Con 2FA</span><span class="ichip amber">${ic('shield-check')}</span></div>
      <div><div class="value">${pct2fa}%</div><div class="sub">${s.twoFactor} de ${s.users} cuentas</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Administradores</span><span class="ichip red">${ic('crown')}</span></div>
      <div><div class="value">${s.admins}</div><div class="sub">${s.blocked} cuenta${s.blocked === 1 ? '' : 's'} desactivada${s.blocked === 1 ? '' : 's'}</div></div></div>
  </div>
  <div class="grid g3">
    <div class="card span2"><div class="card-head"><h3>${ic('user-plus', 'sm')}Nuevos registros</h3><span class="badge">Últimos 30 días</span></div><div class="chart-box sm"><canvas id="cRegs"></canvas></div></div>
    <div class="card"><div class="card-head"><h3>${ic('server', 'sm')}Estado del sistema</h3></div>
      ${sys.map(([ok, t, d]) => `<div class="sys-row"><span class="${ok ? 'move-in' : 'move-out'}">${ic(ok ? 'circle-check' : 'circle-alert', 'sm')}</span><span class="t">${t}</span><small class="muted">${d}</small></div>`).join('')}
    </div>
  </div>
  <div class="card"><div class="card-head"><h3>${ic('database', 'sm')}Datos guardados</h3><span class="badge">${ic('lock')}Solo totales: no ves los datos de nadie</span></div>
    <div class="mini-stats" style="margin:0">
      <div><b>${s.totals.expenses}</b><small>gastos</small></div><div><b>${s.totals.incomes}</b><small>ingresos</small></div>
      <div><b>${s.totals.recurring}</b><small>mensuales</small></div><div><b>${s.totals.savings}</b><small>huchas</small></div>
    </div></div>`;
  chart($('#cRegs'), {
    type: 'bar',
    data: { labels: s.registrations.map((r) => fmtDate(r.date)), datasets: [{ data: s.registrations.map((r) => r.count), backgroundColor: cssVar('--primary'), borderRadius: 5, maxBarThickness: 18 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.parsed.y} registro${c.parsed.y === 1 ? '' : 's'}` } } }, scales: { y: { beginAtZero: true, ticks: { precision: 0, maxTicksLimit: 5 }, border: { display: false } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } } } },
  });
}

async function adminUsers(el) {
  const users = await api('/admin/users');
  el.innerHTML = `
  <div class="toolbar">
    <div class="input-icon grow">${ic('search')}<input type="search" id="auQ" placeholder="Buscar por nombre o correo…" value="${esc(adminState.q)}"></div>
    <select id="auF">
      <option value="">Todos (${users.length})</option><option value="admin">Administradores</option><option value="2fa">Con 2FA</option>
      <option value="no2fa">Sin 2FA</option><option value="blocked">Desactivadas</option><option value="locked">Bloqueadas</option>
    </select>
  </div>
  <div class="card"><div id="auTable"></div></div>`;
  $('#auF').value = adminState.filter;
  const paint = () => {
    const q = adminState.q.toLowerCase();
    const f = adminState.filter;
    const rows = users.filter((u) => (!q || `${u.name} ${u.email}`.toLowerCase().includes(q)) &&
      (!f || (f === 'admin' && u.isAdmin) || (f === '2fa' && u.twoFactor) || (f === 'no2fa' && !u.twoFactor) || (f === 'blocked' && u.blocked) || (f === 'locked' && u.locked)));
    $('#auTable').innerHTML = rows.length ? `<div class="xl-wrap"><table class="xl">
      <thead><tr><th>Usuario</th><th>Alta</th><th>Última actividad</th><th>2FA</th><th>Estado</th><th>Rol</th><th class="num">Gastos</th><th></th></tr></thead>
      <tbody>${rows.map((u) => `<tr data-id="${u.id}">
        <td><div class="user-cell"><span class="avatar">${initialOf(u.name)}</span><div><b>${esc(u.name)}${u.id === me.id ? ' <span class="badge primary" style="padding:1px 7px">Tú</span>' : ''}</b><small>${esc(u.email)}</small></div></div></td>
        <td class="date">${fmtDate(u.createdAt.slice(0, 10), { day: '2-digit', month: '2-digit', year: 'numeric' })}</td>
        <td class="date">${ago(u.lastActiveAt)}</td>
        <td>${u.twoFactor ? `<span class="badge ok">${ic('shield-check')}Sí</span>` : '<span class="badge">No</span>'}</td>
        <td>${userStatus(u)}</td>
        <td>${u.isAdmin ? `<span class="badge primary">${ic('crown')}Admin</span>` : '<span class="muted">Usuario</span>'}</td>
        <td class="num">${u.counts.expenses}</td>
        <td class="acts"><button class="btn sm" data-manage="${u.id}">${ic('user-cog', 'sm')}Gestionar</button></td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="8">${rows.length} usuario${rows.length === 1 ? '' : 's'}</td></tr></tfoot></table></div>`
      : emptyHtml('users', 'Ningún usuario coincide', 'Prueba con otra búsqueda o filtro.');
  };
  $('#auTable').onclick = (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row) manageUser(users.find((u) => u.id === row.dataset.id));
  };
  $('#auQ').oninput = (e) => { adminState.q = e.target.value; paint(); };
  $('#auF').onchange = (e) => { adminState.filter = e.target.value; paint(); };
  paint();
}

// Ejecuta una acción de administración con confirmación previa
function adminAction({ title, text, icon = 'user-cog', danger = false, okText = 'Confirmar', extra = '', run }) {
  openModal({
    title, icon, danger, okText,
    html: `<p style="margin:0 0 14px;color:var(--text-2)">${text}</p>${extra}`,
    onSubmit: async (d) => {
      const r = await run(d);
      if (r !== false) route();
    },
  });
}

function manageUser(u) {
  const self = u.id === me.id;
  const act = (k, icon, t, sub, cls = '') => `<button type="button" data-a="${k}" class="${cls}">${ic(icon)}<span>${t}<small>${sub}</small></span></button>`;
  openModal({
    title: 'Gestionar usuario',
    icon: 'user-cog',
    actions: false,
    html: `
      <div class="user-head"><span class="avatar">${initialOf(u.name)}</span><div><b>${esc(u.name)}</b><span class="muted">${esc(u.email)}</span><div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">${userStatus(u)}${u.isAdmin ? `<span class="badge primary">${ic('crown')}Admin</span>` : ''}${u.twoFactor ? `<span class="badge ok">${ic('shield-check')}2FA</span>` : ''}</div></div></div>
      <div class="mini-stats">
        <div><b>${u.counts.expenses}</b><small>gastos</small></div><div><b>${u.counts.incomes}</b><small>ingresos</small></div>
        <div><b>${u.counts.savings}</b><small>huchas</small></div><div><b>${u.sessions}</b><small>sesiones</small></div>
      </div>
      <p class="muted" style="font-size:13px;margin:-4px 0 14px">Alta: ${new Date(u.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })} · Última actividad ${ago(u.lastActiveAt)}</p>
      <div class="action-list">
        ${act('edit', 'user-pen', 'Editar nombre o correo', 'Cambia los datos de la cuenta')}
        ${act('reset', 'mail-check', 'Enviar enlace para restablecer la contraseña', 'Le llega un correo para crear una contraseña nueva')}
        ${self ? '' : act('temp', 'key-round', 'Generar contraseña temporal', 'Tendrá que cambiarla al entrar. Útil si no recibe correos')}
        ${u.twoFactor && !self ? act('no2fa', 'shield-alert', 'Quitar la verificación en dos pasos', 'Si ha perdido el móvil y los códigos de recuperación') : ''}
        ${u.locked ? act('unlock', 'lock-open', 'Desbloquear acceso', 'Quita el bloqueo por intentos fallidos') : ''}
        ${!self && u.sessions ? act('logout', 'log-out', u.sessions === 1 ? 'Cerrar su sesión abierta' : `Cerrar sus ${u.sessions} sesiones`, 'Tendrá que volver a iniciar sesión en todos sus dispositivos') : ''}
        ${self ? '' : u.isAdmin ? (u.envAdmin ? '' : act('demote', 'user-x', 'Quitar permisos de administrador', 'Pasará a ser un usuario normal')) : act('promote', 'crown', 'Hacer administrador', 'Podrá gestionar usuarios y ajustes de la app')}
        ${self ? '' : u.blocked ? act('unblock', 'user-check', 'Reactivar cuenta', 'Podrá volver a entrar') : act('block', 'ban', 'Desactivar cuenta', 'No podrá entrar. Sus datos se conservan', 'danger')}
        ${self ? '' : act('delete', 'trash-2', 'Eliminar cuenta y todos sus datos', 'No se puede deshacer', 'danger')}
      </div>`,
  });
  $('.action-list').onclick = (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    const who = `<b>${esc(u.name)}</b> (${esc(u.email)})`;
    const post = (p, body) => api(`/admin/users/${u.id}/${p}`, { method: 'POST', body });
    closeModal();
    setTimeout(() => {
      if (a === 'edit') openModal({
        title: 'Editar usuario', icon: 'user-pen',
        html: `<label class="field">Nombre<input name="name" required maxlength="60" value="${esc(u.name)}"></label>
          <label class="field">Correo<input name="email" type="email" required value="${esc(u.email)}"></label>
          <p class="muted" style="font-size:13px;margin:0">Si cambias el correo, avisaremos a la dirección anterior.</p>`,
        onSubmit: async (d) => { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: d }); toast('Usuario actualizado'); route(); },
      });
      if (a === 'reset') adminAction({ title: 'Restablecer contraseña', icon: 'mail-check', okText: 'Enviar correo', text: `Enviaremos a ${who} un enlace para crear una contraseña nueva. Caduca en 1 hora.`,
        run: async () => { const r = await post('reset-link'); toast(r.simulated ? 'El correo no está configurado: no se ha podido enviar' : 'Correo enviado', !!r.simulated); } });
      if (a === 'temp') adminAction({ title: 'Contraseña temporal', icon: 'key-round', okText: 'Generar', text: `Se cerrarán las sesiones de ${who} y tendrá que entrar con la contraseña temporal y cambiarla. Comunícasela por un medio seguro.`,
        run: async () => {
          const r = await post('temp-password');
          setTimeout(() => {
            openModal({ title: 'Contraseña temporal', icon: 'key-round', okText: 'Hecho', html: `
              <p style="margin:0 0 12px;color:var(--text-2)">Contraseña temporal para ${who}. <b>Solo se muestra ahora.</b></p>
              <div class="codes-grid" style="grid-template-columns:1fr"><code style="font-size:19px">${esc(r.password)}</code></div>
              <button type="button" class="btn sm" id="cpTemp">${ic('copy', 'sm')}Copiar</button>`, onSubmit: async () => route() });
            $('#modalCancel').classList.add('hidden');
            $('#cpTemp').onclick = () => copyText(r.password);
          }, 80);
          return false;
        } });
      if (a === 'no2fa') adminAction({ title: 'Quitar verificación en dos pasos', icon: 'shield-alert', danger: true, okText: 'Quitar 2FA', text: `${who} podrá entrar solo con su contraseña y se cerrarán sus sesiones. Hazlo solo si has comprobado su identidad.`,
        run: async () => { await post('disable-2fa'); toast('2FA desactivado'); } });
      if (a === 'unlock') adminAction({ title: 'Desbloquear acceso', icon: 'lock-open', okText: 'Desbloquear', text: `Se quitará el bloqueo temporal de ${who}.`, run: async () => { await post('unlock'); toast('Acceso desbloqueado'); } });
      if (a === 'logout') adminAction({ title: 'Cerrar sesiones', icon: 'log-out', okText: 'Cerrar sesiones', text: `Se cerrarán todas las sesiones de ${who}.`, run: async () => { await post('logout-all'); toast('Sesiones cerradas'); } });
      if (a === 'promote') adminAction({ title: 'Hacer administrador', icon: 'crown', okText: 'Hacer administrador', text: `${who} podrá ver la lista de usuarios, cambiar contraseñas, desactivar cuentas y cambiar los ajustes de la app. Necesitará el 2FA para entrar en la administración.`,
        run: async () => { await post('role', { admin: true }); toast('Ahora es administrador'); } });
      if (a === 'demote') adminAction({ title: 'Quitar administrador', icon: 'user-x', okText: 'Quitar permisos', text: `${who} pasará a ser un usuario normal.`, run: async () => { await post('role', { admin: false }); toast('Permisos retirados'); } });
      if (a === 'block') adminAction({ title: 'Desactivar cuenta', icon: 'ban', danger: true, okText: 'Desactivar', text: `${who} no podrá entrar y se cerrarán sus sesiones. Sus datos se conservan y puedes reactivarla cuando quieras.`,
        run: async () => { await post('block', { blocked: true }); toast('Cuenta desactivada'); } });
      if (a === 'unblock') adminAction({ title: 'Reactivar cuenta', icon: 'user-check', okText: 'Reactivar', text: `${who} podrá volver a entrar.`, run: async () => { await post('block', { blocked: false }); toast('Cuenta reactivada'); } });
      if (a === 'delete') adminAction({ title: 'Eliminar cuenta', icon: 'trash-2', danger: true, okText: 'Eliminar para siempre',
        text: `Se borrarán la cuenta de ${who} y <b>todos sus datos</b> (${u.counts.expenses} gastos, ${u.counts.incomes} ingresos, ${u.counts.savings} huchas). <b>No se puede deshacer.</b>`,
        extra: `<label class="field">Escribe <b>${esc(u.email)}</b> para confirmar<input name="confirmEmail" autocomplete="off" required></label>`,
        run: async (d) => { await api(`/admin/users/${u.id}`, { method: 'DELETE', body: { confirmEmail: d.confirmEmail } }); toast('Cuenta eliminada'); } });
    }, 60);
  };
}

async function adminLog(el) {
  const log = await api('/admin/log');
  el.innerHTML = `<div class="card"><div class="card-head"><h3>${ic('clipboard-list', 'sm')}Registro de acciones</h3><span class="badge">Últimas ${log.length}</span></div>
    <p class="set-desc">Todo lo que hacen los administradores queda anotado aquí y no se puede borrar desde la app.</p>
    <div class="list">${log.map((e) => `<div class="li"><span class="ev-ic">${ic(/eliminad|desactiv|Quitar|retirad/i.test(e.action) ? 'shield-alert' : /Contraseña|restablecer/i.test(e.action) ? 'key-round' : 'user-cog', 'sm')}</span>
      <div class="main"><b>${esc(e.action)}${e.targetEmail ? ` · ${esc(e.targetEmail)}` : ''}</b>
      <small>Por ${esc(e.adminEmail)}<span class="dot-sep"></span>${ago(e.at)}${e.detail ? `<span class="dot-sep"></span>${esc(e.detail)}` : ''}</small></div></div>`).join('') || emptyHtml('clipboard-list', 'Aún no hay acciones', '')}</div></div>`;
}

function adminSettings(el, st) {
  let type = st.bannerType || 'info';
  el.innerHTML = `
  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>${ic('user-plus', 'sm')}Registro de usuarios</h3></div>
      <label class="switch-row"><span class="ichip sm green">${ic('user-plus', 'sm')}</span><span class="txt"><b>Permitir nuevos registros</b><small>Si lo desactivas, nadie más podrá crear una cuenta</small></span>
        <span class="switch"><input type="checkbox" id="stReg" ${st.registrationOpen !== false ? 'checked' : ''}><span></span></span></label>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('megaphone', 'sm')}Aviso para todos los usuarios</h3></div>
      <p class="set-desc">Aparece arriba en la app y en la pantalla de acceso. Déjalo vacío para quitarlo.</p>
      <label class="field">Mensaje<textarea id="stBanner" maxlength="300" placeholder="Ej: El domingo por la noche haremos mantenimiento.">${esc(st.banner || '')}</textarea></label>
      <div class="seg" id="stType" style="margin-bottom:14px"><button data-t="info">${ic('info', 'sm')}Información</button><button data-t="warn">${ic('triangle-alert', 'sm')}Importante</button><button data-t="ok">${ic('circle-check', 'sm')}Buenas noticias</button></div>
      <div id="stPrev"></div>
      <button class="btn primary" id="stSave">${ic('check', 'sm')}Publicar aviso</button>
    </div>
  </div>`;
  const prev = () => {
    $$('#stType button').forEach((b) => b.classList.toggle('on', b.dataset.t === type));
    const txt = $('#stBanner').value.trim();
    $('#stPrev').innerHTML = txt ? `<div class="mini-label">Vista previa</div>${bannerHtml(txt, type)}<div style="height:14px"></div>` : '';
  };
  $('#stType').onclick = (e) => { const b = e.target.closest('button'); if (b) { type = b.dataset.t; prev(); } };
  $('#stBanner').oninput = prev;
  prev();
  $('#stReg').onchange = async (e) => {
    try { await api('/admin/settings', { method: 'PUT', body: { registrationOpen: e.target.checked } }); toast(e.target.checked ? 'Registros abiertos' : 'Registros cerrados'); }
    catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
  };
  $('#stSave').onclick = async () => {
    try {
      const s = await api('/admin/settings', { method: 'PUT', body: { banner: $('#stBanner').value, bannerType: type } });
      publicCfg.banner = s.banner;
      publicCfg.bannerType = s.bannerType;
      renderBanners();
      toast(s.banner ? 'Aviso publicado' : 'Aviso retirado');
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- Aviso global ----------
const bannerHtml = (txt, type) => `<div class="notice ${type === 'warn' ? 'warn' : type === 'ok' ? 'ok' : ''}">${ic(type === 'warn' ? 'triangle-alert' : type === 'ok' ? 'circle-check' : 'megaphone', 'sm')}<span>${esc(txt)}</span></div>`;
function renderBanners() {
  const env = publicCfg.environment === 'pruebas' ? bannerHtml('Entorno de PRUEBAS: los datos se borran en cada actualización. No uses datos reales.', 'warn') : '';
  if (env) document.title = '[Pruebas] ' + document.title.replace(/^\[Pruebas\] /, '');
  const h = env + (publicCfg.banner ? bannerHtml(publicCfg.banner, publicCfg.bannerType) : '');
  $('#appBanner').innerHTML = h;
  $('#authBanner').innerHTML = h;
}

// ---------- ¿Has olvidado tu contraseña? ----------
function forgotForm() {
  openModal({
    title: 'Recuperar contraseña',
    icon: 'key-round',
    okText: 'Enviar enlace',
    html: `<p class="set-desc">Escribe el correo de tu cuenta y te enviaremos un enlace para crear una contraseña nueva.</p>
      <label class="field">Correo electrónico<div class="input-icon">${ic('mail')}<input name="email" type="email" required autocomplete="email" value="${esc($('#authForm').email.value)}"></div></label>`,
    onSubmit: async (d) => {
      await api('/auth/forgot', { method: 'POST', body: d });
      setTimeout(() => openModal({ title: 'Revisa tu correo', icon: 'mail-check', okText: 'Entendido', html: `<p style="margin:0;color:var(--text-2)">Si existe una cuenta con <b>${esc(d.email)}</b>, recibirás un correo con un enlace. Caduca en 1 hora. Mira también en la carpeta de spam.</p>`, onSubmit: async () => {} }), 80);
    },
  });
}
function resetForm(token) {
  openModal({
    title: 'Crea tu contraseña nueva',
    icon: 'key-round',
    okText: 'Guardar contraseña',
    html: `<label class="field">Nueva contraseña<div class="input-icon pw-wrap">${ic('lock')}<input name="password" type="password" required autocomplete="new-password" placeholder="8+ caracteres, letras y números"><button type="button" class="pw-eye" tabindex="-1">${ic('eye')}</button></div></label>
      <div class="pw-meter" id="rsMeter"></div>
      <label class="field">Repite la contraseña<div class="input-icon">${ic('lock')}<input name="confirm" type="password" required autocomplete="new-password"></div></label>`,
    onSubmit: async (d) => {
      if (d.password !== d.confirm) throw new Error('Las contraseñas no coinciden');
      const r = await api('/auth/reset', { method: 'POST', body: { token, password: d.password } });
      history.replaceState(null, '', location.pathname + '#/');
      if (me) showAuth();
      toast(r.twoFactor ? 'Contraseña cambiada. Entra con ella y con tu código 2FA.' : 'Contraseña cambiada. Ya puedes entrar.');
    },
  });
  const inp = $('#modalBody input[name=password]');
  inp.oninput = () => paintMeter($('#rsMeter'), inp.value);
}
// Cambio obligatorio tras una contraseña temporal
function forcePasswordChange() {
  openModal({
    title: 'Cambia tu contraseña temporal',
    icon: 'key-round',
    okText: 'Guardar y continuar',
    locked: true,
    html: `<div class="notice warn" style="margin-bottom:16px">${ic('info', 'sm')}<span>Un administrador te ha dado una contraseña temporal. Elige una contraseña nueva para continuar.</span></div>
      <label class="field">Contraseña temporal<div class="input-icon">${ic('lock')}<input name="currentPassword" type="password" required autocomplete="current-password"></div></label>
      <label class="field">Nueva contraseña<div class="input-icon pw-wrap">${ic('lock')}<input name="newPassword" type="password" required autocomplete="new-password" placeholder="8+ caracteres, letras y números"><button type="button" class="pw-eye" tabindex="-1">${ic('eye')}</button></div></label>
      <div class="pw-meter" id="fpMeter"></div>
      <label class="field">Repite la nueva contraseña<div class="input-icon">${ic('lock')}<input name="confirm" type="password" required autocomplete="new-password"></div></label>
      ${me.twoFactor ? '<label class="field">Código de tu app<input name="code" inputmode="numeric" maxlength="6" required placeholder="000000"></label>' : ''}
      <button type="button" class="btn ghost sm" id="fpLogout">${ic('log-out', 'sm')}Cerrar sesión</button>`,
    onSubmit: async (d) => {
      if (d.newPassword !== d.confirm) throw new Error('Las contraseñas no coinciden');
      me = await api('/me/password', { method: 'POST', body: d });
      toast('Contraseña cambiada');
      setTimeout(() => { $('#view').innerHTML = ''; route(); }, 50);
    },
  });
  const inp = $('#modalBody input[name=newPassword]');
  inp.oninput = () => paintMeter($('#fpMeter'), inp.value);
  $('#fpLogout').onclick = () => { modalLocked = false; closeModal(); logout(); };
}

// ---------- Menú «Más» (móvil) ----------
function openMore() {
  const items = [
    ['ingresos', 'hand-coins', 'Ingresos'],
    ['calendario', 'calendar-days', 'Calendario'],
    ['cuentas', 'landmark', 'Cuentas'],
    ['presupuestos', 'target', 'Presupuestos'],
    ['mensuales', 'repeat', 'Pagos fijos'],
    ['previsiones', 'chart-line', 'Previsiones'],
    ['tickets', 'scan-line', 'Tickets'],
    ['informes', 'file-text', 'Informes'],
    ['ahorros', 'piggy-bank', 'Ahorros'],
    ['semanal', 'calendar-range', 'Resumen semanal'],
    ['seguridad', 'shield-check', 'Seguridad'],
    ['ajustes', 'settings', 'Ajustes'],
    ...(me?.isAdmin ? [['admin', 'user-cog', 'Administración']] : []),
    ...(IS_ELECTRON ? [] : [['descargar', 'download', 'Descargar app']]),
  ];
  openModal({
    title: 'Más opciones',
    actions: false,
    html: `<div class="more-list grid2">${items.map(([v, i, t]) => `<a href="#/${v}">${ic(i)}${t}</a>`).join('')}
      <button type="button" class="danger" id="moreLogout">${ic('log-out')}Cerrar sesión</button></div>`,
  });
  $$('.more-list a').forEach((a) => a.addEventListener('click', closeModal));
  $('#moreLogout').onclick = () => { closeModal(); logout(); };
}

// ---------- Router ----------
const addExpense = () => expenseForm({}, location.hash.includes('calendario') ? { date: state.calSel } : {});
const VIEWS = {
  dashboard: ['Inicio', () => `Hola, ${esc(me.name.split(' ')[0])} · ${todayD().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}`, renderDashboard],
  gastos: ['Movimientos', () => 'Tus gastos día a día: busca, filtra y exporta', renderExpenses],
  ingresos: ['Ingresos', () => 'Lo que has cobrado, en una tabla que puedes llevar a Excel', renderIncomes, ['Nuevo ingreso', () => incomeForm()]],
  calendario: ['Calendario', () => 'Gastos, ingresos y pagos previstos', renderCalendar],
  cuentas: ['Cuentas', () => 'Tu dinero en cada cuenta, tarjeta y efectivo', (el) => renderAccounts(el), ['Nueva cuenta', () => accountForm()]],
  presupuestos: ['Presupuestos', () => 'Cuánto puedes gastar y cómo vas este mes', (el) => renderBudgets(el), ['Nuevo presupuesto', () => budgetForm()]],
  mensuales: ['Pagos fijos', () => 'Recibos, alquiler y suscripciones con aviso antes de cada cobro', renderRecurring, ['Nuevo pago fijo', () => recurringForm()]],
  previsiones: ['Previsiones', () => 'Cuánto dinero tendrás y si puedes permitirte una compra', (el) => renderForecast(el)],
  asistente: ['Asistente', () => 'Pregunta lo que quieras sobre tu dinero', (el) => renderAssistant(el)],
  tickets: ['Tickets', () => 'Escanea tickets y consulta su historial', (el) => renderReceipts(el)],
  informes: ['Informes', () => 'Estadísticas por periodo, listas para descargar', (el) => renderReports(el)],
  ahorros: ['Ahorros', () => 'Cuánto dinero tienes guardado y para qué', renderSavings, ['Nueva hucha', () => savingForm()]],
  semanal: ['Resumen semanal', () => 'Cómo ha ido tu semana', renderWeekly],
  seguridad: ['Seguridad', () => 'Verificación en dos pasos, contraseña y sesiones', renderSecurity],
  ajustes: ['Ajustes', () => 'Perfil, economía, avisos, apariencia, categorías y tus datos', renderSettings],
  descargar: ['Descargar app', () => 'Úsala en el móvil y en el ordenador', renderDownload],
  admin: ['Administración', () => 'Usuarios, contraseñas, permisos y ajustes de la app', renderAdmin],
};
const IN_MORE = ['ingresos', 'calendario', 'cuentas', 'presupuestos', 'mensuales', 'previsiones', 'tickets', 'informes', 'ahorros', 'semanal', 'seguridad', 'ajustes', 'descargar', 'admin'];
let currentAdd = addExpense;
let lastNotifCheck = 0;
async function route() {
  if (!me) return;
  let [v, query] = location.hash.replace('#/', '').split('?');
  if (!VIEWS[v]) v = 'dashboard';
  const [title, subtitle, render, add] = VIEWS[v];
  currentAdd = add ? add[1] : addExpense;
  $('#btnAddTxt').textContent = add ? add[0] : 'Nuevo gasto';
  if (query?.includes('nuevo=1')) {
    history.replaceState(null, '', '#/' + v);
    setTimeout(() => currentAdd(), 0);
  }
  $('#viewTitle').textContent = title;
  $('#viewSubtitle').innerHTML = subtitle();
  document.title = `${title} · Agenda de Gastos`;
  if (v === 'admin' && !me.isAdmin) { location.hash = '#/dashboard'; return; }
  $$('#nav a, #tabbar [data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === v || (a.dataset.view === 'more' && IN_MORE.includes(v))));
  charts.forEach((c) => c.destroy());
  charts = [];
  const view = $('#view');
  if (!view.children.length) view.innerHTML = '<div class="grid g3"><div class="skeleton span2" style="height:190px"></div><div class="skeleton" style="height:190px"></div></div><div class="skeleton" style="height:300px"></div>';
  if (Date.now() - lastNotifCheck > 60_000) { lastNotifCheck = Date.now(); refreshNotifs(); }
  try {
    await render(view);
    hydrate(view);
  } catch (e) {
    if (!me) return;
    view.innerHTML = `<div class="card">${emptyHtml('triangle-alert', 'No se pudo cargar', esc(e.message), '<button class="btn sm" data-act="retry">Reintentar</button>')}</div>`;
  }
}
window.addEventListener('hashchange', () => { $('#view').innerHTML = ''; window.scrollTo(0, 0); route(); });

// ---------- Sesión ----------
function setUser() {
  const initial = me.name.trim()[0]?.toUpperCase() || '?';
  $('#userName').textContent = me.name;
  $('#userEmail').textContent = me.email;
  $('#avatar').textContent = initial;
  $('#avatarMobile').textContent = initial;
  $('#secWarn').classList.toggle('hidden', !!me.twoFactor);
  $('#navAdmin').classList.toggle('hidden', !me.isAdmin);
}
function showAuth() {
  me = null;
  cats = [];
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  backToPassword();
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  showAuth();
}
async function enter() {
  me = await api('/me');
  setUser();
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#view').innerHTML = '';
  if (me.mustChangePassword) { forcePasswordChange(); return; }
  cats = await api('/categories');
  await loadAccounts();
  route();
  refreshNotifs();
  api('/finance-settings').then((f) => { me.finance = f; me.onboarded = f.onboarded; if (!f.onboarded && !accs.length) setTimeout(onboarding, 600); }).catch(() => {});
  api('/recurring').then((recs) => { updateDueBadge(recs); notifyUpcoming(recs); }).catch(() => {});
}

let registering = false;
function setAuthMode(reg) {
  registering = reg;
  $$('.reg-only').forEach((e) => e.classList.toggle('hidden', !reg));
  $$('.login-only').forEach((e) => e.classList.toggle('hidden', reg));
  $('.auth-switch').classList.toggle('hidden', !reg && publicCfg.registrationOpen === false);
  $('#authTitle').textContent = reg ? 'Crea tu cuenta' : 'Bienvenido de nuevo';
  $('#authSubmit').textContent = reg ? 'Crear cuenta gratis' : 'Entrar';
  $('#authSubtitle').textContent = reg ? 'Tu cuenta quedará vinculada a tu correo para recibir los avisos.' : 'Inicia sesión para ver tus gastos';
  $('#authSwitchTxt').textContent = reg ? '¿Ya tienes cuenta?' : '¿No tienes cuenta?';
  $('#authToggle').textContent = reg ? 'Inicia sesión' : 'Regístrate gratis';
  $('#authForm').password.autocomplete = reg ? 'new-password' : 'current-password';
  $('#authForm').password.placeholder = reg ? '8+ caracteres, letras y números' : 'Tu contraseña';
  paintMeter($('#authMeter'), reg ? $('#authForm').password.value : '');
  $('#authError').textContent = '';
}
$('#authToggle').onclick = (e) => { e.preventDefault(); setAuthMode(!registering); };
$('#forgotLink').onclick = (e) => { e.preventDefault(); forgotForm(); };
$('#authForm').password.addEventListener('input', (e) => { if (registering) paintMeter($('#authMeter'), e.target.value); });

let loginTicket = null;
let recoveryMode = false;
function backToPassword() {
  loginTicket = null;
  $('#codeForm').classList.add('hidden');
  $('#authForm').classList.remove('hidden');
}
function setRecoveryMode(on) {
  recoveryMode = on;
  const inp = $('#codeForm').code;
  inp.value = '';
  inp.maxLength = on ? 9 : 6;
  inp.inputMode = on ? 'text' : 'numeric';
  inp.placeholder = on ? 'xxxx-xxxx' : '000000';
  inp.classList.toggle('code-input', !on);
  $('#codeSub').textContent = on ? 'Escribe uno de los códigos de recuperación que guardaste. Cada uno sirve una sola vez.' : 'Abre tu app autenticadora y escribe el código de 6 cifras.';
  $('#codeLabel').firstChild.textContent = on ? 'Código de recuperación' : 'Código de verificación';
  $('#codeRecovery').textContent = on ? 'Usar la app autenticadora' : '¿Has perdido el móvil? Usa un código de recuperación';
  $('#codeError').textContent = '';
  setTimeout(() => inp.focus(), 30);
}
$('#authForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  $('#authSubmit').disabled = true;
  $('#authError').textContent = '';
  try {
    const r = await api(registering ? '/auth/register' : '/auth/login', { method: 'POST', body });
    if (r.twoFactor) {
      loginTicket = r.ticket;
      $('#authForm').classList.add('hidden');
      $('#codeForm').classList.remove('hidden');
      setRecoveryMode(false);
      return;
    }
    ev.target.reset();
    paintMeter($('#authMeter'), '');
    await enter();
  } catch (e) {
    $('#authError').textContent = e.message;
  } finally {
    $('#authSubmit').disabled = false;
  }
};
$('#codeForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const code = ev.target.code.value.trim();
  if (!code) return;
  $('#codeSubmit').disabled = true;
  try {
    await api('/auth/2fa', { method: 'POST', body: { ticket: loginTicket, code } });
    $('#authForm').reset();
    backToPassword();
    await enter();
  } catch (e) {
    $('#codeError').textContent = e.message;
    ev.target.code.select();
    if (/caducado|Vuelve a empezar/.test(e.message)) setTimeout(() => { backToPassword(); $('#authError').textContent = e.message; }, 1500);
  } finally {
    $('#codeSubmit').disabled = false;
  }
};
$('#codeForm').code.addEventListener('input', (e) => {
  if (!recoveryMode) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (e.target.value.length === 6) $('#codeForm').requestSubmit();
  }
});
$('#codeRecovery').onclick = (e) => { e.preventDefault(); setRecoveryMode(!recoveryMode); };
$('#codeBack').onclick = (e) => { e.preventDefault(); backToPassword(); };

$('#logout').onclick = logout;
$('#btnAdd').onclick = () => currentAdd();
$('#fabAdd').onclick = () => currentAdd();
$('#moreBtn').onclick = openMore;
$('#themeBtn').onclick = () => { applyTheme(isDark() ? 'light' : 'dark'); route(); };

// ---------- Arranque ----------
hydrate();
applyTheme(themePref());
setAuthMode(false);
if (IS_ELECTRON) $$('.nav-download').forEach((e) => e.classList.add('hidden'));
fetch('/api/public-config').then((r) => r.json()).then((c) => { publicCfg = c; renderAuthInstall(); renderBanners(); setAuthMode(registering); }).catch(() => {});
if ('serviceWorker' in navigator && !IS_ELECTRON) navigator.serviceWorker.register('/sw.js').catch(() => {});
const resetToken = /^#\/restablecer\?token=([\w-]+)/.exec(location.hash)?.[1];
if (resetToken) { showAuth(); resetForm(resetToken); }
else enter().catch(() => showAuth());
