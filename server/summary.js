const { db } = require('./db');
const D = require('./dates');

const round = (n) => Math.round(n * 100) / 100;
const sum = (list) => round(list.reduce((a, e) => a + e.amount, 0));

function catInfo(userId, catId) {
  const c = db.categories.find((c) => c.id === catId && c.userId === userId);
  return c || { id: null, name: 'Sin categoría', color: '#94a3b8', icon: '📦' };
}

// Resumen de la semana (lunes-domingo) que contiene dateStr
function weekSummary(userId, dateStr) {
  const start = D.weekStart(D.parse(dateStr));
  const from = D.ymd(start);
  const to = D.ymd(D.addDays(start, 6));
  const prevFrom = D.ymd(D.addDays(start, -7));
  const prevTo = D.ymd(D.addDays(start, -1));

  const mine = db.expenses.filter((e) => e.userId === userId);
  const list = mine.filter((e) => e.date >= from && e.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  const prevTotal = sum(mine.filter((e) => e.date >= prevFrom && e.date <= prevTo));
  const total = sum(list);

  const byCat = new Map();
  const byPlace = new Map();
  for (const e of list) {
    const c = catInfo(userId, e.categoryId);
    const k = c.id || 'none';
    const cur = byCat.get(k) || { id: c.id, name: c.name, color: c.color, icon: c.icon, total: 0, count: 0 };
    cur.total = round(cur.total + e.amount);
    cur.count++;
    byCat.set(k, cur);
    if (e.place) byPlace.set(e.place, round((byPlace.get(e.place) || 0) + e.amount));
  }

  const byDay = D.DAY_NAMES.map((name, i) => {
    const date = D.ymd(D.addDays(start, i));
    return { name, date, total: sum(list.filter((e) => e.date === date)) };
  });

  const top = list.reduce((m, e) => (!m || e.amount > m.amount ? e : m), null);

  return {
    from,
    to,
    total,
    prevTotal,
    count: list.length,
    avgPerDay: round(total / 7),
    byCategory: [...byCat.values()].sort((a, b) => b.total - a.total),
    byDay,
    byPlace: [...byPlace.entries()].map(([place, total]) => ({ place, total })).sort((a, b) => b.total - a.total).slice(0, 5),
    top: top ? { ...top, category: catInfo(userId, top.categoryId) } : null,
    expenses: list.map((e) => ({ ...e, category: catInfo(userId, e.categoryId) })),
  };
}

module.exports = { weekSummary, catInfo, round };
