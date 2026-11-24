/* Agenda de Gastos · cuentas, presupuestos, previsiones, asistente, informes, tickets, avisos y bienvenida */

// ---------- Cuentas (caché para los formularios) ----------
let accs = [];
const ACC_TYPES = {
  corriente: ['Cuenta corriente', 'landmark'], ahorro: ['Cuenta de ahorro', 'piggy-bank'], efectivo: ['Efectivo', 'banknote'],
  credito: ['Tarjeta de crédito', 'credit-card'], debito: ['Tarjeta de débito', 'wallet-cards'], otra: ['Otra', 'wallet'],
};
const PAY_METHODS = { tarjeta: 'Tarjeta', efectivo: 'Efectivo', bizum: 'Bizum', transferencia: 'Transferencia', domiciliacion: 'Domiciliación', otro: 'Otro' };
async function loadAccounts() {
  try { accs = await api('/accounts'); } catch { accs = []; }
  return accs;
}
const accOf = (id) => accs.find((a) => a.id === id);
const accIc = (a, cls = '') => `<span class="cat-ic ${cls}" style="--c:${safeColor(a.color || '#1e3a8a')}">${ic((ACC_TYPES[a.type] || ACC_TYPES.otra)[1])}</span>`;
function accountSelect(selected = '', { name = 'accountId', label = 'Cuenta', none = 'Cuenta principal' } = {}) {
  if (!accs.length) return '';
  return `<label class="field">${label}<select name="${name}"><option value="">${none}</option>${accs.map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>`;
}
const signed = (n) => `<span class="${n < 0 ? 'neg' : n > 0 ? 'pos' : ''}">${n > 0 ? '+' : ''}${eur(n)}</span>`;
const bal = (n) => (n < 0 ? `<span class="neg">${eur(n)}</span>` : eur(n));
const LEVEL_COLOR = { ok: 'var(--success)', watch: 'var(--primary-2)', caution: 'var(--warn)', alert: '#ea580c', over: 'var(--danger)' };
const bar = (p, level) => `<div class="progress"><div style="width:${Math.min(100, Math.max(2, p))}%;background:${LEVEL_COLOR[level] || 'var(--primary)'}"></div></div>`;
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
const getQuery = () => new URLSearchParams(location.hash.split('?')[1] || '');

// ================= CUENTAS =================
function accountForm(a = {}) {
  openModal({
    title: a.id ? 'Editar cuenta' : 'Nueva cuenta',
    icon: 'landmark',
    html: `
      <label class="field">Nombre<input name="name" required maxlength="60" value="${esc(a.name || '')}" placeholder="Ej: Cuenta nómina, Tarjeta, Efectivo"></label>
      <label class="field">Tipo<select name="type">${Object.entries(ACC_TYPES).map(([k, [l]]) => `<option value="${k}" ${a.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="row">
        <label class="field">Saldo${a.id ? ' inicial' : ' actual'}<div class="input-money"><input name="initialBalance" type="number" step="0.01" inputmode="decimal" required value="${a.initialBalance ?? ''}" placeholder="0,00"><span>€</span></div></label>
        <label class="field">A fecha de<input name="balanceDate" type="date" required value="${a.balanceDate || ymd(todayD())}"></label>
      </div>
      <p class="set-desc" style="margin-top:-6px">Solo cuentan los movimientos posteriores a esa fecha. En tarjetas de crédito usa un saldo negativo si debes dinero.</p>
      <label class="switch-row"><span class="ichip sm">${ic('star', 'sm')}</span><span class="txt"><b>Cuenta principal</b><small>Los movimientos sin cuenta se asignan a esta</small></span>
        <span class="switch"><input type="checkbox" name="isDefault" ${a.isDefault ? 'checked' : ''}><span></span></span></label>`,
    onSubmit: async (d) => {
      d.initialBalance = Number(d.initialBalance);
      if (a.id) await api('/accounts/' + a.id, { method: 'PUT', body: d });
      else await api('/accounts', { method: 'POST', body: d });
      await loadAccounts();
      toast('Cuenta guardada');
      route();
    },
  });
}
function transferForm(fromId = '') {
  if (accs.length < 2) return toast('Necesitas al menos dos cuentas para hacer una transferencia', true);
  const opts = (sel) => accs.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)} (${eur(a.balance)})</option>`).join('');
  openModal({
    title: 'Transferencia entre cuentas',
    icon: 'arrow-left-right',
    html: `
      <p class="set-desc">Mover dinero entre tus cuentas no cuenta como gasto ni como ingreso.</p>
      <label class="field">Importe<div class="input-money"><input name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" required placeholder="0,00"><span>€</span></div></label>
      <div class="row">
        <label class="field">Desde<select name="fromId">${opts(fromId || accs[0].id)}</select></label>
        <label class="field">Hacia<select name="toId">${opts(accs.find((a) => a.id !== (fromId || accs[0].id))?.id)}</select></label>
      </div>
      <div class="row">
        <label class="field">Fecha<input name="date" type="date" required value="${ymd(todayD())}"></label>
        <label class="field">Nota<input name="note" maxlength="200" placeholder="Opcional"></label>
      </div>`,
    onSubmit: async (d) => {
      d.amount = Number(d.amount);
      await api('/transfers', { method: 'POST', body: d });
      await loadAccounts();
      toast('Transferencia registrada');
      route();
    },
  });
}
function adjustForm(a) {
  openModal({
    title: `Ajustar saldo · ${a.name}`,
    icon: 'scale',
    html: `<p class="set-desc">Si el saldo de la app no coincide con el de tu banco, escribe el saldo real. Se creará un ajuste por la diferencia.</p>
      <div class="summary-strip" style="margin-bottom:14px"><div><small>Saldo en la app</small><b>${eur(a.balance)}</b></div></div>
      <label class="field">Saldo real<div class="input-money"><input name="newBalance" type="number" step="0.01" inputmode="decimal" required value="${a.balance}"><span>€</span></div></label>
      <label class="field">Fecha<input name="date" type="date" required value="${ymd(todayD())}"></label>`,
    onSubmit: async (d) => {
      await api('/transfers', { method: 'POST', body: { type: 'adjust', accountId: a.id, newBalance: Number(d.newBalance), date: d.date } });
      await loadAccounts();
      toast('Saldo ajustado');
      route();
    },
  });
}
async function accountMovements(a) {
  const list = await api(`/accounts/${a.id}/movements`);
  openModal({
    title: a.name,
    icon: (ACC_TYPES[a.type] || ACC_TYPES.otra)[1],
    actions: false,
    html: `<div class="summary-strip" style="margin-bottom:12px"><div><small>Saldo</small><b>${eur(a.balance)}</b></div><div><small>Saldo inicial</small><b>${eur(a.initialBalance)}</b></div><div><small>Movimientos</small><b>${a.movements}</b></div></div>
      <div class="list">${list.map((m) => `<div class="li">${m.kind === 'expense' ? catIc(m.category || NO_CAT, 'sm') : `<span class="ichip sm ${m.kind === 'income' ? 'green' : m.kind === 'adjust' ? 'amber' : ''}">${ic(m.kind === 'income' ? 'hand-coins' : m.kind === 'adjust' ? 'scale' : 'arrow-left-right', 'sm')}</span>`}
        <div class="main"><b>${esc(m.name)}</b><small>${fmtDate(m.date, { day: 'numeric', month: 'short', year: 'numeric' })}${m.counted ? '' : ' · anterior al saldo inicial'}</small></div><div class="amt">${signed(m.amount)}</div></div>`).join('') || emptyHtml('list', 'Sin movimientos', '')}</div>`,
  });
}
async function renderAccounts(el) {
  const [list, ov, transfers] = await Promise.all([loadAccounts(), api('/overview'), api('/transfers')]);
  const m = ov.money;
  el.innerHTML = `
  <div class="grid g4 stats">
    <div class="card stat"><div class="top"><span class="label">Saldo bancario</span><span class="ichip">${ic('landmark')}</span></div><div><div class="value">${eur(m.balance)}</div><div class="sub">${list.length} cuenta${list.length === 1 ? '' : 's'}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Disponible</span><span class="ichip green">${ic('wallet')}</span></div><div><div class="value">${eur(m.available)}</div><div class="sub">${eur(m.perDay)} al día hasta fin de mes</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Reservado</span><span class="ichip amber">${ic('lock')}</span></div><div><div class="value">${eur(m.reservedBills + m.reservedSavings)}</div><div class="sub">Pagos pendientes y objetivo de ahorro</div></div></div>
    <a class="card stat" href="#/ahorros" style="color:inherit"><div class="top"><span class="label">Ahorro acumulado</span><span class="ichip">${ic('piggy-bank')}</span></div><div><div class="value">${eur(m.savings)}</div><div class="sub">En tus huchas</div></div></a>
  </div>
  <div class="toolbar" style="justify-content:space-between">
    <div class="muted" style="font-size:14px">El saldo se calcula con tus movimientos. Ajústalo si no coincide con el banco.</div>
    <button class="btn" id="btnTransfer">${ic('arrow-left-right', 'sm')}Transferir entre cuentas</button>
  </div>
  <div class="grid g3" id="accGrid">
    ${list.map((a) => `<div class="card acc-card" data-id="${a.id}">
      <div class="top">${accIc(a)}<div class="main"><b>${esc(a.name)}</b><small>${esc(a.typeLabel)}${a.id === me.finance?.defaultAccountId ? ' · Principal' : ''}</small></div>${a.demo ? '<span class="badge warn">Demo</span>' : ''}</div>
      <div class="acc-balance ${a.balance < 0 ? 'neg' : ''}">${eur(a.balance)}</div>
      <div class="acc-flow"><span>${ic('arrow-down-left', 'xs')}${eur(a.monthIn)} este mes</span><span>${ic('arrow-up-right', 'xs')}${eur(a.monthOut)}</span></div>
      <div class="btns">
        <button class="btn sm" data-mov="${a.id}">${ic('list', 'sm')}Movimientos</button>
        <button class="icon-btn sm" data-adj="${a.id}" title="Ajustar saldo">${ic('scale', 'sm')}</button>
        <button class="icon-btn sm" data-tr="${a.id}" title="Transferir">${ic('arrow-left-right', 'sm')}</button>
        <button class="icon-btn sm" data-edit="${a.id}" title="Editar">${ic('pencil', 'sm')}</button>
        <button class="icon-btn sm danger" data-del="${a.id}" title="Eliminar">${ic('trash-2', 'sm')}</button>
      </div></div>`).join('') || `<div class="card span2">${emptyHtml('landmark', 'Añade tu primera cuenta', 'Indica tu cuenta del banco, tarjeta o efectivo con su saldo actual para saber cuánto dinero tienes de verdad.', `<button class="btn primary sm" id="emptyAcc">${ic('plus', 'sm')}Añadir cuenta</button>`)}</div>`}
  </div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h3>${ic('arrow-left-right', 'sm')}Transferencias y ajustes</h3></div>
      <div class="list" id="trList">${transfers.slice(0, 12).map((t) => `<div class="li"><span class="ichip sm ${t.type === 'adjust' ? 'amber' : ''}">${ic(t.type === 'adjust' ? 'scale' : 'arrow-left-right', 'sm')}</span>
        <div class="main"><b>${t.type === 'adjust' ? `Ajuste · ${esc(accOf(t.toId)?.name || '')}` : `${esc(accOf(t.fromId)?.name || '?')} → ${esc(accOf(t.toId)?.name || '?')}`}</b><small>${fmtDate(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</small></div>
        <div class="amt">${t.type === 'adjust' ? signed(t.amount) : eur(t.amount)}</div><div class="row-actions"><button class="icon-btn sm danger" data-deltr="${t.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></div></div>`).join('') || emptyHtml('arrow-left-right', 'Sin transferencias', 'Mover dinero entre tus cuentas no cuenta como gasto.')}</div></div>
    <div class="card"><div class="card-head"><h3>${ic('shield-check', 'sm')}Conexión con tu banco</h3><span class="badge">Próximamente</span></div>
      <p class="set-desc">La app está preparada para conectarse a bancos europeos mediante proveedores autorizados de <b>Open Banking (PSD2)</b>, siempre con tu consentimiento explícito y revocable.</p>
      <p class="set-desc">Nunca te pediremos ni guardaremos tus claves del banco. Mientras tanto, apunta tus movimientos o escanea tus tickets.</p>
    </div>
  </div>`;
  $('#emptyAcc')?.addEventListener('click', () => accountForm());
  $('#btnTransfer').onclick = () => transferForm();
  $('#accGrid').onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const a = list.find((x) => x.id === (b.dataset.mov || b.dataset.adj || b.dataset.tr || b.dataset.edit || b.dataset.del));
    if (!a) return;
    if (b.dataset.mov) accountMovements(a);
    if (b.dataset.adj) adjustForm(a);
    if (b.dataset.tr) transferForm(a.id);
    if (b.dataset.edit) accountForm(a);
    if (b.dataset.del) confirmModal('Eliminar cuenta', `¿Eliminar <b>${esc(a.name)}</b>? Sus gastos e ingresos se mantienen (pasarán a la cuenta principal) y se borran sus transferencias.`, async () => {
      await api('/accounts/' + a.id, { method: 'DELETE' });
      await loadAccounts();
      toast('Cuenta eliminada');
      route();
    });
  };
  $('#trList').onclick = (ev) => {
    const b = ev.target.closest('[data-deltr]');
    if (b) confirmModal('Eliminar movimiento', '¿Eliminar esta transferencia o ajuste? Los saldos se recalcularán.', async () => { await api('/transfers/' + b.dataset.deltr, { method: 'DELETE' }); await loadAccounts(); toast('Eliminado'); route(); });
  };
}

// ================= PRESUPUESTOS =================
function budgetForm(b = {}, preset = {}) {
  const used = new Set((budgetForm.existing || []).map((x) => x.categoryId || 'general'));
  const options = [['', 'Presupuesto general (todo el mes)'], ...cats.map((c) => [c.id, c.name])].filter(([id]) => b.id ? (id || '') === (b.categoryId || '') : !used.has(id || 'general'));
  openModal({
    title: b.id ? 'Editar presupuesto' : 'Nuevo presupuesto',
    icon: 'target',
    html: `
      <label class="field">Límite mensual<div class="input-money"><input name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" required value="${b.amount ?? preset.amount ?? ''}" placeholder="0,00"><span>€</span></div></label>
      <label class="field">Para<select name="categoryId" ${b.id ? 'disabled' : ''}>${options.map(([id, n]) => `<option value="${id}" ${(preset.categoryId ?? b.categoryId ?? '') === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      ${preset.average ? `<p class="set-desc">Tu gasto medio aquí es de <b>${eur(preset.average)}</b> al mes.</p>` : ''}`,
    onSubmit: async (d) => {
      d.amount = Number(d.amount);
      if (b.id) await api('/budgets/' + b.id, { method: 'PUT', body: d });
      else await api('/budgets', { method: 'POST', body: { ...d, categoryId: d.categoryId || null } });
      toast('Presupuesto guardado');
      route();
    },
  });
}
const DISMISSED_SUG = 'agenda_sug_descartadas';
async function renderBudgets(el) {
  state.budMonth ||= monthKey(todayD());
  const isCur = state.budMonth === monthKey(todayD());
  const [data, rep, hist] = await Promise.all([api('/budgets?month=' + state.budMonth), api('/reports/month?month=' + state.budMonth), api('/budgets/history')]);
  budgetForm.existing = data.budgets;
  const general = data.budgets.find((b) => !b.categoryId);
  const catB = data.budgets.filter((b) => b.categoryId);
  let dismissed = [];
  try { dismissed = JSON.parse(store.get(DISMISSED_SUG) || '[]'); } catch {}
  const sugs = data.suggestions.filter((s) => !dismissed.includes(s.categoryId || 'general'));
  const th = data.thresholds;
  const mDate = parse(state.budMonth + '-01');
  const paceTxt = (b) => (b.pace && isCur ? (b.pace > 1.1 ? `${ic('trending-up', 'xs')}Vas un ${Math.round((b.pace - 1) * 100)} % más rápido de lo previsto` : `${ic('circle-check', 'xs')}Vas a buen ritmo`) : '');
  el.innerHTML = `
  <div class="toolbar">
    <div class="month-nav"><button class="icon-btn" id="bPrev">${ic('chevron-left')}</button><span class="lbl">${cap(monthName(mDate))}</span><button class="icon-btn" id="bNext">${ic('chevron-right')}</button></div>
    <div class="grow"></div>
    <button class="btn" id="bTh">${ic('sliders-horizontal', 'sm')}Avisos</button>
  </div>
  <div class="grid g3">
    <div class="card span2 budget-main">
      ${general ? `
      <div class="card-head"><h3>${ic('target', 'sm')}Presupuesto general</h3><span class="badge lvl-${general.level.key}">${general.level.label}</span></div>
      <div class="bm-row">
        <div><small>Presupuesto</small><b>${eur(general.amount)}</b></div>
        <div><small>Gastado</small><b>${eur(general.spent)}</b></div>
        <div><small>Disponible</small><b class="${general.remaining < 0 ? 'neg' : 'pos'}">${eur(general.remaining)}</b></div>
        <div><small>Consumido</small><b>${general.percent} %</b></div>
        <div><small>Ahorro conseguido</small><b class="${rep.balance < 0 ? 'neg' : ''}">${eur(rep.balance)}</b></div>
      </div>
      ${bar(general.percent, general.level.key)}
      <div class="bm-foot"><span>${paceTxt(general)}</span>${general.projected ? `<span>Previsión a fin de mes: <b>${eur(general.projected)}</b></span>` : ''}
        <span class="acts"><button class="icon-btn sm" data-edit="${general.id}">${ic('pencil', 'sm')}</button><button class="icon-btn sm danger" data-del="${general.id}">${ic('trash-2', 'sm')}</button></span></div>`
      : emptyHtml('target', 'Sin presupuesto general', 'Pon un límite de gasto para todo el mes y te avisaremos si te acercas.', `<button class="btn primary sm" id="bGen">${ic('plus', 'sm')}Crear presupuesto general</button>`)}
    </div>
    <div class="card"><div class="card-head"><h3>${ic('gauge', 'sm')}Cómo leer los colores</h3></div>
      <div class="lvl-legend">
        <div><span class="dot" style="background:${LEVEL_COLOR.ok}"></span>Correcto<small>menos del ${th[0]} %</small></div>
        <div><span class="dot" style="background:${LEVEL_COLOR.watch}"></span>Seguimiento<small>${th[0]}–${th[1] - 1} %</small></div>
        <div><span class="dot" style="background:${LEVEL_COLOR.caution}"></span>Precaución<small>${th[1]}–${th[2] - 1} %</small></div>
        <div><span class="dot" style="background:${LEVEL_COLOR.alert}"></span>Alerta<small>${th[2]}–99 %</small></div>
        <div><span class="dot" style="background:${LEVEL_COLOR.over}"></span>Superado<small>100 % o más</small></div>
      </div></div>
  </div>
  <div class="card">
    <div class="card-head"><h3>${ic('tag', 'sm')}Por categoría</h3><span class="badge">${catB.length}</span></div>
    <div class="budget-list" id="bList">${catB.map((b) => `<div class="bl-item">
      ${catIc(b.category || NO_CAT, 'sm')}
      <div class="main"><div class="bl-top"><b>${esc(b.category?.name || '—')}</b><span class="badge lvl-${b.level.key}">${b.level.label}</span></div>
        ${bar(b.percent, b.level.key)}
        <small>${eur(b.spent)} de ${eur(b.amount)} · ${b.remaining >= 0 ? `quedan ${eur(b.remaining)}` : `<span class="neg">${eur(-b.remaining)} por encima</span>`}${b.projected ? ` · previsión ${eur(b.projected)}` : ''}</small></div>
      <div class="pct">${b.percent}%</div>
      <div class="row-actions"><button class="icon-btn sm" data-edit="${b.id}">${ic('pencil', 'sm')}</button><button class="icon-btn sm danger" data-del="${b.id}">${ic('trash-2', 'sm')}</button></div>
    </div>`).join('') || emptyHtml('tag', 'Sin presupuestos por categoría', 'Crea uno o acepta las propuestas de abajo.')}</div>
  </div>
  ${sugs.length ? `<div class="card"><div class="card-head"><h3>${ic('sparkles', 'sm')}Presupuestos sugeridos</h3><span class="badge primary">Según tus últimos ${sugs[0].months} mes${sugs[0].months === 1 ? '' : 'es'}</span></div>
    <p class="set-desc">Calculados con tu gasto medio real. Nada cambia hasta que tú lo aceptes.</p>
    <div class="list" id="sugList">${sugs.map((s, i) => `<div class="li">${s.categoryId ? catIc(catOf(s.categoryId), 'sm') : `<span class="ichip sm">${ic('target', 'sm')}</span>`}
      <div class="main"><b>${esc(s.name)}</b><small>Gastas de media ${eur(s.average)} · te proponemos ${eur(s.suggested)}</small></div>
      <div class="sug-acts"><button class="btn sm primary" data-acc="${i}">${ic('check', 'sm')}Aceptar</button><button class="btn sm" data-mod="${i}">Modificar</button><button class="icon-btn sm" data-rej="${i}" title="Rechazar">${ic('x', 'sm')}</button></div></div>`).join('')}</div></div>` : ''}
  <div class="grid g3">
    <div class="card span2"><div class="card-head"><h3>${ic('chart-column', 'sm')}Historial</h3><span class="badge">Últimos 6 meses</span></div><div class="chart-box sm"><canvas id="cBHist"></canvas></div></div>
    <div class="card"><div class="card-head"><h3>${ic('history', 'sm')}Cumplimiento</h3></div>
      <div class="list">${hist.months.filter((m) => m.total).map((m) => `<div class="li"><div class="main"><b>${esc(m.label)}</b><small>${m.met} cumplido${m.met === 1 ? '' : 's'} · ${m.over} superado${m.over === 1 ? '' : 's'}</small></div><div class="amt">${Math.round((m.met / m.total) * 100)}%</div></div>`).join('') || emptyHtml('history', 'Aún sin historial', '')}</div>
      ${hist.mostExceeded.length ? `<p class="set-desc" style="margin-top:12px">Lo que más se supera: <b>${hist.mostExceeded.slice(0, 3).map((x) => `${esc(x.name)} (${x.times})`).join(', ')}</b></p>` : ''}</div>
  </div>`;
  const go = (n) => { state.budMonth = monthKey(new Date(mDate.getFullYear(), mDate.getMonth() + n, 1)); route(); };
  $('#bPrev').onclick = () => go(-1);
  $('#bNext').onclick = () => go(1);
  $('#bGen')?.addEventListener('click', () => budgetForm({}, { categoryId: '' }));
  $('#bTh').onclick = () => thresholdsForm(th);
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-edit],[data-del]');
    if (!b || !el.contains(b)) return;
    const item = data.budgets.find((x) => x.id === (b.dataset.edit || b.dataset.del));
    if (!item) return;
    if (b.dataset.edit) budgetForm(item);
    else confirmModal('Eliminar presupuesto', '¿Eliminar este presupuesto? Tus gastos no se tocan.', async () => { await api('/budgets/' + item.id, { method: 'DELETE' }); toast('Presupuesto eliminado'); route(); });
  });
  $('#sugList')?.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const s = sugs[b.dataset.acc ?? b.dataset.mod ?? b.dataset.rej];
    if (b.dataset.acc !== undefined) { try { await api('/budgets', { method: 'POST', body: { categoryId: s.categoryId, amount: s.suggested } }); toast('Presupuesto creado'); route(); } catch (e) { toast(e.message, true); } }
    if (b.dataset.mod !== undefined) budgetForm({}, { categoryId: s.categoryId || '', amount: s.suggested, average: s.average });
    if (b.dataset.rej !== undefined) { store.set(DISMISSED_SUG, JSON.stringify([...dismissed, s.categoryId || 'general'])); route(); }
  });
  chart($('#cBHist'), {
    type: 'bar',
    data: {
      labels: hist.months.map((m) => cap(parse(m.month + '-01').toLocaleDateString('es-ES', { month: 'short' }).replace('.', ''))),
      datasets: [
        { label: 'Gastado', data: hist.months.map((m) => m.spent), backgroundColor: cssVar('--primary'), borderRadius: 6, maxBarThickness: 34 },
        ...(general ? [{ label: 'Presupuesto', type: 'line', data: hist.months.map(() => general.amount), borderColor: cssVar('--danger'), borderDash: [6, 5], pointRadius: 0, borderWidth: 2 }] : []),
      ],
    },
    options: { ...barOpts, plugins: { ...barOpts.plugins, legend: { display: !!general, position: 'bottom', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${eur(c.parsed.y)}` } } } },
  });
}
function thresholdsForm(th) {
  openModal({
    title: 'Avisos de presupuesto',
    icon: 'sliders-horizontal',
    html: `<p class="set-desc">Elige a partir de qué porcentaje cambia el estado de tus presupuestos. Te avisaremos al llegar a «Precaución», «Alerta» y al superarlo.</p>
      <div class="row3">
        <label class="field">Seguimiento desde<div class="input-money"><input name="t0" type="number" min="1" max="98" required value="${th[0]}"><span>%</span></div></label>
        <label class="field">Precaución desde<div class="input-money"><input name="t1" type="number" min="2" max="98" required value="${th[1]}"><span>%</span></div></label>
        <label class="field">Alerta desde<div class="input-money"><input name="t2" type="number" min="3" max="99" required value="${th[2]}"><span>%</span></div></label>
      </div>`,
    onSubmit: async (d) => {
      await api('/finance-settings', { method: 'PUT', body: { thresholds: [Number(d.t0), Number(d.t1), Number(d.t2)] } });
      toast('Porcentajes guardados');
      route();
    },
  });
}

// ================= PREVISIONES =================
const sims = [];
async function renderForecast(el) {
  const fc = await api('/forecast');
  state.fcH ||= 90;
  const c = fc.confidence;
  const eom = fc.checkpoints.find((x) => x.key === 'eom');
  el.innerHTML = `
  ${fc.hasAccounts ? '' : `<div class="notice warn" style="margin-bottom:16px">${ic('triangle-alert', 'sm')}<span>No has añadido tus cuentas, así que la previsión parte de 0 €. <a href="#/cuentas">Añade tus cuentas</a> para que sea real.</span></div>`}
  <div class="grid g4 stats">
    <div class="card stat"><div class="top"><span class="label">Saldo actual</span><span class="ichip">${ic('landmark')}</span></div><div><div class="value">${eur(fc.balance)}</div><div class="sub">${eur(fc.variablePerDay)}/día de gasto variable</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Fin de mes</span><span class="ichip ${eom.realistic < 0 ? 'red' : 'green'}">${ic('calendar-check')}</span></div><div><div class="value">${eur(eom.realistic)}</div><div class="sub">Entre ${eurShort(eom.pessimistic)} y ${eurShort(eom.optimistic)}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Saldo mínimo previsto</span><span class="ichip ${fc.minimum.balance < 0 ? 'red' : 'amber'}">${ic('trending-down')}</span></div><div><div class="value">${eur(fc.minimum.balance)}</div><div class="sub">El ${fmtDate(fc.minimum.date, { day: 'numeric', month: 'long' })}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Fiabilidad</span><span class="ichip ${c.score >= 70 ? 'green' : c.score >= 40 ? 'amber' : 'red'}">${ic('gauge')}</span></div><div><div class="value">${c.label}</div><div class="progress thin" style="margin-top:9px"><div style="width:${c.score}%"></div></div></div></div>
  </div>
  ${c.notes.length ? `<div class="notice" style="margin-bottom:16px">${ic('info', 'sm')}<span>${c.notes.map(esc).join(' ')} Las previsiones son estimaciones, no certezas.</span></div>` : ''}
  <div class="card">
    <div class="card-head"><h3>${ic('chart-line', 'sm')}Evolución del saldo</h3>
      <div class="seg sm" id="fcH"><button data-h="30">30 días</button><button data-h="90">3 meses</button><button data-h="180">6 meses</button></div></div>
    <div class="chart-box lg"><canvas id="cFc"></canvas></div>
    <div class="fc-legend"><span><i style="background:var(--text-2)"></i>Histórico</span><span><i style="background:var(--primary)"></i>Realista</span><span><i class="dash" style="border-color:var(--success)"></i>Optimista</span><span><i class="dash" style="border-color:var(--danger)"></i>Pesimista</span></div>
  </div>
  <div class="grid g3">
    <div class="card span2"><div class="card-head"><h3>${ic('calendar-range', 'sm')}Previsión por plazos</h3></div>
      <div class="xl-wrap"><table class="xl fc-table"><thead><tr><th>Plazo</th><th>Fecha</th><th class="num">Pesimista</th><th class="num">Realista</th><th class="num">Optimista</th></tr></thead>
      <tbody>${fc.checkpoints.map((p) => `<tr><td><b>${p.label}</b></td><td>${fmtDate(p.date, { day: 'numeric', month: 'short', year: 'numeric' })}</td><td class="num">${bal(p.pessimistic)}</td><td class="num"><b>${bal(p.realistic)}</b></td><td class="num">${bal(p.optimistic)}</td></tr>`).join('')}</tbody></table></div>
      <p class="set-desc" style="margin-top:10px"><b>Optimista:</b> reduces un 15 % tus gastos variables. <b>Realista:</b> mantienes tu ritmo. <b>Pesimista:</b> gastas un 20 % más y cobras un 10 % menos.</p></div>
    <div class="card"><div class="card-head"><h3>${ic('bell-ring', 'sm')}Alertas</h3></div>
      <div class="alert-list">${fc.alerts.map((a) => `<div class="notice ${a.level === 'danger' ? 'danger' : a.level === 'warn' ? 'warn' : a.level === 'ok' ? 'ok' : ''}">${ic(a.level === 'danger' || a.level === 'warn' ? 'triangle-alert' : a.level === 'ok' ? 'lightbulb' : 'info', 'sm')}<span>${esc(a.text)}</span></div>`).join('') || emptyHtml('circle-check', 'Todo en orden', '')}</div></div>
  </div>
  <div class="grid g2">
    <div class="card" id="simCard"><div class="card-head"><h3>${ic('calculator', 'sm')}¿Puedo permitirme esta compra?</h3></div>
      <form id="simForm" class="sim-form">
        <div class="row"><label class="field">¿Qué quieres comprar?<input name="name" maxlength="80" placeholder="Ej: Portátil" required></label>
          <label class="field">Precio<div class="input-money"><input name="price" type="number" step="0.01" min="0.01" inputmode="decimal" required placeholder="0,00"><span>€</span></div></label></div>
        <div class="row"><label class="field">Fecha prevista<input name="date" type="date" required value="${ymd(todayD())}" min="${ymd(todayD())}"></label>
          <label class="field">Tipo de pago<select name="monthly"><option value="">Pago único</option><option value="1">Cada mes</option></select></label></div>
        <button class="btn primary full">${ic('calculator', 'sm')}Calcular</button>
      </form>
      <div id="simOut"></div></div>
    <div class="card"><div class="card-head"><h3>${ic('calendar-clock', 'sm')}Próximos 30 días</h3></div>
      <div class="list">${fc.upcoming.map((e) => `<div class="li"><span class="ichip sm ${e.type === 'income' ? 'green' : e.type === 'bill' ? '' : 'amber'}">${ic(e.type === 'income' ? 'hand-coins' : e.type === 'bill' ? 'repeat' : 'shopping-bag', 'sm')}</span>
        <div class="main"><b>${esc(e.name)}</b><small>${cap(fmtDate(e.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</small></div><div class="amt">${signed(e.amount)}</div></div>`).join('') || emptyHtml('calendar-clock', 'Nada previsto', 'Añade tus pagos fijos y tus ingresos mensuales en Ajustes.')}</div></div>
  </div>`;
  const draw = () => {
    charts.forEach((x) => x.destroy());
    charts = [];
    $$('#fcH button').forEach((b) => b.classList.toggle('on', Number(b.dataset.h) === state.fcH));
    const hist = fc.history.slice(-Math.min(60, Math.round(state.fcH / 2)));
    const fut = fc.series.slice(0, state.fcH + 1);
    const labels = [...hist.map((x) => x.date), ...fut.slice(hist.length && hist[hist.length - 1].date === fut[0].date ? 1 : 0).map((x) => x.date)];
    const idx = Object.fromEntries(labels.map((d, i) => [d, i]));
    const arr = (src, key) => { const a = labels.map(() => null); for (const p of src) if (idx[p.date] !== undefined) a[idx[p.date]] = p[key]; return a; };
    const low = Number(me.finance?.lowBalance);
    chart($('#cFc'), {
      type: 'line',
      data: {
        labels: labels.map((d) => fmtDate(d)),
        datasets: [
          { label: 'Histórico', data: arr(hist, 'balance'), borderColor: cssVar('--text-2'), borderWidth: 2, pointRadius: 0, tension: 0.25 },
          { label: 'Optimista', data: arr(fut, 'optimistic'), borderColor: cssVar('--success'), borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, tension: 0.25 },
          { label: 'Pesimista', data: arr(fut, 'pessimistic'), borderColor: cssVar('--danger'), borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, tension: 0.25 },
          { label: 'Realista', data: arr(fut, 'realistic'), borderColor: cssVar('--primary'), backgroundColor: cssVar('--primary') + '18', fill: 'origin', borderWidth: 2.5, pointRadius: 0, tension: 0.25 },
        ],
      },
      options: {
        maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { displayColors: true, callbacks: { label: (x) => (x.parsed.y == null ? null : ` ${x.dataset.label}: ${eur(x.parsed.y)}`) } } },
        scales: { y: { ...moneyAxis, beginAtZero: false }, x: { grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 8, autoSkip: true } } },
      },
    });
    void low;
  };
  $('#fcH').onclick = (e) => { const b = e.target.closest('button'); if (b) { state.fcH = Number(b.dataset.h); draw(); } };
  draw();
  const renderSims = () => {
    $('#simOut').innerHTML = sims.length ? `
      ${simResult(sims[sims.length - 1])}
      ${sims.length > 1 ? `<div class="mini-label" style="margin-top:16px">Comparación</div><div class="xl-wrap"><table class="xl"><thead><tr><th>Compra</th><th class="num">Precio</th><th class="num">Fin de mes</th><th class="num">Mínimo</th><th>Riesgo</th></tr></thead><tbody>
        ${sims.map((s) => `<tr><td>${esc(s.name)}${s.monthly ? ' <small class="muted">/mes</small>' : ''}</td><td class="num">${eur(s.price)}</td><td class="num">${bal(s.endOfMonthAfter)}</td><td class="num">${bal(s.minimumAfter.balance)}</td><td><span class="badge risk-${s.risk}">${cap(s.risk)}</span></td></tr>`).join('')}
      </tbody></table></div><button class="btn sm ghost" id="simClear" style="margin-top:8px">${ic('eraser', 'sm')}Borrar comparación</button>` : ''}` : '';
    $('#simClear')?.addEventListener('click', () => { sims.length = 0; renderSims(); });
  };
  $('#simForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    try {
      const r = await api('/forecast/simulate', { method: 'POST', body: { name: f.name, price: Number(f.price), date: f.date, monthly: !!f.monthly } });
      sims.push(r);
      if (sims.length > 5) sims.shift();
      renderSims();
      hydrate($('#simOut'));
    } catch (e) { toast(e.message, true); }
  };
  renderSims();
}
function simResult(s) {
  return `<div class="sim-result risk-${s.risk}">
    <div class="sim-verdict">${ic(s.risk === 'bajo' ? 'circle-check' : s.risk === 'medio' ? 'triangle-alert' : 'circle-x')}<div><b>${esc(s.name)} · ${eur(s.price)}${s.monthly ? ' al mes' : ''}</b><span>${esc(s.verdict)}</span></div></div>
    <div class="sim-grid">
      <div><small>Saldo antes</small><b>${eur(s.balanceBefore)}</b></div>
      <div><small>Saldo después</small><b>${bal(s.balanceAfter)}</b></div>
      <div><small>Fin de mes</small><b>${bal(s.endOfMonthAfter)}</b><em>antes ${eur(s.endOfMonthBefore)}</em></div>
      <div><small>Mínimo previsto</small><b>${bal(s.minimumAfter.balance)}</b><em>${fmtDate(s.minimumAfter.date)}</em></div>
      ${s.budgetRemainingAfter !== null ? `<div><small>Presupuesto restante</small><b>${bal(s.budgetRemainingAfter)}</b></div>` : ''}
      <div><small>Ahorro</small><b>${s.savingsGoal ? (s.savingsAffected ? '<span class="neg">Afectado</span>' : '<span class="pos">No afectado</span>') : '—'}</b>${s.savingsGoal ? `<em>objetivo ${eur(s.savingsGoal)}/mes</em>` : ''}</div>
      <div><small>Riesgo de liquidez</small><b><span class="badge risk-${s.risk}">${cap(s.risk)}</span></b></div>
    </div></div>`;
}

// ================= ASISTENTE =================
const CHAT_KEY = 'agenda_chat';
let chatLog = [];
try { chatLog = JSON.parse(sessionStorage.getItem(CHAT_KEY) || '[]'); } catch {}
const saveChat = () => { try { sessionStorage.setItem(CHAT_KEY, JSON.stringify(chatLog.slice(-30))); } catch {} };
function chatBubble(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.text)}</div></div>`;
  const r = m.data;
  return `<div class="msg bot"><span class="bot-av">${ic('bot', 'sm')}</span><div class="bubble">
    <p>${esc(r.answer)}</p>
    ${r.facts?.length ? `<div class="facts">${r.facts.map((f) => `<div><small>${esc(f.label)}</small><b>${esc(f.value)}</b></div>`).join('')}</div>` : ''}
    ${r.items?.length ? `<div class="items">${r.items.map((i) => `<div><span>${esc(i.label)}${i.detail ? `<small>${esc(i.detail)}</small>` : ''}</span><b>${esc(i.value)}</b></div>`).join('')}</div>` : ''}
    ${r.note ? `<p class="note">${ic('info', 'xs')}${esc(r.note)}</p>` : ''}
    ${r.suggestions?.length ? `<div class="chips">${r.suggestions.map((s) => `<button type="button" class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
    ${r.link ? `<a class="btn sm" href="${esc(r.link.href)}" style="margin-top:8px">${esc(r.link.label)}${ic('chevron-right', 'xs')}</a>` : ''}
    <div class="src">${ic(r.source === 'ai' ? 'sparkles' : 'database', 'xs')}${r.source === 'ai' ? 'Redactado con IA a partir de tus cifras' : 'Calculado con tus datos'}</div>
  </div></div>`;
}
async function renderAssistant(el) {
  const q = getQuery();
  state.aTab = q.get('tab') || state.aTab || 'chat';
  const help = await api('/assistant/help');
  el.innerHTML = `
  <div class="seg tabs" id="aTabs">
    <button data-t="chat">${ic('message-circle', 'sm')}Chat</button>
    <button data-t="consejos">${ic('lightbulb', 'sm')}Consejos</button>
    <button data-t="alertas">${ic('circle-alert', 'sm')}Alertas</button>
  </div>
  <div id="aBody"></div>`;
  const body = $('#aBody');
  const show = async (t) => {
    state.aTab = t;
    $$('#aTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    if (t === 'chat') {
      body.innerHTML = `<div class="card chat">
        <div class="chat-log" id="chatLog">${chatLog.length ? chatLog.map(chatBubble).join('') : `<div class="chat-welcome"><span class="ichip lg">${ic('bot', 'lg')}</span><b>Tu asistente financiero</b><p>Pregúntame lo que quieras sobre tu dinero. Respondo con tus datos reales${help.ai ? '' : ', calculados al momento y gratis'}.</p></div>`}</div>
        <div class="chips sugg">${help.suggestions.map((s) => `<button type="button" class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        <form class="chat-input" id="chatForm"><input name="q" maxlength="500" placeholder="Escribe tu pregunta…" autocomplete="off"><button class="btn primary" aria-label="Enviar">${ic('send-horizontal', 'sm')}</button>
          ${chatLog.length ? `<button type="button" class="icon-btn" id="chatClear" title="Borrar conversación">${ic('eraser', 'sm')}</button>` : ''}</form>
      </div>`;
      const log = $('#chatLog');
      log.scrollTop = log.scrollHeight;
      const ask = async (text) => {
        text = text.trim();
        if (!text) return;
        chatLog.push({ role: 'user', text });
        log.insertAdjacentHTML('beforeend', chatBubble({ role: 'user', text }) + '<div class="msg bot typing"><span class="bot-av">' + ic('bot', 'sm') + '</span><div class="bubble"><span class="dots3"><i></i><i></i><i></i></span></div></div>');
        $('.chat-welcome', log)?.remove();
        log.scrollTop = log.scrollHeight;
        try {
          const data = await api('/assistant/ask', { method: 'POST', body: { question: text } });
          chatLog.push({ role: 'bot', data });
        } catch (e) {
          chatLog.push({ role: 'bot', data: { answer: e.message, source: 'local' } });
        }
        saveChat();
        $('.typing', log)?.remove();
        log.insertAdjacentHTML('beforeend', chatBubble(chatLog[chatLog.length - 1]));
        log.scrollTop = log.scrollHeight;
      };
      $('#chatForm').onsubmit = (e) => { e.preventDefault(); const v = e.target.q.value; e.target.q.value = ''; ask(v); };
      body.onclick = (e) => { const c = e.target.closest('[data-q]'); if (c) ask(c.dataset.q); };
      $('#chatClear')?.addEventListener('click', () => { chatLog = []; saveChat(); show('chat'); });
      if (matchMedia('(min-width: 901px)').matches) $('#chatForm').q.focus();
    } else if (t === 'consejos') {
      body.innerHTML = '<div class="skeleton" style="height:240px"></div>';
      const ins = await api('/insights');
      body.onclick = null;
      body.innerHTML = `<p class="set-desc">Consejos calculados con tus movimientos. El ahorro potencial es una estimación: no es dinero ya ahorrado.</p>
        <div class="grid g2">${ins.recommendations.map(tipCard).join('') || `<div class="card span2">${emptyHtml('party-popper', 'Nada que mejorar ahora mismo', 'Sigue apuntando tus gastos y te avisaremos si vemos algo.')}</div>`}</div>`;
    } else {
      body.innerHTML = '<div class="skeleton" style="height:240px"></div>';
      const ins = await api('/insights');
      body.innerHTML = `<p class="set-desc">Movimientos que parecen raros. Revísalos: nunca se borra nada sin que tú lo confirmes.</p>
        <div class="grid g2" id="anoms">${ins.anomalies.map((a, i) => `<div class="card anom ${a.level}">
          <div class="card-head"><h3>${ic(a.type === 'duplicate' ? 'copy' : a.type === 'future' ? 'calendar-clock' : a.type === 'spike' ? 'trending-up' : 'circle-alert', 'sm')}${esc(a.title)}</h3></div>
          <p>${esc(a.text)}</p>
          ${a.expenses.length ? `<div class="list">${a.expenses.map((e) => expenseRow(e)).join('')}</div>` : ''}
          <div class="btns">
            ${a.type === 'duplicate' && a.expenses[1] ? `<button class="btn sm danger" data-deldup="${i}">${ic('trash-2', 'sm')}Eliminar el repetido</button>` : ''}
            <button class="btn sm" data-ok="${i}">${ic('check', 'sm')}Es correcto</button>
          </div></div>`).join('') || `<div class="card span2">${emptyHtml('shield-check', 'Sin alertas', 'No hemos encontrado gastos duplicados ni fuera de lo normal.')}</div>`}</div>`;
      $('#anoms').onclick = async (e) => {
        const b = e.target.closest('button[data-ok],button[data-deldup]');
        const row = e.target.closest('[data-id]');
        if (!b && row) { const a = ins.anomalies.flatMap((x) => x.expenses).find((x) => x.id === row.dataset.id); if (a) expenseForm(a); return; }
        if (!b) return;
        const a = ins.anomalies[b.dataset.ok ?? b.dataset.deldup];
        if (b.dataset.ok !== undefined) { await api('/insights/anomalies/dismiss', { method: 'POST', body: { key: a.key } }); toast('Alerta descartada'); show('alertas'); }
        else confirmModal('Eliminar gasto repetido', `¿Eliminar el segundo «${esc(a.expenses[1].name)}» de ${eur(a.expenses[1].amount)}? El primero se mantiene.`, async () => {
          await api('/expenses/' + a.expenses[1].id, { method: 'DELETE' });
          await api('/insights/anomalies/dismiss', { method: 'POST', body: { key: a.key } });
          toast('Gasto repetido eliminado');
          show('alertas');
        });
      };
    }
    hydrate(body);
  };
  $('#aTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { history.replaceState(null, '', '#/asistente' + (b.dataset.t === 'chat' ? '' : '?tab=' + b.dataset.t)); show(b.dataset.t); } };
  await show(state.aTab);
}
const PRIO = { alta: ['red', 'Prioridad alta'], media: ['amber', 'Prioridad media'], baja: ['', 'Prioridad baja'] };
const tipCard = (r) => `<div class="card tip">
  <div class="tip-head"><span class="ichip sm ${PRIO[r.priority][0]}">${ic('lightbulb', 'sm')}</span><b>${esc(r.title)}</b><span class="badge ${r.priority === 'alta' ? 'danger' : r.priority === 'media' ? 'warn' : ''}">${PRIO[r.priority][1]}</span></div>
  <p>${esc(r.text)}</p>
  <ul class="evidence">${r.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
  <div class="tip-foot">${r.potential ? `<span>Ahorro potencial <b>≈ ${eur(r.potential)}/mes</b></span>` : '<span></span>'}<a class="btn sm" href="${esc(r.action.href)}">${esc(r.action.label)}${ic('chevron-right', 'xs')}</a></div>
</div>`;

// ================= INFORMES =================
function periodRange(kind, anchor) {
  const t = parse(anchor);
  if (kind === 'semana') { const s = weekStart(t); return [ymd(s), ymd(addDays(s, 6))]; }
  if (kind === 'trimestre') { const q = Math.floor(t.getMonth() / 3) * 3; return [ymd(new Date(t.getFullYear(), q, 1)), ymd(new Date(t.getFullYear(), q + 3, 0))]; }
  if (kind === 'anio') return [`${t.getFullYear()}-01-01`, `${t.getFullYear()}-12-31`];
  return [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(new Date(t.getFullYear(), t.getMonth() + 1, 0))];
}
function shiftAnchor(kind, anchor, n) {
  const t = parse(anchor);
  if (kind === 'semana') return ymd(addDays(t, 7 * n));
  if (kind === 'trimestre') return ymd(new Date(t.getFullYear(), t.getMonth() + 3 * n, 1));
  if (kind === 'anio') return ymd(new Date(t.getFullYear() + n, 0, 1));
  return ymd(new Date(t.getFullYear(), t.getMonth() + n, 1));
}
async function renderReports(el) {
  const q = getQuery();
  if (q.get('mes')) { state.repKind = 'mes'; state.repAnchor = q.get('mes') + '-01'; history.replaceState(null, '', '#/informes'); }
  state.repKind ||= 'mes';
  state.repAnchor ||= ymd(todayD());
  let [from, to] = state.repKind === 'custom' ? [state.repFrom || ymd(addDays(todayD(), -30)), state.repTo || ymd(todayD())] : periodRange(state.repKind, state.repAnchor);
  const r = state.repKind === 'mes' ? await api('/reports/month?month=' + from.slice(0, 7)) : await api(`/reports/period?${qs({ from, to })}`);
  const label = state.repKind === 'mes' ? r.label : state.repKind === 'custom' ? `${fmtDate(from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(to, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : state.repKind === 'anio' ? from.slice(0, 4) : state.repKind === 'trimestre' ? `${Math.floor(parse(from).getMonth() / 3) + 1}.º trimestre de ${from.slice(0, 4)}` : `Semana del ${fmtDate(from, { day: 'numeric', month: 'long' })}`;
  const dPrev = pct(r.expenses, r.previous.expenses);
  const dYear = pct(r.expenses, r.lastYear.expenses);
  const months = r.history || r.byMonth;
  el.innerHTML = `
  <div class="toolbar no-print">
    <div class="seg" id="rKind">${[['semana', 'Semana'], ['mes', 'Mes'], ['trimestre', 'Trimestre'], ['anio', 'Año'], ['custom', 'Fechas']].map(([k, l]) => `<button data-k="${k}" class="${state.repKind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${state.repKind === 'custom' ? `<input type="date" id="rFrom" value="${from}"><input type="date" id="rTo" value="${to}">` : `<div class="month-nav"><button class="icon-btn" id="rPrev">${ic('chevron-left')}</button><span class="lbl">${esc(label)}</span><button class="icon-btn" id="rNext">${ic('chevron-right')}</button></div>`}
    <div class="grow"></div>
    <button class="btn" id="rPdf">${ic('printer', 'sm')}PDF</button>
    <button class="btn" id="rCsv">${ic('file-down', 'sm')}CSV</button>
    <button class="btn" id="rXls">${ic('file-spreadsheet', 'sm')}Excel</button>
  </div>
  <h2 class="print-only">Informe financiero · ${esc(label)}</h2>
  <div class="grid g4 stats">
    <div class="card stat"><div class="top"><span class="label">Ingresos</span><span class="ichip green">${ic('hand-coins')}</span></div><div><div class="value">${eur(r.incomes)}</div><div class="sub">${trendHtml(pct(r.incomes, r.previous.incomes), ' vs. periodo anterior', true) || '—'}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Gastos</span><span class="ichip red">${ic('receipt-text')}</span></div><div><div class="value">${eur(r.expenses)}</div><div class="sub">${trendHtml(dPrev, ' vs. anterior') || '—'}${dYear !== null ? ` · ${trendHtml(dYear, ' vs. hace un año')}` : ''}</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Balance</span><span class="ichip">${ic('scale')}</span></div><div><div class="value ${r.balance < 0 ? 'neg' : ''}">${eur(r.balance)}</div><div class="sub">${r.count} gastos</div></div></div>
    <div class="card stat"><div class="top"><span class="label">Tasa de ahorro</span><span class="ichip amber">${ic('piggy-bank')}</span></div><div><div class="value">${r.savingsRate === null ? '—' : r.savingsRate + ' %'}</div><div class="sub">${eur(r.saved)} a tus huchas</div></div></div>
  </div>
  <div class="grid g3">
    <div class="card span2"><div class="card-head"><h3>${ic('chart-column', 'sm')}${state.repKind === 'mes' ? 'Evolución mensual' : 'Por meses'}</h3></div><div class="chart-box"><canvas id="cRMonths"></canvas></div></div>
    <div class="card"><div class="card-head"><h3>${ic('chart-pie', 'sm')}Por categoría</h3></div>
      ${r.byCategory.length ? `<div class="donut-wrap"><canvas id="cRCat"></canvas><div class="donut-center"><div><b>${eurShort(r.expenses)}</b><small>gastos</small></div></div></div>${legendHtml(r.byCategory, r.expenses)}` : emptyHtml('chart-pie', 'Sin gastos', '')}</div>
  </div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h3>${ic('tag', 'sm')}Categorías</h3></div>
      <div class="xl-wrap"><table class="xl"><thead><tr><th>Categoría</th><th class="num">Gasto</th>${r.categoryChanges ? '<th class="num">Mes anterior</th><th class="num">Cambio</th>' : '<th class="num">Nº</th><th class="num">%</th>'}</tr></thead><tbody>
      ${(r.categoryChanges || r.byCategory).map((c) => r.categoryChanges ? `<tr><td>${catTag(c)}</td><td class="num">${eur(c.current)}</td><td class="num">${eur(c.previous)}</td><td class="num">${c.change === null ? '—' : `<span class="${c.change > 0 ? 'neg' : 'pos'}">${c.change > 0 ? '+' : ''}${c.change} %</span>`}</td></tr>`
        : `<tr><td>${catTag(c)}</td><td class="num">${eur(c.total)}</td><td class="num">${c.count}</td><td class="num">${r.expenses ? Math.round((c.total / r.expenses) * 100) : 0} %</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin datos</td></tr>'}
      </tbody></table></div></div>
    <div class="card"><div class="card-head"><h3>${ic('store', 'sm')}Por establecimiento</h3></div>
      <div class="list">${r.byMerchant.map((m) => `<div class="li"><span class="ichip sm">${ic('store', 'sm')}</span><div class="main"><b>${esc(m.name)}</b><small>${m.count} compra${m.count === 1 ? '' : 's'}</small></div><div class="amt">${eur(m.total)}</div></div>`).join('') || emptyHtml('store', 'Sin establecimientos', 'Indica «dónde» al apuntar tus gastos.')}</div></div>
  </div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h3>${ic('repeat', 'sm')}Gastos recurrentes y suscripciones</h3><span class="badge">${eur(r.recurringTotal)}/mes</span></div>
      <div class="list">${r.recurring.map((s) => `<div class="li">${catIc(s.category, 'sm')}<div class="main"><b>${esc(s.name)}</b><small>${esc(s.frequency)}${s.isSubscription ? ' · Suscripción' : ''}</small></div><div class="amt">${eur(s.monthly)}<small class="muted">/mes</small></div></div>`).join('') || emptyHtml('repeat', 'Sin pagos fijos', '')}</div></div>
    <div class="card"><div class="card-head"><h3>${ic('target', 'sm')}Presupuestos</h3>${r.budgets?.length ? `<span class="badge">${r.budgets.filter((b) => b.percent < 100).length}/${r.budgets.length} cumplidos</span>` : ''}</div>
      <div class="list">${(r.budgets || []).map((b) => `<div class="li"><div class="main"><div class="bl-top"><b>${esc(b.name)}</b><span class="badge lvl-${b.level.key}">${b.percent}%</span></div>${bar(b.percent, b.level.key)}<small>${eur(b.spent)} de ${eur(b.amount)}</small></div></div>`).join('') || emptyHtml('target', 'Sin presupuestos', '')}</div></div>
  </div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h3>${ic('trophy', 'sm')}Mayores gastos</h3></div><div class="list" id="rTop">${r.top.map((e) => expenseRow(e)).join('') || emptyHtml('receipt-text', 'Sin gastos', '')}</div></div>
    ${r.recommendations ? `<div class="card"><div class="card-head"><h3>${ic('lightbulb', 'sm')}Recomendaciones</h3></div><div class="list">${r.recommendations.map((x) => `<div class="li"><span class="ichip sm amber">${ic('lightbulb', 'sm')}</span><div class="main"><b>${esc(x.title)}</b><small>${esc(x.evidence[0] || '')}</small></div>${x.potential ? `<div class="amt">≈ ${eur(x.potential)}</div>` : ''}</div>`).join('') || emptyHtml('party-popper', 'Sin recomendaciones', '')}</div></div>`
      : `<div class="card"><div class="card-head"><h3>${ic('chart-line', 'sm')}Previsión</h3></div><div class="list">${(r.forecast || []).slice(0, 5).map((p) => `<div class="li"><div class="main"><b>${esc(p.label)}</b><small>${fmtDate(p.date)}</small></div><div class="amt">${bal(p.realistic)}</div></div>`).join('')}</div></div>`}
  </div>`;
  bindExpenseClicks($('#rTop'), r.top);
  $('#rKind').onclick = (e) => { const b = e.target.closest('button'); if (b) { state.repKind = b.dataset.k; state.repAnchor = ymd(todayD()); route(); } };
  $('#rPrev')?.addEventListener('click', () => { state.repAnchor = shiftAnchor(state.repKind, state.repAnchor, -1); route(); });
  $('#rNext')?.addEventListener('click', () => { state.repAnchor = shiftAnchor(state.repKind, state.repAnchor, 1); route(); });
  const setCustom = () => { state.repFrom = $('#rFrom').value; state.repTo = $('#rTo').value; if (state.repFrom && state.repTo && state.repFrom <= state.repTo) route(); };
  $('#rFrom')?.addEventListener('change', setCustom);
  $('#rTo')?.addEventListener('change', setCustom);
  $('#rPdf').onclick = () => window.print();
  $('#rCsv').onclick = () => download(`/export.csv?${qs({ from, to })}`, 'movimientos.csv').catch((e) => toast(e.message, true));
  $('#rXls').onclick = () => download(`/export.xlsx?${qs({ from, to })}`, 'agenda-gastos.xlsx').catch((e) => toast(e.message, true));
  chart($('#cRMonths'), {
    type: 'bar',
    data: {
      labels: months.map((m) => cap(parse(m.month + '-01').toLocaleDateString('es-ES', { month: 'short', year: '2-digit' }).replace('.', ''))),
      datasets: [
        { label: 'Ingresos', data: months.map((m) => m.incomes), backgroundColor: cssVar('--success'), borderRadius: 6, maxBarThickness: 26 },
        { label: 'Gastos', data: months.map((m) => m.expenses), backgroundColor: cssVar('--danger'), borderRadius: 6, maxBarThickness: 26 },
      ],
    },
    options: { ...barOpts, plugins: { ...barOpts.plugins, legend: { display: true, position: 'bottom', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${eur(c.parsed.y)}` } } } },
  });
  if (r.byCategory.length) donut($('#cRCat'), r.byCategory);
}

// ================= TICKETS =================
const rState = { q: '', from: '', to: '', cat: '' };
async function renderReceipts(el) {
  el.innerHTML = `
  <div class="scan-hero card">
    <div><h2>${ic('scan-line')}Escanea tus tickets</h2><p>Haz una foto y la app lee el establecimiento, la fecha, el importe y los productos. Revisas los datos y se guarda como gasto.</p></div>
    <button class="btn primary lg" id="bigScan">${ic('camera', 'sm')}ESCANEAR TICKET</button>
  </div>
  <div class="toolbar">
    <div class="input-icon grow">${ic('search')}<input type="search" id="rq" placeholder="Buscar establecimiento…" value="${esc(rState.q)}"></div>
    <input type="date" id="rf" value="${rState.from}" title="Desde"><input type="date" id="rt" value="${rState.to}" title="Hasta">
    <select id="rc"><option value="">Todas las categorías</option>${cats.map((c) => `<option value="${c.id}" ${rState.cat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
  </div>
  <div id="rGrid"><div class="skeleton" style="height:220px"></div></div>`;
  $('#bigScan').onclick = () => pickReceipt();
  let list = [];
  const load = async () => {
    list = await api('/receipts?' + qs({ q: rState.q, from: rState.from, to: rState.to, category: rState.cat }));
    $('#rGrid').innerHTML = list.length ? `<div class="summary-strip" style="margin-bottom:14px"><div><small>Tickets</small><b>${list.length}</b></div><div><small>Total</small><b>${eur(list.reduce((a, r) => a + (r.expense?.amount ?? r.total), 0))}</b></div></div>
      <div class="ticket-grid">${list.map((r) => `<button class="ticket" data-id="${r.id}">
        <span class="thumb">${r.hasImage ? `<img loading="lazy" src="/api/receipts/${r.id}/image" alt="">` : ic('receipt', 'lg')}</span>
        <span class="t-body"><b>${esc(r.expense?.name || r.merchant)}</b><small>${fmtDate(r.date, { day: 'numeric', month: 'short', year: 'numeric' })}</small>
        <span class="t-foot">${catTag(r.category)}<b>${eur(r.expense?.amount ?? r.total)}</b></span></span></button>`).join('')}</div>`
      : emptyHtml('receipt', rState.q || rState.from || rState.to || rState.cat ? 'Sin resultados' : 'Aún no has escaneado tickets', 'Los tickets que escanees aparecerán aquí con su foto.');
    hydrate($('#rGrid'));
  };
  $('#rGrid').onclick = (e) => { const b = e.target.closest('.ticket'); if (b) receiptDetail(list.find((r) => r.id === b.dataset.id)); };
  let t;
  $('#rq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { rState.q = e.target.value; load(); }, 250); };
  $('#rf').onchange = (e) => { rState.from = e.target.value; load(); };
  $('#rt').onchange = (e) => { rState.to = e.target.value; load(); };
  $('#rc').onchange = (e) => { rState.cat = e.target.value; load(); };
  await load();
}
function receiptDetail(r) {
  const row = (l, v) => (v ? `<div><small>${l}</small><b>${v}</b></div>` : '');
  openModal({
    title: r.merchant || 'Ticket',
    icon: 'receipt',
    actions: false,
    html: `<div class="rd">
      ${r.hasImage ? `<a class="rd-img" href="/api/receipts/${r.id}/image" target="_blank" rel="noopener"><img src="/api/receipts/${r.id}/image" alt="Foto del ticket"></a>` : ''}
      <div class="rd-data">
        <div class="facts">${row('Importe', eur(r.expense?.amount ?? r.total))}${row('Fecha', fmtDate(r.date, { day: 'numeric', month: 'long', year: 'numeric' }) + (r.time ? ' · ' + esc(r.time) : ''))}
          ${row('Categoría', esc(r.category?.name))}${row('Pago', esc({ tarjeta: 'Tarjeta', efectivo: 'Efectivo', otro: 'Otro' }[r.paymentMethod] || ''))}
          ${row('IVA', r.taxAmount ? eur(r.taxAmount) : '')}${row('Nº ticket', esc(r.ticketNumber))}${row('CIF/NIF', esc(r.taxId))}
          ${row('Lectura', r.source === 'ai' ? 'Con IA' : 'En el dispositivo')}${row('Confianza', r.confidence ? r.confidence + ' %' : '')}</div>
        ${r.items?.length ? `<div class="mini-label">Productos</div><div class="items">${r.items.map((i) => `<div><span>${i.quantity > 1 ? i.quantity + ' × ' : ''}${esc(i.name)}</span><b>${eur(i.amount)}</b></div>`).join('')}</div>` : ''}
        ${r.expense ? '' : '<div class="notice warn">El gasto de este ticket se eliminó.</div>'}
      </div></div>
      <div class="rd-btns">
        ${r.expense ? `<button type="button" class="btn primary" id="rdEdit">${ic('pencil', 'sm')}Editar gasto</button>` : ''}
        ${r.hasImage ? `<button type="button" class="btn" id="rdDown">${ic('download', 'sm')}Descargar</button>` : ''}
        <button type="button" class="btn danger" id="rdDel">${ic('trash-2', 'sm')}Eliminar ticket</button>
      </div>`,
  });
  $('#modalBody').classList.add('wide');
  $('#rdEdit')?.addEventListener('click', () => { closeModal(); expenseForm(r.expense); });
  $('#rdDown')?.addEventListener('click', () => download(`/receipts/${r.id}/image?download=1`, `ticket-${r.date}.jpg`).catch((e) => toast(e.message, true)));
  $('#rdDel').onclick = () => openModal({
    title: 'Eliminar ticket',
    icon: 'trash-2',
    danger: true,
    okText: 'Eliminar',
    html: `<p style="margin:0 0 12px;color:var(--text-2)">Se borrará la foto del ticket de forma definitiva.</p>
      ${r.expense ? `<label class="switch-row"><span class="txt"><b>Borrar también el gasto</b><small>${esc(r.expense.name)} · ${eur(r.expense.amount)}</small></span><span class="switch"><input type="checkbox" name="withExpense"><span></span></span></label>` : ''}`,
    onSubmit: async (d) => {
      await api(`/receipts/${r.id}${d.withExpense ? '?withExpense=1' : ''}`, { method: 'DELETE' });
      toast('Ticket eliminado');
      route();
    },
  });
}

// ================= AVISOS =================
const NOTIF_IC = { bill: 'calendar-clock', budget: 'target', anomaly: 'circle-alert', forecast: 'chart-line', weekly: 'calendar-range', monthly: 'file-text', goal: 'trophy' };
let notifCache = { unread: 0, list: [] };
async function refreshNotifs() {
  try { notifCache = await api('/notifications'); } catch { return; }
  for (const b of $$('.notif-count')) { b.textContent = notifCache.unread > 9 ? '9+' : notifCache.unread; b.classList.toggle('hidden', !notifCache.unread); }
}
async function openNotifs() {
  await refreshNotifs();
  const l = notifCache.list;
  openModal({
    title: 'Avisos',
    icon: 'bell',
    actions: false,
    html: `${l.length ? `<div class="notif-acts"><button type="button" class="btn sm" id="nRead">${ic('check-check', 'sm')}Marcar como leídos</button><button type="button" class="btn sm ghost" id="nClear">${ic('eraser', 'sm')}Borrar leídos</button></div>` : ''}
      <div class="notif-list">${l.map((n) => `<a class="notif ${n.read ? '' : 'unread'} ${n.level}" href="${esc(n.link || '#/dashboard')}" data-id="${n.id}">
        <span class="ichip sm ${n.level === 'danger' ? 'red' : n.level === 'warn' ? 'amber' : n.level === 'ok' ? 'green' : ''}">${ic(NOTIF_IC[n.type] || 'bell', 'sm')}</span>
        <span class="n-body"><b>${esc(n.title)}</b><small>${esc(n.body || '')}</small><em>${ago(n.createdAt)}</em></span></a>`).join('') || emptyHtml('bell-off', 'No tienes avisos', 'Aquí verás facturas próximas, presupuestos, alertas y previsiones.')}</div>
      <p class="set-desc" style="margin-top:12px">Elige qué avisos recibir en <a href="#/ajustes">Ajustes</a>.</p>`,
  });
  $$('.notif').forEach((a) => a.addEventListener('click', () => { api('/notifications/read', { method: 'POST', body: { ids: [a.dataset.id] } }).then(refreshNotifs); closeModal(); }));
  $('#nRead')?.addEventListener('click', async () => { await api('/notifications/read', { method: 'POST', body: {} }); await refreshNotifs(); openNotifs(); });
  $('#nClear')?.addEventListener('click', async () => { await api('/notifications', { method: 'DELETE' }); await refreshNotifs(); openNotifs(); });
}

// ================= BIENVENIDA =================
async function onboarding() {
  const data = { step: 0 };
  const steps = [
    () => ({
      title: 'Bienvenido a tu agenda financiera',
      html: `<div class="ob-hero"><span class="ichip lg">${ic('sparkles', 'lg')}</span><p>En un par de minutos la dejamos lista: tus cuentas, tus ingresos y tus límites. Así podremos decirte <b>cuánto puedes gastar</b>, <b>cuánto tendrás a final de mes</b> y <b>dónde ahorrar</b>.</p>
        <ul class="evidence"><li>Puedes saltarte cualquier paso y configurarlo más tarde.</li><li>Moneda: <b>euro (€)</b>.</li></ul></div>`,
      next: 'Empezar',
    }),
    () => ({
      title: 'Tu cuenta principal',
      html: `<p class="set-desc">¿Cuánto dinero tienes ahora mismo en tu cuenta principal?</p>
        <label class="field">Nombre<input name="accName" maxlength="60" value="Cuenta principal"></label>
        <label class="field">Tipo<select name="accType">${Object.entries(ACC_TYPES).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="field">Saldo actual<div class="input-money"><input name="accBalance" type="number" step="0.01" inputmode="decimal" placeholder="0,00"><span>€</span></div></label>`,
      save: async (d) => { if (d.accBalance !== '') await api('/accounts', { method: 'POST', body: { name: d.accName || 'Cuenta principal', type: d.accType, initialBalance: Number(d.accBalance), isDefault: true } }); },
    }),
    () => ({
      title: 'Tus categorías',
      html: `<p class="set-desc">Desmarca las que no vayas a usar. Podrás crear más en Ajustes.</p>
        <div class="cat-pick multi">${cats.map((c) => `<label style="--c:${safeColor(c.color)}"><input type="checkbox" name="cat_${c.id}" checked>${ic(c.icon)}${esc(c.name)}</label>`).join('')}</div>`,
      save: async (d) => {
        for (const c of cats) if (!d['cat_' + c.id]) await api('/categories/' + c.id, { method: 'DELETE' }).catch(() => {});
        cats = await api('/categories');
      },
    }),
    () => ({
      title: 'Tus ingresos',
      html: `<p class="set-desc">Con tu ingreso mensual (nómina, pensión…) calculamos la previsión de tu saldo.</p>
        <div class="row"><label class="field">Ingreso mensual<div class="input-money"><input name="monthlyIncome" type="number" step="0.01" inputmode="decimal" placeholder="0,00"><span>€</span></div></label>
        <label class="field">Día de cobro<input name="payday" type="number" min="1" max="31" placeholder="Ej: 28"></label></div>`,
      save: async (d) => { if (d.monthlyIncome) await api('/finance-settings', { method: 'PUT', body: { monthlyIncome: Number(d.monthlyIncome), payday: Number(d.payday) || 1 } }); },
    }),
    () => ({
      title: 'Presupuesto y ahorro',
      html: `<p class="set-desc">Opcional. Un límite de gasto al mes y cuánto quieres ahorrar.</p>
        <div class="row"><label class="field">Presupuesto mensual<div class="input-money"><input name="budget" type="number" step="0.01" inputmode="decimal" placeholder="Ej: 1500"><span>€</span></div></label>
        <label class="field">Ahorro mensual objetivo<div class="input-money"><input name="savingsGoal" type="number" step="0.01" inputmode="decimal" placeholder="Ej: 300"><span>€</span></div></label></div>
        <label class="field">Hucha para un objetivo (opcional)<input name="goalName" maxlength="60" placeholder="Ej: Viaje, Fondo de emergencia"></label>
        <label class="field">¿Cuánto quieres reunir?<div class="input-money"><input name="goalAmount" type="number" step="0.01" inputmode="decimal" placeholder="0,00"><span>€</span></div></label>`,
      save: async (d) => {
        if (Number(d.budget) > 0) await api('/budgets', { method: 'POST', body: { categoryId: null, amount: Number(d.budget) } }).catch(() => {});
        if (Number(d.savingsGoal) > 0) await api('/finance-settings', { method: 'PUT', body: { savingsGoal: Number(d.savingsGoal) } });
        if (d.goalName) await api('/savings', { method: 'POST', body: { name: d.goalName, goal: Number(d.goalAmount) || '', icon: 'target', color: '#16a34a' } });
      },
    }),
    () => ({
      title: '¡Todo listo!',
      html: `<div class="ob-hero"><span class="ichip lg green">${ic('circle-check', 'lg')}</span><p>Ya puedes apuntar gastos, escanear tickets y preguntar a tu asistente.</p>
        <label class="switch-row"><span class="ichip sm amber">${ic('flask-conical', 'sm')}</span><span class="txt"><b>Probar con datos de demostración</b><small>Se marcan como «demo» y puedes borrarlos cuando quieras sin tocar tus datos</small></span><span class="switch"><input type="checkbox" name="demo"><span></span></span></label></div>`,
      next: 'Ir al panel',
      save: async (d) => { if (d.demo) { await api('/demo', { method: 'POST' }); toast('Datos de demostración cargados'); } },
    }),
  ];
  const finish = async () => { await api('/finance-settings', { method: 'PUT', body: { onboarded: true } }).catch(() => {}); me.onboarded = true; await loadAccounts(); closeModal(); route(); };
  const show = () => {
    const s = steps[data.step]();
    openModal({
      title: s.title,
      icon: 'rocket',
      locked: true,
      okText: s.next || 'Siguiente',
      html: `<div class="ob-steps">${steps.map((_, i) => `<span class="${i <= data.step ? 'on' : ''}"></span>`).join('')}</div>${s.html}
        <div class="ob-skip">${data.step > 0 && data.step < steps.length - 1 ? '<a href="#" id="obSkip">Saltar este paso</a>' : ''}<a href="#" id="obLater">Configurar más tarde</a></div>`,
      onSubmit: async (d) => {
        if (s.save) await s.save(d);
        if (data.step === steps.length - 1) { await finish(); return; }
        data.step++;
        setTimeout(show, 0);
      },
    });
    $('#obSkip')?.addEventListener('click', (e) => { e.preventDefault(); data.step++; show(); });
    $('#obLater').onclick = (e) => { e.preventDefault(); finish(); };
  };
  show();
}

// ================= Ajustes de finanzas, avisos, demo y datos =================
async function financeSettingsHtml() {
  const [f, demo] = await Promise.all([api('/finance-settings'), api('/demo')]);
  return {
    f,
    demo,
    html: `
  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>${ic('wallet', 'sm')}Tu economía</h3></div>
      <p class="set-desc">Se usa para las previsiones, el dinero disponible y los avisos.</p>
      <form id="finForm">
        <div class="row"><label class="field">Ingreso mensual previsto<div class="input-money"><input name="monthlyIncome" type="number" step="0.01" inputmode="decimal" value="${f.monthlyIncome ?? ''}" placeholder="Automático"><span>€</span></div></label>
          <label class="field">Día de cobro<input name="payday" type="number" min="1" max="31" value="${f.payday ?? ''}" placeholder="1-31"></label></div>
        <div class="row"><label class="field">Ahorro mensual objetivo<div class="input-money"><input name="savingsGoal" type="number" step="0.01" inputmode="decimal" value="${f.savingsGoal ?? ''}" placeholder="Opcional"><span>€</span></div></label>
          <label class="field">Avisar si el saldo baja de<div class="input-money"><input name="lowBalance" type="number" step="1" min="0" value="${f.lowBalance}"><span>€</span></div></label></div>
        ${accs.length ? `<label class="field">Cuenta principal<select name="defaultAccountId">${accs.map((a) => `<option value="${a.id}" ${a.id === f.defaultAccountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : ''}
        <p class="set-desc">Si dejas vacío el ingreso, se calcula con la media de tus últimos meses. Moneda: euro (€).</p>
        <button class="btn primary">${ic('check', 'sm')}Guardar</button>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('bell-ring', 'sm')}Avisos dentro de la app</h3></div>
      <p class="set-desc">Aparecen en la campana. Los correos se configuran arriba.</p>
      ${[['bills', 'calendar-clock', 'Facturas próximas y vencidas'], ['budgets', 'target', 'Presupuestos (al acercarte y al superarlos)'], ['anomalies', 'circle-alert', 'Gastos anormales o duplicados'], ['forecast', 'chart-line', 'Previsión de saldo bajo'], ['weekly', 'calendar-range', 'Resumen semanal'], ['monthly', 'file-text', 'Informe mensual'], ['goals', 'trophy', 'Objetivos de ahorro conseguidos']]
        .map(([k, i, t]) => `<label class="switch-row"><span class="ichip sm">${ic(i, 'sm')}</span><span class="txt"><b>${t}</b></span><span class="switch"><input type="checkbox" data-n="${k}" ${f.notifyApp[k] ? 'checked' : ''}><span></span></span></label>`).join('')}
    </div>
  </div>
  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>${ic('flask-conical', 'sm')}Datos de demostración</h3>${demo.active ? '<span class="badge warn">Activos</span>' : ''}</div>
      <p class="set-desc">Prueba la app con 3 meses de datos inventados (cuentas, gastos, nómina, facturas, presupuestos y una hucha). Van marcados como «demo» y se borran sin tocar tus datos reales.</p>
      ${demo.active ? `<button class="btn danger" id="demoDel">${ic('trash-2', 'sm')}Borrar datos de demostración (${demo.count})</button>` : `<button class="btn" id="demoAdd">${ic('flask-conical', 'sm')}Cargar datos de demostración</button>`}
      <button class="btn ghost" id="obAgain" style="margin-left:4px">${ic('rocket', 'sm')}Repetir la bienvenida</button>
    </div>
    <div class="card">
      <div class="card-head"><h3>${ic('database', 'sm')}Tus datos</h3></div>
      <p class="set-desc">Tus datos son tuyos (RGPD): puedes descargarlos todos o eliminar tu cuenta y todo su contenido.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="expJson">${ic('download', 'sm')}Descargar todo (JSON)</button>
        <button class="btn" id="expCsv">${ic('file-down', 'sm')}Movimientos (CSV)</button>
        <button class="btn danger" id="delAcc">${ic('user-x', 'sm')}Eliminar mi cuenta</button>
      </div>
    </div>
  </div>`,
  };
}
function bindFinanceSettings() {
  $('#finForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target));
    try {
      await api('/finance-settings', { method: 'PUT', body: { monthlyIncome: d.monthlyIncome, payday: d.payday, savingsGoal: d.savingsGoal, lowBalance: d.lowBalance === '' ? 0 : d.lowBalance, ...(d.defaultAccountId ? { defaultAccountId: d.defaultAccountId } : {}) } });
      toast('Guardado');
    } catch (e) { toast(e.message, true); }
  };
  $$('input[data-n]').forEach((i) => i.addEventListener('change', async () => {
    const notifyApp = Object.fromEntries($$('input[data-n]').map((x) => [x.dataset.n, x.checked]));
    try { await api('/finance-settings', { method: 'PUT', body: { notifyApp } }); toast('Preferencias guardadas'); } catch (e) { toast(e.message, true); }
  }));
  $('#demoAdd')?.addEventListener('click', async (e) => { e.currentTarget.disabled = true; try { const r = await api('/demo', { method: 'POST' }); await loadAccounts(); toast(`${r.created} datos de demostración cargados`); route(); } catch (x) { toast(x.message, true); } });
  $('#demoDel')?.addEventListener('click', () => confirmModal('Borrar datos de demostración', 'Se borrarán solo los datos marcados como demo. Tus datos reales no se tocan.', async () => { await api('/demo', { method: 'DELETE' }); await loadAccounts(); toast('Datos de demostración borrados'); route(); }));
  $('#obAgain').onclick = () => onboarding();
  $('#expJson').onclick = () => download('/me/export', 'mis-datos.json').catch((e) => toast(e.message, true));
  $('#expCsv').onclick = () => download('/export.csv', 'movimientos.csv').catch((e) => toast(e.message, true));
  $('#delAcc').onclick = () => openModal({
    title: 'Eliminar mi cuenta',
    icon: 'user-x',
    danger: true,
    okText: 'Eliminar definitivamente',
    html: `<div class="notice warn" style="margin-bottom:14px">${ic('triangle-alert', 'sm')}<span>Se borrarán para siempre tu cuenta, tus gastos, ingresos, tickets y fotos. No se puede deshacer. Descarga antes tus datos si los quieres conservar.</span></div>
      <label class="field">Tu contraseña<div class="input-icon pw-wrap">${ic('lock')}<input name="password" type="password" required autocomplete="current-password"><button type="button" class="pw-eye" tabindex="-1">${ic('eye')}</button></div></label>
      ${me.twoFactor ? '<label class="field">Código de verificación<input name="code" class="code-input" inputmode="numeric" maxlength="6" placeholder="000000" required></label>' : ''}`,
    onSubmit: async (d) => {
      await api('/me/delete', { method: 'POST', body: d });
      toast('Tu cuenta se ha eliminado');
      showAuth();
    },
  });
}

// ================= Calendario (datos del mes) =================
async function calendarData(month) {
  return api('/calendar?month=' + month);
}

$('#notifBtn').onclick = openNotifs;
$('#notifMobile').onclick = openNotifs;
