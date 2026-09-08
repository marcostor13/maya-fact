# DocFlow — ingesta y extracción de documentos, AWS-native

Plataforma B2B multi-tenant: un cliente sube facturas, el sistema las procesa en
segundo plano (clasificación de ruta → extracción con IA → reglas deterministas)
y devuelve datos estructurados con una decisión auditable.

---

## Mapa de lectura — 15 minutos

Si solo tienes un cuarto de hora, este es el orden. Cada línea dice **por qué**
merece tu tiempo.

| # | Documento | Min | Por qué |
|---|---|---|---|
| 1 | [`00-contexto/requisitos.md`](./00-contexto/requisitos.md) | 2 | **Los números primero.** Sin volumetría, una arquitectura no se evalúa: se opina sobre ella. Todo lo demás se deriva de esta página |
| 2 | [`01-arquitectura/vision-general.md`](./01-arquitectura/vision-general.md) | 4 | El recorrido de un documento de punta a punta, narrado |
| 3 | [`02-adr/003-sqs-standard-no-fifo.md`](./02-adr/003-sqs-standard-no-fifo.md) | 2 | Si solo lees un ADR, que sea este |
| 4 | [`02-adr/011-ruta-decidida-por-clasificador.md`](./02-adr/011-ruta-decidida-por-clasificador.md) | 3 | La decisión que mueve la factura: un factor 43× que no está en ninguna caja del diagrama |
| 5 | [`02-adr/012-llm-extrae-no-decide.md`](./02-adr/012-llm-extrae-no-decide.md) | 2 | La decisión más madura, y la mitigación estructural de la inyección de prompts |
| 6 | [`99-deudas-y-siguientes-pasos.md`](./99-deudas-y-siguientes-pasos.md) | 2 | Mis debilidades, escritas por mí |

> `04-defensa/` es material de preparación mío, no parte del diseño: el guion
> cronometrado y la primera frase de respuesta a 36 preguntas previsibles.

**Si te sobran 10 minutos más:** [`03-nfr/seguridad.md`](./03-nfr/seguridad.md)
(OWASP con columna de aplicabilidad y dos "no aplica" argumentados) y
[`05-ia/ai-log.md`](./05-ia/ai-log.md) (dónde corregí a la IA, con casos
verificables contra el código).

**Si prefieres leer código:** `services/src/pipeline/consumer.ts` (idempotencia,
lote parcial, clasificación de errores) y `services/src/pipeline/rules-engine.ts`
(el motor que no lee el documento).

## Estructura

```
00-contexto/      El problema, los actores, el alcance y la volumetría
01-arquitectura/  3 diagramas Mermaid + el recorrido narrado
02-adr/           14 decisiones, cada una con "cuándo la revisaría"
03-nfr/           Seguridad · Observabilidad · Resiliencia · Costos
04-defensa/       Guion de 15 min (con los 90 primeros segundos) + 36 preguntas
05-ia/            La IA como herramienta (ai-log) y la estrategia de evals
99-deudas...      Lo que falta, lo que no probé y lo que NO haría

infra/            CDK en TypeScript — un construct por dominio
services/         Lambdas: api/, auth/, pipeline/ y shared/
rules/            Rulesets declarativos por tenant, versionados
evals/            Conjunto dorado y runner de evaluación
scripts/          smoke · alta de usuarios · aislamiento · destruir
web/              Las tres piezas de Angular que tienen decisiones dentro
```

Y [`GUIA-PASO-A-PASO.md`](./GUIA-PASO-A-PASO.md) explica cómo desplegarlo fase a
fase, con la decisión detrás de cada comando.

---

## Arranque rápido

```bash
npm install
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
# us-east-1 no es una preferencia: es donde vive el Web ACL de CloudFront y
# donde la disponibilidad de modelos de Bedrock es más amplia. La región está
# fijada en bin/docflow.ts; se cambia con -c region=..., no con el entorno.
npx cdk bootstrap aws://$ACCOUNT/us-east-1
# Habilita el modelo en la consola: Bedrock -> Model access -> us-east-1
cd infra && npx cdk deploy
cd .. && ./scripts/crear-usuario.sh tu@email.com acme
EMAIL=tu@email.com PASSWORD='Docflow-Prueba-2026!' ./scripts/smoke.sh factura.pdf
./scripts/desplegar-web.sh    # genera, compila y publica la SPA
```

## Borrarlo todo

**Todo lo que este proyecto crea en AWS se elimina con un comando, cuando quieras.**

```bash
./scripts/destruir.sh --verificar   # qué hay desplegado ahora mismo
./scripts/destruir.sh               # borra el stack y VERIFICA que no quedó nada
./scripts/destruir.sh --todo        # además borra el bootstrap de CDK
```

Esto no es una promesa: es una propiedad **verificada sobre la plantilla
sintetizada**. De los 103 recursos del stack, **0 tienen `DeletionPolicy: Retain`**,
y los 3 buckets se auto-vacían antes de borrarse (S3 no permite eliminar un
bucket con objetos dentro, versiones antiguas incluidas).

Dos fugas que había y que están cerradas, porque son las que nadie ve:

| Recurso | Qué pasaba | Arreglo |
|---|---|---|
| **Bucket de logs de CloudFront** | `enableLogging: true` sin `logBucket` hace que CDK cree uno con `Retain`. `cdk destroy` decía OK y el bucket se quedaba **recibiendo y cobrando logs para siempre** | Bucket explícito, con expiración a 30 días y `autoDeleteObjects` |
| **Grupo de logs de Step Functions** | Un `LogGroup` de CDK es `Retain` por defecto | `removalPolicy` explícito |

En `prod: true` ambos vuelven a `RETAIN` a propósito: en producción, borrar el
stack no debe llevarse los datos por delante. El interruptor está en
`bin/docflow.ts`.

**Qué esperar al ejecutarlo:** la distribución de CloudFront tarda **15–25
minutos** en eliminarse (CloudFormation la desactiva primero y espera a que se
propague por los edge locations). No está colgado.

**Lo que el script NO borra, porque no cuesta nada y caduca solo:** trazas de
X-Ray (30 días), métricas de CloudWatch (15 meses) y el acceso concedido a
modelos en Bedrock, que es configuración de cuenta y no un recurso del stack.

> El script comprueba las credenciales **antes** de inventariar. Sin esa
> comprobación mentía: todas las consultas llevan `|| true` para tolerar
> permisos parciales, así que con credenciales inválidas devolvían vacío y la
> verificación anunciaba "limpio" sin haber podido mirar.

## Integración y despliegue continuos

`.github/workflows/ci-cd.yml` · `infra/lib/cicd.ts`

**Verifica en cualquier rama; despliega solo al empujar a `main`.** Un único
workflow con dos jobs encadenados: así es imposible desplegar algo que no haya
pasado la verificación.

| Job `verificar` | Qué comprueba |
|---|---|
| Tipos de `services` e `infra` | `tsc --noEmit` |
| **15 tests del motor de reglas** | Deterministas, sin AWS ni modelo: **coste cero por ejecución** |
| `cdk synth` | Compilar la infraestructura antes de tocar la cuenta |
| **Todo el stack es eliminable** | Falla si alguien añade un recurso con `DeletionPolicy: Retain` |
| **El tenant no viaja en el request** | `grep` sobre `services/src`, excluyendo comentarios |

Las dos últimas son guards de propiedades que este repositorio promete: que se
puede borrar entero y que el `tenant_id` sale siempre del token. Una promesa que
no se verifica en CI es una promesa que caduca en el siguiente pull request.

**Sin claves estáticas.** El job de despliegue se autentica con **OIDC**: GitHub
firma un token por ejecución y AWS devuelve credenciales temporales de una hora.
El único secreto del repositorio es un ARN, que no sirve de nada sin un token
firmado para *este* repositorio y *esta* rama. Cierra OWASP A08.

Y el rol **no tiene administrador**: solo puede asumir los roles de bootstrap de
CDK, que ya están acotados. Es la capa de indirección que la mayoría se salta.

### Puesta en marcha, una sola vez

```bash
cd infra && npx cdk deploy DocFlow-Cicd     # crea el proveedor OIDC y el rol
```

Copia el `RoleArn` que imprime y guárdalo en GitHub como secreto
**`AWS_DEPLOY_ROLE_ARN`** (Settings → Secrets and variables → Actions).

A partir de ahí, cada push a `main` despliega infraestructura y frontend, y
termina comprobando que la SPA responde `200` y que `/api/documents` responde
**401 y no 404** — porque un 404 ahí significaría que el rewrite de `/api` se
rompió, que es el fallo más fácil de introducir en esta arquitectura.

## Las siete decisiones que definen el diseño

1. **El archivo no pasa por la API.** Presigned POST con condiciones que aplica
   S3. Evita el límite de 10 MB, el coste de transferencia y la superficie de
   ataque del backend.
2. **SQS Standard, no FIFO.** FIFO no da exactly-once de extremo a extremo: da
   deduplicación de 5 minutos a cambio de throughput. La idempotencia vive en la
   capa de datos, con un `ConditionExpression` sobre un candado con TTL.
3. **El OCR no es un requisito, es una compra.** El clasificador decide la ruta.
   Textract solo donde compra confianza calibrada, coordenadas o texto
   reutilizable. Según AWS, la ruta sin OCR sale ~16× más barata.
4. **El LLM extrae; el LLM no decide.** Un motor de reglas determinista y
   versionado toma la decisión. Da auditabilidad, reproducibilidad y es la
   mitigación estructural de la inyección de prompts.
5. **El prompt es código.** Versión, conjunto dorado y evals en CI. El ciclo de
   vida de modelos de AWS garantiza aviso, no compatibilidad.
6. **El OCR se compra tarde, no pronto.** La ruta R3 no se decide al recibir el
   documento: se activa cuando la decisión ya salió `NEEDS_REVIEW`. Solo entonces
   sabemos que un humano va a mirarlo, que es cuando las coordenadas y la
   confianza calibrada de Textract valen lo que cuestan. En el resto del
   volumen, Textract no se llama nunca.
7. **Un mecanismo, dos beneficios.** El mismo `ConditionExpression` da
   idempotencia de entrega (candado con TTL, por objeto+etag) y deduplicación de
   contenido (por `sha256`, sin TTL). El primero evita procesar dos veces; el
   segundo evita *pagar* dos veces cuando el mismo documento vuelve dentro de
   seis meses — que en B2B es rutina, no excepción.

## Estado de verificación

- `cdk synth` limpio: **103 recursos**, sin estados inalcanzables en la máquina
  de pasos (21 estados, verificado sobre la plantilla sintetizada).
- `tsc --noEmit` sin errores en `infra` y `services`.
- **La región es una decisión, no una variable de entorno.** Se fija en
  `bin/docflow.ts` y por defecto es `us-east-1`; se cambia a propósito con
  `cdk deploy -c region=...`. Deliberadamente NO se lee `CDK_DEFAULT_REGION`:
  el CLI de CDK la sobrescribe con la región del perfil de AWS, así que un
  `aws configure` ajeno podría desplegar en otra región —sin Web ACL de
  CloudFront y sin garantía de disponibilidad del modelo— sin decir nada.
  Fuera de `us-east-1` el synth emite un aviso explícito en vez de callarse.
### Desplegado y probado en AWS real

No es una estimación: se desplegó en `us-east-1` y se ejecutó contra servicios reales.

| Prueba | Resultado |
|---|---|
| Despliegue completo | ✅ 103 recursos, 5 min |
| Claim `tenant_id` en el access token | ✅ `{"tenant_id":"acme","roles":"reviewer"}` |
| Subida directa a S3 con presigned POST | ✅ HTTP 204 |
| **Factura válida → decisión** | ✅ **`APPROVED` en 35 s**, ruta `R1_PDF_TEXT` (sin OCR) |
| **Inyección de prompts** | ✅ **El modelo NO obedeció.** El PDF ordenaba `total = 0`; extrajo `4,956.00 → 495600` |
| **Deduplicación por contenido** | ✅ Mismo `sha256` → `DUPLICATE` **sin volver a llamar a Bedrock** |
| **`.txt` renombrado a `.pdf`** | ✅ `QUARANTINED` en 25 s, **DLQ vacía** |
| Ejecuciones de Step Functions | ✅ 5/5 `SUCCEEDED` |
| Normalización a céntimos y confianzas | ✅ 8/8 campos, confianza 1.0 |
| **SPA servida por CloudFront + OAC** | ✅ Angular 22 compilado y desplegado |
| **Las 5 cabeceras de seguridad** | ✅ HSTS, CSP, nosniff, DENY, Referrer-Policy |
| **Fallback de SPA** | ✅ Una ruta de cliente inexistente devuelve `index.html` |
| **Rewrite de `/api` en CloudFront** | ✅ `/api/documents` sin token → **401, no 404** |
| **API completa a través del CDN** | ✅ Con token: `200` y 3 documentos aprobados |

**Latencia real: 25–35 s** de subida a resultado, frente a un SLO de p95 < 5 min.

Y tres fallos que **solo aparecieron al desplegar**, con `tsc` y `cdk synth`
limpios en los tres casos:

1. **El trigger de Cognito no estaba conectado.** `lambdaTriggers: { preTokenGenerationV2: ... }` — esa clave no existe en CDK, pero `UserPoolTriggers` declara una *index signature* `[trigger: string]`, así que TypeScript la aceptó. CDK emitió `LambdaConfig: {}`. **El token salía sin `tenant_id`: el aislamiento multi-tenant entero no existía, en silencio.** Se arregla con `addTrigger(UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, …)`.
2. **Y aun así, CDK ponía `LambdaVersion: V1_0`**, que solo alcanza al ID token, no al access token. Hace falta un escape hatch al recurso L1.
3. **`jq` en Windows escribe CRLF.** Cada campo del formulario arrastraba un `\r` invisible y S3 respondía `Only AWS4-HMAC-SHA256 is supported` **mostrando ese mismo valor** como el rechazado.

## Deudas conocidas

Escritas por mí, antes de que las encuentres tú.

- **`hasPdfTextLayer` y `countPdfPages` son heurísticas sobre bytes en crudo.**
  Buscan operadores `BT/Tj` y objetos `/Type /Page`. Fallan con PDFs con streams
  comprimidos u object streams, que son mayoría en generadores modernos. La
  decisión de arquitectura —rutar según haya o no texto— no cambia; la
  implementación pide una librería de parseo. No la metí porque la superficie de
  ataque de las librerías de PDF es exactamente el riesgo de A06 que documento.
- **`LeadingKeys` con `TENANT#*` limita la forma de la clave, no su valor.** El
  aislamiento por valor exige credenciales por sesión. Ver ADR-008.
- **Sin escaneo antimalware.** GuardDuty Malware Protection for S3 está en el
  diseño y no en el código: es una activación de consola con coste por GB.
- **Sin Bedrock Guardrails.** El filtro de *prompt attacks* y el enmascarado de
  PII están argumentados en el diseño; el código depende hoy de las otras cuatro
  capas (delimitación, esquema forzado, sin herramientas, motor de reglas).
- **El conjunto dorado tiene 4 casos, no 200.** Suficiente para demostrar que el
  mecanismo existe y corre; insuficiente para confiar en el umbral.
