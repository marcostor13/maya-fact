import type { PreTokenGenerationV2TriggerHandler } from 'aws-lambda';

/**
 * Inyecta tenant_id y roles en el ACCESS token.
 *
 * El authorizer JWT de API Gateway valida firma, issuer, audiencia y expiración
 * antes de que nuestro código se ejecute. Nuestras Lambdas leen el claim y lo
 * usan como clave de partición. Nadie puede falsificarlo sin la clave privada
 * del user pool.
 */
export const handler: PreTokenGenerationV2TriggerHandler = async (event) => {
  const attrs = event.request.userAttributes;
  const tenantId = attrs['custom:tenant_id'];

  if (!tenantId) {
    // Un usuario sin tenant no puede operar. Fallar aquí es preferible a emitir
    // un token ambiguo que luego alguna Lambda interprete como "todos".
    throw new Error('Usuario sin custom:tenant_id asignado');
  }

  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];

  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: {
        claimsToAddOrOverride: {
          tenant_id: tenantId,
          roles: groups.join(','),
        },
      },
    },
  };

  return event;
};
