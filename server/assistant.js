// Asistente financiero.
// 1) Entiende la pregunta (reglas en español, gratis).  2) Consulta los datos.  3) Calcula en el servidor.
// 4) Redacta la respuesta con esas cifras. El modelo de IA (opcional, si hay ANTHROPIC_API_KEY) solo se usa
//    para preguntas que las reglas no entienden y recibe únicamente cifras ya calculadas, nunca datos personales.
const { db } = require('./db');
const D = require('./dates');
const L = require('./ledger');
const I = require('./insights');
const F = require('./forecast');
const { catInfo } = require('./summary');

const { round, sum, of } = L;
const fmt = I.fmt;
const norm = I.norm;
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const dLong = (s) => D.parse(s).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });

// Palabras que la gente usa para cada tipo de gasto -> patrón del nombre de categoría
const SYNONYMS = [
  [/restaurante|comer fuera|cenas?|bares?|cafeteri|copas|comida rapida|delivery|glovo|just eat|uber eats/, /comida|restaur|bar/],
  [/gasolina|gasoil|diesel|combustible|gasolinera|repsol|cepsa|galp|carburante/, /gasolin|combust|transporte|coche/],
  [/supermercado|super\b|mercadona|carrefour|lidl|aldi|dia\b|alimentacion|la compra/, /supermerc|aliment|compra semanal/],
  [/luz|electricidad|agua|gas\b|internet|telefono|movil|fibra|facturas?|recibos?/, /factura|suministro|luz|casa/],
  [/suscripcion|netflix|spotify|hbo|disney|prime video|plataformas/, /suscrip/],
  [/farmacia|medico|dentista|salud|medicinas?/, /salud|farmac/],
  [/ropa|amazon|tiendas?|compras online|zara/, /compras|ropa/],
  [/alquiler|hipoteca|vivienda|casa|comunidad/, /casa|vivienda|alquiler/],
  [/ocio|cine|conciertos?|juegos?|viajes?|vacaciones/, /ocio|viaje/],
  [/transporte|metro|autobus|bus\b|tren|taxi|uber|cabify|parking|peaje/, /transporte/],
];

function parsePeriod(q, t = D.today()) {
  const y = t.getFullYear(), m = t.getMonth();
  const range = (from, to, label) => ({ from: D.ymd(from), to: D.ymd(to), label });
  let x;
  if (/\bhoy\b/.test(q)) return range(t, t, 'hoy');
  if (/\bayer\b/.test(q)) return range(D.addDays(t, -1), D.addDays(t, -1), 'ayer');
  if (/semana pasada|ultima semana/.test(q)) { const s = D.addDays(D.weekStart(t), -7); return range(s, D.addDays(s, 6), 'la semana pasada'); }
  if (/esta semana|la semana\b/.test(q)) return range(D.weekStart(t), t, 'esta semana');
  if (/mes pasado|ultimo mes|mes anterior/.test(q)) return range(new Date(y, m - 1, 1), new Date(y, m, 0), `en ${MONTHS[(m + 11) % 12]}`);
  if (/ano pasado/.test(q)) return range(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31), `en ${y - 1}`);
  if (/este ano|en el ano|al ano|este ejercicio|en lo que va de ano/.test(q)) return range(new Date(y, 0, 1), t, `en ${y}`);
  if ((x = /ultimos? (\d{1,2}|tres|seis|doce|dos) meses/.exec(q))) {
    const n = { dos: 2, tres: 3, seis: 6, doce: 12 }[x[1]] || Number(x[1]);
    return range(new Date(y, m - n, 1), new Date(y, m, 0), `en los últimos ${n} meses`);
  }
  if ((x = /ultimos? (\d{1,3}) dias/.exec(q))) return range(D.addDays(t, -Number(x[1]) + 1), t, `en los últimos ${x[1]} días`);
  if (/trimestre/.test(q)) { const s = new Date(y, Math.floor(m / 3) * 3, 1); return range(s, t, 'este trimestre'); }
  for (const [i, name] of MONTHS.entries()) if (new RegExp(`\\b${name}\\b`).test(q)) {
    const yy = i > m ? y - 1 : y;
    return range(new Date(yy, i, 1), new Date(yy, i + 1, 0), `en ${name}${yy !== y ? ' de ' + yy : ''}`);
  }
  return range(new Date(y, m, 1), t, 'este mes');
}
function findCategory(user, q) {
  const cats = of(db.categories, user.id);
  for (const c of cats) if (norm(c.name).length >= 3 && new RegExp(`\\b${norm(c.name)}`).test(q)) return c;
  for (const [words, catRe] of SYNONYMS) if (words.test(q)) { const c = cats.find((c) => catRe.test(norm(c.name))); if (c) return c; }
  return null;
}
function findMerchant(user, q) {
  const places = [...new Set(of(db.expenses, user.id).map((e) => e.place).filter(Boolean))];
  return places.sort((a, b) => b.length - a.length).find((p) => norm(p).length >= 3 && q.includes(norm(p))) || null;
}
function findAmount(q) {
  const m = /(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*(?:€|euros?|eur\b|pavos)?/.exec(q.replace(/(\d)\s+(?=\d{3}\b)/g, '$1'));
  if (!m) return null;
  const n = Number(m[1].replace(/[.\s]/g, '') + (m[2] ? '.' + m[2] : ''));
  return n > 0 ? n : null;
}
const reply = (answer, extra = {}) => ({ answer, facts: [], items: [], suggestions: [], ...extra });

// ¿Están al día los saldos? Se avisa siempre que una respuesta use saldos de cuentas
function freshness(user) {
  const accs = L.accountBalances(user);
  const notes = [];
  const stale = accs.filter((a) => a.stale);
  const expired = (db.bankConnections || []).filter((c) => c.userId === user.id && (c.status === 'caducada' || (c.validUntil && c.validUntil < new Date().toISOString())));
  for (const c of expired) notes.push(`La conexión con ${c.bankName} ha caducado: sus saldos pueden estar desfasados.`);
  if (stale.length) {
    const txt = stale.slice(0, 4).map((a) => (a.balances?.at ? `${a.name} (dato del banco del ${dLong(a.balances.at)})` : `${a.name} (calculado con tus movimientos)`)).join(', ');
    notes.push(`Saldos sin confirmar con el banco en los últimos días: ${txt}.`);
  } else if (accs.length) notes.push('Saldos confirmados con el banco en los últimos 3 días.');
  return notes.join(' ');
}
const accLabel = (a) => `${a.name}${a.bankName ? ' · ' + a.bankName : ''}`;

const HELP = [
  '¿Cuánto dinero tengo en total?',
  '¿Cuánto puedo gastar sin tocar mis ahorros?',
  '¿Cuánto tengo en mis huchas?',
  '¿Cuánto he gastado este mes?',
  '¿Cuánto llevo gastado en restaurantes?',
  '¿Cuánto puedo gastar esta semana?',
  '¿Cuánto dinero tendré a final de mes?',
  '¿Puedo comprar algo de 900 euros?',
  '¿Cómo puedo ahorrar 200 euros al mes?',
  '¿Qué categoría ha aumentado más?',
  '¿Qué facturas tengo pendientes?',
];

function answerLocal(user, raw) {
  const q = norm(raw);
  const t = D.today();
  const exps = of(db.expenses, user.id);
  const incs = of(db.incomes, user.id);
  if (!q || /^(hola|buenas|hey|ayuda|que puedes hacer|que sabes hacer)\b/.test(q)) return reply('Hola. Soy tu asistente financiero: respondo con tus datos reales. Prueba alguna de estas preguntas:', { suggestions: HELP, intent: 'help' });

  // ¿Puedo permitirme / comprar algo de X €?
  if (/puedo (comprar|permitir|gastar(me)? \d)|me puedo (comprar|permitir)|permitirme|me lo puedo/.test(q) && findAmount(q)) {
    const price = findAmount(q);
    const monthly = /al mes|mensual|cada mes/.test(q);
    const s = F.simulate(user, { name: 'Compra', price, date: D.ymd(t), monthly });
    const facts = [
      { label: 'Saldo ahora', value: fmt(s.balanceBefore) },
      { label: 'Saldo tras la compra', value: fmt(s.balanceAfter) },
      { label: 'Fin de mes sin la compra', value: fmt(s.endOfMonthBefore) },
      { label: 'Fin de mes con la compra', value: fmt(s.endOfMonthAfter) },
      { label: 'Saldo mínimo previsto', value: `${fmt(s.minimumAfter.balance)} (${dLong(s.minimumAfter.date)})` },
    ];
    if (s.budgetRemainingAfter !== null) facts.push({ label: 'Presupuesto restante tras la compra', value: fmt(s.budgetRemainingAfter) });
    return reply(`${s.verdict} Riesgo: ${s.risk}.${s.hasAccounts ? '' : ' Ojo: no has añadido tus cuentas, así que parto de un saldo de 0 €.'}`, { facts, intent: 'simulate', link: { label: 'Abrir el simulador', href: '#/previsiones' } });
  }

  // ¿Cómo puedo ahorrar X € al mes?
  if (/como (puedo )?ahorrar|quiero ahorrar|ahorrar \d/.test(q)) {
    const goal = findAmount(q);
    const recs = I.recommendations(user).filter((r) => r.potential > 0);
    const items = [];
    let acc = 0;
    for (const r of recs) { if (goal && acc >= goal) break; items.push({ label: r.title, value: `≈ ${fmt(r.potential)}/mes` }); acc += r.potential; }
    const comp = I.categoryComparison(user, t).filter((c) => c.id && c.avg3 > 0 && !/factura|casa|vivienda|alquiler|salud|seguro/i.test(c.name));
    if (goal && acc < goal && comp.length) {
      const pool = comp.reduce((a, c) => a + c.avg3, 0);
      const need = goal - acc;
      for (const c of comp.slice(0, 4)) items.push({ label: `Recortar ${c.name} (gastas ${fmt(c.avg3)} al mes)`, value: `−${fmt(Math.min(c.avg3, (c.avg3 / pool) * need))}` });
      acc = goal;
    }
    if (!items.length) return reply('Todavía no tengo datos suficientes para proponerte un plan de ahorro. Apunta tus gastos de unas semanas y vuelve a preguntarme.', { intent: 'save' });
    return reply(goal ? `Para ahorrar ${fmt(goal)} al mes podrías combinar estas medidas (son estimaciones, no dinero ya ahorrado):` : 'Estas son las medidas con más ahorro potencial según tus datos (estimaciones):', { items, intent: 'save', link: { label: 'Crear presupuestos', href: '#/presupuestos' } });
  }

  if (/reduc|recort|consejo|mejorar|gastos innecesarios|optimiz/.test(q)) {
    const recs = I.recommendations(user).slice(0, 4);
    if (!recs.length) return reply('Ahora mismo no veo nada que recortar: tus gastos están en línea con lo habitual. ¡Bien hecho!', { intent: 'advice' });
    return reply('Esto es lo que yo revisaría:', { items: recs.map((r) => ({ label: r.title, value: r.potential ? `≈ ${fmt(r.potential)}/mes` : r.priority, detail: r.evidence.join(' · ') })), intent: 'advice' });
  }

  const money = L.moneySummary(user);

  // ---------- Patrimonio y cuentas (saldos reales de todas tus cuentas) ----------
  if (/sin tocar (mis |los )?ahorros|sin usar (mis |los )?ahorros|sin tocar (la |las )?huchas/.test(q)) {
    const w = L.wealth(user);
    return reply(`Sin tocar tus ahorros puedes usar ${fmt(money.available)} hasta fin de mes. Es el dinero de tus cuentas para gastar y el efectivo (${fmt(w.spendable)}, ya sin lo apartado en huchas), menos los pagos fijos pendientes (${fmt(money.reservedBills)})${money.reservedSavings ? ` y lo que te falta para tu objetivo de ahorro (${fmt(money.reservedSavings)})` : ''}.`, {
      facts: [{ label: 'Cuentas para gastar y efectivo', value: fmt(w.spendable) }, { label: 'Pagos pendientes', value: fmt(money.reservedBills) }, { label: 'Ahorros que no se tocan', value: fmt(w.reservedForSavings) }, { label: 'Al día', value: fmt(money.perDayBalance) }],
      intent: 'spendable-safe', note: freshness(user),
    });
  }
  if (/huchas?\b|apartado/.test(q) && !/crear|nueva|anadir/.test(q)) {
    const w = L.wealth(user);
    if (!w.piggies.length) return reply('No tienes huchas. Puedes crearlas en «Mi dinero → Ahorros» e indicar si el dinero está dentro de una cuenta o aparte.', { intent: 'piggies' });
    return reply(`Tienes ${fmt(w.piggyTotal)} en ${w.piggies.length} hucha${w.piggies.length === 1 ? '' : 's'}.${w.piggies.some((p) => p.location === 'virtual') ? ' Las que están dentro de una cuenta ya forman parte de su saldo: no se suman dos veces.' : ''}`, {
      items: w.piggies.map((p) => ({ label: p.name, value: fmt(p.balance), detail: p.location === 'separada' ? 'Aparte de tus cuentas' : `Dentro de ${db.accounts.find((a) => a.id === p.accountId)?.name || 'tu cuenta principal'}` })),
      intent: 'piggies', note: freshness(user),
    });
  }
  if (/(tengo|hay) ahorrado|mis ahorros|dinero ahorrado|cuanto ahorro tengo/.test(q) && !/este ano|este mes|ano pasado|mes pasado|conseguido/.test(q)) {
    const w = L.wealth(user);
    const savingAccs = w.accounts.filter((a) => a.group === 'ahorro');
    return reply(`Tienes ${fmt(w.reservedForSavings)} ahorrados: ${fmt(w.byGroup.ahorro)} en cuentas de ahorro y depósitos y ${fmt(w.piggyTotal)} en huchas.`, {
      items: [...savingAccs.map((a) => ({ label: accLabel(a), value: fmt(a.balance) })), ...w.piggies.map((p) => ({ label: `Hucha ${p.name}`, value: fmt(p.balance) }))],
      intent: 'saved-stock', note: freshness(user),
    });
  }
  const namedAcc = L.accountBalances(user).some((a) => norm(a.name).length >= 3 && q.includes(norm(a.name)));
  if (!(namedAcc && !/en total|patrimonio/.test(q)) && (/en total|patrimonio|todo mi dinero|todas mis cuentas|cuanto dinero tengo|dinero tengo en total/.test(q) || (/cuanto tengo/.test(q) && !/cuenta|banco/.test(q) && !/gastad|pagar/.test(q)))) {
    const w = L.wealth(user);
    if (!w.accounts.length) return reply('Aún no has añadido tus cuentas, así que no sé cuánto dinero tienes. Añádelas en «Mi dinero» o conecta tu banco.', { intent: 'networth', link: { label: 'Mi dinero', href: '#/cuentas' } });
    return reply(`En total tienes ${fmt(w.total)}. De eso, ${fmt(money.available)} está disponible para gastar este mes y ${fmt(w.reservedForSavings)} está ahorrado.`, {
      facts: [
        { label: 'Cuentas corrientes', value: fmt(w.byGroup.corriente) }, { label: 'Cuentas de ahorro', value: fmt(w.byGroup.ahorro) },
        { label: 'Huchas', value: fmt(w.piggyTotal) }, { label: 'Efectivo', value: fmt(w.byGroup.efectivo) },
        ...(w.debt ? [{ label: 'Deuda de tarjetas', value: fmt(w.debt) }] : []),
      ],
      items: w.accounts.map((a) => ({ label: accLabel(a), value: fmt(a.balance), detail: a.reserved ? `${fmt(a.reserved)} apartados en huchas` : '' })),
      intent: 'networth', note: freshness(user), link: { label: 'Ver Mi dinero', href: '#/cuentas' },
    });
  }
  {
    const accsAll = L.accountBalances(user);
    const named = accsAll.find((a) => norm(a.name).length >= 3 && q.includes(norm(a.name)));
    const main = /cuenta principal|cuenta corriente|cuenta de la nomina|cuenta nomina/.test(q) ? (L.defaultAccount(user) && accsAll.find((a) => a.id === L.defaultAccount(user).id)) : null;
    const acc = named || main;
    if (acc && /cuanto|saldo|tengo|hay/.test(q)) {
      const b = acc.balances;
      return reply(`En ${acc.name} tienes ${fmt(acc.balance)}${b.source !== 'calculado' ? (acc.confirmed ? ', confirmado con el banco' : ` (el banco dio ${fmt(b.booked)} el ${dLong(b.at)} y se han sumado los movimientos de después)`) : ' (calculado con tus movimientos; no hay saldo del banco)'}.`, {
        facts: [...(b.available != null ? [{ label: 'Disponible según el banco', value: fmt(b.available) }] : []), ...(b.pending ? [{ label: 'Retenido o pendiente', value: fmt(b.pending) }] : [])],
        intent: 'account', note: freshness(user),
      });
    }
  }
  if (/puedo gastar|me queda para gastar|disponible para gastar|cuanto gasto (hoy|al dia)/.test(q)) {
    const week = /semana/.test(q);
    const daysWeek = 7 - ((t.getDay() + 6) % 7);
    const value = week ? round(money.perDay * Math.min(daysWeek, money.daysLeft)) : money.perDay;
    const byBalance = week ? round(money.perDayBalance * Math.min(daysWeek, money.daysLeft)) : money.perDayBalance;
    const text = money.budgetExceeded
      ? `Ya has superado tu presupuesto general de este mes (${fmt(money.budgetRemaining)}), así que lo recomendable es no gastar más de lo imprescindible. Por saldo disponible podrías gastar unos ${fmt(byBalance)} ${week ? 'el resto de la semana' : 'al día'}.`
      : `Puedes gastar unos ${fmt(value)} ${week ? 'el resto de la semana' : 'al día'} sin descuadrar el mes.`;
    return reply(text, {
      facts: [
        { label: 'Saldo en cuentas', value: fmt(money.balance) },
        { label: 'Reservado para pagos fijos pendientes', value: fmt(money.reservedBills) },
        { label: 'Reservado para tu objetivo de ahorro', value: fmt(money.reservedSavings) },
        { label: 'Disponible hasta fin de mes', value: fmt(money.available) },
        ...(money.budgetRemaining !== null ? [{ label: 'Presupuesto restante', value: fmt(money.budgetRemaining) }] : []),
        { label: 'Días que quedan', value: String(money.daysLeft) },
      ],
      intent: 'spendable',
      note: money.hasAccounts ? '' : 'No has añadido cuentas: el saldo de partida es 0 €. Añádelas en «Cuentas».',
    });
  }

  if (/final de mes|fin de mes|cuanto tendre|cuanto me quedara|tendre a final|dentro de \d+ (dias|meses)|previsi/.test(q)) {
    const fc = F.forecast(user);
    let x = /dentro de (\d+) (dias|meses)/.exec(q);
    let point = fc.checkpoints.find((c) => c.key === 'eom');
    if (x) { const days = x[2] === 'dias' ? Number(x[1]) : Number(x[1]) * 30; point = { label: `Dentro de ${x[1]} ${x[2]}`, ...(fc.series[Math.min(days, fc.series.length - 1)]) }; }
    return reply(`${point.label}: tendrás unos ${fmt(point.realistic)} (escenario realista). Entre ${fmt(point.pessimistic)} si gastas más de lo habitual y ${fmt(point.optimistic)} si recortas. Fiabilidad ${fc.confidence.label.toLowerCase()}.`, {
      facts: [{ label: 'Saldo actual', value: fmt(fc.balance) }, { label: 'Gasto variable medio', value: `${fmt(fc.variablePerDay)}/día` }, { label: 'Saldo mínimo previsto', value: `${fmt(fc.minimum.balance)} (${dLong(fc.minimum.date)})` }],
      intent: 'forecast', note: fc.confidence.notes.join(' '), link: { label: 'Ver previsiones', href: '#/previsiones' },
    });
  }

  if (/despues de pagar|tras pagar|me queda .*factur/.test(q)) {
    return reply(`Después de pagar lo que tienes pendiente este mes te quedarán ${fmt(round(money.balance - money.reservedBills))}.`, { facts: [{ label: 'Saldo', value: fmt(money.balance) }, { label: 'Pagos pendientes', value: fmt(money.reservedBills) }], items: money.bills.map((b) => ({ label: `${b.name} · ${dLong(b.date)}`, value: fmt(b.amount) })), intent: 'after-bills' });
  }

  if (/factura|pendiente|tengo que pagar|proximos pagos|vencimiento|recibos/.test(q)) {
    const bills = L.pendingBills(user, t, new Date(t.getFullYear(), t.getMonth() + 1, 0));
    if (!bills.length) return reply('No tienes pagos pendientes lo que queda de mes.', { intent: 'bills' });
    return reply(`Tienes ${bills.length} pago${bills.length === 1 ? '' : 's'} pendiente${bills.length === 1 ? '' : 's'} hasta fin de mes por ${fmt(sum(bills))}.`, { items: bills.map((b) => ({ label: `${b.name}${b.overdue ? ' (atrasado)' : ''}`, value: `${fmt(b.amount)} · ${dLong(b.date)}` })), intent: 'bills', link: { label: 'Ver pagos fijos', href: '#/mensuales' } });
  }

  if (/fijos|recurrentes|suscripcion|cuotas|domiciliad/.test(q)) {
    const subs = I.subscriptions(user);
    if (!subs.length) return reply('No tienes pagos fijos registrados. Añádelos en «Pagos fijos» para que te avise antes de cada cobro.', { intent: 'fixed' });
    const list = /suscrip/.test(q) ? subs.filter((s) => s.isSubscription) : subs;
    return reply(`Tus ${/suscrip/.test(q) ? 'suscripciones' : 'gastos fijos'} suman ${fmt(round(list.reduce((a, s) => a + s.monthly, 0)))} al mes.`, { items: list.map((s) => ({ label: `${s.name} (${s.frequency.toLowerCase()})`, value: `${fmt(s.amount)}` })), intent: 'fixed' });
  }

  if (/ahorrad|he ahorrado|mis ahorros|cuanto ahorro|tasa de ahorro|conseguido ahorrar/.test(q)) {
    const p = parsePeriod(q, t);
    const inc = sum(incs.filter((i) => i.date >= p.from && i.date <= p.to));
    const exp = sum(exps.filter((e) => e.date >= p.from && e.date <= p.to));
    return reply(`Tienes ${fmt(money.savings)} en tus huchas. ${inc ? `${p.label.charAt(0).toUpperCase() + p.label.slice(1)} has ingresado ${fmt(inc)} y gastado ${fmt(exp)}: un ahorro de ${fmt(round(inc - exp))} (${Math.round(((inc - exp) / inc) * 100)} %).` : `${p.label.charAt(0).toUpperCase() + p.label.slice(1)} no hay ingresos registrados, así que no puedo calcular tu tasa de ahorro.`}`, { facts: [{ label: 'En huchas', value: fmt(money.savings) }, { label: 'Aportado este mes', value: fmt(money.savedMonth) }], intent: 'savings' });
  }

  if (/saldo|cuanto dinero tengo|dinero tengo|cuanto tengo/.test(q)) {
    const accs = L.accountBalances(user);
    if (!accs.length) return reply('Aún no has añadido tus cuentas, así que no sé tu saldo. Añádelas en «Cuentas» con su saldo actual.', { intent: 'balance', link: { label: 'Añadir cuenta', href: '#/cuentas' } });
    return reply(`Tienes ${fmt(money.balance)} en tus cuentas. Descontando pagos pendientes y tu objetivo de ahorro, tienes disponibles ${fmt(money.available)}.`, { note: freshness(user), items: accs.map((a) => ({ label: a.name, value: fmt(a.balance) })), facts: [{ label: 'En huchas', value: fmt(money.savings) }], intent: 'balance' });
  }

  if (/(categoria|que) .*(aumentado|subido|crecido|incrementado)|mas ha (subido|aumentado)|(aumentado|subido) mas/.test(q)) {
    const comp = I.categoryComparison(user, t).map((c) => ({ ...c, base: c.previous || c.avg3, now: c.projected ?? c.current })).filter((c) => c.base > 0);
    if (!comp.length) return reply('Necesito al menos un mes completo de datos para comparar categorías.', { intent: 'increase' });
    const ranked = comp.map((c) => ({ ...c, diff: round(c.now - c.base) })).sort((a, b) => b.diff - a.diff);
    const top = ranked[0];
    if (top.diff <= 0) return reply('Ninguna categoría ha subido respecto al mes pasado. ¡Buen trabajo!', { intent: 'increase' });
    return reply(`La que más ha subido es ${top.name}: ${fmt(top.now)} este mes${top.projected ? ' (previsión)' : ''} frente a ${fmt(top.base)} el mes pasado (+${fmt(top.diff)}).`, { items: ranked.slice(0, 5).map((c) => ({ label: c.name, value: `${c.diff >= 0 ? '+' : ''}${fmt(c.diff)}` })), intent: 'increase' });
  }

  if (/compar|frente al|respecto al|vs\.? (el )?mes/.test(q)) {
    const mk = D.monthKey(t);
    const prev = D.monthKey(new Date(t.getFullYear(), t.getMonth() - 1, 1));
    const cur = sum(exps.filter((e) => e.date.startsWith(mk) && Number(e.date.slice(8)) <= t.getDate()));
    const pre = sum(exps.filter((e) => e.date.startsWith(prev) && Number(e.date.slice(8)) <= t.getDate()));
    const changes = I.categoryComparison(user, t).filter((c) => c.current || c.previous).slice(0, 6);
    return reply(`Hasta el día ${t.getDate()} llevas ${fmt(cur)} este mes, frente a ${fmt(pre)} el mes pasado en las mismas fechas (${pre ? `${cur >= pre ? '+' : ''}${Math.round((cur / pre - 1) * 100)} %` : 'sin datos'}).`, { items: changes.map((c) => ({ label: c.name, value: `${fmt(c.current)} · antes ${fmt(c.previous)}` })), intent: 'compare' });
  }

  if (/anomal|duplicad|raro|extrano|sospech|error/.test(q)) {
    const list = I.anomalies(user);
    if (!list.length) return reply('No he encontrado gastos raros ni duplicados.', { intent: 'anomalies' });
    return reply(`He encontrado ${list.length} cosa${list.length === 1 ? '' : 's'} que conviene revisar:`, { items: list.slice(0, 6).map((a) => ({ label: a.title, value: '', detail: a.text })), intent: 'anomalies', link: { label: 'Revisar alertas', href: '#/asistente?tab=alertas' } });
  }

  if (/en que (gasto|me gasto)|donde gasto|mayor gasto|mas gasto|que categoria/.test(q)) {
    const p = parsePeriod(q, t);
    const list = exps.filter((e) => e.date >= p.from && e.date <= p.to);
    const cats = I.byCategory(user, list);
    if (!cats.length) return reply(`No hay gastos ${p.label}.`, { intent: 'top' });
    const total = sum(list);
    return reply(`${p.label.charAt(0).toUpperCase() + p.label.slice(1)} donde más gastas es ${cats[0].name}: ${fmt(cats[0].total)} (${Math.round((cats[0].total / total) * 100)} % del total).`, { items: cats.slice(0, 6).map((c) => ({ label: c.name, value: fmt(c.total) })), intent: 'top' });
  }

  if (/ingres|cobrad|cobre|ganado|gane|nomina|sueldo/.test(q)) {
    const p = parsePeriod(q, t);
    const list = incs.filter((i) => i.date >= p.from && i.date <= p.to);
    return reply(`${p.label.charAt(0).toUpperCase() + p.label.slice(1)} has ingresado ${fmt(sum(list))} en ${list.length} ingreso${list.length === 1 ? '' : 's'}.`, { items: list.slice(0, 8).map((i) => ({ label: `${i.name} · ${dLong(i.date)}`, value: fmt(i.amount) })), intent: 'income' });
  }

  if (/gast|cuanto|llevo|pague|pagado/.test(q)) {
    const p = parsePeriod(q, t);
    const place = findMerchant(user, q);
    const cat = place ? null : findCategory(user, q);
    let list = exps.filter((e) => e.date >= p.from && e.date <= p.to);
    if (cat) list = list.filter((e) => e.categoryId === cat.id);
    if (place) list = list.filter((e) => norm(e.place) === norm(place));
    const len = D.diffDays(D.parse(p.from), D.parse(p.to)) + 1;
    let pf = D.ymd(D.addDays(D.parse(p.from), -len)), pt = D.ymd(D.addDays(D.parse(p.from), -1));
    let prevLabel = 'En el periodo anterior equivalente';
    if (p.label === 'este mes') { // mismo tramo del mes pasado (del 1 al mismo día)
      pf = D.ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1));
      pt = D.ymd(new Date(t.getFullYear(), t.getMonth() - 1, Math.min(t.getDate(), D.daysInMonth(t.getFullYear(), t.getMonth() - 1 < 0 ? 11 : t.getMonth() - 1))));
      prevLabel = 'El mes pasado, en las mismas fechas,';
    }
    let prev = exps.filter((e) => e.date >= pf && e.date <= pt);
    if (cat) prev = prev.filter((e) => e.categoryId === cat.id);
    if (place) prev = prev.filter((e) => norm(e.place) === norm(place));
    const total = sum(list);
    const what = [cat ? `en ${cat.name}` : '', place ? `en ${place}` : ''].filter(Boolean).join(' ');
    const pv = sum(prev);
    return reply(`${p.label.charAt(0).toUpperCase() + p.label.slice(1)} has gastado ${fmt(total)}${what ? ' ' + what : ''} en ${list.length} movimiento${list.length === 1 ? '' : 's'}.${pv ? ` ${prevLabel} fueron ${fmt(pv)} (${total >= pv ? '+' : ''}${Math.round((total / pv - 1) * 100)} %).` : ''}`, {
      items: (cat || place ? list : I.byCategory(user, list)).slice(0, 6).map((x) => (x.date ? { label: `${x.name} · ${dLong(x.date)}`, value: fmt(x.amount) } : { label: x.name, value: fmt(x.total) })),
      intent: 'spent',
    });
  }
  return null;
}

// Contexto agregado (sin nombres, correos ni conceptos) para el modelo de IA opcional
function aggregatedContext(user) {
  const t = D.today();
  const money = L.moneySummary(user);
  const fc = F.forecast(user, { horizon: 62 });
  return {
    hoy: D.ymd(t),
    saldo_cuentas: money.balance,
    disponible_hasta_fin_de_mes: money.available,
    pagos_fijos_pendientes_mes: money.reservedBills,
    en_huchas: money.savings,
    patrimonio_total: money.netWorth,
    en_cuentas_de_ahorro: money.inSavingsAccounts,
    cuentas_con_saldo_sin_confirmar: money.stale.length,
    meses: I.monthSeries(user, 6, t).map((m) => ({ mes: m.month, ingresos: m.incomes, gastos: m.expenses })),
    categorias: I.categoryComparison(user, t).slice(0, 12).map((c) => ({ categoria: c.name, este_mes: c.current, mes_pasado: c.previous, media_3_meses: c.avg3 })),
    gastos_fijos_mensuales: round(I.subscriptions(user).reduce((a, s) => a + s.monthly, 0)),
    prevision_fin_de_mes: fc.checkpoints.find((c) => c.key === 'eom'),
    presupuestos: L.budgetStatus(user).map((b) => ({ categoria: b.categoryId ? catInfo(user.id, b.categoryId).name : 'general', limite: b.amount, gastado: b.spent })),
  };
}

let client = null;
async function answerWithAI(user, question) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const AnthropicModule = require('@anthropic-ai/sdk');
    const Anthropic = AnthropicModule.default || AnthropicModule;
    client ||= new Anthropic();
    const r = await client.beta.messages.create({
      model: process.env.ASSISTANT_MODEL || process.env.RECEIPT_MODEL || 'claude-opus-5-5',
      max_tokens: 1200,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: 'Eres el asistente financiero de una app de control de gastos personal en España. Responde en español, breve y claro (máximo 5 frases). '
        + 'Usa EXCLUSIVAMENTE las cifras del JSON que te doy; si la respuesta necesita un dato que no está, dilo. No inventes cantidades ni hagas cálculos complejos. '
        + 'No das asesoramiento de inversión: si te piden en qué invertir, explica que no eres un asesor financiero autorizado.',
      messages: [{ role: 'user', content: `Datos calculados por la app:\n${JSON.stringify(aggregatedContext(user))}\n\nPregunta: ${String(question).slice(0, 500)}` }],
    });
    const text = r.content.find((b) => b.type === 'text')?.text;
    return text ? reply(text.trim(), { intent: 'ai', source: 'ai' }) : null;
  } catch (e) {
    console.error('[asistente] IA no disponible:', e.message);
    return null;
  }
}

async function ask(user, question) {
  const local = answerLocal(user, String(question || '').slice(0, 500));
  if (local) return { ...local, source: 'local' };
  const ai = await answerWithAI(user, question);
  if (ai) return ai;
  return { ...reply('No he entendido la pregunta. Puedo responderte sobre gastos, ingresos, saldo, pagos pendientes, previsiones, presupuestos y ahorro. Por ejemplo:', { suggestions: HELP.slice(0, 6) }), source: 'local', intent: 'unknown' };
}

module.exports = { ask, answerLocal, parsePeriod, HELP };
