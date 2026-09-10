/**
 * La distinción que evita quemar dinero: un error permanente reintentado tres
 * veces son tres facturas de OCR y tres entradas de ruido en las métricas.
 */
/**
 * El código va DENTRO del mensaje, y no es un descuido de estilo.
 *
 * El runtime de Lambda serializa un error como `{errorType, errorMessage}`:
 * `errorType` es el `name` y `errorMessage` es el `message`. **Cualquier otra
 * propiedad se pierde** en el salto a Step Functions. Sin este prefijo, el paso
 * que cierra el documento recibe "algo falló" y el cliente lee "no se pudo
 * procesar" en vez de "esto no es un PDF" — que es la única de las dos frases
 * que le dice qué hacer.
 *
 * El `name` NO se toca: Step Functions selecciona los reintentos comparándolo
 * con `'TransientError'`, así que meter el código ahí desactivaría el backoff
 * en silencio. `services/src/shared/explicacion.ts` lo vuelve a extraer.
 */
const conCodigo = (code: string, message: string) => `[${code}] ${message}`;

/**
 * El `code` se asigna en el cuerpo del constructor y NO como propiedad de
 * parámetro (`constructor(..., readonly code: string)`).
 *
 * No es preferencia de estilo: `node --experimental-strip-types` —el mismo
 * runner con el que CI ejecuta los tests— **no admite propiedades de
 * parámetro**, porque borrar tipos no puede generar la asignación implícita.
 * Escrito de la otra forma, este fichero compila con `tsc` y revienta con
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` en cuanto un test lo importa. Estuvo así
 * hasta que un test lo importó por primera vez, que es exactamente cuando se
 * descubren estas cosas.
 */
export class PermanentError extends Error {
  readonly permanent = true;
  readonly code: string;
  constructor(message: string, code: string) {
    super(conCodigo(code, message));
    this.name = 'PermanentError';
    this.code = code;
  }
}

export class TransientError extends Error {
  readonly permanent = false;
  readonly code: string;
  constructor(message: string, code: string) {
    super(conCodigo(code, message));
    this.name = 'TransientError';
    this.code = code;
  }
}

const TRANSIENT_AWS_CODES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'ServiceUnavailable',
  'InternalServerError',
  'RequestTimeout',
  'ModelTimeoutException',
  'ModelNotReadyException',
]);

export function isTransient(err: unknown): boolean {
  if (err instanceof PermanentError) return false;
  if (err instanceof TransientError) return true;
  const name = (err as { name?: string })?.name ?? '';
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (TRANSIENT_AWS_CODES.has(name)) return true;
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
  return false;
}
