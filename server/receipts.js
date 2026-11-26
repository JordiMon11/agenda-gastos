// Lectura de tickets con IA (Claude). Solo se activa si existe la variable ANTHROPIC_API_KEY.
// Sin ella, la app lee los tickets gratis en el propio dispositivo (OCR en el navegador).
const express = require('express');
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const store = require('./db');
const { db } = store;
const S = require('./security');
const D = require('./dates');
const { catInfo } = require('./summary');
const { HttpError } = require('./auth');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();
const MODEL = process.env.RECEIPT_MODEL || 'claude-opus-5-5';
const enabled = () => !!process.env.ANTHROPIC_API_KEY;
let client = null;
const getClient = () => (client ||= new Anthropic());

router.get('/receipts/status', (req, res) => res.json({ ai: enabled() }));

router.post('/receipts/scan', h(async (req, res) => {
  if (!enabled()) throw Object.assign(new HttpError(503, 'La lectura con IA no está configurada'), { fallback: true });
  const lim = S.limiter({ key: 'scan:' + req.user.id, max: 40, windowMs: 60 * 60 * 1000 });
  if (!lim.ok) throw new HttpError(429, `Has escaneado muchos tickets seguidos. Espera ${lim.retryIn} min.`);

  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.image || ''));
  if (!m) throw new HttpError(400, 'Imagen no válida');
  if (m[2].length > 7 * 1024 * 1024) throw new HttpError(413, 'La foto es demasiado grande');

  const cats = db.categories.filter((c) => c.userId === req.user.id);
  const catNames = [...new Set([...cats.map((c) => c.name), 'Sin categoría'])];
  const today = new Date().toISOString().slice(0, 10);

  const schema = {
    type: 'object',
    properties: {
      is_receipt: { type: 'boolean', description: 'true si la imagen es un ticket, factura o recibo de compra' },
      merchant: { type: 'string', description: 'Nombre comercial de la tienda o establecimiento, sin S.A./S.L. Vacío si no se ve' },
      total: { type: 'number', description: 'Importe TOTAL pagado en euros. 0 si no se puede leer' },
      date: { type: 'string', description: 'Fecha del ticket en formato AAAA-MM-DD, o cadena vacía si no aparece' },
      category: { type: 'string', enum: catNames, description: 'La categoría que mejor encaja con la compra' },
      tax_amount: { type: 'number', description: 'Importe total de IVA si aparece, 0 si no' },
      payment_method: { type: 'string', enum: ['tarjeta', 'efectivo', 'otro', ''], description: 'Cómo se pagó; vacío si no aparece' },
      ticket_number: { type: 'string', description: 'Número de ticket o factura; vacío si no aparece' },
      tax_id: { type: 'string', description: 'CIF/NIF del establecimiento; vacío si no aparece' },
      time: { type: 'string', description: 'Hora HH:MM si aparece; vacío si no' },
      items: {
        type: 'array',
        description: 'Artículos comprados (como mucho 15), con su importe',
        items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'number' }, amount: { type: 'number' } }, required: ['name', 'quantity', 'amount'], additionalProperties: false },
      },
    },
    required: ['is_receipt', 'merchant', 'total', 'date', 'category', 'tax_amount', 'payment_method', 'ticket_number', 'tax_id', 'time', 'items'],
    additionalProperties: false,
  };

  let response;
  try {
    response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system:
        'Extraes los datos de fotos de tickets de compra para una app de control de gastos en España. ' +
        'El total es lo que el cliente pagó (TOTAL, TOTAL A PAGAR, IMPORTE), nunca la base imponible, el IVA, el efectivo entregado ni el cambio. ' +
        'No inventes datos: si un campo no aparece en el ticket, déjalo vacío o a 0. ' +
        `Hoy es ${today}. Si la imagen no es un ticket, devuelve is_receipt=false y total=0.`,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
            { type: 'text', text: 'Lee este ticket y devuelve sus datos.' },
          ],
        },
      ],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error('[tickets] La clave ANTHROPIC_API_KEY no es válida');
    else if (e instanceof Anthropic.RateLimitError) console.error('[tickets] Límite de la API de Claude alcanzado');
    else if (e instanceof Anthropic.APIError) console.error(`[tickets] Error de la API ${e.status}:`, e.message);
    else console.error('[tickets]', e.message);
    throw Object.assign(new HttpError(502, 'La IA no ha podido leer el ticket'), { fallback: true });
  }

  if (response.stop_reason === 'refusal') throw Object.assign(new HttpError(422, 'La IA no ha podido procesar esta imagen'), { fallback: true });
  const text = response.content.find((b) => b.type === 'text')?.text;
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new HttpError(502, 'Respuesta de la IA no válida'), { fallback: true }); }

  const cat = cats.find((c) => c.name === data.category);
  res.json({
    source: 'ai',
    isReceipt: !!data.is_receipt,
    merchant: String(data.merchant || '').trim().slice(0, 100),
    total: Number(data.total) > 0 ? Math.round(Number(data.total) * 100) / 100 : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : null,
    categoryId: cat?.id || null,
    taxAmount: Number(data.tax_amount) > 0 ? Math.round(Number(data.tax_amount) * 100) / 100 : null,
    paymentMethod: ['tarjeta', 'efectivo', 'otro'].includes(data.payment_method) ? data.payment_method : null,
    ticketNumber: String(data.ticket_number || '').slice(0, 40),
    taxId: String(data.tax_id || '').slice(0, 20),
    time: /^\d{1,2}:\d{2}$/.test(data.time || '') ? data.time : '',
    confidence: data.is_receipt && Number(data.total) > 0 ? 90 : 40,
    items: (Array.isArray(data.items) ? data.items : []).slice(0, 30).map((i) => ({ name: String(i.name).slice(0, 60), quantity: Number(i.quantity) || 1, amount: Number(i.amount) || 0 })),
  });
}));

// ---------- Guardar el ticket (solo tras la confirmación del usuario), historial y foto ----------
let cleanExpense = null;
const setExpenseCleaner = (fn) => { cleanExpense = fn; };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const num = (v) => (Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : null);

// Posibles duplicados: mismo importe y fecha, mismo importe y tienda en días cercanos, o el mismo número de ticket.
// Solo se avisa: puede haber compras legítimas iguales.
function findDuplicates(userId, { amount, date, merchant, ticketNumber }) {
  const amt = Number(amount);
  const m = norm(merchant);
  const out = [];
  for (const e of db.expenses.filter((x) => x.userId === userId)) {
    if (!(Math.abs(e.amount - amt) < 0.01)) continue;
    const near = D.isYmd(date) && Math.abs(D.diffDays(D.parse(e.date), D.parse(date))) <= 3;
    const p = norm(e.place);
    const sameShop = !!m && (p.includes(m) || norm(e.name).includes(m) || (!!p && m.includes(p)));
    if (e.date === date || (near && sameShop)) out.push({ id: e.id, name: e.name, amount: e.amount, date: e.date, place: e.place, reason: e.date === date ? 'Mismo importe y fecha' : 'Mismo importe y establecimiento' });
  }
  if (ticketNumber) {
    for (const r of db.receipts.filter((x) => x.userId === userId && x.ticketNumber === String(ticketNumber) && norm(x.merchant) === m)) {
      if (!out.some((o) => o.id === r.expenseId)) out.push({ id: r.expenseId, name: r.merchant, amount: r.total, date: r.date, place: r.merchant, reason: 'Mismo número de ticket' });
    }
  }
  return out.slice(0, 5);
}
router.post('/receipts/duplicates', h(async (req, res) => res.json(findDuplicates(req.user.id, req.body || {}))));

router.post('/receipts', h(async (req, res) => {
  const b = req.body || {};
  const lim = S.limiter({ key: 'rsave:' + req.user.id, max: 120, windowMs: 60 * 60 * 1000 });
  if (!lim.ok) throw new HttpError(429, 'Demasiados tickets seguidos. Espera un poco.');
  const exp = cleanExpense(b.expense || {}, req);
  const r = b.receipt || {};
  let img = null;
  if (b.image) {
    img = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image));
    if (!img) throw new HttpError(400, 'Imagen no válida');
    if (img[2].length > 4 * 1024 * 1024) throw new HttpError(413, 'La foto es demasiado grande');
  }
  const e = { id: store.id(), userId: req.user.id, ...exp, scanned: true, createdAt: new Date().toISOString() };
  let imageId = null;
  if (img) {
    imageId = store.id();
    await store.putBlob(imageId, req.user.id, img[1], Buffer.from(img[2], 'base64'));
  }
  const receipt = {
    id: store.id(),
    userId: req.user.id,
    expenseId: e.id,
    merchant: String(r.merchant || exp.place || exp.name).slice(0, 100),
    date: D.isYmd(r.date) ? r.date : exp.date,
    time: /^\d{1,2}:\d{2}$/.test(r.time || '') ? r.time : '',
    total: num(r.total) ?? exp.amount,
    taxAmount: num(r.taxAmount),
    taxId: String(r.taxId || '').slice(0, 20),
    ticketNumber: String(r.ticketNumber || '').slice(0, 40),
    paymentMethod: ['tarjeta', 'efectivo', 'otro'].includes(r.paymentMethod) ? r.paymentMethod : null,
    items: (Array.isArray(r.items) ? r.items : []).slice(0, 40).map((i) => ({ name: String(i.name || '').slice(0, 60), quantity: Number(i.quantity) || 1, amount: Number(i.amount) || 0 })),
    source: r.source === 'ai' ? 'ai' : 'ocr',
    confidence: Math.max(0, Math.min(100, Math.round(Number(r.confidence) || 0))),
    imageId,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };
  e.receiptId = receipt.id;
  require('./classifier').onExpenseCreated(req.user, e, { userCategory: !!e.categoryId });
  db.expenses.push(e);
  db.receipts.push(receipt);
  store.save();
  res.json({ expense: e, receipt });
}));

router.get('/receipts', (req, res) => {
  const { q, from, to, category } = req.query;
  let list = db.receipts.filter((r) => r.userId === req.user.id).map((r) => {
    const e = db.expenses.find((x) => x.id === r.expenseId && x.userId === req.user.id) || null;
    return { ...r, hasImage: !!r.imageId, expense: e, category: catInfo(req.user.id, e?.categoryId) };
  });
  if (q) { const s = norm(q); list = list.filter((r) => norm(`${r.merchant} ${r.expense?.name || ''}`).includes(s)); }
  if (D.isYmd(from)) list = list.filter((r) => r.date >= from);
  if (D.isYmd(to)) list = list.filter((r) => r.date <= to);
  if (category) list = list.filter((r) => (category === 'none' ? !r.expense?.categoryId : r.expense?.categoryId === category));
  res.json(list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)));
});
router.get('/receipts/:id/image', h(async (req, res) => {
  const r = db.receipts.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!r || !r.imageId) throw new HttpError(404, 'Este ticket no tiene foto');
  const blob = await store.getBlob(r.imageId, req.user.id);
  if (!blob) throw new HttpError(404, 'No se encontró la foto');
  res.setHeader('Content-Type', blob.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="ticket-${r.date}.${blob.mime === 'image/jpeg' ? 'jpg' : blob.mime.split('/')[1]}"`);
  res.send(blob.data);
}));
router.delete('/receipts/:id', h(async (req, res) => {
  const r = db.receipts.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!r) throw new HttpError(404, 'No encontrado');
  await store.delBlobs([r.imageId]);
  db.receipts.splice(db.receipts.indexOf(r), 1);
  const e = db.expenses.find((x) => x.id === r.expenseId && x.userId === req.user.id);
  if (e) {
    if (req.query.withExpense === '1') db.expenses.splice(db.expenses.indexOf(e), 1);
    else delete e.receiptId;
  }
  store.save();
  res.json({ ok: true });
}));

module.exports = { router, setExpenseCleaner, findDuplicates };
