// Datos de demostración: marcados con demo:true, se pueden borrar sin tocar los datos reales.
const store = require('./db');
const { db } = store;
const D = require('./dates');

const DEMO_COLLECTIONS = ['accounts', 'expenses', 'incomes', 'recurring', 'budgets', 'savings', 'savingMoves', 'transfers'];
const count = (user) => DEMO_COLLECTIONS.reduce((a, k) => a + db[k].filter((x) => x.userId === user.id && x.demo).length, 0);

// Generador pseudoaleatorio con semilla (siempre los mismos datos)
function rng(seed = 7) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

function create(user) {
  const t = D.today();
  const r = rng(42);
  const now = () => new Date().toISOString();
  const cats = db.categories.filter((c) => c.userId === user.id);
  const cat = (re) => (cats.find((c) => re.test(c.name)) || cats[0] || {}).id || null;
  const base = { userId: user.id, demo: true };
  let n = 0;
  const add = (k, o) => { db[k].push({ id: store.id(), ...base, createdAt: now(), ...o }); n++; return db[k][db[k].length - 1]; };

  const start = D.addDays(t, -90);
  const main = add('accounts', { name: 'Cuenta nómina (demo)', type: 'corriente', initialBalance: 1650, balanceDate: D.ymd(D.addDays(start, -1)), color: '#1e3a8a', currency: 'EUR' });
  const cash = add('accounts', { name: 'Efectivo (demo)', type: 'efectivo', initialBalance: 120, balanceDate: D.ymd(D.addDays(start, -1)), color: '#16a34a', currency: 'EUR' });
  const note = 'Dato de demostración';

  for (let k = 3; k >= 0; k--) {
    const d = D.dueInMonth(28, t.getFullYear(), t.getMonth() - k);
    if (d >= start && d <= t) add('incomes', { name: 'Nómina (demo)', amount: 1850, date: D.ymd(d), source: 'nomina', accountId: main.id, notes: note });
  }
  add('incomes', { name: 'Venta de segunda mano (demo)', amount: 60, date: D.ymd(D.addDays(t, -40)), source: 'ventas', accountId: cash.id, notes: note });

  const recs = [
    { name: 'Alquiler (demo)', amount: 650, dayOfMonth: 1, frequency: 'monthly', categoryId: cat(/casa|vivienda/i), autoAdd: true },
    { name: 'Netflix (demo)', amount: 12.99, dayOfMonth: 15, frequency: 'monthly', categoryId: cat(/suscrip/i), autoAdd: true },
    { name: 'Gimnasio (demo)', amount: 35, dayOfMonth: 5, frequency: 'monthly', categoryId: cat(/ocio|salud/i), autoAdd: true },
    { name: 'Luz (demo)', amount: 58, dayOfMonth: 20, frequency: 'monthly', categoryId: cat(/factura/i), autoAdd: false },
    { name: 'Seguro del coche (demo)', amount: 240, dayOfMonth: 10, frequency: 'semiannual', categoryId: cat(/transporte/i), autoAdd: false },
  ];
  for (const rc of recs) {
    const anchor = D.dueInMonth(rc.dayOfMonth, start.getFullYear(), start.getMonth() + (rc.frequency === 'semiannual' ? 4 : 0));
    const rec = add('recurring', { ...rc, place: '', remindDaysBefore: 3, active: true, anchorDate: D.ymd(anchor), startDate: D.ymd(start), accountId: main.id, paid: [] });
    const R = require('./recurrence');
    for (const d of R.occurrences(rec, start, t)) {
      if (!rc.autoAdd && D.diffDays(d, t) < 5) continue; // la última factura queda pendiente
      add('expenses', { name: rc.name, amount: rc.amount, categoryId: rc.categoryId, date: D.ymd(d), place: '', notes: note, recurringId: rec.id, accountId: main.id, paymentMethod: 'domiciliacion', tags: [] });
      R.markPaid(rec, d);
    }
  }

  const shops = [
    { re: /supermerc/i, places: ['Mercadona', 'Lidl', 'Carrefour'], min: 25, max: 95, perWeek: 2 },
    { re: /comida|restaur/i, places: ['Bar Manolo', 'Telepizza', 'Cafetería Sol', 'Burger King'], min: 6, max: 38, perWeek: 2.5 },
    { re: /transporte/i, places: ['Repsol', 'Cepsa', 'Metro'], min: 15, max: 60, perWeek: 1 },
    { re: /ocio/i, places: ['Cines Yelmo', 'Steam', 'Concierto'], min: 8, max: 45, perWeek: 0.6 },
    { re: /compras/i, places: ['Amazon', 'Zara', 'Decathlon'], min: 12, max: 80, perWeek: 0.5 },
    { re: /salud/i, places: ['Farmacia'], min: 4, max: 25, perWeek: 0.3 },
  ];
  for (let i = 0; i <= 90; i++) {
    const d = D.addDays(start, i);
    if (d > t) break;
    for (const s of shops) {
      if (r() < s.perWeek / 7) {
        const place = s.places[Math.floor(r() * s.places.length)];
        const amount = Math.round((s.min + r() * (s.max - s.min)) * 100) / 100;
        add('expenses', { name: place, amount, categoryId: cat(s.re), date: D.ymd(d), place, notes: note, ...(amount < 15 && r() < 0.3 ? { accountId: cash.id, paymentMethod: 'efectivo' } : { accountId: main.id, paymentMethod: 'tarjeta' }), tags: [] });
      }
    }
  }
  add('transfers', { type: 'transfer', fromId: main.id, toId: cash.id, amount: 100, date: D.ymd(D.addDays(t, -20)), note: 'Sacar efectivo (demo)' });

  const have = new Set(db.budgets.filter((b) => b.userId === user.id).map((b) => b.categoryId || 'general'));
  for (const [categoryId, amount] of [[null, 1400], [cat(/supermerc/i), 320], [cat(/comida|restaur/i), 140], [cat(/ocio/i), 60]]) {
    if (!have.has(categoryId || 'general')) { add('budgets', { categoryId, amount, period: 'monthly' }); have.add(categoryId || 'general'); }
  }
  const sv = add('savings', { name: 'Viaje a Italia (demo)', goal: 1200, icon: 'plane', color: '#0891b2' });
  for (let k = 3; k >= 1; k--) add('savingMoves', { savingId: sv.id, type: 'in', amount: 150, date: D.ymd(D.dueInMonth(1, t.getFullYear(), t.getMonth() - k + 1)), note: 'Aportación (demo)' });
  store.save();
  return n;
}

async function remove(user) {
  const n = count(user);
  for (const k of DEMO_COLLECTIONS) db[k] = db[k].filter((x) => !(x.userId === user.id && x.demo));
  // los gastos reales que apuntaban a una cuenta de demostración vuelven a la cuenta principal
  const ids = new Set(db.accounts.map((a) => a.id));
  for (const x of [...db.expenses, ...db.incomes]) if (x.userId === user.id && x.accountId && !ids.has(x.accountId)) delete x.accountId;
  if (user.finance?.defaultAccountId && !ids.has(user.finance.defaultAccountId)) user.finance.defaultAccountId = null;
  db.notifications = db.notifications.filter((x) => x.userId !== user.id);
  await store.save();
  return n;
}

module.exports = { create, remove, count };
