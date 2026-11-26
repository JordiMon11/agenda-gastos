// Almacenamiento de datos.
// - Online (Render): si existe DATABASE_URL se guarda en PostgreSQL (p. ej. Neon, gratis).
// - Local: si no, se guarda en data/db.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');
const EMPTY = {
  users: [], sessions: [], categories: [], expenses: [], recurring: [], incomes: [], savings: [], savingMoves: [],
  securityLog: [], adminLog: [], passwordResets: [], settings: { registrationOpen: true, banner: '' },
  accounts: [], transfers: [], budgets: [], notifications: [], receipts: [],
  imports: [], importRules: [], importMappings: [], bankConnections: [],
};
// Colecciones con datos de cada usuario (para exportarlos o borrarlos)
const USER_COLLECTIONS = [
  'sessions', 'categories', 'expenses', 'recurring', 'incomes', 'savings', 'savingMoves', 'securityLog', 'passwordResets',
  'accounts', 'transfers', 'budgets', 'notifications', 'receipts', 'imports', 'importRules', 'importMappings', 'bankConnections',
];

const db = structuredClone(EMPTY); // objeto compartido: nunca se reasigna, solo se modifica
let pool = null;

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
    await pool.query('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mime TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ DEFAULT now())');
    await pool.query('CREATE INDEX IF NOT EXISTS blobs_user ON blobs (user_id)');
    const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (r.rows[0]) Object.assign(db, structuredClone(EMPTY), r.rows[0].data);
    console.log('   Datos: PostgreSQL ✅');
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } catch {}
    console.log(`   Datos: archivo local (${FILE})`);
  }
}

// Guardado: en PostgreSQL las escrituras se encadenan y se agrupan
let chain = Promise.resolve();
let queued = false;
function save() {
  if (!pool) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);
    return chain;
  }
  if (queued) return chain;
  queued = true;
  chain = chain
    .then(async () => {
      queued = false;
      await pool.query(
        'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
        [JSON.stringify(db)]
      );
    })
    .catch((e) => console.error('[db] Error guardando:', e.message));
  return chain;
}

const flush = () => chain;
const id = () => crypto.randomUUID();

// ---------- Archivos privados (fotos de tickets) ----------
// Se guardan aparte del estado principal: en PostgreSQL (tabla blobs) o en data/blobs.
// Cada archivo va ligado a su usuario y solo se entrega a ese usuario.
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const blobFile = (bid) => path.join(BLOB_DIR, String(bid).replace(/[^a-z0-9-]/gi, ''));
async function putBlob(bid, userId, mime, buf) {
  if (pool) return pool.query('INSERT INTO blobs (id, user_id, mime, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [bid, userId, mime, buf]);
  fs.mkdirSync(BLOB_DIR, { recursive: true });
  fs.writeFileSync(blobFile(bid), JSON.stringify({ userId, mime, data: buf.toString('base64') }));
}
async function getBlob(bid, userId) {
  if (pool) {
    const r = await pool.query('SELECT mime, data FROM blobs WHERE id = $1 AND user_id = $2', [bid, userId]);
    return r.rows[0] ? { mime: r.rows[0].mime, data: r.rows[0].data } : null;
  }
  try {
    const j = JSON.parse(fs.readFileSync(blobFile(bid), 'utf8'));
    return j.userId === userId ? { mime: j.mime, data: Buffer.from(j.data, 'base64') } : null;
  } catch {
    return null;
  }
}
async function delBlobs(ids) {
  ids = ids.filter(Boolean);
  if (!ids.length) return;
  if (pool) return pool.query('DELETE FROM blobs WHERE id = ANY($1)', [ids]);
  for (const b of ids) try { fs.unlinkSync(blobFile(b)); } catch {}
}
// Borra todo lo de un usuario (cuenta eliminada por él mismo o por un administrador)
async function deleteUserData(userId) {
  await delBlobs(db.receipts.filter((r) => r.userId === userId).map((r) => r.imageId));
  for (const k of USER_COLLECTIONS) db[k] = db[k].filter((x) => x.userId !== userId);
  db.users = db.users.filter((x) => x.id !== userId);
  return save();
}

module.exports = { db, init, save, flush, id, DATA_DIR, USER_COLLECTIONS, putBlob, getBlob, delBlobs, deleteUserData };
