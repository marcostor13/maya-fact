import type { Decision, RuleHit } from './types.js';

/**
 * Por qué un documento acabó como acabó, en castellano y para un humano.
 *
 * ── Por qué esto se calcula en el servidor y se PERSISTE ─────────────────
 *
 * La tentación es dejar los códigos (`CLASIFICACION_FALLIDA`, `R-002`) en la
 * base de datos y traducirlos en el frontend. Es peor por tres razones:
 *
 *  1. **Auditabilidad.** Lo que se guarda es exactamente lo que se le dijo al
 *     cliente. Si el catálogo cambia dentro de seis meses, el registro sigue
 *     diciendo lo que decía el día de la decisión — igual que `rulesetVersion`
 *     existe para que una decisión vieja se pueda reproducir (ADR-013).
 *  2. **Una sola fuente.** La API, el correo de notificación que no existe
 *     todavía y la pantalla de revisión dicen lo mismo sin coordinarse.
 *  3. **Superficie.** El frontend no necesita saber qué códigos internos
 *     existen, y esos códigos tampoco son algo que convenga publicar.
 *
 * ── Qué NO entra aquí ────────────────────────────────────────────────────
 *
 * Nada que venga del `Cause` de Step Functions: lleva trazas de pila y nombres
 * de recursos (CLAUDE.md I-7). De ahí solo se extrae el CÓDIGO, que es un
 * identificador nuestro de un conjunto cerrado, y se usa para elegir una frase
 * escrita por nosotros. El detalle sigue yendo al log y al evento de auditoría.
 */
export interface Explicacion {
  /** Una frase. Es lo que se lee primero y, muchas veces, lo único que se lee. */
  resumen: string;
  /** Las razones concretas, una por línea. Puede venir vacío. */
  detalles: string[];
}

/**
 * Nombres de campo legibles. El motor de reglas y la compuerta de confianza
 * hablan en `proveedor_id_fiscal`; una persona, no.
 */
export const ETIQUETA_CAMPO: Record<string, string> = {
  proveedor_nombre: 'nombre del proveedor',
  proveedor_id_fiscal: 'identificador fiscal del proveedor',
  numero_documento: 'número de documento',
  fecha_emision: 'fecha de emisión',
  moneda: 'moneda',
  subtotal: 'base imponible',
  impuesto: 'impuesto',
  total: 'importe total',
};

export const etiquetaCampo = (nombre: string): string => ETIQUETA_CAMPO[nombre] ?? nombre;

/**
 * El código de un `PermanentError` viaja DENTRO del mensaje.
 *
 * El runtime de Lambda serializa un error como `{errorType, errorMessage}` —
 * `errorType` es el `name` y `errorMessage` es el `message`. Cualquier
 * propiedad extra se pierde en el salto a Step Functions. Sin el prefijo,
 * `finalize` recibiría "algo falló" y el usuario leería "no se pudo procesar"
 * en lugar de "esto no es un PDF".
 *
 * Se lee de `Cause`, que es un JSON con esa forma, y **solo se acepta un código
 * de la lista blanca**: un `Cause` es contenido que no controlamos del todo, y
 * lo que sale de aquí acaba eligiendo un texto que ve el cliente.
 */
const CODIGOS_CONOCIDOS = new Set([
  'MIME_DESCONOCIDO',
  'DEMASIADAS_PAGINAS',
  'ENTRADA_DEMASIADO_GRANDE',
  'SIN_SALIDA_ESTRUCTURADA',
  'FALTA_OCR',
  'RUTA_MANUAL',
  'BEDROCK_TRANSITORIO',
]);

export function codigoDeCausa(cause?: string): string | undefined {
  if (!cause) return undefined;
  let mensaje = cause;
  try {
    const obj: unknown = JSON.parse(cause);
    if (obj && typeof obj === 'object' && typeof (obj as { errorMessage?: unknown }).errorMessage === 'string') {
      mensaje = (obj as { errorMessage: string }).errorMessage;
    }
  } catch {
    // El Cause no siempre es JSON (un timeout de la propia tarea, por ejemplo).
    // No es un error: simplemente no hay código que extraer del cuerpo.
  }
  const encontrado = mensaje.match(/^\[([A-Z_]{3,40})\]/)?.[1];
  return encontrado && CODIGOS_CONOCIDOS.has(encontrado) ? encontrado : undefined;
}

/** Quita el prefijo `[CODIGO] ` de un mensaje pensado para un humano. */
export const sinPrefijo = (mensaje: string): string => mensaje.replace(/^\[[A-Z_]{3,40}\]\s*/, '');

// ── Cierres por el camino de fallo ───────────────────────────────────────

/**
 * Cada código explica **qué pasó y qué puede hacer el cliente**. Un mensaje que
 * no dice qué hacer no es un mensaje de error, es una notificación de derrota.
 */
const POR_CODIGO: Record<string, Explicacion> = {
  MIME_DESCONOCIDO: {
    resumen: 'El archivo no es un PDF ni una imagen que podamos leer.',
    detalles: [
      'El tipo de archivo se comprueba leyendo sus primeros bytes, no su extensión: renombrar un fichero a «.pdf» no lo convierte en un PDF.',
      'Vuelve a subirlo en PDF, JPG, PNG o TIFF.',
    ],
  },
  DEMASIADAS_PAGINAS: {
    resumen: 'El documento supera el límite de 50 páginas.',
    detalles: [
      'El límite protege el tiempo de proceso y el coste de extracción.',
      'Si son varias facturas en un mismo archivo, súbelas por separado.',
    ],
  },
  ENTRADA_DEMASIADO_GRANDE: {
    resumen: 'El documento es demasiado extenso para extraerlo automáticamente.',
    detalles: [
      'Cabe en el límite de páginas, pero contiene demasiado texto para una sola extracción.',
      'Queda a la espera de revisión manual: no se ha perdido nada.',
    ],
  },
  SIN_SALIDA_ESTRUCTURADA: {
    resumen: 'No hemos podido reconocer los campos de la factura.',
    detalles: [
      'El documento se leyó, pero no tiene la forma de una factura que sepamos interpretar.',
      'Queda a la espera de revisión manual.',
    ],
  },
  FALTA_OCR: {
    resumen: 'No hemos podido leer el texto del documento.',
    detalles: ['Queda a la espera de revisión manual.'],
  },
  RUTA_MANUAL: {
    resumen: 'Este documento no se puede procesar automáticamente.',
    detalles: ['Queda a la espera de revisión manual.'],
  },
  BEDROCK_TRANSITORIO: {
    resumen: 'El servicio de extracción no respondió tras varios intentos.',
    detalles: [
      'Es un fallo temporal por nuestra parte, no un problema del documento.',
      'Queda a la espera de revisión manual; puedes volver a subirlo más tarde.',
    ],
  },
};

/** Cuando no hay código, al menos se dice en qué fase se cayó. */
const POR_MOTIVO: Record<string, Explicacion> = {
  CONTENIDO_YA_PROCESADO: {
    resumen: 'Este archivo es idéntico a otro que ya procesamos.',
    detalles: [
      'Dos archivos con exactamente el mismo contenido son el mismo documento, aunque el nombre o la fecha de subida cambien.',
      'No se ha vuelto a extraer: el resultado del original sigue siendo válido.',
    ],
  },
  CLASIFICACION_FALLIDA: {
    resumen: 'No hemos podido leer el archivo, así que no llegó a procesarse.',
    detalles: ['Comprueba que sea un PDF o una imagen válidos y vuelve a subirlo.'],
  },
  EXTRACCION_FALLIDA: {
    resumen: 'La extracción no pudo completarse.',
    detalles: ['El documento queda a la espera de revisión manual: no se ha perdido.'],
  },
};

const GENERICA: Explicacion = {
  resumen: 'El documento no pudo procesarse automáticamente.',
  detalles: ['Queda a la espera de revisión manual.'],
};

/**
 * Explicación de un cierre por el camino de fallo. El código concreto manda
 * sobre el motivo de fase: «esto no es un PDF» le sirve al cliente, «falló la
 * clasificación» no.
 */
export function explicarCierre(motivo: string, codigo?: string): Explicacion {
  const porCodigo = codigo ? POR_CODIGO[codigo] : undefined;
  return porCodigo ?? POR_MOTIVO[motivo] ?? GENERICA;
}

// ── Decisiones del motor de reglas ───────────────────────────────────────

const plural = (n: number, singular: string, plural_: string) => (n === 1 ? singular : plural_);

/** Lista natural: «a, b y c». Un «a, b, c» a secas se lee como una máquina. */
function enumerar(partes: string[]): string {
  if (partes.length <= 1) return partes[0] ?? '';
  return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1] ?? ''}`;
}

/**
 * Explicación de una decisión del motor de reglas.
 *
 * Fíjate en la separación, que es la misma que hace el motor: una regla
 * `BLOCK` es un **rechazo**; un campo por debajo de su umbral de confianza es
 * una **duda de lectura**. Mezclarlas en un solo párrafo haría que el cliente
 * leyera «rechazada» donde el sistema solo quiso decir «no lo veo claro».
 */
export function explicarDecision(decision: Decision, ajustes: string[] = []): Explicacion {
  const bloqueos = decision.hits.filter((h) => h.severidad === 'BLOCK');
  const avisos = decision.hits.filter((h) => h.severidad !== 'BLOCK');
  const detalles: string[] = [];

  const texto = (h: RuleHit) => `${h.mensaje} (${h.id})`;

  if (decision.status === 'REJECTED') {
    detalles.push(...bloqueos.map(texto), ...avisos.map(texto));
    detalles.push(...detallesDeAjustes(ajustes));
    return {
      resumen:
        bloqueos.length === 1
          ? 'Rechazada: una comprobación obligatoria no se cumple.'
          : `Rechazada: ${bloqueos.length} comprobaciones obligatorias no se cumplen.`,
      detalles,
    };
  }

  if (decision.status === 'NEEDS_REVIEW') {
    detalles.push(...avisos.map(texto));

    const dudosos = decision.camposBajoUmbral.map(etiquetaCampo);
    if (dudosos.length) {
      detalles.push(
        `No hemos podido leer con suficiente seguridad ${enumerar(dudosos)}. ` +
          'Los campos críticos se aprueban solos únicamente cuando la lectura es clara.',
      );
    }
    detalles.push(...detallesDeAjustes(ajustes));

    const motivos: string[] = [];
    if (avisos.length) motivos.push(`${avisos.length} ${plural(avisos.length, 'aviso', 'avisos')}`);
    if (dudosos.length) {
      motivos.push(`${dudosos.length} ${plural(dudosos.length, 'campo dudoso', 'campos dudosos')}`);
    }

    return {
      resumen: motivos.length
        ? `Necesita revisión: ${enumerar(motivos)}.`
        : 'Necesita que una persona la revise antes de aprobarla.',
      detalles,
    };
  }

  return {
    resumen: 'Aprobada: todas las comprobaciones se cumplen.',
    detalles: detallesDeAjustes(ajustes),
  };
}

/**
 * Los ajustes de la reconciliación se enseñan SIEMPRE, también en las
 * aprobadas. Un importe que el sistema dedujo en vez de leer es exactamente el
 * dato que alguien querrá comprobar, y esconderlo en una aprobación sería
 * corregir en silencio — que es justo lo que `source: 'rule_derived'` existe
 * para evitar.
 */
function detallesDeAjustes(ajustes: string[]): string[] {
  return ajustes.map((a) => `Ajuste automático: ${a}`);
}
