import type {
  Decision,
  ExtractedField,
  ExtractionResult,
  LineItem,
  RuleExpr,
  RuleHit,
  RuleSet,
} from '../shared/types.js';

/**
 * Lo único que ve el motor: campos escalares y líneas, ambos ya validados
 * contra el esquema. Nunca el documento, nunca el texto crudo, nunca el prompt.
 */
interface Hechos {
  fields: Record<string, ExtractedField>;
  lineas: LineItem[];
}

/**
 * Motor de reglas determinista.
 *
 * Esta es la pieza que sostiene toda la capacidad de IA. El LLM extrae; ESTO
 * decide. Y la razón no es de estilo:
 *
 *  - Auditabilidad: "se rechazó por R-014 con estos valores", no "el modelo lo
 *    consideró así".
 *  - Reproducibilidad: guardamos rulesetVersion junto al resultado, así que una
 *    decisión de hace seis meses se puede reproducir exactamente.
 *  - Seguridad: un documento con texto malicioso puede engañar al extractor,
 *    pero no puede saltarse esto — porque este código NO LEE EL DOCUMENTO. Lee
 *    el JSON ya validado contra esquema. La separación es la mitigación.
 *  - Coste: un LLM es una forma cara, lenta y no determinista de sumar.
 */
export function evaluar(extraction: ExtractionResult, ruleSet: RuleSet): Decision {
  const { fields } = extraction;
  const hechos: Hechos = { fields, lineas: extraction.lineas ?? [] };
  const hits: RuleHit[] = [];

  for (const regla of ruleSet.reglas) {
    if (evalExpr(regla.cuando, hechos)) {
      hits.push({ id: regla.id, severidad: regla.severidad, mensaje: interpolar(regla.mensaje, fields) });
    }
  }

  // Compuerta de confianza POR CAMPO, no por documento: equivocarse en el
  // nombre del proveedor y en el importe total no cuestan lo mismo.
  const camposBajoUmbral = ruleSet.camposCriticos.filter((name) => {
    const f = fields[name];
    const umbral = ruleSet.umbrales[name] ?? ruleSet.umbrales.default;
    return !f || f.normalized === null || f.confidence < umbral;
  });

  const status = hits.some((h) => h.severidad === 'BLOCK')
    ? 'REJECTED'
    : camposBajoUmbral.length > 0 || hits.some((h) => h.severidad === 'WARN')
      ? 'NEEDS_REVIEW'
      : 'APPROVED';

  return { status, hits, camposBajoUmbral, rulesetVersion: ruleSet.version };
}

function evalExpr(expr: RuleExpr, hechos: Hechos): boolean {
  const { fields } = hechos;

  if ('de' in expr) {
    if (expr.op === 'and') return expr.de.every((e) => evalExpr(e, hechos));
    if (expr.op === 'or') return expr.de.some((e) => evalExpr(e, hechos));
    if (expr.op === 'not') return !evalExpr(expr.de as RuleExpr, hechos);
  }

  if (expr.op === 'sum_eq') {
    const suma = expr.campos.reduce((acc, c) => acc + num(fields, c), 0);
    const objetivo = num(fields, expr.ref);
    // Se dispara cuando NO cuadra: las reglas expresan la condición de problema.
    return Math.abs(suma - objetivo) > (expr.tolerancia ?? 0);
  }

  if (expr.op === 'sum_lineas_eq') {
    // Sin líneas no se puede afirmar que la suma esté mal. Que falten es un
    // problema de extracción (lo coge la compuerta de confianza), no de
    // aritmética: disparar aquí produciría un RECHAZO por un dato ausente.
    if (hechos.lineas.length === 0) return false;
    const suma = hechos.lineas.reduce((acc, l) => acc + (Number(l[expr.propiedad]) || 0), 0);
    const objetivo = num(fields, expr.ref);
    return Math.abs(suma - objetivo) > (expr.tolerancia ?? 0);
  }

  if (!('campo' in expr)) return false;
  const f = fields[expr.campo.split('.')[0] ?? ''];

  switch (expr.op) {
    case 'exists':
      return f?.normalized != null;
    case 'missing':
      return f?.normalized == null;
    case 'matches':
      // Una regla de FORMATO no puede dispararse sobre un dato ausente: eso
      // convertiría "el modelo no lo leyó" en "rechazado al cliente". La
      // ausencia la gobierna la compuerta de confianza; el formato, solo lo
      // que existe. Separar ambas cosas es lo que evita rechazos injustos.
      if (f?.normalized == null) return false;
      return new RegExp(expr.patron).test(String(f.normalized));
    default: {
      const izq = num(fields, expr.campo);
      const der = expr.ref !== undefined ? num(fields, expr.ref) : Number(expr.valor);
      switch (expr.op) {
        case 'gt': return izq > der;
        case 'gte': return izq >= der;
        case 'lt': return izq < der;
        case 'lte': return izq <= der;
        case 'eq': return izq === der;
        case 'ne': return izq !== der;
        default: return false;
      }
    }
  }
}

function num(fields: Record<string, ExtractedField>, ruta: string): number {
  const base = ruta.split('.')[0] ?? '';
  const v = fields[base]?.normalized;
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function interpolar(plantilla: string, fields: Record<string, ExtractedField>): string {
  return plantilla.replace(/\{(\w+)\}/g, (_, k: string) => String(fields[k]?.normalized ?? fields[k]?.value ?? '?'));
}
