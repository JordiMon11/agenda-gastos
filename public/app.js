/* Agenda de Gastos · interfaz (web, móvil y escritorio) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const TOKEN_KEY = 'agenda_gastos_token';
let token = store.get(TOKEN_KEY);
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
const trendHtml = (p, suffix = '') =>
  p === null ? '' : `<span class="trend ${p > 0 ? 'up' : 'down'}">${ic(p > 0 ? 'trending-up' : 'trending-down', 'xs')}${Math.abs(p).toFixed(0)}%</span>${suffix}`;
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
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (r.status === 401 && token && !path.startsWith('/auth')) { showAuth(); throw new Error('Tu sesión ha caducado'); }
  if (!r.ok) throw new Error(data?.error || 'No se pudo conectar con el servidor');
  return data;
}

// ---------- Tema ----------
const THEME_KEY = 'agenda_tema';
const themePref = () => store.get(THEME_KEY) || 'system';
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme(pref) {
  store.set(THEME_KEY, pref === 'system' ? null : pref);
  if (pref === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  $('#themeBtn').innerHTML = ic(isDark() ? 'sun' : 'moon');
  document.querySelector('meta[name=theme-color]').content = isDark() ? '#0c0e17' : '#4f46e5';
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
function openModal({ title, icon = '', html, onSubmit, okText = 'Guardar', danger = false, actions = true }) {
  $('#modalTitle').textContent = title;
  $('#modalIcon').innerHTML = icon ? `<span class="ichip sm ${danger ? 'red' : ''}">${ic(icon)}</span>` : '';
  $('#modalBody').innerHTML = html;
  $('#modalError').textContent = '';
  $('#modalOk').textContent = okText;
  $('#modalOk').className = 'btn ' + (danger ? 'danger solid' : 'primary');
  $('#modalActions').classList.toggle('hidden', !actions);
  hydrate($('#modalBody'));
  modalSubmit = onSubmit;
  $('#modal').showModal();
  if (matchMedia('(min-width: 901px)').matches) setTimeout(() => $('#modalBody input:not([type=hidden]), #modalBody select')?.focus(), 40);
}
const closeModal = () => $('#modal').close();
$('#modalCancel').onclick = closeModal;
$('#modalClose').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
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
  openModal({
    title: exp.id ? 'Editar gasto' : 'Nuevo gasto',
    icon: exp.id ? 'pencil' : 'receipt-text',
    html: `
      <label class="field">Importe
        <div class="input-money"><input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required value="${exp.amount ?? ''}" placeholder="0,00"><span>€</span></div>
      </label>
      <label class="field">Concepto<input name="name" required maxlength="100" value="${esc(exp.name || '')}" placeholder="Ej: Compra semanal"></label>
      ${catPicker(exp.categoryId ?? preset.categoryId)}
      <div class="row">
        <label class="field">Fecha<input name="date" type="date" required value="${exp.date || preset.date || ymd(todayD())}"></label>
        <label class="field">¿Dónde?<div class="input-icon"><i data-i="map-pin"></i><input name="place" list="placesList" maxlength="100" value="${esc(exp.place || '')}" placeholder="Tienda, web, lugar…"></div></label>
      </div>
      <label class="field">Notas<textarea name="notes" maxlength="500" placeholder="Opcional">${esc(exp.notes || '')}</textarea></label>
      ${exp.id ? `<button type="button" class="btn danger sm" id="delInModal">${ic('trash-2', 'sm')}Eliminar gasto</button>` : ''}`,
    onSubmit: async (d) => {
      d.amount = Number(d.amount);
      if (exp.id) await api('/expenses/' + exp.id, { method: 'PUT', body: d });
      else await api('/expenses', { method: 'POST', body: d });
      toast(exp.id ? 'Gasto actualizado' : 'Gasto añadido');
      route();
    },
  });
  bindCatPicker($('#modalBody'));
  $('#delInModal')?.addEventListener('click', () => deleteExpense(exp));
}

function recurringForm(rec = {}) {
  loadPlaces();
  openModal({
    title: rec.id ? 'Editar gasto mensual' : 'Nuevo gasto mensual',
    icon: 'repeat',
    html: `
      <label class="field">Importe al mes
        <div class="input-money"><input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required value="${rec.amount ?? ''}" placeholder="0,00"><span>€</span></div>
      </label>
      <label class="field">Concepto<input name="name" required maxlength="100" value="${esc(rec.name || '')}" placeholder="Alquiler, Netflix, gimnasio…"></label>
      ${catPicker(rec.categoryId)}
      <div class="row">
        <label class="field">Día de cobro<input name="dayOfMonth" type="number" min="1" max="31" required value="${rec.dayOfMonth ?? 1}"></label>
        <label class="field">Avisar (días antes)<input name="remindDaysBefore" type="number" min="0" max="30" required value="${rec.remindDaysBefore ?? 3}"></label>
      </div>
      <label class="field">¿Quién cobra?<div class="input-icon"><i data-i="store"></i><input name="place" list="placesList" maxlength="100" value="${esc(rec.place || '')}" placeholder="Banco, Netflix…"></div></label>
      <label class="switch-row"><span class="ichip sm amber">${ic('zap', 'sm')}</span><span class="txt"><b>Registro automático</b><small>Se añade a tus gastos el día del cobro</small></span>
        <span class="switch"><input type="checkbox" name="autoAdd" ${rec.autoAdd ?? true ? 'checked' : ''}><span></span></span></label>
      <label class="switch-row"><span class="ichip sm green">${ic('circle-check', 'sm')}</span><span class="txt"><b>Activo</b><small>Si lo desactivas no recibirás avisos</small></span>
        <span class="switch"><input type="checkbox" name="active" ${rec.active ?? true ? 'checked' : ''}><span></span></span></label>`,
    onSubmit: async (d) => {
      d.amount = Number(d.amount);
      d.dayOfMonth = Number(d.dayOfMonth);
      d.remindDaysBefore = Number(d.remindDaysBefore);
      if (rec.id) await api('/recurring/' + rec.id, { method: 'PUT', body: d });
      else await api('/recurring', { method: 'POST', body: d });
      toast('Gasto mensual guardado');
      route();
    },
  });
  bindCatPicker($('#modalBody'));
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
  const meta = [date ? fmtDate(e.date) : '', esc(c.name), e.place ? `${ic('map-pin')}${esc(e.place)}` : '', e.recurringId ? `${ic('repeat')}Mensual` : '']
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
  const from = ymd(new Date(t.getFullYear(), t.getMonth() - 5, 1));
  const to = ymd(new Date(t.getFullYear(), t.getMonth() + 1, 0));
  const [exps, recs] = await Promise.all([api(`/expenses?from=${from}&to=${to}`), api('/recurring')]);
  updateDueBadge(recs);
  const mk = monthKey(t);
  const prevD = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const monthExp = exps.filter((e) => e.date.startsWith(mk));
  const monthTotal = sum(monthExp);
  const prevTotal = sum(exps.filter((e) => e.date.startsWith(monthKey(prevD))));
  const ws = weekStart(t);
  const weekTotal = sum(exps.filter((e) => e.date >= ymd(ws) && e.date <= ymd(addDays(ws, 6))));
  const prevWeekTotal = sum(exps.filter((e) => e.date >= ymd(addDays(ws, -7)) && e.date < ymd(ws)));
  const dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  const avg = monthTotal / t.getDate();
  const active = recs.filter((r) => r.active);
  const fixed = active.reduce((a, r) => a + r.amount, 0);
  const paid = active.filter((r) => r.paidThisMonth).reduce((a, r) => a + r.amount, 0);

  const byCat = {};
  for (const e of monthExp) byCat[e.categoryId || ''] = (byCat[e.categoryId || ''] || 0) + e.amount;
  const catItems = Object.entries(byCat).map(([id, total]) => ({ ...catOf(id || null), total })).sort((a, b) => b.total - a.total);
  const byPlace = {};
  for (const e of monthExp) if (e.place) byPlace[e.place] = (byPlace[e.place] || 0) + e.amount;
  const places = Object.entries(byPlace).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const months = [...Array(6)].map((_, i) => new Date(t.getFullYear(), t.getMonth() - 5 + i, 1));
  const diff = pct(monthTotal, prevTotal);
  const upcoming = active.filter((r) => !r.paidThisMonth || r.daysLeft <= 31).slice(0, 4);

  el.innerHTML = `
  <div class="grid g3">
    <div class="hero span2">
      <div>
        <div class="label">${ic('wallet', 'sm')}Gastado en ${monthName(t, false)}</div>
        <div class="amount">${eur(monthTotal)}</div>
        <div class="pill">${diff === null ? `${ic('sparkles', 'xs')}Tu primer mes con datos` : `${ic(diff > 0 ? 'trending-up' : 'trending-down', 'xs')}${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(0)}% que en ${monthName(prevD, false)}`}</div>
      </div>
      <div class="foot">
        <div><b>${monthExp.length}</b>gastos este mes</div>
        <div><b>${eur(avg * dim)}</b>previsión a fin de mes</div>
        <div style="min-width:180px;flex:1;max-width:260px"><b>${eur(paid)} <span style="font-weight:500;opacity:.8;font-size:13px">de ${eur(fixed)}</span></b>fijos pagados
          <div class="progress thin" style="margin-top:7px"><div style="width:${fixed ? (paid / fixed) * 100 : 0}%"></div></div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('calendar-clock', 'sm')}Próximos cobros</h3><a class="link" href="#/mensuales">Ver todos${ic('chevron-right', 'xs')}</a></div>
      <div class="list">${upcoming.map((r) => { const c = catOf(r.categoryId); return `<div class="li">
        ${catIc(c, 'sm')}<div class="main"><b>${esc(r.name)}</b><small>${fmtDate(r.nextDue, { weekday: 'short', day: 'numeric', month: 'short' })}</small></div>
        <div style="text-align:right"><div class="amt">${eur(r.amount)}</div><span class="badge ${r.daysLeft <= r.remindDaysBefore ? 'warn' : ''}" style="margin-top:3px">${daysTxt(r.daysLeft)}</span></div></div>`; }).join('')
        || emptyHtml('repeat', 'Sin gastos mensuales', 'Añade alquiler, luz o suscripciones y te avisaremos antes de cada cobro.', `<a class="btn sm" href="#/mensuales">${ic('plus', 'sm')}Añadir</a>`)}</div>
    </div>
  </div>

  <div class="grid g4 stats">
    <div class="card stat"><div class="top"><span class="label">Esta semana</span><span class="ichip">${ic('calendar-range')}</span></div>
      <div><div class="value">${eur(weekTotal)}</div><div class="sub">${trendHtml(pct(weekTotal, prevWeekTotal), ' vs. semana pasada') || 'Desde el lunes'}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Media diaria</span><span class="ichip green">${ic('activity')}</span></div>
      <div><div class="value">${eur(avg)}</div><div class="sub">En ${monthName(t, false)}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Gastos fijos</span><span class="ichip amber">${ic('repeat')}</span></div>
      <div><div class="value">${eur(fixed)}</div><div class="sub">${active.length} al mes</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Mayor categoría</span><span class="ichip red">${ic('trophy')}</span></div>
      <div><div class="value">${catItems[0] ? eur(catItems[0].total) : '—'}</div><div class="sub">${catItems[0] ? esc(catItems[0].name) : 'Sin gastos todavía'}</div></div></div>
  </div>

  <div class="grid g3">
    <div class="card">
      <div class="card-head"><h3>${ic('chart-pie', 'sm')}Por categoría</h3><span class="badge">${cap(monthName(t, false))}</span></div>
      ${catItems.length ? `<div class="donut-wrap"><canvas id="cCat"></canvas><div class="donut-center"><div><b>${eurShort(monthTotal)}</b><small>total</small></div></div></div>${legendHtml(catItems, monthTotal)}`
        : emptyHtml('chart-pie', 'Sin datos este mes', 'Cuando añadas gastos verás aquí el reparto.')}
    </div>
    <div class="card span2">
      <div class="card-head"><h3>${ic('receipt-text', 'sm')}Gasto diario</h3><span class="badge">${cap(monthName(t))}</span></div>
      <div class="chart-box"><canvas id="cDays"></canvas></div>
    </div>
  </div>

  <div class="grid g3">
    <div class="card span2">
      <div class="card-head"><h3>${ic('trending-up', 'sm')}Últimos 6 meses</h3></div>
      <div class="chart-box sm"><canvas id="cMonths"></canvas></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('map-pin', 'sm')}Dónde más gastas</h3></div>
      <div class="list">${places.map(([p, v], i) => `<div class="li"><span class="ichip sm ${['', 'green', 'amber', 'red', ''][i]}">${ic('store', 'sm')}</span>
        <div class="main"><b>${esc(p)}</b><div class="progress thin" style="margin-top:6px"><div style="width:${(v / places[0][1]) * 100}%"></div></div></div><div class="amt">${eur(v)}</div></div>`).join('')
        || emptyHtml('map-pin', 'Aún no hay lugares', 'Indica «dónde» al apuntar un gasto para verlo aquí.')}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>${ic('clock', 'sm')}Últimos gastos</h3><a class="link" href="#/gastos">Ver todos${ic('chevron-right', 'xs')}</a></div>
    <div class="list" id="recent">${exps.slice(0, 6).map((e) => expenseRow(e)).join('')
      || emptyHtml('receipt-text', 'Todavía no hay gastos', 'Pulsa «Nuevo gasto» para apuntar el primero.', `<button class="btn primary sm" onclick="expenseForm()">${ic('plus', 'sm')}Nuevo gasto</button>`)}</div>
  </div>`;

  bindExpenseClicks($('#recent'), exps);
  if (catItems.length) donut($('#cCat'), catItems);
  chart($('#cDays'), {
    type: 'bar',
    data: {
      labels: [...Array(dim)].map((_, i) => i + 1),
      datasets: [{
        data: [...Array(dim)].map((_, i) => sum(monthExp.filter((e) => e.date === `${mk}-${pad(i + 1)}`))),
        backgroundColor: [...Array(dim)].map((_, i) => (i + 1 === t.getDate() ? cssVar('--primary-2') : cssVar('--primary'))),
        borderRadius: 6, maxBarThickness: 22,
      }],
    },
    options: { ...barOpts, plugins: { ...barOpts.plugins, tooltip: { callbacks: { title: (c) => `${c[0].label} de ${monthName(t, false)}`, label: (c) => ` ${eur(c.parsed.y)}` } } } },
  });
  const ctx = $('#cMonths')?.getContext('2d');
  let grad = cssVar('--primary');
  if (ctx) { grad = ctx.createLinearGradient(0, 0, 0, 210); grad.addColorStop(0, cssVar('--primary') + '55'); grad.addColorStop(1, cssVar('--primary') + '00'); }
  chart($('#cMonths'), {
    type: 'line',
    data: {
      labels: months.map((d) => cap(d.toLocaleDateString('es-ES', { month: 'short' }).replace('.', ''))),
      datasets: [{ data: months.map((d) => sum(exps.filter((e) => e.date.startsWith(monthKey(d))))), borderColor: cssVar('--primary'), backgroundColor: grad, fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: cssVar('--surface'), pointBorderWidth: 2, borderWidth: 2.5 }],
    },
    options: barOpts,
  });
}

// ---------- Gastos ----------
async function renderExpenses(el) {
  const mDate = parse(state.month + '-01');
  el.innerHTML = `
  <div class="toolbar">
    <div class="month-nav"><button class="icon-btn" id="mPrev" title="Mes anterior">${ic('chevron-left')}</button><span class="lbl">${cap(monthName(mDate))}</span><button class="icon-btn" id="mNext" title="Mes siguiente">${ic('chevron-right')}</button></div>
    <select id="fCat"><option value="">Todas las categorías</option><option value="none">Sin categoría</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
    <div class="input-icon grow">${ic('search')}<input type="search" id="fQ" placeholder="Buscar concepto, lugar o nota…" value="${esc(state.q)}"></div>
    <button class="btn" id="btnCsv">${ic('file-down', 'sm')}Exportar</button>
  </div>
  <div class="card"><div id="tbl"><div class="skeleton" style="height:240px"></div></div></div>`;
  $('#fCat').value = state.cat;
  let list = [];
  const load = async () => {
    const [y, m] = state.month.split('-').map(Number);
    const qs = new URLSearchParams({ from: `${y}-${pad(m)}-01`, to: ymd(new Date(y, m, 0)) });
    if (state.cat) qs.set('category', state.cat);
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
  $('#btnCsv').onclick = () => {
    if (!list.length) return toast('No hay gastos que exportar', true);
    const rows = [['Fecha', 'Concepto', 'Categoría', 'Lugar', 'Importe', 'Notas'], ...list.map((e) => [e.date, e.name, catOf(e.categoryId).name, e.place, String(e.amount).replace('.', ','), e.notes])];
    const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `gastos-${state.month}.csv`;
    a.click();
  };
  await load();
}

// ---------- Calendario ----------
async function renderCalendar(el) {
  const base = parse(state.calMonth + '-01');
  const y = base.getFullYear(), m = base.getMonth();
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const [exps, recs] = await Promise.all([api(`/expenses?from=${ymd(first)}&to=${ymd(last)}`), api('/recurring')]);
  const byDay = {};
  for (const e of exps) (byDay[e.date] ||= []).push(e);
  const dues = {};
  for (const r of recs.filter((r) => r.active)) (dues[ymd(dueInMonth(r.dayOfMonth, y, m))] ||= []).push(r);
  const max = Math.max(1, ...Object.values(byDay).map(sum));
  const lead = (first.getDay() + 6) % 7;
  const tStr = ymd(todayD());

  let cells = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((d) => `<div class="dow">${d}</div>`).join('');
  cells += '<div class="day out"></div>'.repeat(lead);
  for (let d = 1; d <= last.getDate(); d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
    const list = byDay[ds] || [];
    const tot = sum(list);
    cells += `<div class="day ${ds === tStr ? 'today' : ''} ${ds === state.calSel ? 'sel' : ''}" data-date="${ds}">
      ${tot ? `<div class="heat" style="opacity:${0.04 + (tot / max) * 0.2}"></div>` : ''}
      <span class="n">${d}</span>
      ${tot ? `<span class="t">${eurShort(tot)}</span>` : ''}
      ${(dues[ds] || []).map((r) => `<span class="due" title="${esc(r.name)} · ${eur(r.amount)}">${ic('bell')}<span>${esc(r.name)}</span></span>`).join('')}
      <div class="dots">${list.slice(0, 6).map((e) => `<i style="background:${safeColor(catOf(e.categoryId).color)}"></i>`).join('')}</div>
    </div>`;
  }

  el.innerHTML = `
  <div class="grid g3">
    <div class="card span2">
      <div class="cal-head">
        <h2>${monthName(base)}</h2>
        <button class="btn sm" id="todayM">Hoy</button>
        <div class="month-nav"><button class="icon-btn" id="prevM">${ic('chevron-left')}</button><button class="icon-btn" id="nextM">${ic('chevron-right')}</button></div>
      </div>
      <div class="cal" id="cal">${cells}</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:16px;font-size:13px;color:var(--muted)">
        <span>Total del mes: <b style="color:var(--text)">${eur(sum(exps))}</b></span>
        <span style="display:inline-flex;gap:6px;align-items:center"><span class="badge warn">${ic('bell')}</span>Gasto mensual que se cobra ese día</span>
      </div>
    </div>
    <div class="card" id="dayPanel"></div>
  </div>`;

  const showDay = (ds) => {
    state.calSel = ds;
    $$('.cal .day').forEach((c) => c.classList.toggle('sel', c.dataset.date === ds));
    const list = byDay[ds] || [];
    const due = dues[ds] || [];
    $('#dayPanel').innerHTML = `
      <div class="card-head" style="margin-bottom:6px"><h3>${ic('calendar-days', 'sm')}${cap(fmtDate(ds, { weekday: 'long', day: 'numeric', month: 'long' }))}</h3></div>
      <div class="day-panel-total">${eur(sum(list))}</div>
      <div class="muted" style="font-size:13px;margin-bottom:14px">${list.length} gasto${list.length === 1 ? '' : 's'}</div>
      ${due.length ? `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">${due.map((r) => `<div class="notice warn" style="padding:10px 12px">${ic('bell', 'sm')}<span><b>${esc(r.name)}</b> se cobra este día · ${eur(r.amount)}</span></div>`).join('')}</div>` : ''}
      <div class="list" id="dayList">${list.map((e) => expenseRow(e, { date: false })).join('') || emptyHtml('calendar-check', 'Día sin gastos', '')}</div>
      <button class="btn primary full" id="addDay" style="margin-top:16px">${ic('plus', 'sm')}Añadir gasto este día</button>`;
    bindExpenseClicks($('#dayList'), list);
    $('#addDay').onclick = () => expenseForm({}, { date: ds });
  };
  $('#cal').onclick = (ev) => {
    const c = ev.target.closest('.day[data-date]');
    if (!c) return;
    showDay(c.dataset.date);
    if (matchMedia('(max-width: 900px)').matches) $('#dayPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const go = (n) => { state.calMonth = monthKey(new Date(y, m + n, 1)); route(); };
  $('#prevM').onclick = () => go(-1);
  $('#nextM').onclick = () => go(1);
  $('#todayM').onclick = () => { state.calMonth = monthKey(todayD()); state.calSel = ymd(todayD()); route(); };
  showDay(state.calSel.startsWith(state.calMonth) ? state.calSel : ymd(first));
}

// ---------- Gastos mensuales ----------
async function renderRecurring(el) {
  const recs = await api('/recurring');
  updateDueBadge(recs);
  const active = recs.filter((r) => r.active);
  const fixed = active.reduce((a, r) => a + r.amount, 0);
  const paid = active.filter((r) => r.paidThisMonth).reduce((a, r) => a + r.amount, 0);
  el.innerHTML = `
  <div class="grid g3">
    <div class="card stat"><div class="top"><span class="label">Total fijo al mes</span><span class="ichip">${ic('repeat')}</span></div>
      <div><div class="value">${eur(fixed)}</div><div class="sub">${active.length} gasto${active.length === 1 ? '' : 's'} activo${active.length === 1 ? '' : 's'}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Pagado este mes</span><span class="ichip green">${ic('circle-check')}</span></div>
      <div><div class="value">${eur(paid)}</div><div class="progress" style="margin-top:10px"><div style="width:${fixed ? (paid / fixed) * 100 : 0}%"></div></div></div></div>
    <div class="card stat"><div class="top"><span class="label">Pendiente</span><span class="ichip amber">${ic('hourglass')}</span></div>
      <div><div class="value">${eur(fixed - paid)}</div><div class="sub">${ic('mail', 'xs')}Avisos a ${esc(me.email)}</div></div></div>
  </div>
  <div class="toolbar" style="justify-content:space-between">
    <div class="muted" style="font-size:14px">Te enviamos un correo antes de cada cobro.</div>
    <button class="btn primary" id="addRec">${ic('plus', 'sm')}Nuevo gasto mensual</button>
  </div>
  <div class="grid g3" id="recs">
    ${recs.map((r) => {
      const c = catOf(r.categoryId);
      const progress = Math.max(4, Math.min(100, 100 - (r.daysLeft / 30) * 100));
      return `<div class="card rec-card ${r.active ? '' : 'inactive'}">
        <div class="top">${catIc(c)}<div class="main"><b>${esc(r.name)}</b><small>${esc(c.name)} · día ${r.dayOfMonth}</small></div><div class="amount">${eur(r.amount)}</div></div>
        ${r.active ? `<div class="due-box">
          <div class="line"><span class="muted">Próximo cobro</span><b>${cap(fmtDate(r.nextDue, { weekday: 'short', day: 'numeric', month: 'short' }))}</b></div>
          <div class="progress thin"><div style="width:${progress}%"></div></div>
          <div class="line"><span class="badge ${r.daysLeft <= r.remindDaysBefore ? 'warn' : ''}">${ic('clock')}${daysTxt(r.daysLeft)}</span>
            ${r.paidThisMonth ? `<span class="badge ok">${ic('circle-check')}Pagado este mes</span>` : ''}</div>
        </div>` : `<div class="due-box"><div class="line"><span class="badge">${ic('pause')}En pausa</span></div></div>`}
        <div class="meta">
          <span class="badge">${ic('bell')}Aviso ${r.remindDaysBefore === 0 ? 'el mismo día' : `${r.remindDaysBefore} día${r.remindDaysBefore === 1 ? '' : 's'} antes`}</span>
          ${r.autoAdd ? `<span class="badge primary">${ic('zap')}Automático</span>` : ''}
          ${r.place ? `<span class="badge">${ic('store')}${esc(r.place)}</span>` : ''}
        </div>
        <div class="btns">
          ${r.paidThisMonth || !r.active ? `<button class="btn sm" data-edit="${r.id}">${ic('pencil', 'sm')}Editar</button>` : `<button class="btn sm primary" data-pay="${r.id}">${ic('check', 'sm')}Marcar pagado</button><button class="icon-btn sm" data-edit="${r.id}" title="Editar">${ic('pencil', 'sm')}</button>`}
          <button class="icon-btn sm danger" data-del="${r.id}" title="Eliminar">${ic('trash-2', 'sm')}</button>
        </div>
      </div>`;
    }).join('') || `<div class="card span2">${emptyHtml('repeat', 'Aún no tienes gastos mensuales', 'Añade tu alquiler, la luz, internet o tus suscripciones y recibirás un correo antes de cada cobro.', `<button class="btn primary sm" id="emptyRec">${ic('plus', 'sm')}Añadir el primero</button>`)}</div>`}
  </div>`;
  $('#addRec').onclick = () => recurringForm();
  $('#emptyRec')?.addEventListener('click', () => recurringForm());
  $('#recs').onclick = async (ev) => {
    const b = ev.target.closest('button[data-pay], button[data-edit], button[data-del]');
    if (!b) return;
    const r = recs.find((x) => x.id === (b.dataset.pay || b.dataset.edit || b.dataset.del));
    if (b.dataset.edit) recurringForm(r);
    if (b.dataset.del) confirmModal('Eliminar gasto mensual', `¿Eliminar <b>${esc(r.name)}</b>? Dejarás de recibir sus avisos. Los gastos ya registrados se mantienen.`, async () => {
      await api('/recurring/' + r.id, { method: 'DELETE' });
      toast('Gasto mensual eliminado');
      route();
    });
    if (b.dataset.pay) {
      try { await api(`/recurring/${r.id}/pay`, { method: 'POST' }); toast('Marcado como pagado'); route(); } catch (e) { toast(e.message, true); }
    }
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
    <div class="card stat"><div class="top"><span class="label">Gastos</span><span class="ichip green">${ic('receipt-text')}</span></div>
      <div><div class="value">${s.count}</div><div class="sub">En ${s.byCategory.length} categorías</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Media diaria</span><span class="ichip amber">${ic('activity')}</span></div>
      <div><div class="value">${eur(s.avgPerDay)}</div><div class="sub">${best ? `Más gasto el ${best.name.toLowerCase()}` : '—'}</div></div></div>
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
  const mail = await api('/mail/status');
  const pref = themePref();
  el.innerHTML = `
  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>${ic('user', 'sm')}Perfil</h3></div>
      <p class="set-desc">Tu nombre y la contraseña de acceso.</p>
      <form id="profileForm">
        <label class="field">Nombre<input name="name" value="${esc(me.name)}" required maxlength="60"></label>
        <label class="field">Correo vinculado<div class="input-icon">${ic('mail')}<input value="${esc(me.email)}" disabled></div></label>
        <label class="field">Nueva contraseña<div class="input-icon">${ic('lock')}<input name="newPassword" type="password" minlength="6" autocomplete="new-password" placeholder="Déjalo vacío para no cambiarla"></div></label>
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
      me = await api('/me', { method: 'PUT', body: { name: f.get('name'), newPassword: f.get('newPassword') || undefined } });
      setUser();
      ev.target.newPassword.value = '';
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

// ---------- Menú «Más» (móvil) ----------
function openMore() {
  const items = [
    ['calendario', 'calendar-days', 'Calendario'],
    ['semanal', 'calendar-range', 'Resumen semanal'],
    ['ajustes', 'settings', 'Ajustes'],
    ...(IS_ELECTRON ? [] : [['descargar', 'download', 'Descargar app']]),
  ];
  openModal({
    title: 'Más opciones',
    actions: false,
    html: `<div class="more-list">${items.map(([v, i, t]) => `<a href="#/${v}">${ic(i)}${t}</a>`).join('')}
      <button type="button" class="danger" id="moreLogout">${ic('log-out')}Cerrar sesión</button></div>`,
  });
  $$('.more-list a').forEach((a) => a.addEventListener('click', closeModal));
  $('#moreLogout').onclick = () => { closeModal(); logout(); };
}

// ---------- Router ----------
const VIEWS = {
  dashboard: ['Panel', () => `Hola, ${esc(me.name.split(' ')[0])} · ${todayD().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}`, renderDashboard],
  gastos: ['Gastos', () => 'Todo lo que has apuntado, día a día', renderExpenses],
  calendario: ['Calendario', () => 'Tus gastos y cobros en el mes', renderCalendar],
  mensuales: ['Gastos mensuales', () => 'Cobros fijos con aviso por correo', renderRecurring],
  semanal: ['Resumen semanal', () => 'Cómo ha ido tu semana', renderWeekly],
  ajustes: ['Ajustes', () => 'Perfil, avisos, apariencia y categorías', renderSettings],
  descargar: ['Descargar app', () => 'Úsala en el móvil y en el ordenador', renderDownload],
};
async function route() {
  if (!me) return;
  let [v, query] = location.hash.replace('#/', '').split('?');
  if (!VIEWS[v]) v = 'dashboard';
  if (query?.includes('nuevo=1')) {
    history.replaceState(null, '', '#/' + v);
    setTimeout(() => expenseForm(), 0);
  }
  const [title, subtitle, render] = VIEWS[v];
  $('#viewTitle').textContent = title;
  $('#viewSubtitle').innerHTML = subtitle();
  document.title = `${title} · Agenda de Gastos`;
  $$('#nav a, #tabbar [data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === v || (a.dataset.view === 'more' && ['calendario', 'semanal', 'ajustes', 'descargar'].includes(v))));
  charts.forEach((c) => c.destroy());
  charts = [];
  const view = $('#view');
  if (!view.children.length) view.innerHTML = '<div class="grid g3"><div class="skeleton span2" style="height:190px"></div><div class="skeleton" style="height:190px"></div></div><div class="skeleton" style="height:300px"></div>';
  try {
    await render(view);
    hydrate(view);
  } catch (e) {
    view.innerHTML = `<div class="card">${emptyHtml('triangle-alert', 'No se pudo cargar', esc(e.message), '<button class="btn sm" onclick="route()">Reintentar</button>')}</div>`;
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
}
function showAuth() {
  token = null;
  me = null;
  store.set(TOKEN_KEY, null);
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  showAuth();
}
async function enter() {
  [me, cats] = await Promise.all([api('/me'), api('/categories')]);
  setUser();
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#view').innerHTML = '';
  route();
  api('/recurring').then((recs) => { updateDueBadge(recs); notifyUpcoming(recs); }).catch(() => {});
}

let registering = false;
function setAuthMode(reg) {
  registering = reg;
  $$('.reg-only').forEach((e) => e.classList.toggle('hidden', !reg));
  $('#authTitle').textContent = reg ? 'Crea tu cuenta' : 'Bienvenido de nuevo';
  $('#authSubmit').textContent = reg ? 'Crear cuenta gratis' : 'Entrar';
  $('#authSubtitle').textContent = reg ? 'Tu cuenta quedará vinculada a tu correo para recibir los avisos.' : 'Inicia sesión para ver tus gastos';
  $('#authSwitchTxt').textContent = reg ? '¿Ya tienes cuenta?' : '¿No tienes cuenta?';
  $('#authToggle').textContent = reg ? 'Inicia sesión' : 'Regístrate gratis';
  $('#authForm').password.autocomplete = reg ? 'new-password' : 'current-password';
  $('#authError').textContent = '';
}
$('#authToggle').onclick = (e) => { e.preventDefault(); setAuthMode(!registering); };
$('#authForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  $('#authSubmit').disabled = true;
  try {
    const r = await api(registering ? '/auth/register' : '/auth/login', { method: 'POST', body });
    token = r.token;
    store.set(TOKEN_KEY, token);
    ev.target.reset();
    await enter();
  } catch (e) {
    $('#authError').textContent = e.message;
  } finally {
    $('#authSubmit').disabled = false;
  }
};
$('#logout').onclick = logout;
$('#btnAdd').onclick = () => expenseForm({}, location.hash.includes('calendario') ? { date: state.calSel } : {});
$('#fabAdd').onclick = () => (location.hash.includes('mensuales') ? recurringForm() : expenseForm({}, location.hash.includes('calendario') ? { date: state.calSel } : {}));
$('#moreBtn').onclick = openMore;
$('#themeBtn').onclick = () => { applyTheme(isDark() ? 'light' : 'dark'); route(); };

// ---------- Arranque ----------
hydrate();
applyTheme(themePref());
setAuthMode(false);
if (IS_ELECTRON) $$('.nav-download').forEach((e) => e.classList.add('hidden'));
fetch('/api/public-config').then((r) => r.json()).then((c) => { publicCfg = c; renderAuthInstall(); }).catch(() => {});
if ('serviceWorker' in navigator && !IS_ELECTRON) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (token) enter().catch(showAuth);
else showAuth();
