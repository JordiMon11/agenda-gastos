// Conexión directa con bancos (Open Banking PSD2): arquitectura preparada para una futura ampliación.
//
// Cómo funciona cuando se active un proveedor autorizado (por ejemplo, un agregador AISP regulado):
//  1. El usuario da su consentimiento explícito en la web del propio banco (la app NUNCA pide ni guarda
//     contraseñas bancarias; solo recibe un identificador de consentimiento del proveedor).
//  2. La app solo LEE: cuentas, saldos y movimientos. No puede hacer pagos ni transferencias.
//  3. La sincronización periódica entrega los movimientos nuevos al mismo proceso que la importación manual
//     (imports.analyzeRows): misma huella, misma detección de duplicados y mismas reglas de clasificación.
//  4. El usuario puede revocar el permiso en cualquier momento; el consentimiento PSD2 caduca a los 180 días.
//
// Para añadir un proveedor, implementa este contrato y regístralo en PROVIDERS:
//   { id, name,
//     start(user, { redirectUrl }) → { link, consentId }          // enlace a la web del banco
//     accounts(connection) → [{ externalId, iban, name, balance }]
//     transactions(connection, externalAccountId, { from }) → [{ bankId, date, valueDate, description, amount, currency, balance }]
//     revoke(connection) }
// y configura OPENBANKING_PROVIDER con su id (más las claves que necesite, solo en variables de entorno).
// La importación de archivos funciona siempre, con o sin esta integración.
const express = require('express');
const store = require('./db');
const { db } = store;
const { HttpError } = require('./auth');

const PROVIDERS = {}; // ningún proveedor activo todavía
const active = () => PROVIDERS[process.env.OPENBANKING_PROVIDER] || null;
const router = express.Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/banks/status', (req, res) => {
  const p = active();
  res.json({
    available: !!p,
    provider: p ? p.name : null,
    connections: db.bankConnections.filter((c) => c.userId === req.user.id).map(({ consentId, userId, ...c }) => c),
    note: p ? null : 'La conexión directa con el banco estará disponible más adelante. Mientras tanto, importa el extracto que descargas de tu banca online.',
  });
});
router.post('/banks/connect', h(async (req, res) => {
  const p = active();
  if (!p) throw new HttpError(501, 'La conexión directa con bancos todavía no está disponible');
  const { link, consentId } = await p.start(req.user, { redirectUrl: `${req.protocol}://${req.get('host')}/#/importar` });
  db.bankConnections.push({ id: store.id(), userId: req.user.id, provider: p.id, consentId, status: 'pendiente', createdAt: new Date().toISOString() });
  await store.save();
  res.json({ link });
}));
router.delete('/banks/connections/:id', h(async (req, res) => {
  const c = db.bankConnections.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!c) throw new HttpError(404, 'Conexión no encontrada');
  const p = PROVIDERS[c.provider];
  if (p) await p.revoke(c).catch(() => {});
  db.bankConnections.splice(db.bankConnections.indexOf(c), 1);
  await store.save();
  res.json({ ok: true });
}));

module.exports = { router, PROVIDERS };
