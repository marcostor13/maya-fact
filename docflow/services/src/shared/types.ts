/** Ruta de procesamiento elegida por el clasificador. Es la palanca de coste. */
export type Route =
  | 'R1_PDF_TEXT'        // PDF con capa de texto -> directo al modelo. Sin OCR.
  | 'R2_VISION'          // Imagen o escaneo -> modelo multimodal. Sin OCR.
  | 'R3_TEXTRACT'        // Necesita bbox y confianza calibrada -> Textract + modelo.
  | 'R4_MANUAL';         // No procesable automáticamente.

export type DocumentStatus =
  | 'PENDING'      // intent creado, archivo aún no subido
  | 'RECEIVED'     // archivo en S3, evento emitido
  | 'PROCESSING'
  | 'APPROVED'
  | 'NEEDS_REVIEW'
  | 'REJECTED'
  | 'DUPLICATE'    // mismo contenido que un documento anterior: no se re-extrae
  | 'QUARANTINED'; // fallo permanente: no se reintenta

/** Procedencia de un campo. Distingue lo que el sistema LEYÓ de lo que DEDUJO. */
export type FieldSource = 'ocr_geometry' | 'llm_inference' | 'rule_derived';

export interface ExtractedField<T = string | number | null> {
  value: string | null;
  normalized: T;
  confidence: number;      // 0..1
  source: FieldSource;
  page?: number;
  bbox?: { left: number; top: number; width: number; height: number };
  /** Cita literal del documento. Permite verificar sin bbox en rutas sin OCR. */
  quote?: string;
}

/**
 * Una línea de detalle. NO es un ExtractedField: es una fila, y las reglas
 * aritméticas necesitan sumarla. Vive aparte de `fields` justo por eso.
 */
export interface LineItem {
  descripcion: string;
  cantidad?: number;
  importe: number;
  confidence: number;
}

export interface ExtractionResult {
  fields: Record<string, ExtractedField>;
  /** Las líneas de detalle, separadas de los campos escalares. */
  lineas: LineItem[];
  modelId: string;
  promptVersion: string;
  route: Route;
  inputTokens?: number;
  outputTokens?: number;
}

export type Severity = 'BLOCK' | 'WARN' | 'INFO';

export interface Rule {
  id: string;
  descripcion: string;
  severidad: Severity;
  mensaje: string;
  cuando: RuleExpr;
}

export type RuleExpr =
  | { campo: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'; valor?: number | string; ref?: string }
  | { campo: string; op: 'exists' | 'missing' }
  | { campo: string; op: 'matches'; patron: string }
  /** Suma de campos escalares comparada con otro campo. subtotal + impuesto = total. */
  | { op: 'sum_eq'; campos: string[]; ref: string; tolerancia?: number }
  /**
   * Suma de una propiedad de las líneas comparada con uno o VARIOS campos.
   *
   * `refs` admite varios a propósito: si los precios de las líneas excluyen
   * impuesto, suman el subtotal; si lo incluyen —boletas y tickets—, suman el
   * total. Las dos son facturas correctas, así que la regla solo se dispara
   * cuando la suma no coincide con NINGUNA. Exigir solo `subtotal` daba por
   * universal un modelo de precios que no lo es.
   */
  | { op: 'sum_lineas_eq'; propiedad: 'importe'; ref?: string; refs?: string[]; tolerancia?: number }
  | { op: 'and' | 'or'; de: RuleExpr[] }
  | { op: 'not'; de: RuleExpr };

export interface RuleSet {
  tenantId: string;
  version: string;
  reglas: Rule[];
  /** Umbral de confianza por campo. Falta -> se usa `default`. */
  umbrales: Record<string, number> & { default: number };
  camposCriticos: string[];
}

export interface RuleHit {
  id: string;
  severidad: Severity;
  mensaje: string;
}

export interface Decision {
  status: Extract<DocumentStatus, 'APPROVED' | 'NEEDS_REVIEW' | 'REJECTED'>;
  hits: RuleHit[];
  camposBajoUmbral: string[];
  rulesetVersion: string;
}
