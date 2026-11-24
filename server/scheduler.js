// Tareas automáticas: registro de pagos fijos, avisos por correo, resumen semanal y avisos dentro de la app
const store = require('./db');
const { db } = store;
const D = require('./dates');
const R = require('./recurrence');
const mailer = require('./mailer');
const { weekSummary, catInfo } = require('./summary');

let running = false;

async function checkUser(user) {
  const t = D.today();
  const recs = db.recurring.filter((r) => r.userId === user.id && r.active);

  for (const rec of recs) {
    // 1) Registro automático de cada cobro cuando llega su día (nunca dos veces el mismo cobro)
    if (rec.autoAdd) {
      const from = D.addDays(t, -35);
      for (const due of R.occurrences(rec, from, t)) {
        if (R.isPaid(rec, due) || D.ymd(due) < (rec.startDate || '0000')) continue;
        db.expenses.push({
          id: store.id(),
          userId: user.id,
          name: rec.name,
          amount: rec.amount,
          categoryId: rec.categoryId,
          date: D.ymd(due),
          place: rec.place || '',
          notes: 'Añadido automáticamente (pago fijo)',
          recurringId: rec.id,
          dueDate: D.ymd(due),
          accountId: rec.accountId || null,
          paymentMethod: 'domiciliacion',
          tags: [],
          ...(rec.demo ? { demo: true } : {}),
          createdAt: new Date().toISOString(),
        });
        R.markPaid(rec, due);
        store.save();
      }
    }

    // 2) Aviso por correo X días antes
    if (!user.notify?.reminders) continue;
    const st = R.status(rec, t);
    if (!st.nextDue || st.state === 'overdue') continue;
    const key = D.ymd(st.nextDue);
    if (st.daysLeft >= 0 && st.daysLeft <= rec.remindDaysBefore && rec.lastRemindedFor !== key) {
      try {
        await mailer.send(mailer.reminderEmail(user, rec, st.nextDue, st.daysLeft, catInfo(user.id, rec.categoryId)));
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

  // 4) Avisos dentro de la app (presupuestos, facturas, anomalías, previsión…)
  try {
    require('./insights').refreshNotifications(user);
  } catch (e) {
    console.error('[avisos]', e.message);
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
