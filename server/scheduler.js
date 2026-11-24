// Tareas automáticas: avisos de gastos mensuales, registro automático y resumen semanal
const store = require('./db');
const { db } = store;
const D = require('./dates');
const mailer = require('./mailer');
const { weekSummary, catInfo } = require('./summary');

let running = false;

async function checkUser(user) {
  const t = D.today();
  const mk = D.monthKey(t);
  const recs = db.recurring.filter((r) => r.userId === user.id && r.active);

  for (const rec of recs) {
    // 1) Registro automático del cargo cuando llega el día
    const thisDue = D.dueInMonth(rec.dayOfMonth, t.getFullYear(), t.getMonth());
    if (rec.autoAdd && t >= thisDue && rec.lastPaidMonth !== mk && D.ymd(thisDue) >= rec.startDate) {
      db.expenses.push({
        id: store.id(),
        userId: user.id,
        name: rec.name,
        amount: rec.amount,
        categoryId: rec.categoryId,
        date: D.ymd(thisDue),
        place: rec.place || '',
        notes: 'Añadido automáticamente (gasto mensual)',
        recurringId: rec.id,
        createdAt: new Date().toISOString(),
      });
      rec.lastPaidMonth = mk;
      store.save();
    }

    // 2) Aviso por correo X días antes
    if (!user.notify?.reminders) continue;
    const due = D.nextDue(rec, t);
    const daysLeft = D.diffDays(t, due);
    const key = D.ymd(due);
    if (daysLeft >= 0 && daysLeft <= rec.remindDaysBefore && rec.lastRemindedFor !== key) {
      try {
        await mailer.send(mailer.reminderEmail(user, rec, due, daysLeft, catInfo(user.id, rec.categoryId)));
        rec.lastRemindedFor = key;
        store.save();
      } catch (e) {
        console.error('[aviso] Error enviando correo:', e.message);
      }
    }
  }

  // 3) Resumen semanal (de la semana anterior) a partir del lunes
  const thisWeek = D.ymd(D.weekStart(t));
  if (user.notify?.weekly && user.lastWeeklySent !== thisWeek) {
    try {
      const s = weekSummary(user.id, D.ymd(D.addDays(t, -7)));
      await mailer.send(mailer.weeklyEmail(user, s));
      user.lastWeeklySent = thisWeek;
      store.save();
    } catch (e) {
      console.error('[resumen] Error enviando correo:', e.message);
    }
  }
}

async function run() {
  if (running) return;
  running = true;
  try {
    for (const user of db.users) await checkUser(user);
  } finally {
    running = false;
  }
}

function start() {
  run();
  setInterval(run, 30 * 60 * 1000); // cada 30 minutos
}

module.exports = { start, run, checkUser };
