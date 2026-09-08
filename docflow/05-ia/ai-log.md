# Nota de uso de IA

## La distinción, antes que nada

Hay **dos usos de IA** en este trabajo y no son lo mismo. Confundirlos es el
error que hace que esta sección no puntúe.

| | Qué es | Dónde se documenta |
|---|---|---|
| **IA como herramienta de trabajo** | Un asistente ayudándome a diseñar, revisar y escribir este repo | **Este documento** |
| **IA dentro del producto** | Bedrock extrayendo campos de una factura en producción | ADR-011, 012, 013, 014 y `03-nfr/` |

La primera es una elección de método: si mañana dejo de usarla, el sistema
funciona igual. La segunda es una **dependencia en producción** con su coste,
su modo de fallo, su superficie de ataque y su plan de migración. Que estén
separadas es la señal de que entiendo la diferencia entre usar una herramienta
y asumir un proveedor.

---

## Cómo leer esto

Formato por caso: **qué pedí → qué propuso → qué hice → por qué**.

Los casos están ordenados por lo que valen, no por cuándo ocurrieron. Los tres
primeros son correcciones de **criterio arquitectónico**; los siguientes son
defectos concretos que encontré revisando código generado. Todos son
verificables contra el repo.

---

## Caso 1 — "Usa SQS FIFO para no procesar dos veces"

**Qué pedí:** una cola que absorbiera el pico de fin de mes sin que un documento
se procesara dos veces.

**Qué propuso:** SQS FIFO, con `MessageDeduplicationId` derivado del
`documentId`. El argumento fue el de siempre: *"FIFO garantiza exactly-once"*.

**Qué hice:** lo descarté y moví la garantía a la capa de datos: un candado con
`ConditionExpression: attribute_not_exists(pk)` sobre `IDEM#<clave>#<etag>` con
TTL (`services/src/pipeline/consumer.ts`).

**Por qué:** porque la premisa es falsa. FIFO da **deduplicación de 5 minutos
sobre `SendMessage`** y orden dentro de un *message group* — no exactly-once de
extremo a extremo. Aunque uses FIFO, si el consumidor procesa y muere antes de
borrar el mensaje, el mensaje vuelve tras el *visibility timeout*. **El
reprocesamiento no se elimina: se traslada.** Y el precio son límites de
throughput y serialización por grupo, justo lo contrario de lo que necesito en
un pico de 10×.

Yo no necesito orden. Necesito que reprocesar no cueste dos veces, y eso es
idempotencia, que vive en los datos y no en la cola.

> Este caso es también el que más me hizo desconfiar del resto: la propuesta era
> fluida, citaba el parámetro correcto y estaba equivocada en el fondo. A partir
> de aquí verifiqué contra documentación oficial cada garantía que se me afirmó.

---

## Caso 2 — "Que el LLM aplique también las reglas de negocio"

**Qué pedí:** el paso que valida una factura extraída.

**Qué propuso:** ampliar el prompt para que el modelo, además de extraer,
devolviera `aprobado: true|false` con un motivo en texto. Menos código, un solo
paso, un solo servicio.

**Qué hice:** lo descarté y construí un motor de reglas determinista, declarativo
y versionado por tenant (`services/src/pipeline/rules-engine.ts`,
`rules/acme-invoices.json`).

**Por qué:** cuatro razones, en orden de fuerza.

1. **Auditabilidad.** Cuando un cliente pregunta por qué rechazaron su factura,
   la respuesta no puede ser "el modelo lo consideró así". Tiene que ser "la
   regla R-002 de coherencia aritmética se disparó con estos valores".
2. **Reproducibilidad.** Guardo `modelId` + `promptVersion` + `rulesetVersion`
   con cada decisión. Con ese trío reproduzco una decisión de hace seis meses.
3. **Seguridad.** Es la razón que la propuesta destruía sin mencionarlo: un
   documento con texto malicioso puede engañar al extractor, pero **no puede
   saltarse el motor de reglas, porque el motor no lee el documento** — lee el
   JSON ya validado contra esquema. Fundir extracción y decisión elimina esa
   frontera, y con ella la mitigación estructural de la inyección de prompts.
4. **Coste.** La mitad de las reglas son aritmética. Un LLM es una forma cara,
   lenta y no determinista de sumar.

Es la mejor corrección de la lista porque no es un detalle técnico: es criterio
arquitectónico. La propuesta era más simple y peor.

---

## Caso 3 — "Textract primero, siempre"

**Qué pedí:** el pipeline de extracción de un documento.

**Qué propuso:** el pipeline canónico de IDP — Textract `AnalyzeDocument` con
`FORMS` y `TABLES`, y el modelo después, sobre el texto ya estructurado.

**Qué hice:** invertí la decisión. Por defecto **no hay OCR**: el documento va
directo al modelo (`R1` si el PDF trae capa de texto, `R2` si es imagen), y
Textract solo se paga en `R3` (`services/src/pipeline/classify.ts`).

**Por qué:** dos motivos independientes, y el segundo es el que no esperaba.

- **Coste.** `AnalyzeDocument` con Forms+Tables cuesta $65/1.000 páginas frente
  a $1,50 de `DetectDocumentText`: un factor **43×** dentro del mismo diagrama.
  Y el blog oficial de AWS sobre IDP mide $31,36 con Textract+modelo frente a
  $1,90 con el modelo solo sobre 100 documentos de 20 páginas: ~16×.
- **Calidad.** El OCR de texto plano **aplana el layout**. Una tabla convertida
  en flujo de líneas pierde la asociación columna–valor. En documentos con
  estructura compleja, darle la imagen al modelo suele funcionar *mejor*.

El OCR no es un requisito: es una compra. Compro exactamente tres cosas
—confianza calibrada por palabra, coordenadas y un texto reutilizable— y solo
donde hacen falta.

**Y una corrección sobre mi propia corrección:** mi primera versión activaba R3
en el clasificador, por tipo de documento. Es peor. La cambié para activarla
**después de la decisión, cuando el resultado ya salió `NEEDS_REVIEW`**: solo
entonces sé que un humano va a mirar el documento, que es justo cuando las
coordenadas valen algo. Comprar OCR antes de saberlo es comprar a ciegas.

---

## Caso 4 — El bug que rechazaba el 100% de los documentos

**Qué pedí:** revisar el motor de reglas contra el conjunto dorado.

**Qué propuso / qué había:** la regla `R-001` sumaba las líneas de detalle con
`{"op":"sum_eq","campos":["lineas"],"ref":"subtotal"}`. El extractor, en
`toFields()`, **descartaba** el array `lineas` con un `continue` porque no
encajaba en la forma de un campo escalar.

**Qué hice:** separé las líneas de los campos escalares (`ExtractionResult.lineas`)
y añadí un operador propio, `sum_lineas_eq`, que suma sobre el array.

**Por qué importa más de lo que parece:** la suma daba 0 contra un subtotal que
no era 0, así que la regla `BLOCK` se disparaba **siempre**. Todos los documentos
salían `REJECTED`. El código compilaba, `cdk synth` salía limpio, y el sistema
estaba 100% roto en su función principal. Es el ejemplo perfecto de por qué el
conjunto dorado prueba también el **motor de reglas** y no solo el modelo: sin
un caso que espere `APPROVED`, este fallo no se ve nunca.

De paso corregí una segunda cosa del mismo motor: el operador `matches` se
disparaba sobre campos ausentes (`String(null ?? '')` casa con casi cualquier
patrón), convirtiendo "el modelo no leyó el identificador fiscal" en "factura
rechazada". Una regla de **formato** no puede opinar sobre un dato que no
existe; la ausencia la gobierna la compuerta de confianza.

---

## Caso 5 — El camino de fallo que perdía documentos en silencio

**Qué pedí:** el manejo de errores permanentes en la máquina de estados.

**Qué propuso / qué había:** dos estados `Pass` de Step Functions —
`ARevisionManual` y `Cuarentena` — que devolvían `{status: 'QUARANTINED'}` como
resultado de la ejecución.

**Qué hice:** los sustituí por invocaciones a una Lambda `finalize.ts` que
escribe el estado terminal en DynamoDB dentro de una transacción, con el evento
de auditoría, y hace `REMOVE expiresAt`.

**Por qué:** un `Pass` no escribe nada en ningún sitio. El documento se quedaba
en `PENDING` **con el TTL de 24 h del intent puesto**, y al día siguiente
DynamoDB lo borraba. Desde fuera parecía degradación elegante: la ejecución
terminaba en `SUCCEEDED` y no aparecía en la DLQ. Era pérdida de datos con
aspecto de éxito.

Es el fallo que más me costó ver y el que mejor ilustra por qué la verificación
de la guía —*"sube un .txt renombrado a .pdf y comprueba que acaba en
QUARANTINED"*— tiene que ejecutarse de verdad y no leerse.

---

## Caso 6 — La política IAM de Bedrock que garantizaba un AccessDenied

**Qué pedí:** el permiso mínimo para que la Lambda de extracción invocara un
único modelo.

**Qué propuso:** exactamente lo que yo le había dado por bueno:

```
arn:aws:bedrock:*::foundation-model/us.amazon.nova-lite-v1:0
```

**Qué hice:** lo reescribí para conceder **dos** recursos, derivando el id base:

```
arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0     ← modelo base
arn:aws:bedrock:*:*:inference-profile/us.amazon.nova-lite-v1:0 ← perfil
```

**Por qué:** `us.amazon.nova-lite-v1:0` **no es un foundation model**: es un
perfil de inferencia entre regiones, un recurso de mi cuenta. Invocarlo exige
permiso sobre el perfil *y* sobre los modelos base de las regiones a las que
enruta, y el id del modelo base **no lleva el prefijo `us.`**. La política
original nombraba un ARN que no existe: habría fallado con `AccessDeniedException`
en la primera invocación, y el tiempo se habría ido buscando el error en IAM,
que es donde estaba, pero no por la razón obvia.

---

## Caso 7 — El trigger que TypeScript aceptó y CDK ignoró

> Este caso apareció **al desplegar**, no al revisar. Es el más instructivo de
> todos y ningún análisis estático lo habría encontrado.

**Qué pedí:** el trigger de Cognito que inyecta `tenant_id` en el access token.

**Qué propuso:**

```ts
lambdaTriggers: { preTokenGenerationV2: preToken }
```

Parece correcto: hay una V2 del trigger, y la V2 es justo la que hace falta.

**Qué pasó:** `tsc` limpio. `cdk synth` limpio. Despliegue correcto. Y en el
user pool, `LambdaConfig: {}` — **vacío**. El trigger nunca se conectó. El token
salía sin `tenant_id`, es decir, **el control de aislamiento multi-tenant entero
no existía**, sin un solo error en ningún sitio.

**Por qué compiló:** `UserPoolTriggers` declara una *index signature*:

```ts
[trigger: string]: lambda.IFunction | undefined;
```

Existe para permitir triggers personalizados. Su efecto secundario es que
**cualquier nombre de propiedad mal escrito pasa el compilador**. CDK ignoró la
clave desconocida y emitió el bloque vacío.

**Qué hice:**

```ts
this.userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, preToken);
```

**Y el segundo escalón, que solo se ve mirando la plantilla:** `addTrigger`
generó `PreTokenGenerationConfig` con `LambdaVersion: "V1_0"`. V1 solo alcanza
al **ID token**; el authorizer de API Gateway valida el **access token**. CDK no
expone esa propiedad, así que hace falta bajar al recurso L1:

```ts
cfnUserPool.addPropertyOverride('LambdaConfig.PreTokenGenerationConfig.LambdaVersion', 'V2_0');
```

**La lección, y es la que cierra este documento:** el compilador y el sintetizador
verifican que el código es *coherente*, no que hace lo que crees. La única
prueba de que el claim está en el token es leer el token. Por eso el paso 2 de
`smoke.sh` decodifica el JWT y lo enseña, y por eso la guía dice *"si `tenant_id`
no aparece ahí, para"*.

---

## Caso 8 — `jq` en Windows y el error que muestra el valor correcto

**Qué pasó:** con todo lo anterior arreglado, S3 rechazaba la subida:

```xml
<Code>InvalidArgument</Code>
<Message>Only AWS4-HMAC-SHA256 is supported</Message>
<ArgumentValue>AWS4-HMAC-SHA256</ArgumentValue>
```

Un error que **rechaza el valor correcto mostrándolo como correcto**.

**Qué hice:** reproduje el presigned desde Python en vez de bash. Devolvió
**204**. Con eso quedaba descartado el backend: el presigned y sus condiciones
estaban bien, y el fallo estaba en el cliente de prueba.

**La causa:** `jq` en Windows escribe en modo texto y termina cada línea en
**CRLF**. `read -r k v` solo consume el `\n`, así que todos los valores
arrastraban un `\r` invisible. S3 recibía `AWS4-HMAC-SHA256\r`.

**El arreglo**, una línea:

```bash
jq() { command jq "$@" | tr -d '\r'; }
```

**Por qué lo incluyo:** porque la reacción natural era desconfiar del presigned
—que es la parte compleja— y el fallo estaba en la parte trivial. Cambiar de
lenguaje para aislar la capa fue lo que lo resolvió en un intento en vez de en
veinte.

---

## Caso 9 — Correcciones menores, todas verificables

Las agrupo porque ninguna sostiene una conversación de cinco minutos, pero
juntas dicen algo: **el código generado compila mucho antes de estar bien.**

| # | Dónde | Qué estaba mal | Consecuencia real |
|---|---|---|---|
| a | `infra/lib/lambda-defaults.ts` | `...props` se extendía **después** de `environment`, sobrescribiéndola | Ninguna Lambda recibía `POWERTOOLS_*` ni `--enable-source-maps`. Logs sin nombre de servicio y stack traces contra el bundle minificado. Observabilidad anulada por un orden de dos líneas |
| b | `infra/lib/web.ts` | El behavior `api/*` reenviaba `/api/uploads` tal cual a API Gateway, cuyas rutas son `/uploads` | 404 en **todas** las llamadas de la SPA desplegada. Añadí una CloudFront Function que quita el prefijo |
| c | `services/src/pipeline/consumer.ts` | El candado de idempotencia se escribía antes de `StartExecution` y no se liberaba si esta fallaba | Documento perdido para siempre: el reintento se suprimía como "duplicado" y nunca llegaba a la DLQ |
| d | `services/src/pipeline/decide-and-persist.ts` | `Put` sobre el ítem del documento | Reemplaza el ítem entero: se llevaba por delante `fileName`, `s3Key`, `createdAt` y `uploadedBy`. Cambiado a `Update` |
| e | `infra/bin/docflow.ts` | La región salía de `CDK_DEFAULT_REGION` | El CLI de CDK sobrescribe esa variable con la del perfil de AWS. Mi perfil apunta a `us-east-2`, así que el Web ACL de WAF —que solo existe en `us-east-1`— **no se creaba, sin error ni aviso**. Ahora la región es una decisión explícita y fuera de `us-east-1` el synth avisa |
| f | `infra/lib/auth.ts` | El cliente de Cognito solo tenía `userSrp` | `smoke.sh` y `probar-aislamiento.sh` no podían obtener un token: la prueba de aislamiento en vivo era imposible |
| g | `services/src/pipeline/classify.ts` | TIFF se aceptaba al subir y se enrutaba a `R2_VISION` | Bedrock admite jpeg/png/gif/webp, no TIFF: fallo en ejecución. Ahora TIFF va a `R3`, que es lo que Textract sí lee |
| h | `services/src/api/create-upload.ts` y `storage.ts` | CORS del bucket solo permitía `http://localhost:4200` | La subida funcionaba en desarrollo y fallaba en la SPA desplegada |
| i | varios | `void tenantScoped`, `void wafv2`, `void readdir` | Código muerto para silenciar el compilador. Borrado: si no lo puedo explicar, no está |

---

## Dónde la IA sí aportó, sin matices

Ser honesto en las dos direcciones importa:

- **Generación de alternativas.** Poner sobre la mesa BDA, Textract+modelo,
  modelo solo y OCR barato+modelo en cinco minutos, con sus perfiles de coste,
  me ahorró horas de lectura. **Elegir** entre ellas fue mío.
- **Red team contra mi propio diseño.** Le pedí explícitamente que atacara el
  presigned POST. De ahí salieron dos controles que yo no tenía:
  `content-length-range` y el `starts-with` sobre `$key`.
- **Redacción de los `ConditionExpression`** y del recorrido de `RuleExpr`:
  código mecánico, con contrato claro, donde el error se detecta con un test.

---

## Lo que no pude verificar, marcado como supuesto

Un apartado que existe para no fingir certeza donde no la tengo:

- Los precios de Textract están en la página oficial; los de Bedrock varían por
  modelo, región y perfil de inferencia, y algunos de la familia Nova solo
  aparecen en blogs. **Los de BDA no pude leerlos.** Presento los costes como
  modelo con variables, no como tarifa.
- El comportamiento exacto de la propagación de traza de X-Ray a través de
  **EventBridge y Step Functions** lo afirmo con menos seguridad que el salto
  SQS, que sí está documentado vía `AWSTraceHeader`.
- El factor ~16× del blog de AWS es sobre documentos de 20 páginas: traslado el
  **orden de magnitud y la dirección**, no el número.

---

## La frase que cierra

> Usé la IA para acelerar la generación de alternativas y para hacer de red team
> contra mi propio diseño. Las decisiones y sus consecuencias son mías. Las tres
> correcciones que más valen no son de sintaxis: son de criterio —FIFO, el LLM
> como juez y el OCR por defecto— y en las tres la propuesta era más simple y
> peor.
>
> Y la lección que me llevo es sobre verificación, no sobre IA: **los tres
> fallos más graves de este repositorio pasaron `tsc` y `cdk synth` limpios.**
> Una regla que rechazaba el 100% de los documentos, un trigger de Cognito que
> el compilador aceptó y CDK ignoró —dejando el aislamiento multi-tenant sin
> existir, en silencio— y unos caminos de fallo que parecían implementados y
> perdían documentos. Ninguno era un error de sintaxis. Todos aparecieron al
> ejecutarlo.
