# ADR-008 — Aislamiento de tenant reforzado en IAM, con su límite declarado

**Estado:** aceptada, **con una limitación conocida y asumida** · **Código:** `infra/lib/api.ts`

## Contexto

El riesgo número uno de un SaaS multi-tenant es que el cliente A lea datos del
cliente B (OWASP A01, IDOR). La primera capa ya está: el `tenant_id` sale del
token (ADR-007) y forma parte de la clave de partición (ADR-005), así que una
lectura cruzada **no encuentra el ítem**.

Pero esa capa depende de que el código no tenga bugs. La pregunta es: ¿qué pasa
el día que un desarrollador escriba mal una `KeyConditionExpression`?

## Decisión

**Una segunda capa en IAM**, con la condición `dynamodb:LeadingKeys`:

```ts
conditions: {
  'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] },
}
```

Y **no** usar `table.grantReadData()`, que concede `Query` y `GetItem` sobre
toda la tabla sin ninguna restricción de partición.

**`ForAllValues:` no es decorativo.** Sin ese modificador, la condición se
cumple si *cualquiera* de las claves solicitadas encaja con el patrón, no si
encajan *todas*. Es decir: sin él, la condición no hace lo que parece que hace.

## La limitación, dicha por mí antes de que la encuentren

Aplicar `LeadingKeys` **con el tenant concreto del usuario** —lo que daría
aislamiento completo— exige **credenciales por sesión**: un `sts:AssumeRole` con
tags de sesión, o Cognito Identity Pools, de modo que el principal que llama a
DynamoDB *sea* ese tenant.

Con una **Lambda compartida por todos los tenants**, el rol es uno solo y el
patrón solo puede ser `TENANT#*`. Por tanto:

> La condición es un límite de **FORMA** de clave, no de **VALOR**.

**Qué sí impide:** leer particiones que no empiecen por `TENANT#` (los candados
`IDEM#`, los registros de deduplicación), hacer un `Scan` encubierto, o que un
`Query` mal escrito toque el espacio de claves interno.

**Qué NO impide:** que el tenant A lea al tenant B si el código construye mal la
clave. Eso lo impide la primera capa, la clave de partición.

Decir esto uno mismo vale más que fingir que la condición hace algo que no hace.
Si lo dices tú, eres alguien que entiende IAM a fondo; si lo descubren ellos,
eres alguien que copió una política de un blog.

## Alternativas evaluadas

| Opción | Coste real | Por qué no hoy |
|---|---|---|
| **STS AssumeRole con tags de sesión, por petición** | Aislamiento por valor real | Una llamada a STS por petición (latencia + límites de API), gestión de caché de credenciales por tenant, y un rol por tenant o un rol con tags. Es **la solución correcta** y es a donde iría |
| **Cognito Identity Pools** | Aislamiento por valor | Acopla el frontend a credenciales de AWS y complica el modelo: el navegador pasaría a hablar con DynamoDB |
| **Una Lambda (y un rol) por tenant** | Aislamiento total | 40 tenants × 12 funciones = 480 funciones. Inviable operativamente |
| **Modelo *silo*: un stack por cliente** | Aislamiento máximo | ~$X fijos por cliente y 40 despliegues que mantener. Se reserva para el cliente enterprise que lo exija y lo pague |

## Consecuencias

**Buenas**

- Defensa en profundidad real contra el espacio de claves interno.
- Fuerza a nombrar acciones una a una: ningún `dynamodb:*`, ningún recurso con comodín.
- Documenta la intención en la política: quien la lea entiende el modelo de aislamiento.

**Malas**

- **Da una falsa sensación de seguridad si no se entiende su alcance.** Es el motivo de que este ADR exista y de que el comentario esté en el código.
- Añade fricción: cada permiso nuevo hay que escribirlo a mano.
- El aislamiento real sigue descansando en la clave de partición, es decir, **en el código**.

## Cuándo revisaría esta decisión

- **En cuanto un cliente exija aislamiento demostrable ante un auditor.** Ahí `TENANT#*` no basta y hay que ir a credenciales por sesión.
- Si el equipo creciera y el riesgo de un `Query` mal construido dejara de ser hipotético.
- Si apareciera un cliente que exija **su propia clave KMS** o residencia de datos: eso empuja al modelo *silo*, y entonces esta condición sobra porque el aislamiento es de cuenta.

## Cómo se prueba, no cómo se afirma

```bash
./scripts/probar-aislamiento.sh <documentId-del-tenant-A>   # con TOKEN_B
```

Debe devolver **404, no 403**. Distinguirlos permitiría enumerar qué documentos
existen en otras cuentas: "no existe" y "no es tuyo" tienen que ser
indistinguibles desde fuera.
