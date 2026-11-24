// Lectura de tickets con IA (Claude). Solo se activa si existe la variable ANTHROPIC_API_KEY.
// Sin ella, la app lee los tickets gratis en el propio dispositivo (OCR en el navegador).
const express = require('express');
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const { db } = require('./db');
const S = require('./security');
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
      items: {
        type: 'array',
        description: 'Artículos comprados (como mucho 15), con su importe',
        items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' } }, required: ['name', 'amount'], additionalProperties: false },
      },
    },
    required: ['is_receipt', 'merchant', 'total', 'date', 'category', 'items'],
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
    items: (Array.isArray(data.items) ? data.items : []).slice(0, 15).map((i) => ({ name: String(i.name).slice(0, 60), amount: Number(i.amount) || 0 })),
  });
}));

module.exports = { router };
