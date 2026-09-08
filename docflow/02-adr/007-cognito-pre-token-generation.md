# ADR-007 — Cognito con el tenant inyectado en el access token

**Estado:** aceptada · **Código:** `infra/lib/auth.ts`, `services/src/auth/pre-token-generation.ts`, `services/src/shared/auth-context.ts`

## Contexto

Es un SaaS B2B multi-tenant. Cada petición tiene que saber, **de forma no
falsificable**, a qué cliente pertenece quien la hace.

## Decisión

**Cognito User Pools** con un trigger de **pre-token-generation V2** que inyecta
`tenant_id` y `roles` como claims del **access token**. El *authorizer* JWT
nativo de API Gateway valida firma, `iss`, `aud` y `exp` antes de que nuestro
código se ejecute.

**La regla, y es absoluta:**

> El `tenant_id` sale **siempre** del token firmado. **Nunca** del path, del
> query string ni del body.

Es una regla auditable mecánicamente: si en este repositorio aparece
`event.pathParameters.tenantId`, es un bug de seguridad, no una variación de
estilo. Toda la aplicación lee el tenant por una única función,
`callerFrom()`.

## Detalles que importan

- **V2 y no V1**: la versión 1 solo permite modificar el *id token*, y el claim
  hace falta en el *access token*, que es el que valida el authorizer.
- **Si un usuario no tiene tenant asignado, el trigger lanza una excepción** en
  vez de emitir un token sin el claim. Un token ambiguo que alguna Lambda
  interprete como "todos los tenants" es mucho peor que un login fallido.
- `custom:tenant_id` es **inmutable**: se asigna al crear el usuario y no cambia.
- `preventUserExistenceErrors: true`: no se filtra si un email existe (enumeración).
- Access token de **15 minutos**, refresh de 30 días con revocación habilitada.

## Alternativas evaluadas

| Opción | Por qué no |
|---|---|
| **IdP externo (Auth0, Okta, Entra)** | Mejor modelo de organizaciones, SSO empresarial y SCIM ya resueltos. Descartado por coste y por integración: el authorizer JWT nativo, los triggers y la API de administración de Cognito salen gratis en esfuerzo. **Es la alternativa más seria de esta lista** |
| **Autorizador Lambda propio** | Escribir validación de JWT a mano es exactamente donde aparecen los fallos de A07: no verificar `kid` contra JWKS, aceptar `alg: none`, no comprobar `aud`. El authorizer nativo hace esto y no es código nuestro |
| **`tenant_id` en el path (`/tenants/{tid}/documents`)** | Es el anti-patrón. Convierte el aislamiento en "comprobar que el path coincide con el token", que es una comprobación que se puede olvidar en un endpoint |

## Consecuencias

**Buenas**

- El tenant viaja **firmado**: falsificarlo exige la clave privada del user pool.
- Cero código de validación de tokens propio.
- Grupos de Cognito → claim `roles`, listo para autorización por rol.
- La regla es verificable con un `grep`, y eso la hace parte de la revisión de código.

**Malas**

- **Cognito tiene un modelo de organizaciones pobre.** No hay concepto nativo de "empresa con usuarios"; lo emulamos con un atributo personalizado.
- **Migrar fuera de Cognito es doloroso**: las contraseñas no se exportan. Salir implica un flujo de migración con re-login forzado.
- La UI de login alojada es poco personalizable; una UX propia obliga a implementar SRP en el cliente.
- **`adminUserPassword` está habilitado a propósito**, y hay que decirlo: es lo que permite que `smoke.sh` y `probar-aislamiento.sh` obtengan un token sin implementar SRP en bash — es decir, lo que hace posible **ejecutar la prueba de aislamiento en vivo**. `ADMIN_USER_PASSWORD_AUTH` solo se invoca con credenciales IAM firmadas contra la API de administración, así que no está al alcance de un navegador. Aun así, **en producción se quita**.

## Cuándo revisaría esta decisión

- **En cuanto un cliente enterprise exija SSO con su propio IdP** (SAML/OIDC), SCIM para aprovisionamiento automático, o políticas de sesión propias. Cognito admite federación, pero la gestión del ciclo de vida de usuarios se queda corta rápido.
- Si hiciera falta que **un usuario pertenezca a varios tenants** (una gestoría que lleva varias empresas). Hoy el atributo es único e inmutable: ese requisito rompe el modelo y obligaría a un claim con lista y a repensar el ADR-008.
- Si el coste de Cognito por usuario activo mensual superara al de un IdP externo, cosa que a 40 clientes B2B no ocurre.
- **Antes de ir a producción**, para retirar `adminUserPassword` del cliente y mover los scripts de prueba a SRP.
