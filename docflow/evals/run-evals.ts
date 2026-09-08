/**
 * Evals del extractor. El prompt es código: tiene versión, tests y despliegue.
 *
 * Métrica: EXACTITUD A NIVEL DE CAMPO, no de documento. "El 92% de los
 * documentos salieron perfectos" oculta que fallas sistemáticamente en un campo.
 *
 * Uso:
 *   MODEL_ID=... npx tsx evals/run-evals.ts
 *   MODEL_ID=... npx tsx evals/run-evals.ts --umbral 0.95
 *
 * En CI: ningún cambio de prompt, de esquema o de modelo se despliega sin pasar
 * el umbral. Es lo que te permite migrar de versión de modelo sin saltar sin red.
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler as extract } from '../services/src/pipeline/extract.js';
import { evaluar } from '../services/src/pipeline/rules-engine.js';
import ruleSet from '../rules/acme-invoices.json';
import type { ExtractedField, RuleSet } from '../services/src/shared/types.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const UMBRAL = Number(process.argv.includes('--umbral') ? process.argv[process.argv.indexOf('--umbral') + 1] : 0.9);

interface CasoDorado {
  id: string;
  descripcion: string;
  bucket: string;
  key: string;
  route: 'R1_PDF_TEXT' | 'R2_VISION' | 'R3_TEXTRACT';
  detectedMime: string;
  esperado: Record<string, string | number | null>;
  /** Estado esperado tras aplicar reglas. Detecta regresiones del motor. */
  statusEsperado?: 'APPROVED' | 'NEEDS_REVIEW' | 'REJECTED';
}

const aciertos = new Map<string, { ok: number; total: number }>();

function anota(campo: string, ok: boolean) {
  const a = aciertos.get(campo) ?? { ok: 0, total: 0 };
  a.total += 1;
  if (ok) a.ok += 1;
  aciertos.set(campo, a);
}

const casos: CasoDorado[] = JSON.parse(
  await readFile(join(AQUI, 'golden-set', 'casos.json'), 'utf8'),
);

let fallosDeEstado = 0;

for (const caso of casos) {
  const res = await extract({
    tenantId: 'eval',
    documentId: caso.id,
    bucket: caso.bucket,
    key: caso.key,
    route: caso.route,
    detectedMime: caso.detectedMime,
  });

  for (const [campo, esperado] of Object.entries(caso.esperado)) {
    const obtenido = (res.fields as Record<string, ExtractedField>)[campo]?.normalized ?? null;
    anota(campo, iguales(obtenido, esperado));
  }

  if (caso.statusEsperado) {
    const decision = evaluar(res, ruleSet as unknown as RuleSet);
    if (decision.status !== caso.statusEsperado) {
      fallosDeEstado += 1;
      console.error(`  ✗ ${caso.id}: estado ${decision.status}, esperado ${caso.statusEsperado}`);
    }
  }
}

console.log(`\nExactitud por campo (${casos.length} documentos):\n`);
let peor = 1;
for (const [campo, a] of [...aciertos].sort((x, y) => x[1].ok / x[1].total - y[1].ok / y[1].total)) {
  const tasa = a.ok / a.total;
  peor = Math.min(peor, tasa);
  const marca = tasa >= UMBRAL ? '✓' : '✗';
  console.log(`  ${marca} ${campo.padEnd(24)} ${(tasa * 100).toFixed(1)}%  (${a.ok}/${a.total})`);
}

console.log(`\nPeor campo: ${(peor * 100).toFixed(1)}% — umbral ${(UMBRAL * 100).toFixed(0)}%`);
if (fallosDeEstado) console.log(`Fallos de decisión: ${fallosDeEstado}`);

// El criterio de corte es el PEOR campo, no la media. Un campo crítico al 60%
// hunde el producto aunque la media salga en 94%.
if (peor < UMBRAL || fallosDeEstado > 0) {
  console.error('\nEVALS FALLIDOS — no desplegar este prompt/modelo.');
  process.exit(1);
}
console.log('\nEvals superados.');

function iguales(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1;
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}
