import type { ExtractedField, ExtractionResult } from '../shared/types.js';

/** Tolerancia en céntimos: absorbe el redondeo del IGV, no un error real. */
const TOLERANCIA = 2;

export interface Reconciliacion {
  fields: Record<string, ExtractedField>;
  /** Qué se recalculó y por qué. Va al registro de auditoría. */
  ajustes: string[];
}

/**
 * Recalcula los importes que se pueden DERIVAR en vez de leer.
 *
 * ── Por qué existe este fichero ──────────────────────────────────────────
 *
 * Una boleta real de supermercado peruano imprime, en el mismo documento:
 *
 *     SUBTOTAL                26.65   <- pese al nombre, es el TOTAL (con IGV)
 *     OP.GRAVADA              22.59   <- esta es la base imponible
 *     IGV 18.00%               4.06
 *     TOTAL DEL VALOR VENTA   22.59   <- pese al nombre, es la BASE
 *     IMPORTE TOTAL           26.65   <- este sí es el total
 *
 * El modelo seguía las etiquetas —que es lo razonable— y asignaba mal. Lo
 * intenté arreglar tres veces con el prompt: v3, v4 y v5, cada una más
 * explícita. Seguía fallando.
 *
 * Y ahí está la lección, que es de arquitectura y no de prompt: **le estaba
 * pidiendo a un modelo probabilístico un número que se CALCULA**. El subtotal
 * es `total - impuesto`. No hay nada que leer.
 *
 * Es el ADR-012 un nivel más abajo. "El LLM extrae, el LLM no decide" tiene un
 * corolario: **el LLM lee lo que hay que leer; lo que se puede derivar, se
 * deriva de forma determinista.** Cada campo que el modelo no tiene que
 * adivinar es un campo que no puede equivocar.
 *
 * ── Por qué NO rompe la defensa contra inyección ─────────────────────────
 *
 * Derivar a ciegas sería peligroso: taparía justo la incoherencia aritmética
 * que detecta un documento manipulado. Por eso la derivación exige
 * **corroboración de las líneas**, que el atacante no controla junto con el
 * total sin que algo deje de cuadrar:
 *
 *   - Documento legítimo con IGV incluido: las líneas suman el total (26,65).
 *     La derivación se corrobora y se aplica.
 *   - Documento manipulado (total = 0, líneas 4.200): las líneas no suman el
 *     total ni el subtotal derivado. NO se deriva, y R-002 rechaza como antes.
 *
 * Es decir: solo se corrige lo que el propio documento ya confirma por otra vía.
 */
export function reconciliarImportes(extraction: ExtractionResult): Reconciliacion {
  const fields = { ...extraction.fields };
  const ajustes: string[] = [];

  const num = (n: string): number | null => {
    const v = fields[n]?.normalized;
    return typeof v === 'number' ? v : null;
  };

  const subtotal = num('subtotal');
  const impuesto = num('impuesto');
  const total = num('total');

  // Nada que reconciliar si ya cuadra, o si falta información para derivar.
  if (subtotal !== null && impuesto !== null && total !== null) {
    if (Math.abs(subtotal + impuesto - total) <= TOLERANCIA) return { fields, ajustes };
  }
  if (impuesto === null || total === null) return { fields, ajustes };

  const derivado = total - impuesto;
  if (derivado <= 0) return { fields, ajustes };

  // La corroboración: las líneas tienen que respaldar la lectura del total.
  // En documentos con impuesto incluido suman el total; en los que no lo
  // incluyen, suman la base. Cualquiera de las dos vale como confirmación.
  const sumaLineas = (extraction.lineas ?? []).reduce((a, l) => a + (Number(l.importe) || 0), 0);
  if (sumaLineas === 0) return { fields, ajustes };

  const corroborado =
    Math.abs(sumaLineas - total) <= TOLERANCIA || Math.abs(sumaLineas - derivado) <= TOLERANCIA;
  if (!corroborado) return { fields, ajustes };

  const anterior = fields['subtotal'];
  fields['subtotal'] = {
    value: anterior?.value ?? null,
    normalized: derivado,
    // La confianza es la del eslabón más débil de los dos que entran en el
    // cálculo: un derivado no puede ser más fiable que sus operandos.
    confidence: Math.min(fields['impuesto']?.confidence ?? 1, fields['total']?.confidence ?? 1),
    // `rule_derived` distingue lo que el sistema DEDUJO de lo que LEYÓ. Ese
    // matiz existe en el modelo de datos desde el principio y es lo que permite
    // que una auditoría sepa que este número no estaba impreso así.
    source: 'rule_derived',
    ...(anterior?.quote ? { quote: anterior.quote } : {}),
  };

  ajustes.push(
    `subtotal recalculado como total - impuesto (${total} - ${impuesto} = ${derivado}); ` +
      `leído ${subtotal ?? 'null'}; corroborado por la suma de líneas (${sumaLineas})`,
  );

  return { fields, ajustes };
}
