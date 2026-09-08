import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

export interface Caller {
  tenantId: string;
  userId: string;
  roles: string[];
}

/**
 * ÚNICA fuente de verdad del tenant en toda la aplicación.
 *
 * El authorizer JWT de API Gateway ya validó firma, iss, aud y exp. Aquí solo
 * leemos. Si alguna vez ves `event.pathParameters.tenantId` en este repo, es un
 * bug de seguridad, no una variación de estilo.
 */
export function callerFrom(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const tenantId = String(claims['tenant_id'] ?? '');
  const userId = String(claims['sub'] ?? '');
  if (!tenantId || !userId) {
    throw new Error('Token sin tenant_id o sub');
  }
  const roles = String(claims['roles'] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  return { tenantId, userId, roles };
}
