/* Agenda de Gastos · Mi dinero (patrimonio, cuentas, huchas y bancos conectados), revisión inteligente y clasificación */

const MOV_TYPES = {
  expense: 'Gasto', card: 'Compra con tarjeta', bill: 'Recibo domiciliado', subscription: 'Suscripción', fee: 'Comisión bancaria', cash_withdrawal: 'Retirada de efectivo',
  transfer_out: 'Transferencia a otra persona', card_settlement: 'Pago de tarjeta de crédito', income: 'Ingreso', refund: 'Devolución', cash_deposit: 'Ingreso de efectivo', transfer: 'Traspaso entre mis cuentas',
};
const dmy = (s) => (s ? parse(s).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const dtTxt = (iso) => (iso ? new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const SRC_TXT = { banco: 'tu banco (conexión)', extracto: 'el extracto importado', manual: 'lo que indicaste', calculado: 'tus movimientos' };

// ================= MI DINERO =================
async function renderAccounts(el) {
  const [w, bank, transfers] = await Promise.all([api('/wealth'), api('/banks/status'), api('/transfers'), loadAccounts()]);
  const q = getQuery();
  const backFromBank = q.get('banco');
  if (backFromBank) history.replaceState(null, '', '#/cuentas');
  const g = w.byGroup;
  const tile = (label, value, sub, icon, cls = '') => `<div class="card stat mini"><div class="top"><span class="label">${label}</span><span class="ichip ${cls}">${ic(icon)}</span></div><div><div class="value ${value < 0 ? 'neg' : ''}">${eur(value)}</div><div class="sub">${sub}</div></div></div>`;
  const notices = [];
  for (const c of bank.connections.filter((c) => c.status === 'caducada' || c.renewSoon)) notices.push(`<div class="notice warn">${ic('triangle-alert', 'sm')}<span><b>${c.status === 'caducada' ? `La conexión con ${esc(c.bank)} ha caducado` : `La conexión con ${esc(c.bank)} caduca en ${c.daysLeft} días`}</b><small>Sus saldos pueden estar desfasados hasta que la renueves.</small></span><button class="btn sm" data-renew="${c.id}">Renovar</button></div>`);
  for (const c of bank.connections.filter((c) => c.status === 'elegir')) notices.push(`<div class="notice blue">${ic('landmark', 'sm')}<span><b>Elige qué cuentas de ${esc(c.bank)} quieres añadir</b></span><button class="btn sm primary" data-choose="${c.id}">Elegir cuentas</button></div>`);
  if (w.unassignedPiggies.length) notices.push(`<div class="notice">${ic('piggy-bank', 'sm')}<span><b>¿Dónde está el dinero de ${w.unassignedPiggies.map(esc).join(', ')}?</b><small>Mientras no lo indiques, se considera apartado dentro de tu cuenta principal (así no se cuenta dos veces).</small></span><a class="btn sm" href="#/ahorros">Indicarlo</a></div>`);
  const staleN = w.stale.length;
  el.innerHTML = `
  ${notices.join('')}
  <div class="grid g4 stats wealth-tiles">
    <div class="card stat hero-stat"><div class="top"><span class="label">Patrimonio total</span><span class="ichip">${ic('landmark')}</span></div>
      <div><div class="value ${w.total < 0 ? 'neg' : ''}">${eur(w.total)}</div><div class="sub">${staleN ? `${ic('clock', 'xs')}${staleN} cuenta${staleN === 1 ? '' : 's'} sin confirmar con el banco` : `${ic('circle-check', 'xs')}Saldos confirmados con el banco`}</div></div></div>
    ${tile('Disponible para gastar', w.availableToSpend, 'Este mes, sin ahorros ni pagos pendientes', 'wallet', 'green')}
    ${tile('Reservado para ahorro', w.reservedForSavings, 'Cuentas de ahorro y huchas', 'piggy-bank', 'amber')}
    ${tile('Cuentas corrientes', g.corriente, `${w.accounts.filter((a) => a.group === 'corriente').length} cuenta(s)`, 'landmark')}
    ${tile('Cuentas de ahorro', g.ahorro, 'Ahorro y depósitos', 'piggy-bank')}
    ${tile('Huchas', w.piggyTotal, w.separatePiggies ? `${eur(w.separatePiggies)} aparte de tus cuentas` : 'Dentro de tus cuentas', 'coins')}
    ${tile('Efectivo', g.efectivo, 'Apuntado a mano', 'banknote')}
    ${w.accounts.some((a) => a.group === 'credito') ? tile('Deudas de tarjetas', w.debt, w.debt ? 'Pendiente de pagar' : 'Sin deuda', 'credit-card', w.debt ? 'red' : '') : tile('Pagos pendientes', w.reservedBills, 'Pagos fijos hasta fin de mes', 'calendar-clock', 'amber')}
  </div>

  <div class="grid g3">
    <div class="card span2"><div class="card-head"><h3>${ic('chart-pie', 'sm')}Dónde está tu dinero</h3><div class="btn-group"><button class="btn sm" id="btnTransfer">${ic('arrow-left-right', 'sm')}Transferir</button><button class="btn sm" id="btnImpAcc">${ic('upload', 'sm')}Importar extracto</button></div></div>
      ${w.accounts.length ? `<div class="dist-bar">${w.accounts.filter((a) => a.share > 0).map((a) => `<span style="flex:${a.share};--c:${safeColor(a.color || '#1e3a8a')}" title="${esc(a.name)} · ${a.share} %"></span>`).join('')}</div>` : ''}
      <div class="acc-grid" id="accGrid">${w.accounts.map(accountCard).join('') || emptyHtml('landmark', 'Añade o conecta tu primera cuenta', 'Indica tu cuenta del banco, tarjeta o efectivo con su saldo, o conecta tu banco para que se actualice solo.', `<button class="btn primary sm" id="emptyAcc">${ic('plus', 'sm')}Añadir cuenta</button>`)}</div>
      ${w.piggies.length ? `<div class="mini-label" style="margin-top:14px">Huchas</div><div class="list">${w.piggies.map((p) => `<div class="li">${catIc({ color: p.color, icon: p.icon || 'piggy-bank' }, 'sm')}<div class="main"><b>${esc(p.name)}</b><small>${p.location === 'separada' ? 'Aparte de tus cuentas · se suma al total' : `Apartado dentro de ${esc(w.accounts.find((a) => a.id === p.accountId)?.name || 'tu cuenta principal')} · no se suma dos veces`}</small></div><div class="amt">${eur(p.balance)}</div></div>`).join('')}</div>` : ''}
    </div>
    <div class="card"><div class="card-head"><h3>${ic('chart-line', 'sm')}Evolución</h3></div><div class="chart-box" style="height:200px"><canvas id="wEvo"></canvas></div>
      <p class="set-desc" style="margin:8px 0 0">Saldo de todas tus cuentas a final de cada mes, calculado con el último saldo del banco y tus movimientos.</p></div>
  </div>

  <div class="grid g2">
    ${bankCard(bank)}
    <div class="card"><div class="card-head"><h3>${ic('arrow-left-right', 'sm')}Transferencias y ajustes</h3></div>
      <div class="list" id="trList">${transfers.slice(0, 10).map((t) => `<div class="li"><span class="ichip sm ${t.type === 'adjust' ? 'amber' : ''}">${ic(t.type === 'adjust' ? 'scale' : 'arrow-left-right', 'sm')}</span>
        <div class="main"><b>${t.type === 'adjust' ? `Ajuste · ${esc(accOf(t.toId)?.name || '')}` : `${esc(accOf(t.fromId)?.name || '?')} → ${esc(accOf(t.toId)?.name || '?')}`}</b><small>${fmtDate(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</small></div>
        <div class="amt">${t.type === 'adjust' ? signed(t.amount) : eur(t.amount)}</div><div class="row-actions"><button class="icon-btn sm danger" data-deltr="${t.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></div></div>`).join('') || emptyHtml('arrow-left-right', 'Sin transferencias', 'Los traspasos entre tus cuentas no cuentan como gasto ni como ingreso.')}</div></div>
  </div>`;
  hydrate(el);
  chart($('#wEvo'), { type: 'line', data: { labels: w.evolution.map((p) => fmtDate(p.date)), datasets: [{ data: w.evolution.map((p) => p.total), borderColor: cssVar('--primary'), backgroundColor: 'transparent', tension: 0.3, pointRadius: 3 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: moneyTooltip }, scales: { y: { ...moneyAxis, beginAtZero: false }, x: { grid: { display: false } } } } });
  $('#emptyAcc')?.addEventListener('click', () => accountForm());
  $('#btnTransfer').onclick = () => transferForm();
  $('#btnImpAcc').onclick = () => openImport();
  $('#accGrid').onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const a = accs.find((x) => x.id === (b.dataset.mov || b.dataset.bal || b.dataset.tr || b.dataset.edit || b.dataset.del));
    if (!a) return;
    if (b.dataset.mov) accountMovements(a);
    if (b.dataset.bal) bankBalanceForm(a);
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
  bindBank(el, bank);
  if (backFromBank === 'error' || backFromBank === 'cancelado') toast(backFromBank === 'cancelado' ? 'Has cancelado la conexión en el banco' : 'No se ha podido completar la conexión con el banco', true);
  else if (backFromBank) { const c = bank.connections.find((x) => x.id === backFromBank); if (c?.status === 'elegir') chooseAccounts(c); else if (c) toast(`Conexión con ${c.bank} renovada`); }
}

function accountCard(a) {
  const b = a.balances || {};
  const fresh = a.confirmed
    ? `<span class="badge ok">${ic('circle-check', 'xs')}Confirmado por el banco</span>`
    : b.at ? `<span class="badge ${a.stale ? 'warn' : ''}">${ic('clock', 'xs')}${a.stale ? 'Puede estar desfasado' : 'Estimado'}</span>` : `<span class="badge warn">${ic('calculator', 'xs')}Calculado, sin dato del banco</span>`;
  return `<div class="card acc-card" data-id="${a.id}" style="--c:${safeColor(a.color || '#1e3a8a')}">
    <div class="top">${accIc(a)}<div class="main"><b>${esc(a.name)}</b><small>${esc(a.typeLabel)}${a.bankName ? ' · ' + esc(a.bankName) : ''}${a.iban ? ' · ' + esc(a.iban) : ''}${a.id === me.finance?.defaultAccountId ? ' · Principal' : ''}</small></div>${a.connectionId ? `<span class="badge primary" title="Conectada con el banco">${ic('link', 'xs')}</span>` : ''}</div>
    <div class="acc-balance ${a.balance < 0 ? 'neg' : ''}">${eur(a.balance)}<span class="share">${a.share ? a.share.toLocaleString('es-ES') + ' %' : ''}</span></div>
    <div class="acc-detail">
      ${b.booked != null ? `<span>Contable <b>${eur(b.booked)}</b></span>` : ''}${b.available != null ? `<span>Disponible <b>${eur(b.available)}</b></span>` : ''}${b.pending ? `<span>Retenido <b>${eur(b.pending)}</b></span>` : ''}
      ${a.reserved ? `<span>En huchas <b>${eur(a.reserved)}</b></span><span>Libre <b>${eur(a.free)}</b></span>` : ''}
    </div>
    <div class="acc-fresh">${fresh}<small>${b.at ? `Saldo según ${SRC_TXT[b.source] || b.source} del ${dmy(b.at)}${b.updatedAt ? ` (${dtTxt(b.updatedAt)})` : ''}${b.estimated !== b.booked ? ` + movimientos posteriores` : ''}` : 'Saldo inicial + tus movimientos'}</small></div>
    ${a.reconcile ? `<div class="acc-recon">${ic('scale', 'xs')}Tus movimientos no cuadran con el banco por ${signed(a.reconcile)} (falta algo por apuntar o importar).</div>` : ''}
    <div class="btns">
      <button class="btn sm" data-mov="${a.id}">${ic('list', 'sm')}Movimientos</button>
      <button class="btn sm" data-bal="${a.id}" title="Actualizar con el saldo que te muestra el banco">${ic('refresh-cw', 'sm')}Saldo real</button>
      <button class="icon-btn sm" data-tr="${a.id}" title="Transferir">${ic('arrow-left-right', 'sm')}</button>
      <button class="icon-btn sm" data-edit="${a.id}" title="Editar">${ic('pencil', 'sm')}</button>
      <button class="icon-btn sm danger" data-del="${a.id}" title="Eliminar">${ic('trash-2', 'sm')}</button>
    </div></div>`;
}

// Saldo que te muestra el banco: pasa a ser la referencia de la cuenta
function bankBalanceForm(a) {
  openModal({
    title: `Saldo real · ${a.name}`,
    icon: 'refresh-cw',
    html: `<p class="set-desc">Copia el saldo que te muestra la app o la web de tu banco. A partir de ahí, la app suma los movimientos posteriores.</p>
      <div class="row">
        <label class="field">Saldo (contable)<div class="input-money"><input name="booked" type="number" step="0.01" inputmode="decimal" required placeholder="0,00"><span>€</span></div></label>
        <label class="field">Disponible (opcional)<div class="input-money"><input name="available" type="number" step="0.01" inputmode="decimal" placeholder="Igual"><span>€</span></div></label>
      </div>
      <label class="field">Fecha del saldo<input name="at" type="date" required value="${ymd(todayD())}" max="${ymd(todayD())}"></label>
      <p class="set-desc">Si el disponible es menor, la diferencia son cargos retenidos o pendientes.</p>`,
    onSubmit: async (d) => {
      const r = await api(`/accounts/${a.id}/bank-balance`, { method: 'POST', body: { booked: Number(d.booked), available: d.available === '' ? null : Number(d.available), at: d.at } });
      await loadAccounts();
      toast(r.reconcile ? `Saldo actualizado. Tus movimientos no cuadraban por ${eur(r.reconcile)}` : 'Saldo actualizado');
      route();
    },
  });
}

// ---------- Bancos conectados ----------
function bankCard(bank) {
  const st = { activa: ['Activa', 'ok'], caducada: ['Caducada', 'red'], elegir: ['Elige cuentas', 'warn'], pendiente: ['Pendiente', ''], error: ['Error', 'red'] };
  if (!bank.available) return `<div class="card"><div class="card-head"><h3>${ic('shield-check', 'sm')}Conexión con tu banco</h3><span class="badge">No activada</span></div>
    <p class="set-desc">${esc(bank.note || '')}</p>
    <p class="set-desc">Cuando se active, autorizarás la conexión en la web oficial de tu banco (Open Banking PSD2). Será solo de lectura: la app nunca verá tus claves ni podrá hacer pagos.</p>
    <button class="btn sm" id="bkImport">${ic('upload', 'sm')}Importar un extracto</button></div>`;
  return `<div class="card"><div class="card-head"><h3>${ic('shield-check', 'sm')}Bancos conectados</h3><button class="btn sm primary" id="bkConnect">${ic('plus', 'sm')}Conectar banco</button></div>
    <p class="set-desc">Solo lectura. Autorizas en la web oficial de tu banco: la app nunca ve tus claves ni puede hacer pagos. Se actualiza sola cada pocas horas.</p>
    <div class="list">${bank.connections.map((c) => `<div class="li bank-conn">
      <span class="ichip sm">${ic('landmark', 'sm')}</span>
      <div class="main"><b>${esc(c.bank)} <span class="badge ${st[c.status]?.[1] || ''}">${st[c.status]?.[0] || esc(c.status)}</span></b>
        <small>${c.accounts.filter((a) => a.included).length} de ${c.accounts.length} cuentas · ${c.lastSync ? `actualizado ${dtTxt(c.lastSync)}` : 'sin actualizar'}${c.validUntil ? ` · permiso hasta el ${dmy(c.validUntil.slice(0, 10))}` : ''}${c.providerName ? ` · vía ${esc(c.providerName)}` : ''}</small>
        ${c.lastError ? `<small class="neg">${esc(c.lastError)}</small>` : ''}</div>
      <div class="row-actions">
        ${c.status === 'elegir' ? `<button class="btn sm" data-choose="${c.id}">Elegir</button>` : ''}
        ${c.status === 'activa' ? `<button class="icon-btn sm" data-sync="${c.id}" title="Actualizar ahora">${ic('refresh-cw', 'sm')}</button><button class="icon-btn sm" data-choose="${c.id}" title="Cuentas">${ic('list', 'sm')}</button>` : ''}
        ${['caducada', 'error'].includes(c.status) || c.renewSoon ? `<button class="btn sm" data-renew="${c.id}">Renovar</button>` : ''}
        <button class="icon-btn sm danger" data-disc="${c.id}" title="Desconectar">${ic('unlink', 'sm')}</button>
      </div></div>`).join('') || `<p class="muted" style="margin:6px 0">Todavía no has conectado ningún banco.</p>`}</div>
    ${bank.syncs.length ? `<details class="sync-log"><summary>Historial de sincronizaciones</summary><div class="list">${bank.syncs.slice(0, 8).map((s) => `<div class="li"><div class="main"><b>${esc(s.bank || '')} · ${esc(s.status)}</b><small>${dtTxt(s.at)} · ${esc(s.reason || '')} · ${s.imported || 0} nuevos${s.duplicates ? `, ${s.duplicates} ya estaban` : ''}${s.errors?.length ? ' · ' + esc(s.errors[0]) : ''}</small></div></div>`).join('')}</div></details>` : ''}
  </div>`;
}
function bindBank(el, bank) {
  $('#bkImport')?.addEventListener('click', () => openImport());
  $('#bkConnect')?.addEventListener('click', () => connectBank(bank));
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-sync],[data-renew],[data-choose],[data-disc]');
    if (!b) return;
    const c = bank.connections.find((x) => x.id === (b.dataset.sync || b.dataset.renew || b.dataset.choose || b.dataset.disc));
    if (!c) return;
    try {
      if (b.dataset.sync) {
        b.disabled = true;
        const r = await api(`/banks/connections/${c.id}/sync`, { method: 'POST' });
        toast(r.sync.status === 'ok' ? `Actualizado: ${r.sync.imported} movimientos nuevos` : `Actualización ${r.sync.status}: ${r.sync.errors[0] || ''}`, r.sync.status !== 'ok');
        await loadAccounts();
        route();
      }
      if (b.dataset.renew) { const r = await api(`/banks/connections/${c.id}/renew`, { method: 'POST' }); location.href = r.url; }
      if (b.dataset.choose) chooseAccounts(c);
      if (b.dataset.disc) disconnectBank(c);
    } catch (e) { toast(e.message, true); b.disabled = false; }
  });
}
async function connectBank(bank) {
  const provs = bank.providers;
  let prov = provs.find((p) => !p.demo) || provs[0];
  const list = async (p) => api('/banks/list?provider=' + p.id);
  let banks = await list(prov).catch((e) => { toast(e.message, true); return []; });
  openModal({
    title: 'Conectar banco',
    icon: 'landmark',
    okText: 'Ir a mi banco',
    html: `${provs.length > 1 ? `<label class="field">Servicio<select name="provider">${provs.map((p) => `<option value="${p.id}" ${p.id === prov.id ? 'selected' : ''}>${esc(p.name)}${p.demo ? ' (simulado, para probar)' : ''}</option>`).join('')}</select></label>` : ''}
      <label class="field">Tu banco<input name="q" id="bkQ" placeholder="Busca tu banco…" autocomplete="off"></label>
      <select name="bank" id="bkSel" size="6" required class="bank-select">${banks.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select>
      <div class="notice" style="margin-top:12px">${ic('shield-check', 'sm')}<span>Irás a la web oficial de tu banco para autorizar <b>solo la lectura</b> de cuentas, saldos y movimientos (hasta 90 días, renovable). Nunca escribes tus claves en esta app y no se pueden hacer pagos.</span></div>
      ${prov.demo ? `<p class="set-desc" style="margin-top:8px">El banco de demostración no es real: sirve para probar la conexión sin usar tus cuentas.</p>` : ''}`,
    onSubmit: async (d) => {
      if (!d.bank) throw new Error('Elige tu banco');
      const name = $('#bkSel').selectedOptions[0]?.textContent || d.bank;
      const r = await api('/banks/connect', { method: 'POST', body: { provider: d.provider || prov.id, bank: d.bank, bankName: name } });
      location.href = r.url;
    },
  });
  const paint = () => {
    const q = $('#bkQ').value.toLowerCase();
    $('#bkSel').innerHTML = banks.filter((b) => b.name.toLowerCase().includes(q)).map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  };
  $('#bkQ').oninput = paint;
  const ps = $('#modalBody select[name=provider]');
  if (ps) ps.onchange = async () => { prov = provs.find((p) => p.id === ps.value); banks = await list(prov).catch(() => []); paint(); };
}
function chooseAccounts(c) {
  const opts = (sel) => `<option value="new">Crear cuenta nueva</option>${accs.filter((a) => !a.connectionId || a.connectionId === c.id).map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>Enlazar con «${esc(a.name)}»</option>`).join('')}`;
  openModal({
    title: `Cuentas de ${c.bank}`,
    icon: 'landmark',
    okText: 'Añadir y actualizar',
    html: `<p class="set-desc">Elige qué cuentas quieres ver en la app. Si ya tenías una cuenta apuntada a mano, enlázala para no duplicarla.</p>
      <div class="choose-list">${c.accounts.map((a, i) => `<div class="choose-acc">
        <label class="chk"><input type="checkbox" name="inc${i}" ${a.included || c.status === 'elegir' ? 'checked' : ''}><span><b>${esc(a.name)}</b><small>${esc(a.product || '')}${a.iban ? ' · ' + esc(a.iban) : ''}</small></span></label>
        <div class="row"><select name="type${i}">${Object.entries(ACC_TYPES).map(([k, [l]]) => `<option value="${k}" ${a.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select><select name="link${i}">${opts(a.accountId)}</select></div>
      </div>`).join('')}</div>
      <p class="set-desc">Las huchas o espacios que tu banco da como cuenta aparte se añaden como cuenta de ahorro. Si tu banco no las separa, créalas en «Ahorros» como apartado dentro de la cuenta.</p>`,
    onSubmit: async (d) => {
      const accounts = c.accounts.map((a, i) => ({ externalId: a.externalId, include: !!d['inc' + i], type: d['type' + i], accountId: d['link' + i] }));
      const r = await api(`/banks/connections/${c.id}/accounts`, { method: 'POST', body: { accounts } });
      await loadAccounts();
      toast(r.sync.status === 'ok' ? `Banco conectado: ${r.sync.imported} movimientos importados y clasificados` : `Conectado con avisos: ${r.sync.errors[0] || r.sync.status}`, r.sync.status !== 'ok');
      route();
    },
  });
}
function disconnectBank(c) {
  openModal({
    title: `Desconectar ${c.bank}`,
    icon: 'unlink',
    danger: true,
    okText: 'Desconectar',
    html: `<p style="margin:0 0 10px;color:var(--text-2)">Se retira el permiso de lectura. Tus cuentas se quedan en la app como manuales, con su último saldo.</p>
      <label class="switch-row"><span class="txt"><b>Borrar también los movimientos traídos del banco</b><small>No se puede deshacer. Lo que apuntaste a mano no se toca.</small></span><span class="switch"><input type="checkbox" name="del"><span></span></span></label>`,
    onSubmit: async (d) => {
      const r = await api(`/banks/connections/${c.id}${d.del ? '?deleteData=1' : ''}`, { method: 'DELETE' });
      await loadAccounts();
      toast(d.del ? `Banco desconectado y ${r.removed} movimientos borrados` : 'Banco desconectado');
      route();
    },
  });
}

// ================= REVISIÓN INTELIGENTE =================
const REV = { state: 'pending', sel: new Set() };
async function renderSmartReview(el) {
  const d = await api('/review?state=' + REV.state);
  REV.sel = new Set([...REV.sel].filter((k) => d.items.some((x) => `${x.kind}:${x.id}` === k)));
  const tab = (k, label, n) => `<button data-st="${k}" class="${REV.state === k ? 'on' : ''}">${label} <span class="muted">${n}</span></button>`;
  const conf = (c) => { const p = Math.round((c ?? 0) * 100); return `<span class="conf ${p >= 85 ? 'conf-alta' : p >= 60 ? 'conf-media' : 'conf-baja'}">${p}%</span>`; };
  el.innerHTML = `
  <div class="grid g4 stats">
    <div class="card stat mini"><div class="top"><span class="label">Pendientes</span><span class="ichip amber">${ic('circle-alert')}</span></div><div><div class="value">${d.counts.pending}</div><div class="sub">Sin categoría segura</div></div></div>
    <div class="card stat mini"><div class="top"><span class="label">Dudosos</span><span class="ichip">${ic('eye')}</span></div><div><div class="value">${d.counts.review}</div><div class="sub">Clasificados, revísalos</div></div></div>
    <div class="card stat mini"><div class="top"><span class="label">Automáticos</span><span class="ichip green">${ic('sparkles')}</span></div><div><div class="value">${d.counts.auto}</div><div class="sub">Confianza alta</div></div></div>
    <div class="card stat mini"><div class="top"><span class="label">Posibles duplicados</span><span class="ichip red">${ic('copy')}</span></div><div><div class="value">${d.counts.duplicates}</div><div class="sub">Mismo importe y día</div></div></div>
  </div>
  ${d.ownTransfers.length ? `<div class="card"><div class="card-head"><h3>${ic('arrow-left-right', 'sm')}¿Traspasos entre tus cuentas?</h3></div>
    <p class="set-desc">Estos pares parecen dinero que has movido de una cuenta tuya a otra. Si lo son, únelos: dejarán de contar como gasto e ingreso.</p>
    <div class="list">${d.ownTransfers.map((p) => `<div class="li"><div class="main"><b>${esc(accOf(p.expense.accountId)?.name || '?')} → ${esc(accOf(p.income.accountId)?.name || '?')} · ${eur(p.amount)}</b><small>«${esc(p.expense.name)}» (${fmtDate(p.expense.date)}) y «${esc(p.income.name)}» (${fmtDate(p.income.date)})${p.sure ? '' : ' · No hay palabras de traspaso: confírmalo'}</small></div>
      <div class="row-actions"><button class="btn sm primary" data-join="${p.expense.id}|${p.income.id}">Es un traspaso</button><button class="btn sm" data-nojoin="${p.expense.id}|${p.income.id}">No</button></div></div>`).join('')}</div></div>` : ''}
  <div class="card">
    <div class="toolbar" style="justify-content:space-between">
      <div class="seg sm" id="revTabs">${tab('pending', 'Pendientes', d.counts.pending)}${tab('review', 'Dudosos', d.counts.review)}${tab('auto', 'Automáticos', d.counts.auto)}${tab('confirmed', 'Confirmados', d.counts.confirmed)}</div>
      <div class="btn-group">${d.counts.auto ? `<button class="btn sm" id="revAccept">${ic('check-check', 'sm')}Aceptar las ${d.counts.auto} de confianza alta</button>` : ''}<button class="btn sm" id="revRe">${ic('refresh-cw', 'sm')}Reclasificar</button></div>
    </div>
    <div class="bulk-bar ${REV.sel.size ? '' : 'hidden'}" id="revBulk"><b id="revN">${REV.sel.size} seleccionados</b>
      <select id="revCat"><option value="">Cambiar categoría a…</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <button class="btn sm primary" id="revApply">Aplicar</button><button class="btn sm" id="revConfirm">${ic('check', 'sm')}Confirmar como están</button></div>
    <div class="xl-wrap"><table class="xl rev-table"><thead><tr><th><input type="checkbox" id="revAll" aria-label="Seleccionar todos"></th><th>Fecha</th><th>Movimiento</th><th>Categoría</th><th>Tipo</th><th class="num">Importe</th><th>Regla</th><th class="num">Confianza</th></tr></thead><tbody>
      ${d.items.map((x) => `<tr><td><input type="checkbox" data-k="${x.kind}:${x.id}" ${REV.sel.has(`${x.kind}:${x.id}`) ? 'checked' : ''}></td><td class="nowrap">${fmtDate(x.date)}</td>
        <td><b>${esc(x.name)}</b><small class="muted" style="display:block">${esc(x.merchant && x.merchant !== x.name ? x.merchant : '')}${x.subcategory ? ' · ' + esc(x.subcategory) : ''}${x.description && x.description !== x.name ? ' · ' + esc(x.description.slice(0, 70)) : ''}</small></td>
        <td>${x.kind === 'income' ? '<span class="muted">Ingreso</span>' : x.category ? catTag(x.category) : '<span class="badge warn">Sin categoría</span>'}</td>
        <td>${esc(MOV_TYPES[x.type] || x.type)}</td><td class="num nowrap">${signed(x.amount)}</td><td><small>${esc(x.rule || '')}</small></td><td class="num">${conf(x.confidence)}</td></tr>`).join('') || `<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">Nada por aquí 🎉</td></tr>`}
    </tbody></table></div>
  </div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h3>${ic('copy', 'sm')}Posibles duplicados</h3><a class="link" href="#/asistente?tab=alertas">Ver alertas${ic('chevron-right', 'xs')}</a></div>
      <div class="list">${d.duplicates.slice(0, 6).map((a) => `<div class="li"><div class="main"><b>${esc(a.title)}</b><small>${esc(a.text)}</small></div></div>`).join('') || '<p class="muted">No hay duplicados.</p>'}</div></div>
    <div class="card"><div class="card-head"><h3>${ic('tag', 'sm')}Reglas aprendidas recientemente</h3><a class="link" href="#/clasificacion">Gestionar${ic('chevron-right', 'xs')}</a></div>
      <div class="list">${d.rules.map((r) => `<div class="li"><div class="main"><b>${esc(RULE_TXT[r.match] || '')} «${esc(r.pattern)}»</b><small>→ ${esc(r.category || MOV_TYPES[r.type] || '')}${r.updatedAt ? ' · ' + dtTxt(r.updatedAt) : ''}</small></div></div>`).join('') || '<p class="muted">Cuando corrijas una categoría te preguntaré si quieres recordarlo.</p>'}</div></div>
  </div>`;
  hydrate(el);
  const paintBulk = () => { $('#revBulk').classList.toggle('hidden', !REV.sel.size); $('#revN').textContent = `${REV.sel.size} seleccionados`; };
  $$('#revTabs button').forEach((b) => (b.onclick = () => { REV.state = b.dataset.st; REV.sel.clear(); renderSmartReview(el); }));
  $$('.rev-table [data-k]').forEach((c) => (c.onchange = () => { c.checked ? REV.sel.add(c.dataset.k) : REV.sel.delete(c.dataset.k); paintBulk(); }));
  $('#revAll').onchange = (e) => { $$('.rev-table [data-k]').forEach((c) => { c.checked = e.target.checked; e.target.checked ? REV.sel.add(c.dataset.k) : REV.sel.delete(c.dataset.k); }); paintBulk(); };
  const items = () => [...REV.sel].map((k) => { const [kind, id] = k.split(':'); return { kind, id }; });
  $('#revApply').onclick = async () => {
    if (!$('#revCat').value) return toast('Elige la categoría', true);
    const r = await api('/review/bulk', { method: 'POST', body: { items: items(), categoryId: $('#revCat').value } });
    toast(`${r.updated} movimientos actualizados`); REV.sel.clear(); renderSmartReview(el);
  };
  $('#revConfirm').onclick = async () => { const r = await api('/review/bulk', { method: 'POST', body: { items: items() } }); toast(`${r.updated} confirmados`); REV.sel.clear(); renderSmartReview(el); };
  $('#revAccept')?.addEventListener('click', async () => { const r = await api('/review/accept-high', { method: 'POST' }); toast(`${r.accepted} clasificaciones aceptadas. Puedes cambiarlas cuando quieras.`); renderSmartReview(el); });
  $('#revRe').onclick = async () => { const r = await api('/review/reclassify', { method: 'POST' }); toast(r.changed ? `${r.changed} movimientos reclasificados` : 'No hay cambios'); renderSmartReview(el); };
  el.querySelectorAll('[data-join],[data-nojoin]').forEach((b) => (b.onclick = async () => {
    const [expenseId, incomeId] = (b.dataset.join || b.dataset.nojoin).split('|');
    if (b.dataset.join) { await api('/review/own-transfer', { method: 'POST', body: { expenseId, incomeId } }); toast('Unidos como traspaso entre tus cuentas'); await loadAccounts(); }
    else await api('/review/own-transfer/dismiss', { method: 'POST', body: { expenseId, incomeId } });
    renderSmartReview(el);
  }));
}

// ================= CLASIFICACIÓN (Ajustes) =================
const RULE_TXT = { merchant: 'El comercio es', contains: 'La descripción contiene', counterparty: 'Viene de / va a' };
const INCOME_SRC = { nomina: 'Nómina', freelance: 'Trabajo extra', ventas: 'Ventas', inversiones: 'Inversiones', alquiler: 'Alquiler', regalos: 'Regalos', devoluciones: 'Devoluciones', otros: 'Otros' };
async function renderClassification(el) {
  const [rules, dict] = await Promise.all([api('/rules'), api('/dictionary')]);
  const catSel = (name, sel, empty = 'Sin cambiar') => `<select name="${name}"><option value="">${empty}</option>${cats.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
  el.innerHTML = `
  <div class="grid g2">
    <div class="card"><div class="card-head"><h3>${ic('tag', 'sm')}Tus reglas</h3><button class="btn sm primary" id="ruleNew">${ic('plus', 'sm')}Nueva regla</button></div>
      <p class="set-desc">Tienen prioridad sobre todo lo demás. Se crean solas cuando corriges una categoría y aceptas recordarlo.</p>
      <div class="list">${rules.map((r) => `<div class="li"><div class="main"><b>${esc(RULE_TXT[r.match])} «${esc(r.pattern)}»</b><small>→ ${[r.category, r.subcategory, r.type ? MOV_TYPES[r.type] : '', r.incomeSource ? 'Ingreso: ' + INCOME_SRC[r.incomeSource] : ''].filter(Boolean).map(esc).join(' · ')}</small></div><button class="icon-btn sm danger" data-delrule="${r.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></div>`).join('') || '<p class="muted">Aún no tienes reglas.</p>'}</div></div>
    <div class="card"><div class="card-head"><h3>${ic('book-open', 'sm')}Tus palabras</h3><button class="btn sm primary" id="dictNew">${ic('plus', 'sm')}Añadir palabras</button></div>
      <p class="set-desc">Amplía el diccionario con comercios o palabras que la app no conoce.</p>
      <div class="list">${dict.own.map((d) => `<div class="li"><div class="main"><b>${d.words.map(esc).join(', ')}</b><small>→ ${esc(cats.find((c) => c.id === d.categoryId)?.name || '')}${d.subcategory ? ' · ' + esc(d.subcategory) : ''}</small></div><button class="icon-btn sm danger" data-deldict="${d.id}" title="Eliminar">${ic('trash-2', 'sm')}</button></div>`).join('') || '<p class="muted">Nada añadido.</p>'}</div></div>
  </div>
  <div class="card"><div class="card-head"><h3>${ic('list', 'sm')}Diccionario general de comercios</h3><span class="badge">${dict.general.length} grupos</span></div>
    <p class="set-desc">Puedes cambiar la categoría que se asigna a cada grupo o desactivarlo. Los cambios se aplican también a los movimientos que no has confirmado.</p>
    <div class="xl-wrap"><table class="xl dict-table"><thead><tr><th>Palabras</th><th>Subcategoría</th><th>Tu categoría</th><th>Activo</th></tr></thead><tbody>
      ${dict.general.filter((e) => !e.income).map((e) => `<tr data-entry="${e.id}"><td><b>${esc(e.category)}</b><small class="muted" style="display:block">${e.words.slice(0, 8).map(esc).join(', ')}${e.words.length > 8 ? ` y ${e.words.length - 8} más` : ''}</small></td><td>${esc(e.subcategory)}</td>
        <td>${catSel('cat', e.categoryId, 'Sin categoría')}</td><td><span class="switch"><input type="checkbox" ${e.disabled ? '' : 'checked'} aria-label="Activo"><span></span></span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="set-desc" style="margin-top:10px">La confianza de este diccionario está medida con un conjunto de control de movimientos que no se usó para ajustarlo (ver README).</p>
  </div>`;
  hydrate(el);
  $('#ruleNew').onclick = () => ruleForm();
  $('#dictNew').onclick = () => openModal({
    title: 'Añadir palabras', icon: 'book-open',
    html: `<label class="field">Palabras o comercios (separados por comas)<input name="words" required placeholder="Ej: PELUQUERIA, BARBERIA"></label>
      <div class="row"><label class="field">Categoría${catSel('categoryId', '', 'Elige…')}</label><label class="field">Subcategoría (opcional)<input name="subcategory" maxlength="40"></label></div>`,
    onSubmit: async (d) => { const r = await api('/dictionary', { method: 'POST', body: d }); toast(r.reclassified ? `Guardado. ${r.reclassified} movimientos reclasificados` : 'Guardado'); route(); },
  });
  el.querySelectorAll('[data-delrule]').forEach((b) => (b.onclick = async () => { await api('/rules/' + b.dataset.delrule, { method: 'DELETE' }); route(); }));
  el.querySelectorAll('[data-deldict]').forEach((b) => (b.onclick = async () => { await api('/dictionary/' + b.dataset.deldict, { method: 'DELETE' }); route(); }));
  el.querySelectorAll('.dict-table tr[data-entry]').forEach((tr) => {
    const save = async () => {
      const on = tr.querySelector('input[type=checkbox]').checked;
      const r = await api('/dictionary/general/' + tr.dataset.entry, { method: 'PUT', body: { categoryId: tr.querySelector('select').value || null, disabled: !on } });
      toast(r.reclassified ? `Guardado. ${r.reclassified} movimientos reclasificados` : 'Guardado');
    };
    tr.querySelector('select').onchange = save;
    tr.querySelector('input[type=checkbox]').onchange = save;
  });
}
function ruleForm(preset = {}) {
  openModal({
    title: 'Nueva regla', icon: 'tag', okText: 'Crear regla',
    html: `<div class="row"><label class="field">Si…<select name="match">${Object.entries(RULE_TXT).map(([k, l]) => `<option value="${k}" ${preset.match === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Texto<input name="pattern" required maxlength="60" value="${esc(preset.pattern || '')}" placeholder="Ej: AMAZON"></label></div>
      <div class="row"><label class="field">Categoría<select name="categoryId"><option value="">—</option>${cats.map((c) => `<option value="${c.id}" ${preset.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field">Subcategoría<input name="subcategory" maxlength="40"></label></div>
      <div class="row"><label class="field">Tipo de movimiento<select name="type"><option value="">Sin cambiar</option>${Object.entries(MOV_TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="field">Si es un ingreso, origen<select name="incomeSource"><option value="">—</option>${Object.entries(INCOME_SRC).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label></div>
      <label class="switch-row"><span class="txt"><b>Aplicar también a los movimientos que ya tengo</b><small>Solo a los que no has confirmado tú</small></span><span class="switch"><input type="checkbox" name="applyToExisting" checked><span></span></span></label>`,
    onSubmit: async (d) => { const r = await api('/rules', { method: 'POST', body: d }); toast(r.applied ? `Regla creada y aplicada a ${r.applied} movimientos` : 'Regla creada'); route(); },
  });
}
// Tras cambiar la categoría de un gasto: ¿recordarlo para los siguientes?
function offerRule(s) {
  const c = cats.find((x) => x.id === s.categoryId);
  openModal({
    title: '¿Recordar esta categoría?', icon: 'sparkles', okText: 'Sí, aplicar siempre',
    html: `<p style="margin:0 0 8px;color:var(--text-2)">Has puesto <b>${esc(s.merchant)}</b> en <b>${esc(c?.name || '')}</b>. ¿Quieres que los próximos movimientos de este comercio se clasifiquen igual automáticamente?</p>
      ${s.others ? `<label class="switch-row"><span class="txt"><b>Aplicarlo también a ${s.others} movimiento${s.others === 1 ? '' : 's'} parecido${s.others === 1 ? '' : 's'}</b><small>Los que no hayas confirmado tú</small></span><span class="switch"><input type="checkbox" name="applyToExisting" checked><span></span></span></label>` : ''}`,
    onSubmit: async (d) => { const r = await api('/rules', { method: 'POST', body: { match: s.match, pattern: s.pattern, categoryId: s.categoryId, applyToExisting: !!d.applyToExisting } }); toast(r.applied ? `Regla guardada y aplicada a ${r.applied} movimientos` : 'Regla guardada'); if (r.applied) route(); },
  });
}
