// Mide la precisión real del clasificador con el conjunto de prueba (test/fixtures/clasificacion.json).
// Las cifras de confianza de server/classify.js (CONFIDENCE) salen de aquí.
// Uso: node scripts/calibrar-clasificacion.js
const path = require('path');
const C = require('../server/classify');
const FIX = (n) => require(path.join(__dirname, '..', 'test', 'fixtures', n)).items;

function measure(items = FIX(process.argv[2] === 'control' ? 'clasificacion-control.json' : 'clasificacion.json')) {
  // Un usuario con una categoría por cada categoría del diccionario (como si las tuviera todas)
  const names = [...new Set(C.DICTIONARY.filter((e) => !e.income).map((e) => e.category))];
  const cats = names.map((n, i) => ({ id: 'c' + i, name: n }));
  const ctx = C.buildContext({ cats });
  const bySource = {};
  let typeOk = 0;
  const errors = [];
  for (const it of items) {
    const r = C.classify({ description: it.d, amount: it.a }, ctx);
    const got = cats.find((c) => c.id === r.categoryId)?.name || null;
    const key = r.source === 'dictionary' && r.confidence === C.CONFIDENCE.dictionaryLoose ? 'dictionaryLoose' : r.source;
    const s = (bySource[key] ||= { n: 0, ok: 0 });
    s.n++;
    const ok = got === it.cat;
    if (ok) s.ok++;
    if (r.type === it.type) typeOk++;
    if (!ok || r.type !== it.type) errors.push({ d: it.d, esperado: `${it.cat} / ${it.type}`, obtenido: `${got} / ${r.type}`, fuente: key });
  }
  const precision = Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, { casos: v.n, aciertos: v.ok, precision: Math.round((v.ok / v.n) * 1000) / 1000 }]));
  const auto = items.map((it) => ({ it, r: C.classify({ description: it.d, amount: it.a }, ctx) })).filter((x) => x.r.review === 'auto');
  const autoOk = auto.filter(({ it, r }) => (cats.find((c) => c.id === r.categoryId)?.name || null) === it.cat).length;
  return { total: items.length, precision, typeAccuracy: Math.round((typeOk / items.length) * 1000) / 1000, auto: { casos: auto.length, precision: auto.length ? Math.round((autoOk / auto.length) * 1000) / 1000 : null }, errors };
}

if (require.main === module) {
  const m = measure();
  console.log(`Conjunto de prueba: ${m.total} movimientos`);
  console.table(m.precision);
  console.log(`Tipo de movimiento acertado: ${(m.typeAccuracy * 100).toFixed(1)} %`);
  console.log(`Clasificados automáticamente (confianza alta): ${m.auto.casos}, precisión ${(m.auto.precision * 100).toFixed(1)} %`);
  if (m.errors.length) { console.log('\nFallos:'); console.table(m.errors); }
}
module.exports = { measure, FIX };
