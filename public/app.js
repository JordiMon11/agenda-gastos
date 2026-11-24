/* Agenda de Gastos - frontend (compartido por la web y la app de escritorio) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const TOKEN_KEY = 'agenda_gastos_token';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch {}
let me = null;
let cats = [];
let charts = [];

// ---------- Utilidades ----------
const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
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
const monthName = (d) => d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
const dueInMonth = (day, y, m) => { const f = new Date(y, m, 1); return new Date(f.getFullYear(), f.getMonth(), Math.min(day, new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate())); };
const NO_CAT = { id: null, name: 'Sin categoría', color: '#94a3b8', icon: '📦' };
const catOf = (id) => cats.find((c) => c.id === id) || NO_CAT;
const daysTxt = (n) => (n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : `En ${n} días`);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (r.status === 401 && token && !path.startsWith('/auth')) { showAuth(); throw new Error('Sesión caducada'); }
  if (!r.ok) throw new Error(data?.error || 'Error de conexión');
  return data;
}

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function chart(canvas, config) {
  if (!window.Chart) return;
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--border');
  Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
  charts.push(new Chart(canvas, config));
}
const moneyTooltip = { callbacks: { label: (c) => ` ${c.label ? c.label + ': ' : ''}${eur(c.parsed.y ?? c.parsed)}` } };
const moneyAxis = { ticks: { callback: (v) => eur(v).replace(',00', '') }, beginAtZero: true };

// ---------- Modal genérico ----------
let modalSubmit = null;
function openModal(title, html, onSubmit, okText = 'Guardar') {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modalError').textContent = '';
  $('#modalOk').textContent = okText;
  modalSubmit = onSubmit;
  $('#modal').showModal();
  setTimeout(() => $('#modalBody input, #modalBody select')?.focus(), 30);
}
$('#modalCancel').onclick = () => $('#modal').close();
$('#modalForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const data = {};
  for (const el of ev.target.elements) {
    if (!el.name) continue;
    data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  $('#modalOk').disabled = true;
  try {
    await modalSubmit(data);
    $('#modal').close();
  } catch (e) {
    $('#modalError').textContent = e.message;
  } finally {
    $('#modalOk').disabled = false;
  }
};
function confirmModal(title, text, onOk) {
  openModal(title, `<p>${text}</p>`, onOk, 'Eliminar');
}

const catOptions = (sel) =>
  `<option value="">— Sin categoría —</option>` +
  cats.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('');

async function loadPlaces() {
  try {
    const places = await api('/places');
    $('#placesList').innerHTML = places.map((p) => `<option value="${esc(p)}">`).join('');
  } catch {}
}

// ---------- Formularios ----------
function expenseForm(exp = {}, preset = {}) {
  loadPlaces();
  openModal(
    exp.id ? 'Editar gasto' : 'Nuevo gasto',
    `<label>Concepto<input name="name" required maxlength="100" value="${esc(exp.name || '')}" placeholder="Ej: Compra semanal"></label>
     <div class="row">
       <label>Importe (€)<input name="amount" type="number" step="0.01" min="0.01" required value="${exp.amount ?? ''}" placeholder="0,00"></label>
       <label>Fecha<input name="date" type="date" required value="${exp.date || preset.date || ymd(todayD())}"></label>
     </div>
     <label>Categoría<select name="categoryId">${catOptions(exp.categoryId ?? preset.categoryId)}</select></label>
     <label>¿Dónde? (tienda, lugar, web…)<input name="place" list="placesList" maxlength="100" value="${esc(exp.place || '')}" placeholder="Ej: Mercadona"></label>
     <label>Notas<textarea name="notes" maxlength="500">${esc(exp.notes || '')}</textarea></label>`,
    async (d) => {
      d.amount = Number(d.amount);
      if (exp.id) await api('/expenses/' + exp.id, { method: 'PUT', body: d });
      else await api('/expenses', { method: 'POST', body: d });
      toast(exp.id ? 'Gasto actualizado' : 'Gasto añadido ✅');
      route();
    }
  );
}

function recurringForm(rec = {}) {
  loadPlaces();
  openModal(
    rec.id ? 'Editar gasto mensual' : 'Nuevo gasto mensual',
    `<label>Concepto<input name="name" required maxlength="100" value="${esc(rec.name || '')}" placeholder="Ej: Alquiler, Netflix, Gimnasio…"></label>
     <div class="row">
       <label>Importe (€)<input name="amount" type="number" step="0.01" min="0.01" required value="${rec.amount ?? ''}"></label>
       <label>Día de cobro (1-31)<input name="dayOfMonth" type="number" min="1" max="31" required value="${rec.dayOfMonth ?? 1}"></label>
     </div>
     <div class="row">
       <label>Categoría<select name="categoryId">${catOptions(rec.categoryId)}</select></label>
       <label>Avisar por correo (días antes)<input name="remindDaysBefore" type="number" min="0" max="30" required value="${rec.remindDaysBefore ?? 3}"></label>
     </div>
     <label>¿Dónde / quién cobra?<input name="place" list="placesList" maxlength="100" value="${esc(rec.place || '')}" placeholder="Ej: Banco, Netflix…"></label>
     <label class="check"><input type="checkbox" name="autoAdd" ${rec.autoAdd ?? true ? 'checked' : ''}> Añadirlo automáticamente a mis gastos el día del cobro</label>
     <label class="check"><input type="checkbox" name="active" ${rec.active ?? true ? 'checked' : ''}> Activo</label>`,
    async (d) => {
      d.amount = Number(d.amount);
      d.dayOfMonth = Number(d.dayOfMonth);
      d.remindDaysBefore = Number(d.remindDaysBefore);
      if (rec.id) await api('/recurring/' + rec.id, { method: 'PUT', body: d });
      else await api('/recurring', { method: 'POST', body: d });
      toast('Gasto mensual guardado 🔁');
      route();
    }
  );
}

function categoryForm(cat = {}) {
  openModal(
    cat.id ? 'Editar categoría' : 'Nueva categoría',
    `<div class="row">
       <label style="flex:0 0 80px">Icono<input name="icon" maxlength="4" value="${esc(cat.icon || '📦')}" style="text-align:center;font-size:20px"></label>
       <label>Nombre<input name="name" required maxlength="40" value="${esc(cat.name || '')}"></label>
       <label style="flex:0 0 80px">Color<input name="color" type="color" value="${cat.color || '#6366f1'}"></label>
     </div>`,
    async (d) => {
      if (cat.id) await api('/categories/' + cat.id, { method: 'PUT', body: d });
      else await api('/categories', { method: 'POST', body: d });
      cats = await api('/categories');
      toast('Categoría guardada');
      route();
    }
  );
}

function deleteExpense(e) {
  confirmModal('Eliminar gasto', `¿Seguro que quieres eliminar <b>${esc(e.name)}</b> (${eur(e.amount)})?`, async () => {
    await api('/expenses/' + e.id, { method: 'DELETE' });
    toast('Gasto eliminado');
    route();
  });
}

const expenseItem = (e) => {
  const c = catOf(e.categoryId);
  return `<div class="item" data-id="${e.id}">
    <div class="ic" style="background:${c.color}22">${esc(c.icon)}</div>
    <div class="main"><b>${esc(e.name)}</b><small>${fmtDate(e.date)} · ${esc(c.name)}${e.place ? ' · 📍 ' + esc(e.place) : ''}</small></div>
    <div class="amt">${eur(e.amount)}</div>
  </div>`;
};
function bindExpenseClicks(root, list) {
  $$('.item[data-id]', root).forEach((el) => (el.style.cursor = 'pointer'));
  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('.item[data-id]');
    const e = el && list.find((x) => x.id === el.dataset.id);
    if (e) expenseForm(e);
  });
}

// ---------- Avisos de escritorio ----------
function notifyUpcoming(recs) {
  if (!('Notification' in window)) return;
  const due = recs.filter((r) => r.active && !r.paidThisMonth && r.daysLeft <= r.remindDaysBefore);
  if (!due.length) return;
  const go = () => {
    for (const r of due) {
      const key = `notified_${r.id}_${r.nextDue}`;
      try { if (sessionStorage.getItem(key)) continue; sessionStorage.setItem(key, '1'); } catch {}
      new Notification(`🔔 ${r.name} - ${eur(r.amount)}`, { body: `${daysTxt(r.daysLeft)} (${fmtDate(r.nextDue, { day: 'numeric', month: 'long' })})` });
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
  const mk = monthKey(t);
  const prevMk = monthKey(new Date(t.getFullYear(), t.getMonth() - 1, 1));
  const monthExp = exps.filter((e) => e.date.startsWith(mk));
  const monthTotal = sum(monthExp);
  const prevTotal = sum(exps.filter((e) => e.date.startsWith(prevMk)));
  const ws = weekStart(t);
  const weekTotal = sum(exps.filter((e) => e.date >= ymd(ws) && e.date <= ymd(addDays(ws, 6))));
  const active = recs.filter((r) => r.active);
  const fixed = active.reduce((a, r) => a + r.amount, 0);
  const next = active.filter((r) => !r.paidThisMonth || r.daysLeft >= 0).sort((a, b) => a.daysLeft - b.daysLeft)[0];
  const diff = prevTotal ? ((monthTotal - prevTotal) / prevTotal) * 100 : null;

  // Agrupaciones
  const byCat = {};
  for (const e of monthExp) byCat[e.categoryId || ''] = (byCat[e.categoryId || ''] || 0) + e.amount;
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const months = [...Array(6)].map((_, i) => new Date(t.getFullYear(), t.getMonth() - 5 + i, 1));
  const byPlace = {};
  for (const e of monthExp) if (e.place) byPlace[e.place] = (byPlace[e.place] || 0) + e.amount;
  const places = Object.entries(byPlace).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();

  el.innerHTML = `
  <div class="grid g4">
    <div class="card kpi"><div class="label">Gastado este mes</div><div class="value">${eur(monthTotal)}</div>
      <div class="sub">${diff === null ? 'Sin datos del mes anterior' : `<span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(0)}%</span> vs. mes anterior`}</div></div>
    <div class="card kpi"><div class="label">Esta semana</div><div class="value">${eur(weekTotal)}</div><div class="sub">desde el lunes ${fmtDate(ymd(ws))}</div></div>
    <div class="card kpi"><div class="label">Media diaria (mes)</div><div class="value">${eur(monthTotal / t.getDate())}</div><div class="sub">${monthExp.length} gastos registrados</div></div>
    <div class="card kpi"><div class="label">Gastos fijos mensuales</div><div class="value">${eur(fixed)}</div>
      <div class="sub">${next ? `Próximo: <b>${esc(next.name)}</b> · ${daysTxt(next.daysLeft).toLowerCase()}` : 'Ninguno configurado'}</div></div>
  </div>
  <div class="grid g3">
    <div class="card"><h3>Por categoría · ${monthName(t)}</h3><div class="chart-box"><canvas id="cCat"></canvas></div></div>
    <div class="card span2"><h3>Gasto por día · ${monthName(t)}</h3><div class="chart-box"><canvas id="cDays"></canvas></div></div>
  </div>
  <div class="grid g3">
    <div class="card span2"><h3>Últimos 6 meses</h3><div class="chart-box sm"><canvas id="cMonths"></canvas></div></div>
    <div class="card"><h3>📍 Dónde más gastas (mes)</h3><div class="list">
      ${places.length ? places.map(([p, v]) => `<div class="item"><div class="main"><b>${esc(p)}</b>
        <div class="progress"><div style="width:${(v / places[0][1]) * 100}%"></div></div></div><div class="amt">${eur(v)}</div></div>`).join('') : '<div class="empty">Añade el lugar en tus gastos para verlo aquí</div>'}
    </div></div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>Últimos gastos <a href="#/gastos" class="btn small">Ver todos</a></h3><div class="list" id="recent">
      ${exps.slice(0, 7).map(expenseItem).join('') || '<div class="empty">Aún no tienes gastos. ¡Añade el primero!</div>'}</div></div>
    <div class="card"><h3>🔔 Próximos gastos mensuales <a href="#/mensuales" class="btn small">Gestionar</a></h3><div class="list">
      ${active.slice(0, 7).map((r) => { const c = catOf(r.categoryId); return `<div class="item">
        <div class="ic" style="background:${c.color}22">${esc(c.icon)}</div>
        <div class="main"><b>${esc(r.name)}</b><small>${fmtDate(r.nextDue, { weekday: 'short', day: 'numeric', month: 'short' })}</small></div>
        <span class="badge ${r.daysLeft <= r.remindDaysBefore ? 'warn' : 'soft'}">${daysTxt(r.daysLeft)}</span>
        <div class="amt">${eur(r.amount)}</div></div>`; }).join('') || '<div class="empty">Configura tus gastos mensuales (alquiler, suscripciones…) y te avisaremos por correo antes de que lleguen.</div>'}
    </div></div>
  </div>`;

  bindExpenseClicks($('#recent'), exps);
  chart($('#cCat'), {
    type: 'doughnut',
    data: { labels: catEntries.map(([id]) => `${catOf(id || null).icon} ${catOf(id || null).name}`), datasets: [{ data: catEntries.map((x) => x[1]), backgroundColor: catEntries.map(([id]) => catOf(id || null).color), borderWidth: 0 }] },
    options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: moneyTooltip } },
  });
  chart($('#cDays'), {
    type: 'bar',
    data: {
      labels: [...Array(dim)].map((_, i) => i + 1),
      datasets: [{ label: 'Gasto', data: [...Array(dim)].map((_, i) => sum(monthExp.filter((e) => e.date === `${mk}-${pad(i + 1)}`))), backgroundColor: cssVar('--primary'), borderRadius: 4 }],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: moneyTooltip }, scales: { y: moneyAxis, x: { grid: { display: false } } } },
  });
  chart($('#cMonths'), {
    type: 'line',
    data: {
      labels: months.map((d) => d.toLocaleDateString('es-ES', { month: 'short' })),
      datasets: [{ label: 'Total', data: months.map((d) => sum(exps.filter((e) => e.date.startsWith(monthKey(d))))), borderColor: cssVar('--primary-2'), backgroundColor: cssVar('--primary-2') + '33', fill: true, tension: 0.35, pointRadius: 4 }],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: moneyTooltip }, scales: { y: moneyAxis, x: { grid: { display: false } } } },
  });
  notifyUpcoming(recs);
}

// ---------- Gastos ----------
async function renderExpenses(el) {
  el.innerHTML = `
  <div class="card">
    <div class="filters">
      <label>Mes<input type="month" id="fMonth" value="${state.month}"></label>
      <label>Categoría<select id="fCat"><option value="">Todas</option><option value="none">Sin categoría</option>
        ${cats.map((c) => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></label>
      <label>Buscar<input type="search" id="fQ" placeholder="Concepto, lugar, notas…" value="${esc(state.q)}"></label>
      <div style="flex:1"></div>
      <button class="btn" id="btnCsv">⬇ Exportar CSV</button>
    </div>
    <div class="table-wrap" id="tbl"></div>
  </div>`;
  $('#fCat').value = state.cat;
  let list = [];
  const load = async () => {
    const [y, m] = (state.month || monthKey(todayD())).split('-').map(Number);
    const qs = new URLSearchParams({ from: `${y}-${pad(m)}-01`, to: ymd(new Date(y, m, 0)) });
    if (state.cat) qs.set('category', state.cat);
    if (state.q) qs.set('q', state.q);
    list = await api('/expenses?' + qs);
    $('#tbl').innerHTML = list.length
      ? `<table><thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Dónde</th><th class="num">Importe</th><th></th></tr></thead>
        <tbody>${list.map((e) => { const c = catOf(e.categoryId); return `<tr>
          <td>${fmtDate(e.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
          <td><b>${esc(e.name)}</b>${e.recurringId ? ' <span class="badge soft">🔁 mensual</span>' : ''}${e.notes ? `<br><small class="muted">${esc(e.notes)}</small>` : ''}</td>
          <td><span class="badge" style="background:${c.color}22;color:${c.color}">${esc(c.icon)} ${esc(c.name)}</span></td>
          <td>${esc(e.place) || '<span class="muted">—</span>'}</td>
          <td class="num"><b>${eur(e.amount)}</b></td>
          <td class="actions"><button class="icon-btn" data-edit="${e.id}" title="Editar">✏️</button><button class="icon-btn" data-del="${e.id}" title="Eliminar">🗑️</button></td>
        </tr>`; }).join('')}</tbody>
        <tfoot><tr><td colspan="4">Total (${list.length} gastos)</td><td class="num">${eur(sum(list))}</td><td></td></tr></tfoot></table>`
      : '<div class="empty">No hay gastos con estos filtros.</div>';
  };
  $('#tbl').onclick = (ev) => {
    const ed = ev.target.closest('[data-edit]');
    const de = ev.target.closest('[data-del]');
    if (ed) expenseForm(list.find((e) => e.id === ed.dataset.edit));
    if (de) deleteExpense(list.find((e) => e.id === de.dataset.del));
  };
  $('#fMonth').onchange = (e) => { state.month = e.target.value; load(); };
  $('#fCat').onchange = (e) => { state.cat = e.target.value; load(); };
  let qt;
  $('#fQ').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value; load(); }, 250); };
  $('#btnCsv').onclick = () => {
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
      ${tot ? `<div class="heat" style="opacity:${0.05 + (tot / max) * 0.25}"></div>` : ''}
      <span class="n">${d}</span>
      ${tot ? `<span class="t">${eur(tot)}</span>` : ''}
      <div class="dots">${list.slice(0, 6).map((e) => `<i style="background:${catOf(e.categoryId).color}"></i>`).join('')}</div>
      ${(dues[ds] || []).map((r) => `<span class="due" title="${esc(r.name)} ${eur(r.amount)}">🔔 ${esc(r.name)}</span>`).join('')}
    </div>`;
  }

  el.innerHTML = `
  <div class="grid g3">
    <div class="card span2">
      <div class="cal-head">
        <button class="btn small" id="prevM">◀</button><h2>${monthName(base)}</h2>
        <button class="btn small" id="todayM">Hoy</button><button class="btn small" id="nextM">▶</button>
      </div>
      <div class="cal" id="cal">${cells}</div>
      <p class="muted" style="font-size:13px;margin:12px 0 0">Total del mes: <b>${eur(sum(exps))}</b> · 🔔 = gasto mensual que llega ese día</p>
    </div>
    <div class="card" id="dayPanel"></div>
  </div>`;

  const showDay = (ds) => {
    state.calSel = ds;
    $$('.cal .day').forEach((c) => c.classList.toggle('sel', c.dataset.date === ds));
    const list = byDay[ds] || [];
    const due = dues[ds] || [];
    $('#dayPanel').innerHTML = `<h3 style="text-transform:capitalize">${fmtDate(ds, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
      <div class="kpi"><div class="value">${eur(sum(list))}</div><div class="sub">${list.length} gasto(s)</div></div>
      ${due.length ? `<div style="margin:12px 0">${due.map((r) => `<div class="badge warn" style="margin:2px 0">🔔 ${esc(r.name)} · ${eur(r.amount)}</div>`).join(' ')}</div>` : ''}
      <div class="list" id="dayList">${list.map(expenseItem).join('') || '<div class="empty">Sin gastos este día</div>'}</div>
      <button class="btn primary full" id="addDay" style="margin-top:12px">＋ Añadir gasto este día</button>`;
    bindExpenseClicks($('#dayList'), list);
    $('#addDay').onclick = () => expenseForm({}, { date: ds });
  };
  $('#cal').onclick = (ev) => { const c = ev.target.closest('.day[data-date]'); if (c) showDay(c.dataset.date); };
  const go = (n) => { state.calMonth = monthKey(new Date(y, m + n, 1)); route(); };
  $('#prevM').onclick = () => go(-1);
  $('#nextM').onclick = () => go(1);
  $('#todayM').onclick = () => { state.calMonth = monthKey(todayD()); state.calSel = ymd(todayD()); route(); };
  showDay(state.calSel.startsWith(state.calMonth) ? state.calSel : ymd(first));
}

// ---------- Gastos mensuales ----------
async function renderRecurring(el) {
  const recs = await api('/recurring');
  const active = recs.filter((r) => r.active);
  const fixed = active.reduce((a, r) => a + r.amount, 0);
  const paid = active.filter((r) => r.paidThisMonth).reduce((a, r) => a + r.amount, 0);
  el.innerHTML = `
  <div class="grid g3">
    <div class="card kpi"><div class="label">Total fijo al mes</div><div class="value">${eur(fixed)}</div><div class="sub">${active.length} gastos mensuales activos</div></div>
    <div class="card kpi"><div class="label">Ya pagado este mes</div><div class="value">${eur(paid)}</div>
      <div class="progress" style="margin-top:8px"><div style="width:${fixed ? (paid / fixed) * 100 : 0}%"></div></div></div>
    <div class="card kpi"><div class="label">Pendiente este mes</div><div class="value">${eur(fixed - paid)}</div><div class="sub">Te avisamos por correo a <b>${esc(me.email)}</b></div></div>
  </div>
  <div style="display:flex;justify-content:flex-end;margin-bottom:14px"><button class="btn primary" id="addRec">＋ Nuevo gasto mensual</button></div>
  <div class="grid g3" id="recs">
    ${recs.map((r) => { const c = catOf(r.categoryId); return `<div class="card rec-card ${r.active ? '' : 'inactive'}">
      <div class="top"><div class="item" style="padding:0;border:0;flex:1;min-width:0"><div class="ic" style="background:${c.color}22">${esc(c.icon)}</div>
        <div class="main"><b>${esc(r.name)}</b><small>${esc(c.name)}${r.place ? ' · 📍 ' + esc(r.place) : ''}</small></div></div>
        <div class="amount">${eur(r.amount)}</div></div>
      <div class="meta">
        <span class="badge soft">📅 Día ${r.dayOfMonth} de cada mes</span>
        ${r.active ? `<span class="badge ${r.daysLeft <= r.remindDaysBefore ? 'warn' : 'soft'}">⏳ ${daysTxt(r.daysLeft)} · ${fmtDate(r.nextDue)}</span>` : '<span class="badge soft">⏸ Pausado</span>'}
        <span class="badge soft">✉️ Aviso ${r.remindDaysBefore} día(s) antes</span>
        ${r.autoAdd ? '<span class="badge soft">⚡ Registro automático</span>' : ''}
        ${r.paidThisMonth ? '<span class="badge ok">✔ Pagado este mes</span>' : ''}
      </div>
      <div class="btns">
        ${r.paidThisMonth || !r.active ? '' : `<button class="btn small" data-pay="${r.id}">✔ Marcar pagado</button>`}
        <button class="btn small" data-edit="${r.id}">✏️ Editar</button>
        <button class="btn small danger" data-del="${r.id}">🗑️</button>
      </div>
    </div>`; }).join('') || '<div class="card empty span2">Aún no tienes gastos mensuales. Añade tu alquiler, luz, internet, suscripciones… y recibirás un correo antes de cada cobro.</div>'}
  </div>`;
  $('#addRec').onclick = () => recurringForm();
  $('#recs').onclick = async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const r = recs.find((x) => x.id === (b.dataset.pay || b.dataset.edit || b.dataset.del));
    if (b.dataset.edit) recurringForm(r);
    if (b.dataset.del) confirmModal('Eliminar gasto mensual', `¿Eliminar <b>${esc(r.name)}</b>? Dejarás de recibir sus avisos. Los gastos ya registrados se mantienen.`, async () => {
      await api('/recurring/' + r.id, { method: 'DELETE' });
      toast('Gasto mensual eliminado');
      route();
    });
    if (b.dataset.pay) {
      try { await api(`/recurring/${r.id}/pay`, { method: 'POST' }); toast('Marcado como pagado y añadido a tus gastos'); route(); }
      catch (e) { toast(e.message); }
    }
  };
}

// ---------- Resumen semanal ----------
async function renderWeekly(el) {
  const s = await api('/summary/week?date=' + state.week);
  const diff = s.prevTotal ? ((s.total - s.prevTotal) / s.prevTotal) * 100 : null;
  const isCurrent = s.from === ymd(weekStart(todayD()));
  el.innerHTML = `
  <div class="card" style="margin-bottom:16px">
    <div class="cal-head" style="margin:0">
      <button class="btn small" id="prevW">◀</button>
      <h2>Semana del ${fmtDate(s.from, { day: 'numeric', month: 'long' })} al ${fmtDate(s.to, { day: 'numeric', month: 'long', year: 'numeric' })} ${isCurrent ? '<span class="badge ok">Actual</span>' : ''}</h2>
      <button class="btn small" id="nextW">▶</button>
      <button class="btn primary small" id="mailW">✉️ Enviármelo por correo</button>
    </div>
  </div>
  <div class="grid g4">
    <div class="card kpi"><div class="label">Total semana</div><div class="value">${eur(s.total)}</div>
      <div class="sub">${diff === null ? 'Sin datos de la semana anterior' : `<span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(0)}%</span> vs. anterior (${eur(s.prevTotal)})`}</div></div>
    <div class="card kpi"><div class="label">Nº de gastos</div><div class="value">${s.count}</div><div class="sub">en ${s.byCategory.length} categorías</div></div>
    <div class="card kpi"><div class="label">Media diaria</div><div class="value">${eur(s.avgPerDay)}</div><div class="sub">Día con más gasto: ${s.total ? s.byDay.reduce((a, b) => (b.total > a.total ? b : a)).name : '—'}</div></div>
    <div class="card kpi"><div class="label">Mayor gasto</div><div class="value">${s.top ? eur(s.top.amount) : '—'}</div><div class="sub">${s.top ? esc(s.top.name) : 'Sin gastos'}</div></div>
  </div>
  <div class="grid g3">
    <div class="card span2"><h3>Gasto por día</h3><div class="chart-box"><canvas id="cWDays"></canvas></div></div>
    <div class="card"><h3>Por categoría</h3><div class="chart-box"><canvas id="cWCat"></canvas></div></div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>Desglose por categoría</h3><div class="list">
      ${s.byCategory.map((c) => `<div class="item"><div class="ic" style="background:${c.color}22">${esc(c.icon)}</div>
        <div class="main"><b>${esc(c.name)}</b><div class="progress"><div style="width:${(c.total / s.total) * 100}%;background:${c.color}"></div></div></div>
        <div class="amt">${eur(c.total)} <small class="muted">${((c.total / s.total) * 100).toFixed(0)}%</small></div></div>`).join('') || '<div class="empty">Sin gastos esta semana 🎉</div>'}
    </div>
    ${s.byPlace.length ? `<h3 style="margin-top:18px">📍 Dónde gastaste</h3><div class="list">${s.byPlace.map((p) => `<div class="item"><div class="main"><b>${esc(p.place)}</b></div><div class="amt">${eur(p.total)}</div></div>`).join('')}</div>` : ''}
    </div>
    <div class="card"><h3>Todos los gastos de la semana</h3><div class="list" id="wList">${s.expenses.map(expenseItem).join('') || '<div class="empty">Nada por aquí</div>'}</div></div>
  </div>`;
  bindExpenseClicks($('#wList'), s.expenses);
  const go = (n) => { state.week = ymd(addDays(parse(s.from), n * 7)); route(); };
  $('#prevW').onclick = () => go(-1);
  $('#nextW').onclick = () => go(1);
  $('#mailW').onclick = async () => {
    try {
      const r = await api('/summary/week/email', { method: 'POST', body: { date: s.from } });
      toast(r.simulated ? 'Correo guardado en data/outbox (configura SMTP para enviarlo de verdad)' : `Resumen enviado a ${me.email} ✉️`);
    } catch (e) { toast(e.message); }
  };
  chart($('#cWDays'), {
    type: 'bar',
    data: { labels: s.byDay.map((d) => d.name.slice(0, 3)), datasets: [{ data: s.byDay.map((d) => d.total), backgroundColor: cssVar('--primary'), borderRadius: 6 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: moneyTooltip }, scales: { y: moneyAxis, x: { grid: { display: false } } } },
  });
  chart($('#cWCat'), {
    type: 'doughnut',
    data: { labels: s.byCategory.map((c) => `${c.icon} ${c.name}`), datasets: [{ data: s.byCategory.map((c) => c.total), backgroundColor: s.byCategory.map((c) => c.color), borderWidth: 0 }] },
    options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: moneyTooltip } },
  });
}

// ---------- Ajustes ----------
async function renderSettings(el) {
  const mail = await api('/mail/status');
  el.innerHTML = `
  <div class="grid g2">
    <div class="card">
      <h3>👤 Perfil</h3>
      <form id="profileForm">
        <label>Nombre<input name="name" value="${esc(me.name)}" required maxlength="60"></label>
        <label>Correo vinculado<input value="${esc(me.email)}" disabled></label>
        <label>Nueva contraseña (opcional)<input name="newPassword" type="password" minlength="6" autocomplete="new-password"></label>
        <button class="btn primary">Guardar perfil</button>
      </form>
    </div>
    <div class="card">
      <h3>✉️ Correo y avisos</h3>
      <label class="check"><input type="checkbox" id="nRem" ${me.notify?.reminders ? 'checked' : ''}> Avisarme por correo antes de cada gasto mensual</label>
      <label class="check"><input type="checkbox" id="nWeek" ${me.notify?.weekly ? 'checked' : ''}> Enviarme el resumen semanal cada lunes</label>
      <div class="info" style="margin:10px 0 14px">
        ${mail.configured
          ? `✅ El servidor de correo está configurado. Los avisos llegarán a <b>${esc(mail.to)}</b>.`
          : `⚠️ El envío de correos aún no está configurado en el servidor, así que por ahora los avisos no salen.
             Quien administra la app debe añadir <code>BREVO_API_KEY</code> y <code>MAIL_FROM_EMAIL</code> (o los datos SMTP) en la configuración del servidor.`}
      </div>
      <button class="btn" id="testMail">Enviar correo de prueba</button>
    </div>
  </div>
  <div class="card">
    <h3>🏷️ Categorías <button class="btn small primary" id="addCat">＋ Nueva</button></h3>
    <div id="catList">${cats.map((c) => `<div class="cat-row"><span class="sw" style="background:${c.color}"></span><span>${esc(c.icon)}</span>
      <span class="name">${esc(c.name)}</span><button class="icon-btn" data-edit="${c.id}">✏️</button><button class="icon-btn" data-del="${c.id}">🗑️</button></div>`).join('')}</div>
  </div>`;
  $('#profileForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      me = await api('/me', { method: 'PUT', body: { name: f.get('name'), newPassword: f.get('newPassword') || undefined } });
      setUser();
      toast('Perfil guardado');
      ev.target.newPassword.value = '';
    } catch (e) { toast(e.message); }
  };
  const saveNotify = async () => {
    me = await api('/me', { method: 'PUT', body: { notify: { reminders: $('#nRem').checked, weekly: $('#nWeek').checked } } });
    toast('Preferencias guardadas');
  };
  $('#nRem').onchange = saveNotify;
  $('#nWeek').onchange = saveNotify;
  $('#testMail').onclick = async () => {
    try {
      const r = await api('/mail/test', { method: 'POST' });
      toast(r.simulated ? 'Correo guardado en data/outbox (SMTP sin configurar)' : `Correo de prueba enviado a ${me.email} ✅`);
    } catch (e) { toast('Error enviando: ' + e.message); }
  };
  $('#addCat').onclick = () => categoryForm();
  $('#catList').onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const c = cats.find((x) => x.id === (b.dataset.edit || b.dataset.del));
    if (b.dataset.edit) categoryForm(c);
    if (b.dataset.del) confirmModal('Eliminar categoría', `¿Eliminar <b>${esc(c.icon)} ${esc(c.name)}</b>? Sus gastos quedarán como "Sin categoría".`, async () => {
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
  if (location.hash === '#/descargar') route();
});
window.addEventListener('appinstalled', () => { installPrompt = null; toast('App instalada 🎉'); });
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
    installPrompt ? `<button type="button" class="btn small" id="authInstallBtn">📲 Instalar la app</button>` : '',
    publicCfg.downloadUrl ? `<a class="btn small" href="${esc(publicCfg.downloadUrl)}">💻 Descargar para Windows</a>` : '',
    IS_IOS ? `<small class="muted">En iPhone: botón Compartir ⬆️ → «Añadir a pantalla de inicio»</small>` : '',
  ].join('');
  $('#authInstallBtn')?.addEventListener('click', doInstall);
}

async function renderDownload(el) {
  el.innerHTML = `
  <div class="grid g3">
    <div class="card dl-card">
      <div class="dl-ic">📱</div><h3>Móvil (Android)</h3>
      <p class="muted">Se instala como una app normal, con su icono, desde el navegador. Sin tiendas y gratis.</p>
      ${IS_STANDALONE ? '<span class="badge ok">✔ Ya la estás usando como app</span>'
        : installPrompt ? '<button class="btn primary" id="dlInstall">📲 Instalar ahora</button>'
        : '<ol class="steps"><li>Abre esta web en <b>Chrome</b> desde el móvil.</li><li>Toca el menú <b>⋮</b>.</li><li>Elige <b>«Instalar aplicación»</b> o «Añadir a pantalla de inicio».</li></ol>'}
    </div>
    <div class="card dl-card">
      <div class="dl-ic">🍏</div><h3>iPhone / iPad</h3>
      <p class="muted">Funciona como app a pantalla completa y con su propio icono.</p>
      <ol class="steps"><li>Abre esta web en <b>Safari</b>.</li><li>Toca <b>Compartir</b> ⬆️.</li><li>Elige <b>«Añadir a pantalla de inicio»</b>.</li></ol>
    </div>
    <div class="card dl-card">
      <div class="dl-ic">💻</div><h3>Ordenador</h3>
      <p class="muted">App de escritorio para Windows, conectada a tu misma cuenta.</p>
      ${IS_ELECTRON ? '<span class="badge ok">✔ Ya la estás usando</span>'
        : publicCfg.downloadUrl ? `<a class="btn primary" href="${esc(publicCfg.downloadUrl)}">⬇ Descargar para Windows</a>
          <small class="muted">Si Windows muestra «Windows protegió su PC», pulsa <b>Más información → Ejecutar de todas formas</b>: la app no está firmada (eso cuesta dinero), pero es segura.</small>`
        : '<span class="badge soft">Descarga aún no publicada</span>'}
      ${publicCfg.releasesUrl && !IS_ELECTRON ? `<a href="${esc(publicCfg.releasesUrl)}" target="_blank" rel="noopener"><small>Ver todas las versiones</small></a>` : ''}
      ${!IS_ELECTRON && installPrompt ? '<button class="btn" id="dlInstall2">O instalarla desde el navegador</button>' : ''}
    </div>
  </div>
  <div class="card info">🔗 Todas las versiones usan la <b>misma cuenta y los mismos datos</b>: lo que apuntes en el móvil aparece al momento en el ordenador y en la web.</div>`;
  $('#dlInstall')?.addEventListener('click', doInstall);
  $('#dlInstall2')?.addEventListener('click', doInstall);
}

// ---------- Router ----------
const VIEWS = {
  descargar: ['Descargar app', renderDownload],
  dashboard: ['Panel', renderDashboard],
  gastos: ['Gastos', renderExpenses],
  calendario: ['Calendario', renderCalendar],
  mensuales: ['Gastos mensuales', renderRecurring],
  semanal: ['Resumen semanal', renderWeekly],
  ajustes: ['Ajustes', renderSettings],
};
async function route() {
  if (!me) return;
  let [v, query] = location.hash.replace('#/', '').split('?');
  if (!VIEWS[v]) v = 'dashboard';
  if (query?.includes('nuevo=1')) {
    history.replaceState(null, '', '#/' + v);
    setTimeout(() => expenseForm(), 0);
  }
  const [title, render] = VIEWS[v];
  $('#viewTitle').textContent = title;
  document.title = `${title} · Agenda de Gastos`;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  charts.forEach((c) => c.destroy());
  charts = [];
  const view = $('#view');
  if (!view.children.length) view.innerHTML = '<div class="loading">Cargando…</div>';
  try {
    await render(view);
  } catch (e) {
    view.innerHTML = `<div class="card empty">⚠️ ${esc(e.message)}<br><br><button class="btn" onclick="route()">Reintentar</button></div>`;
  }
}
window.addEventListener('hashchange', () => { $('#view').innerHTML = ''; route(); });

// ---------- Sesión ----------
function setUser() {
  $('#userName').textContent = me.name;
  $('#userEmail').textContent = me.email;
  $('#avatar').textContent = me.name.trim()[0]?.toUpperCase() || '?';
}
function showAuth() {
  token = null;
  me = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}
async function enter() {
  [me, cats] = await Promise.all([api('/me'), api('/categories')]);
  setUser();
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#view').innerHTML = '';
  route();
}

let registering = false;
function setAuthMode(reg) {
  registering = reg;
  $$('.reg-only').forEach((e) => e.classList.toggle('hidden', !reg));
  $('#authSubmit').textContent = reg ? 'Crear cuenta' : 'Entrar';
  $('#authSubtitle').textContent = reg ? 'Crea tu cuenta vinculada a tu correo' : 'Inicia sesión para ver tus gastos';
  $('#authToggle').textContent = reg ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Regístrate';
  $('#authForm').password.autocomplete = reg ? 'new-password' : 'current-password';
  $('#authError').textContent = '';
}
$('#authToggle').onclick = (e) => { e.preventDefault(); setAuthMode(!registering); };
$('#authForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const body = Object.fromEntries(f);
  $('#authSubmit').disabled = true;
  try {
    const r = await api(registering ? '/auth/register' : '/auth/login', { method: 'POST', body });
    token = r.token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
    ev.target.reset();
    await enter();
  } catch (e) {
    $('#authError').textContent = e.message;
  } finally {
    $('#authSubmit').disabled = false;
  }
};
$('#logout').onclick = async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  showAuth();
};
$('#btnAdd').onclick = () => expenseForm({}, location.hash.includes('calendario') ? { date: state.calSel } : {});

setAuthMode(false);
if (IS_ELECTRON) $('#navDownload').classList.add('hidden');
fetch('/api/public-config').then((r) => r.json()).then((c) => { publicCfg = c; renderAuthInstall(); }).catch(() => {});
if ('serviceWorker' in navigator && !IS_ELECTRON) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (token) enter().catch(showAuth);
else showAuth();
