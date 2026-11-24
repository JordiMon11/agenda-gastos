// Almacenamiento de datos.
// - Online (Render): si existe DATABASE_URL se guarda en PostgreSQL (p. ej. Neon, gratis).
// - Local: si no, se guarda en data/db.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');
const EMPTY = { users: [], sessions: [], categories: [], expenses: [], recurring: [], incomes: [], savings: [], savingMoves: [], securityLog: [] };

const db = structuredClone(EMPTY); // objeto compartido: nunca se reasigna, solo se modifica
let pool = null;

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
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

module.exports = { db, init, save, flush, id, DATA_DIR };
