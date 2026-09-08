import type { Block } from '@aws-sdk/client-textract';
import type { ExtractedField } from '../shared/types.js';

/**
 * Una palabra del OCR con lo único que compramos al pagar Textract:
 * su posición y su confianza CALIBRADA.
 *
 * La distinción importa y es el corazón del ADR-011: el `confidence` que un LLM
 * escribe en un campo JSON es un token que generó — una opinión con forma de
 * número. El `Confidence` de Textract es la salida de un modelo entrenado para
 * esa tarea estrecha: es una probabilidad. Si tu compuerta de revisión humana
 * depende de la confianza, la diferencia no es académica.
 */
export interface Palabra {
  texto: string;
  /** 1-indexada, como la enseña el visor de la UI de revisión. */
  pagina: number;
  /** Confianza de Textract, 0..1 (la API la devuelve 0..100). */
  confianza: number;
  bbox: { left: number; top: number; width: number; height: number };
}

export interface OcrResultado {
  palabras: Palabra[];
  /** El texto plano reconstruido, que es lo que se le manda al modelo. */
  texto: string;
}

/** Convierte los bloques WORD de Textract en nuestro modelo mínimo. */
export function palabrasDesdeBloques(blocks: Block[] | undefined): Palabra[] {
  return (blocks ?? []).flatMap((b) => {
    if (b.BlockType !== 'WORD' || !b.Text || !b.Geometry?.BoundingBox) return [];
    const bb = b.Geometry.BoundingBox;
    return [{
      texto: b.Text,
      pagina: b.Page ?? 1,
      confianza: (b.Confidence ?? 0) / 100,
      bbox: {
        left: bb.Left ?? 0,
        top: bb.Top ?? 0,
        width: bb.Width ?? 0,
        height: bb.Height ?? 0,
      },
    }];
  });
}

/** Reconstruye el texto por líneas: es lo que va al prompt en la ruta R3. */
export function textoDesdeBloques(blocks: Block[] | undefined): string {
  return (blocks ?? [])
    .filter((b) => b.BlockType === 'LINE' && b.Text)
    .map((b) => b.Text)
    .join('\n');
}

const normalizar = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Ancla un campo extraído a su sitio en la página.
 *
 * Esto es lo que cierra el círculo de la ruta R3. El modelo devuelve una cita
 * literal (`quote`); aquí buscamos esa cita entre las palabras del OCR y
 * devolvemos el rectángulo que las envuelve y la confianza calibrada mínima de
 * ese tramo. Resultado: la UI de revisión puede resaltar el importe dudoso
 * sobre la imagen, y una auditoría puede responder "este número salió de aquí".
 *
 * Y hay un efecto secundario que vale tanto como el principal: si la cita del
 * modelo NO aparece en el texto del OCR, el campo no se ancla. Un importe que
 * el modelo se inventó no tiene dónde anclarse — así que la ausencia de anclaje
 * es una señal de alucinación, no un fallo de la función.
 */
export function anclar(campo: ExtractedField, palabras: Palabra[]): ExtractedField {
  const aguja = normalizar(campo.quote ?? campo.value ?? '');
  if (!aguja || palabras.length === 0) return campo;

  // Ventana deslizante sobre las palabras: la más corta que contiene la cita.
  for (let inicio = 0; inicio < palabras.length; inicio++) {
    let acumulado = '';
    for (let fin = inicio; fin < Math.min(inicio + 40, palabras.length); fin++) {
      const p = palabras[fin];
      if (!p) break;
      // Un tramo solo es válido dentro de una misma página.
      if (p.pagina !== palabras[inicio]!.pagina) break;
      acumulado += normalizar(p.texto);
      if (!acumulado) continue;
      if (acumulado === aguja || acumulado.includes(aguja)) {
        const tramo = palabras.slice(inicio, fin + 1);
        return {
          ...campo,
          source: 'ocr_geometry',
          // La confianza pasa a ser la del ESLABÓN MÁS DÉBIL del tramo leído.
          // Sustituye a la autoevaluación del modelo, que es lo que se compra.
          confidence: Math.min(...tramo.map((t) => t.confianza)),
          page: tramo[0]!.pagina,
          bbox: envolver(tramo),
        };
      }
      if (acumulado.length > aguja.length) break; // ya nos pasamos: reinicia
    }
  }

  // Sin anclaje: se marca como inferencia del modelo, no como lectura. Ese
  // `source` es exactamente lo que distingue lo que el sistema LEYÓ de lo que
  // DEDUJO, y es lo que la compuerta de confianza debe tratar distinto.
  return { ...campo, source: 'llm_inference' };
}

function envolver(tramo: Palabra[]): NonNullable<ExtractedField['bbox']> {
  const left = Math.min(...tramo.map((p) => p.bbox.left));
  const top = Math.min(...tramo.map((p) => p.bbox.top));
  const right = Math.max(...tramo.map((p) => p.bbox.left + p.bbox.width));
  const bottom = Math.max(...tramo.map((p) => p.bbox.top + p.bbox.height));
  return { left, top, width: right - left, height: bottom - top };
}
