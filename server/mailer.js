// Envío de correos: Brevo (API HTTPS), SMTP, o si no hay nada configurado se guardan en data/outbox como .html
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { DATA_DIR } = require('./db');
const D = require('./dates');

const OUTBOX = path.join(DATA_DIR, 'outbox');
const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '';
const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const useBrevo = () => !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL);
const useSmtp = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const configured = () => useBrevo() || useSmtp();
let transporter = null;

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

// ---------- Plantillas ----------
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const dot = (color) =>
  `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${esc(color)};margin-right:8px;vertical-align:middle"></span>`;
const button = (label) =>
  APP_URL
    ? `<a href="${esc(APP_URL)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;margin-top:8px">${label}</a>`
    : '';

function layout(preheader, title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;background:#f3f4f8;font-family:${FONT};color:#111827">
  <span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f8;padding:28px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
      <tr><td style="padding:0 4px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:34px;height:34px;border-radius:10px;background:#4f46e5;color:#fff;font-weight:800;font-size:17px;text-align:center">€</td>
          <td style="padding-left:10px;font-weight:700;font-size:16px;color:#111827">Agenda de Gastos</td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#ffffff;border-radius:18px;border:1px solid #e7e8ef;padding:30px 28px">
        <div style="font-size:22px;font-weight:800;letter-spacing:-.3px;margin-bottom:14px">${title}</div>
        <div style="font-size:15px;line-height:1.6;color:#374151">${body}</div>
      </td></tr>
      <tr><td style="padding:16px 8px;color:#9ca3af;font-size:12px;text-align:center">
        Recibes este correo porque tienes activados los avisos en Agenda de Gastos. Puedes cambiarlo en Ajustes.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

const row = (label, value) =>
  `<tr><td style="padding:11px 0;color:#6b7280;border-bottom:1px solid #f0f1f5">${label}</td>
   <td style="padding:11px 0;text-align:right;font-weight:600;color:#111827;border-bottom:1px solid #f0f1f5">${value}</td></tr>`;

function welcomeEmail(user) {
  return {
    to: user.email,
    subject: 'Tu cuenta de Agenda de Gastos está lista',
    html: layout(
      'Tu cuenta ya está vinculada a este correo',
      `Hola, ${esc(user.name)}`,
      `<p style="margin:0 0 14px">Tu cuenta ha quedado vinculada a este correo. A partir de ahora recibirás aquí:</p>
       <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px">
        <tr><td style="padding:6px 0">${dot('#4f46e5')}<b>Avisos</b> antes de que llegue cada pago fijo.</td></tr>
        <tr><td style="padding:6px 0">${dot('#16a34a')}<b>Un resumen semanal</b> cada lunes con lo que has gastado.</td></tr>
       </table>
       ${button('Abrir mi agenda')}`
    ),
  };
}

function reminderEmail(user, rec, due, daysLeft, cat) {
  const whenShort = daysLeft === 0 ? 'hoy' : daysLeft === 1 ? 'mañana' : `en ${daysLeft} días`;
  return {
    to: user.email,
    subject: `Recordatorio: ${rec.name} (${eur(rec.amount)}) ${whenShort}`,
    html: layout(
      `${rec.name} se cobra ${whenShort}`,
      `${esc(rec.name)} se cobra ${whenShort}`,
      `<p style="margin:0 0 6px">Hola ${esc(user.name)}, te recordamos que se acerca este pago:</p>
       <div style="font-size:34px;font-weight:800;color:#4f46e5;letter-spacing:-.5px;margin:12px 0 6px">${eur(rec.amount)}</div>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px;font-size:14px">
        ${row('Concepto', esc(rec.name))}
        ${row('Fecha de cobro', esc(D.fmtLong(due)))}
        ${row('Categoría', dot(cat.color) + esc(cat.name))}
        ${rec.place ? row('Dónde', esc(rec.place)) : ''}
       </table>
       <p style="margin:0 0 4px;color:#6b7280;font-size:13px">Asegúrate de tener saldo suficiente en la cuenta.</p>
       ${button('Ver mis pagos fijos')}`
    ),
  };
}

function weeklyEmail(user, s) {
  const diff = s.prevTotal ? ((s.total - s.prevTotal) / s.prevTotal) * 100 : null;
  const diffTxt =
    diff === null
      ? ''
      : `<span style="display:inline-block;padding:4px 10px;border-radius:99px;font-size:13px;font-weight:600;background:${diff > 0 ? '#fef2f2' : '#f0fdf4'};color:${diff > 0 ? '#dc2626' : '#16a34a'}">${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(0)}% que la semana anterior</span>`;
  const max = Math.max(1, ...s.byDay.map((d) => d.total));
  const days = s.byDay
    .map(
      (d) => `<tr><td style="padding:5px 0;width:84px;color:#6b7280;font-size:13px">${d.name}</td>
      <td style="padding:5px 0"><div style="background:#eef0ff;border-radius:6px"><div style="background:#4f46e5;height:10px;border-radius:6px;width:${Math.max(d.total ? 3 : 0, Math.round((d.total / max) * 100))}%"></div></div></td>
      <td style="padding:5px 0 5px 10px;text-align:right;width:86px;font-size:13px;font-weight:600">${eur(d.total)}</td></tr>`
    )
    .join('');
  const cats = s.byCategory
    .map((c) => row(`${dot(c.color)}${esc(c.name)} <span style="color:#9ca3af">· ${c.count}</span>`, eur(c.total)))
    .join('');
  return {
    to: user.email,
    subject: `Tu resumen semanal: ${eur(s.total)} gastados`,
    html: layout(
      `Del ${s.from} al ${s.to} gastaste ${eur(s.total)}`,
      'Tu resumen semanal',
      `<p style="margin:0 0 4px;color:#6b7280">Del <b>${esc(s.from)}</b> al <b>${esc(s.to)}</b></p>
       <div style="font-size:36px;font-weight:800;color:#111827;letter-spacing:-.6px;margin:6px 0 8px">${eur(s.total)}</div>
       ${diffTxt}
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;font-size:14px">
        ${row('Número de gastos', s.count)}
        ${row('Media diaria', eur(s.avgPerDay))}
        ${s.top ? row('Mayor gasto', `${esc(s.top.name)} · ${eur(s.top.amount)}`) : ''}
       </table>
       <div style="font-weight:700;margin:22px 0 8px;color:#111827">Por día</div>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${days}</table>
       <div style="font-weight:700;margin:22px 0 4px;color:#111827">Por categoría</div>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${cats || '<tr><td style="padding:10px 0;color:#9ca3af">Sin gastos esta semana.</td></tr>'}</table>
       <div style="margin-top:20px">${button('Ver el resumen completo')}</div>`
    ),
  };
}

const when = () => new Date().toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Madrid' });
function newLoginEmail(user, device, ip) {
  return {
    to: user.email,
    subject: 'Nuevo inicio de sesión en tu cuenta',
    html: layout(
      `Alguien ha entrado en tu cuenta desde ${device}`,
      'Nuevo inicio de sesión',
      `<p style="margin:0 0 12px">Hola ${esc(user.name)}, se ha iniciado sesión en tu cuenta desde un dispositivo nuevo:</p>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px;font-size:14px">
        ${row('Dispositivo', esc(device))}${row('Dirección IP', esc(ip))}${row('Fecha', esc(when()))}
       </table>
       <p style="margin:0;color:#6b7280;font-size:13px"><b style="color:#111827">¿No has sido tú?</b> Entra en la app, ve a <b>Seguridad</b>, cierra las demás sesiones y cambia tu contraseña.</p>`
    ),
  };
}
function lockedEmail(user, ip) {
  return {
    to: user.email,
    subject: 'Hemos bloqueado temporalmente el acceso a tu cuenta',
    html: layout(
      'Varios intentos de acceso fallidos',
      'Acceso bloqueado 15 minutos',
      `<p style="margin:0 0 12px">Hola ${esc(user.name)}, ha habido 5 intentos seguidos con una contraseña incorrecta (IP ${esc(ip)}), así que hemos bloqueado el acceso durante 15 minutos.</p>
       <p style="margin:0;color:#6b7280;font-size:13px">Si no has sido tú, te recomendamos activar la verificación en dos pasos en el apartado <b>Seguridad</b>.</p>`
    ),
  };
}
function securityChangeEmail(user, text) {
  return {
    to: user.email,
    subject: 'Cambio de seguridad en tu cuenta',
    html: layout(
      text,
      'Cambio de seguridad',
      `<p style="margin:0 0 12px">Hola ${esc(user.name)}. ${esc(text)}</p>
       <p style="margin:0;color:#6b7280;font-size:13px">Fecha: ${esc(when())}. Si no has sido tú, cambia tu contraseña inmediatamente.</p>`
    ),
  };
}

function resetEmail(user, link) {
  return {
    to: user.email,
    subject: 'Restablece tu contraseña de Agenda de Gastos',
    html: layout(
      'Enlace para crear una contraseña nueva (caduca en 1 hora)',
      'Restablecer contraseña',
      `<p style="margin:0 0 16px">Hola ${esc(user.name)}, hemos recibido una petición para restablecer tu contraseña. Pulsa el botón para crear una nueva. El enlace caduca en <b>1 hora</b> y solo funciona una vez.</p>
       <a href="${esc(link)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">Crear contraseña nueva</a>
       <p style="margin:18px 0 0;color:#6b7280;font-size:13px">Si no lo has pedido tú, ignora este correo: tu contraseña no cambiará.</p>`
    ),
  };
}

function testEmail(user) {
  return {
    to: user.email,
    subject: 'Prueba de correo de Agenda de Gastos',
    html: layout('Los avisos por correo funcionan', 'Los correos funcionan', `<p style="margin:0">Hola ${esc(user.name)}, si lees esto los avisos por correo están bien configurados.</p>`),
  };
}

module.exports = { send, configured, useBrevo, welcomeEmail, reminderEmail, weeklyEmail, testEmail, newLoginEmail, lockedEmail, securityChangeEmail, resetEmail, OUTBOX };
