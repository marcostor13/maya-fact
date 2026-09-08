import type { APIGatewayProxyResultV2 } from 'aws-lambda';

const SECURITY_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export const ok = (body: unknown, statusCode = 200): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: SECURITY_HEADERS,
  body: JSON.stringify(body),
});

/**
 * Errores genéricos hacia fuera, detalle solo en logs.
 *
 * Y una decisión deliberada: "no existe" y "no es tuyo" devuelven EXACTAMENTE
 * lo mismo (404). Distinguirlos permite enumerar qué documentos existen en
 * otros tenants.
 */
export const fail = (statusCode: number, code: string): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: SECURITY_HEADERS,
  body: JSON.stringify({ error: code }),
});

export const notFound = () => fail(404, 'NOT_FOUND');
