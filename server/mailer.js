// Envío de correos. Si no hay SMTP configurado, se guardan en data/outbox como .html
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { DATA_DIR } = require('./db');
const D = require('./dates');

const OUTBOX = path.join(DATA_DIR, 'outbox');
const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const useBrevo = () => !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL);
const useSmtp = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const configured = () => useBrevo() || useSmtp();
let transporter = null;

// Brevo (gratis, 300 correos/día) envía por HTTPS, así funciona en hostings que bloquean SMTP
async function sendBrevo({ to, subject, html }) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME || 'Agenda de Gastos' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
}
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function send({ to, subject, html }) {
  if (!configured()) {
    fs.mkdirSync(OUTBOX, { recursive: true });
    const file = path.join(OUTBOX, `${Date.now()}-${subject.replace(/[^\w\-áéíóúñ ]/gi, '').slice(0, 40).trim()}.html`);
    fs.writeFileSync(file, `<!-- Para: ${esc(to)} | Asunto: ${esc(subject)} -->\n${html}`);
    console.log(`[correo simulado] Para ${to}: "${subject}" -> ${file}`);
    return { simulated: true, file };
  }
  if (useBrevo()) await sendBrevo({ to, subject, html });
  else await getTransporter().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html });
  console.log(`[correo] Enviado a ${to}: "${subject}"`);
  return { sent: true };
}

function layout(title, body) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px #0001">
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:20px 24px">
      <div style="font-size:13px;opacity:.85">💸 Agenda de Gastos</div>
      <div style="font-size:21px;font-weight:700;margin-top:4px">${title}</div>
    </div>
    <div style="padding:22px 24px;font-size:15px;line-height:1.5">${body}</div>
    <div style="padding:12px 24px;background:#f8fafc;color:#64748b;font-size:12px">Puedes cambiar estos avisos en Ajustes dentro de la aplicación.</div>
  </div></body></html>`;
}

function welcomeEmail(user) {
  return {
    to: user.email,
    subject: 'Tu cuenta de Agenda de Gastos está lista',
    html: layout(
      `¡Hola, ${esc(user.name)}!`,
      `<p>Tu cuenta ha quedado vinculada a este correo.</p>
       <p>Aquí recibirás:</p>
       <ul><li>🔔 Avisos antes de que llegue cada <b>gasto mensual</b>.</li><li>📊 Un <b>resumen semanal</b> cada lunes.</li></ul>`
    ),
  };
}

function reminderEmail(user, rec, due, daysLeft, cat) {
  const when = daysLeft === 0 ? '<b>hoy</b>' : daysLeft === 1 ? '<b>mañana</b>' : `en <b>${daysLeft} días</b>`;
  return {
    to: user.email,
    subject: `🔔 ${rec.name}: ${eur(rec.amount)} ${daysLeft === 0 ? 'hoy' : daysLeft === 1 ? 'mañana' : `en ${daysLeft} días`}`,
    html: layout(
      `Se acerca un gasto mensual`,
      `<p>Hola ${esc(user.name)}, te recordamos que ${when} llega este cargo:</p>
       <table style="width:100%;border-collapse:collapse;margin:14px 0">
        <tr><td style="padding:8px 0;color:#64748b">Concepto</td><td style="text-align:right;font-weight:600">${esc(rec.name)}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b">Importe</td><td style="text-align:right;font-weight:700;font-size:20px;color:#4f46e5">${eur(rec.amount)}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b">Fecha</td><td style="text-align:right">${esc(D.fmtLong(due))}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b">Categoría</td><td style="text-align:right">${esc(cat.icon)} ${esc(cat.name)}</td></tr>
        ${rec.place ? `<tr><td style="padding:8px 0;color:#64748b">Dónde</td><td style="text-align:right">${esc(rec.place)}</td></tr>` : ''}
       </table>
       <p style="color:#64748b;font-size:13px">Asegúrate de tener saldo suficiente 😉</p>`
    ),
  };
}

function weeklyEmail(user, s) {
  const diff = s.prevTotal ? ((s.total - s.prevTotal) / s.prevTotal) * 100 : null;
  const diffTxt =
    diff === null ? '' : `<span style="color:${diff > 0 ? '#dc2626' : '#16a34a'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(0)}% respecto a la semana anterior</span>`;
  const max = Math.max(1, ...s.byDay.map((d) => d.total));
  const days = s.byDay
    .map(
      (d) => `<tr><td style="padding:3px 0;width:90px;color:#64748b">${d.name}</td>
      <td><div style="background:#6366f1;height:12px;border-radius:6px;width:${Math.round((d.total / max) * 100)}%"></div></td>
      <td style="text-align:right;width:90px">${eur(d.total)}</td></tr>`
    )
    .join('');
  const cats = s.byCategory
    .map(
      (c) => `<tr><td style="padding:6px 0">${esc(c.icon)} ${esc(c.name)} <span style="color:#94a3b8">(${c.count})</span></td>
      <td style="text-align:right;font-weight:600">${eur(c.total)}</td></tr>`
    )
    .join('');
  return {
    to: user.email,
    subject: `📊 Tu resumen semanal: ${eur(s.total)} (${s.from} a ${s.to})`,
    html: layout(
      'Resumen semanal',
      `<p>Hola ${esc(user.name)}, esto es lo que gastaste del <b>${s.from}</b> al <b>${s.to}</b>:</p>
       <div style="font-size:32px;font-weight:800;color:#4f46e5">${eur(s.total)}</div>
       <div style="font-size:13px;margin-bottom:16px">${diffTxt}</div>
       <p style="margin:0 0 6px"><b>${s.count}</b> gastos · media de <b>${eur(s.avgPerDay)}</b>/día</p>
       ${s.top ? `<p style="margin:0 0 16px">Mayor gasto: <b>${esc(s.top.name)}</b> (${eur(s.top.amount)})</p>` : ''}
       <h3 style="margin:18px 0 6px;font-size:15px">Por día</h3><table style="width:100%">${days}</table>
       <h3 style="margin:18px 0 6px;font-size:15px">Por categoría</h3>
       <table style="width:100%">${cats || '<tr><td style="color:#94a3b8">Sin gastos esta semana 🎉</td></tr>'}</table>`
    ),
  };
}

function testEmail(user) {
  return {
    to: user.email,
    subject: '✅ Prueba de correo - Agenda de Gastos',
    html: layout('¡El correo funciona!', `<p>Hola ${esc(user.name)}, si lees esto los avisos por correo están bien configurados.</p>`),
  };
}

module.exports = { send, configured, useBrevo, welcomeEmail, reminderEmail, weeklyEmail, testEmail, OUTBOX };
