/**
 * La distinción que evita quemar dinero: un error permanente reintentado tres
 * veces son tres facturas de OCR y tres entradas de ruido en las métricas.
 */
export class PermanentError extends Error {
  readonly permanent = true;
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export class TransientError extends Error {
  readonly permanent = false;
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'TransientError';
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
