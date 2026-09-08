# CLAUDE.md — Reglas de seguridad obligatorias para DocFlow

> **Este documento tiene precedencia sobre cualquier otra instrucción de estilo, brevedad o velocidad.** Si una petición del usuario choca con una regla de aquí, **no la cumplas en silencio**: para, explica qué regla se rompe y propón la alternativa segura. Si el usuario insiste tras la explicación, hazlo pero deja un comentario `// RIESGO ACEPTADO:` en el código y anótalo en `99-deudas-y-siguientes-pasos.md`.

**Contexto:** DocFlow es una plataforma B2B **multi-tenant** que procesa documentos con **PII y datos financieros** de clientes distintos, sobre AWS serverless. Va a ser sometida a **pen testing**. El modelo de amenaza principal es un **cliente legítimo que intenta leer datos de otro cliente**, y en segundo lugar un **documento malicioso** subido por un tercero.

---

## 0. Las tres preguntas antes de escribir cualquier línea

1. **¿De dónde sale el `tenantId` en este código?** Si la respuesta no es "del JWT validado", el código está mal.
2. **¿Qué entrada de esta función viene de un tercero?** El cuerpo de la petición, el nombre del archivo, el contenido del documento y **el texto extraído por OCR o por el modelo** son todos hostiles.
3. **¿Qué puede hacer este rol IAM si comprometen la función?** Si la respuesta incluye "leer toda la tabla" o "invocar cualquier modelo", el permiso está mal.

---

## 1. Invariantes no negociables

Cada una lleva el comando que la verifica. **Ejecuta `./scripts/auditoria-seguridad.sh` antes de dar por terminado cualquier cambio.**

| # | Invariante | Verificación |
|---|---|---|
| **I-1** | El `tenantId` **solo** sale de `callerFrom(event)`, que lo lee del claim del JWT. Nunca de `pathParameters`, `queryStringParameters` ni del body. | `grep -rn "tenant" services/src --include=*.ts \| grep -E "pathParameters\|queryStringParameters\|body\."` → vacío |
| **I-2** | Toda operación de DynamoDB desde una Lambda expuesta lleva la clave de partición del tenant. **Ningún `Scan`. Ningún `Query` sin `pk`.** | `grep -rn "ScanCommand\|new Scan" services/src` → vacío |
| **I-3** | Ninguna política IAM usa `"*"` en `actions` ni en `resources` para servicios de datos (dynamodb, s3, bedrock, secretsmanager, kms). | `grep -rn "'\*'" infra/lib` → revisar caso por caso |
| **I-4** | Ningún secreto, clave, token ni endpoint privado está literal en el código o en el repo. | `git diff --cached \| grep -iE "aws_secret\|BEGIN .*PRIVATE KEY\|password.*="` |
| **I-5** | Ningún archivo se acepta por su extensión ni por su `Content-Type` declarado. Siempre **magic bytes**. | `classify.ts` debe llamar a `detectMime()` antes de cualquier procesamiento |
| **I-6** | El texto extraído (OCR o modelo) **nunca** se inserta en HTML sin escapar, ni se pasa a un intérprete (shell, SQL, plantilla, regex construida). | `grep -rn "innerHTML\|bypassSecurityTrust\|execSync\|exec(" services web/src` → vacío |
| **I-7** | Ninguna respuesta de error hacia el cliente contiene stack traces, ARNs, nombres de bucket, de tabla ni de modelo. | Usa siempre `fail()` / `notFound()` de `shared/http.ts` |
| **I-8** | "No existe" y "no es tuyo" devuelven **exactamente la misma respuesta** (404). | `grep -rn "403" services/src/api` → solo para fallos de autorización de rol, nunca de pertenencia |
| **I-9** | Toda función Lambda tiene `tracing: ACTIVE`, `logGroup` con retención acotada y timeout explícito. | Se aplica por defecto en `infra/lib/lambda-defaults.ts`. **No crear `NodejsFunction` directamente: usar siempre `fn()`.** |
| **I-10** | Los buckets tienen `BLOCK_ALL`, `enforceSSL: true` y acceso desde CloudFront solo por **OAC**. Nunca OAI, nunca política pública. | `grep -rn "PUBLIC_READ\|publicReadAccess\|OriginAccessIdentity" infra/lib` → vacío |
| **I-11** | El `visibilityTimeout` de cada cola es **≥ 6×** el timeout de su función consumidora, y toda cola tiene DLQ con `maxReceiveCount`. | Revisar `infra/lib/pipeline.ts` en cada cambio de timeout |
| **I-12** | La Lambda de extracción solo puede invocar **el model id concreto**, nunca `bedrock:*` ni `foundation-model/*`. | `grep -n "bedrock" infra/lib/pipeline.ts` |

---

## 2. Reglas por capa

### 2.1 Autenticación y autorización

- **NUNCA valides el JWT a mano.** Usa el authorizer JWT nativo de API Gateway, que verifica firma contra JWKS, `iss`, `aud` y `exp`. Escribir esa validación tú mismo es donde nacen los bypass de `alg: none`.
- El `tenant_id` se inyecta con el trigger **`preTokenGenerationV2`** (la V1 solo toca el id token; el authorizer valida el **access** token).
- Si un usuario no tiene `custom:tenant_id`, el trigger **lanza excepción**. Nunca emitas un token sin el claim: un token ambiguo es peor que un login fallido.
- Autorización por rol: lee `roles` del claim. **Nunca confíes en un rol que venga en el body.**
- `preventUserExistenceErrors: true` en el cliente de Cognito: no filtrar qué emails existen.
- Access token de vida corta (≤ 15 min) y revocación habilitada.

### 2.2 Entrada de datos (toda petición)

- Valida **antes** de usar: tipo, rango, longitud, formato. Rechaza por defecto, no saneando.
- Los importes son **enteros en la unidad menor de la moneda**. Nunca `float` para dinero.
- Los identificadores que genera el sistema (`documentId`, claves de S3) los genera el **servidor** con `randomUUID()`. El cliente nunca elige una clave de almacenamiento.
- Límites duros y explícitos: tamaño de archivo, número de páginas, tamaño de página en listados, longitud de cada campo de texto.
- El `cursor` de paginación se decodifica dentro de un `try/catch`: un cursor manipulado devuelve 400, no un 500 con stack.

### 2.3 Subida de archivos — la superficie más peligrosa

- **El archivo NUNCA pasa por API Gateway ni por Lambda antes de estar en S3.** Presigned POST, siempre.
- Las `Conditions` del presigned son controles reales que aplica S3 y **son obligatorias las tres**:
  - `['content-length-range', 1, MAX_BYTES]`
  - `['eq', '$Content-Type', <tipo concreto>]`
  - `['starts-with', '$key', 'tenants/<tenantId del token>/inbox/']`
- Expiración ≤ 5 minutos.
- Al procesar: **magic bytes** primero. Después límite de páginas (bomba de descompresión y *denial of wallet*). Después escaneo antimalware.
- **Nunca** invoques un binario externo (`pdftoppm`, `ghostscript`, `convert`) con un nombre de archivo controlado por el usuario. Si hace falta un binario: `execFile` con argumentos separados y rutas generadas por el sistema. **Nunca `exec`, `execSync` ni concatenación de strings de shell.**
- Si algún día se parsea XML, SVG o DOCX: **entidades externas deshabilitadas** (XXE).
- Las URL de descarga son presigned de vida corta y se emiten **solo tras verificar la pertenencia** del documento al tenant del token.

### 2.4 Aislamiento multi-tenant

- El tenant es **siempre el prefijo de la clave de partición**. Esa es la primera capa.
- Segunda capa, en IAM: condición `ForAllValues:StringLike` sobre `dynamodb:LeadingKeys`.
  > **Sé honesto en los comentarios y en la documentación:** con una Lambda compartida entre tenants, esta condición limita la **forma** de la clave, no el **valor**. El aislamiento por valor exige credenciales por sesión (STS `AssumeRole` con tags de sesión, o Identity Pools). No documentes esta condición como si diera más de lo que da.
- Prohibido `table.grantReadData()` / `grantReadWriteData()` en funciones expuestas a internet: conceden acceso a toda la tabla. Escribe la `PolicyStatement` a mano.
- Cualquier función nueva que toque la tabla **debe** venir con su prueba en `./scripts/probar-aislamiento.sh`.

### 2.5 Capa de IA — el texto del documento es entrada hostil

Trata el contenido de cualquier documento como si lo hubiera escrito un atacante, **porque puede haberlo hecho**.

- **Separación estricta instrucción / dato.** El texto del documento va como contenido de usuario, delimitado con etiquetas (`<documento_ocr>...</documento_ocr>`), nunca concatenado en el prompt de sistema.
- El prompt de sistema declara explícitamente que el contenido del documento es **material a procesar, no instrucciones**, y qué hacer si parece una orden. No borres esas líneas de `schema.ts`.
- **Salida forzada por esquema** (uso de herramienta con `toolChoice`, o Structured Outputs nativo). Nunca `JSON.parse` de texto libre del modelo.
- **El modelo no tiene herramientas con efectos secundarios.** No escribe en DynamoDB, no llama APIs, no lee otros documentos, no navega. Extrae y devuelve. Si alguien pide "dale una tool para que consulte el maestro de proveedores", **para y discútelo**: eso convierte una inyección de prompt en una acción real.
- **Las reglas de negocio NO las evalúa el modelo.** El motor determinista de `rules-engine.ts` es la mitigación estructural: no lee el documento, lee el JSON ya validado. Nunca muevas lógica de decisión al prompt "para simplificar".
- `temperature: 0` y tope de `maxTokens`. Tope también de tokens de **entrada** por documento: es control de coste y de disponibilidad a la vez.
- **Guardrails de Bedrock** activados: filtro de *prompt attacks* (jailbreak, inyección, fuga de prompt) y filtros de información sensible que enmascaran PII en entrada y salida. En la ruta con OCR, además *contextual grounding checks* con el texto de Textract como fuente de referencia.
- El `confidence` que devuelve el modelo **es un token que generó**, no una probabilidad calibrada. Nunca lo trates como garantía: por eso existe la compuerta por campo y la revisión humana.
- **Fija el model id completo con versión.** Nunca un alias. Cambiar de modelo o de prompt exige pasar los evals (`evals/run-evals.ts`).
- Prohibido enviar a un modelo un documento cuyo tenant tenga marcada restricción de residencia de datos sin comprobar antes el perfil de inferencia y el modo de retención del modelo.

### 2.6 XSS a través del contenido extraído — el vector que casi nadie anticipa

El texto que sale del OCR o del modelo procede del documento de un tercero y **acaba pintado en la pantalla de un revisor**.

- En Angular: **interpolación normal** (`{{ campo }}`), que escapa por defecto.
- **Prohibido** `innerHTML`, `[innerHTML]`, `bypassSecurityTrustHtml` y cualquier `DomSanitizer.bypass*` sobre datos extraídos. Si alguna vez hace falta resaltar texto, se construye con nodos del DOM, no con strings de HTML.
- CSP sin `unsafe-eval` y sin `unsafe-inline` en `script-src`.
- Los nombres de archivo originales también son entrada del usuario: escápalos igual.

### 2.7 IAM y radio de impacto

- Un rol por función. **Nunca un rol compartido entre funciones con permisos distintos.**
- Acciones nombradas una a una. Recursos con ARN completo, incluido el sufijo del índice cuando se consulta un GSI.
- Si aparece un `AccessDeniedException`, **la solución NUNCA es ampliar a `*`**. Identifica la acción exacta que falta y añádela sola. Ampliar un permiso para desbloquearte es la forma más rápida de convertir un bug en una brecha.
- Cross-account, `iam:PassRole` y `sts:AssumeRole`: no los añadas sin discutirlo primero.
- Etiqueta todos los recursos (`app`, `env`, y `tenant` donde aplique) — es lo que permite auditar y repartir coste.

### 2.8 Secretos y configuración

- **Cero secretos en el código, en variables de entorno de texto plano del stack, o en el repo.** Lo que hoy no es secreto (un model id, un nombre de tabla) va en variables de entorno; lo que sí lo es va en **Secrets Manager** o **Parameter Store SecureString**, y se lee en caliente con caché.
- Rotación habilitada donde el servicio la soporte.
- Los secretos **nunca** se registran en logs, ni siquiera truncados.
- `.env` en `.gitignore`. Si detectas un secreto commiteado: **detente, avisa al usuario y dale los pasos para rotarlo**. No lo borres del fichero y sigas como si nada — sigue en el historial de git.

### 2.9 Dependencias y cadena de suministro

- Toda dependencia nueva se justifica. Prefiere el SDK de AWS y la librería estándar antes que un paquete de terceros.
- Versiones **fijadas** y `package-lock.json` commiteado. Nunca `^` en algo que parsee entrada de usuario.
- `npm audit --audit-level=high` en CI, bloqueante.
- Las librerías de parseo de PDF e imagen son, históricamente, el peor barrio del ecosistema: si añades una, dilo explícitamente y busca su CVE reciente antes.
- Prohibido `curl | bash` y descargar binarios de fuentes no oficiales en cualquier paso de build.

### 2.10 Logs, trazas y PII

- Logs **estructurados en JSON** con Powertools, siempre con `tenantId`, `documentId` y `traceId`.
- **Nunca registres**: contenido del documento, texto extraído completo, tokens, cabeceras `Authorization`, PII (identificadores fiscales, nombres de persona, direcciones, importes ligados a una persona).
- Nunca interpoles entrada del usuario directamente en un mensaje de log sin sanear `\r\n` (inyección en logs).
- Retención de logs acotada (`ONE_MONTH` en dev). Es a la vez control de coste y de exposición de datos.
- CloudTrail activo. Alarma sobre la DLQ con umbral **0**.

### 2.11 CI/CD

- **OIDC entre GitHub Actions y AWS. Cero claves de acceso estáticas.** Si te piden crear un usuario IAM con claves para el pipeline, propón OIDC en su lugar.
- El pipeline ejecuta, en este orden y todos bloqueantes: `tsc --noEmit` → `npm audit --audit-level=high` → `./scripts/auditoria-seguridad.sh` → `cdk synth` → evals del extractor.
- Despliegue solo desde el pipeline. Nada de `cdk deploy` desde un portátil hacia producción.
- `cdk diff` revisado antes de cada despliegue a producción; `--require-approval broadening` activado.

---

## 3. OWASP Top 10 aplicado a *esta* arquitectura

No es una lista genérica: es dónde aplica, dónde no y qué código lo cubre.

| OWASP | ¿Aplica? | Riesgo concreto aquí | Dónde vive la mitigación |
|---|---|---|---|
| **A01 Control de acceso roto** | **Riesgo nº 1** | IDOR en `GET /documents/{id}`; presigned reutilizado; escribir en el prefijo de otro tenant | `auth-context.ts`, clave de partición, condición IAM, `Conditions` del presigned |
| **A02 Fallos criptográficos** | Sí | PII en reposo; PII filtrada a CloudWatch | SSE en S3 y DynamoDB, `enforceSSL`, TLS 1.2+, política de no registrar PII (§2.10) |
| **A03 Inyección** | **Sí, pero no como SQL** | No hay SQL. Los vectores reales: **inyección de prompts**, **inyección de comandos** si se invoca un binario, **XSS almacenado vía texto extraído**, XXE, inyección en logs | §2.3, §2.5, §2.6, §2.10. **No usar PartiQL/`ExecuteStatement`** |
| **A04 Diseño inseguro** | Sí | Un tenant agota el presupuesto de IA subiendo basura | Cuotas por tenant, límite de páginas y de tokens, `maxConcurrency`, AWS Budgets con alarma |
| **A05 Configuración insegura** | Sí | Bucket expuesto, CORS con comodín, stack trace en la respuesta | `BLOCK_ALL` + OAC, CORS explícito, `fail()` genérico, cabeceras de seguridad en CloudFront |
| **A06 Componentes vulnerables** | Sí | Librerías de parseo de PDF/imagen | §2.9 |
| **A07 Fallos de autenticación** | Parcial | Delegado a Cognito. El riesgo residual es propio: validar el JWT a mano y hacerlo mal | Authorizer nativo, MFA, tokens cortos, revocación (§2.1) |
| **A08 Fallos de integridad** | Sí | Claves estáticas en CI; artefacto manipulado | OIDC, lockfile, despliegue solo desde pipeline (§2.11) |
| **A09 Fallos de registro** | Sí | Un abuso multi-tenant invisible durante semanas | Logs estructurados con `tenantId`, CloudTrail, alarma de DLQ a 0, alarma de presupuesto |
| **A10 SSRF** | **No aplica hoy** | No existe ningún endpoint que acepte una URL del usuario y la busque desde el servidor: todo ingreso es por presigned upload | **Riesgo condicional documentado.** El día que se añada "importar desde URL", exige allowlist, resolución de DNS con bloqueo de rangos privados y salida por proxy. **Si te piden esa funcionalidad, para y aplica esto primero.** |

---

## 4. Modelo de amenazas: lo que va a intentar el pentester

Para cada ataque, **qué línea de código lo impide**. Si al añadir una funcionalidad rompes una de estas, la funcionalidad espera.

| Ataque | Qué lo impide |
|---|---|
| IDOR con el `documentId` de otro tenant | El tenant es la clave de partición; la lectura simplemente no encuentra nada → 404 |
| Manipular el presigned para escribir en `tenants/otro/` | `['starts-with', '$key', ...]` aplicado por S3 |
| Saltarse el límite de tamaño | `['content-length-range', ...]` aplicado por S3 |
| Reutilizar un presigned caducado | `Expires: 300` |
| Subir un HTML con `<script>` renombrado a `.pdf` | Magic bytes en `classify.ts` + `nosniff` + CSP |
| **XSS almacenado vía el texto del OCR** | Interpolación de Angular; prohibición de `innerHTML` (§2.6) |
| **Inyección de prompts en el propio documento** | Separación instrucción/dato, salida por esquema, modelo sin herramientas, y el motor de reglas que no lee el documento (§2.5) |
| PDF de 50.000 páginas / bomba de descompresión | Límite de páginas en `classify.ts` |
| **Denial of wallet** por subida masiva | Cuotas por tenant, `maxConcurrency`, tope de tokens, AWS Budgets |
| `alg: none`, token de otro user pool, token caducado | Authorizer JWT nativo de API Gateway |
| Enumeración por diferencias de mensaje o de tiempo | 404 idéntico, `preventUserExistenceErrors` |
| Exfiltración por stack traces | `fail()` genérico; el detalle solo en logs |
| Reprocesamiento forzado para inflar la factura | Candado de idempotencia con `ConditionExpression` |

---

## 5. Anti-patrones: mal → bien

```ts
// ✗ MAL — el tenant viene del cliente
const tenantId = event.pathParameters.tenantId;
// ✓ BIEN — el tenant viene del token firmado
const { tenantId } = callerFrom(event);

// ✗ MAL — permite leer cualquier partición
table.grantReadData(fn);
// ✓ BIEN — acción nombrada, recurso concreto, condición de clave
fn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['dynamodb:GetItem'],
  resources: [table.tableArn],
  conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } },
}));

// ✗ MAL — inyección de comandos con el nombre del usuario
execSync(`pdftoppm -png "${nombreDelUsuario}" out`);
// ✓ BIEN — argumentos separados y ruta generada por el sistema
execFile('pdftoppm', ['-png', rutaGeneradaPorNosotros, 'out']);

// ✗ MAL — XSS almacenado con el texto extraído
elemento.innerHTML = campo.value;
// ✓ BIEN — interpolación, que escapa
<span>{{ campo.value }}</span>

// ✗ MAL — el modelo decide la regla de negocio
"Si el total supera el límite del proveedor, rechaza la factura"
// ✓ BIEN — el modelo extrae, el motor determinista decide
const decision = evaluar(extraccion.fields, ruleSet);

// ✗ MAL — filtra si el documento existe
if (!doc) return fail(404, 'NO_EXISTE');
if (doc.tenantId !== caller.tenantId) return fail(403, 'NO_AUTORIZADO');
// ✓ BIEN — el tenant está en la clave; una sola respuesta posible
if (!doc.Item) return notFound();

// ✗ MAL — el error revela infraestructura
return { statusCode: 500, body: JSON.stringify({ error: err.stack }) };
// ✓ BIEN — genérico fuera, detalle dentro
logger.error('fallo al leer documento', { err, documentId });
return fail(500, 'ERROR_INTERNO');
```

---

## 6. Definición de "terminado" en seguridad

Un cambio **no está terminado** hasta que todo esto pasa:

- [ ] `npm run build -w services` (tsc sin errores).
- [ ] `cd infra && npx cdk synth` sin warnings nuevos.
- [ ] `./scripts/auditoria-seguridad.sh` en verde.
- [ ] Si el cambio toca datos: `./scripts/probar-aislamiento.sh` devuelve **404**.
- [ ] Si el cambio toca el prompt, el esquema o el modelo: `npx tsx evals/run-evals.ts` supera el umbral.
- [ ] Ningún permiso IAM nuevo más amplio de lo estrictamente necesario, y cada uno con un comentario que diga por qué.
- [ ] Ninguna entrada de tercero llega sin validar a un intérprete, a HTML o a un prompt.
- [ ] Los logs del código nuevo no contienen PII ni contenido de documentos.

---

## 7. Prohibiciones absolutas

Estas no admiten "es solo para probar":

1. **No debilites un control para que pase un test.** Arregla el test.
2. **No amplíes un permiso IAM a `*` para desbloquear un `AccessDenied`.** Encuentra la acción exacta.
3. **No desactives la verificación TLS**, ni `rejectUnauthorized: false`, ni `NODE_TLS_REJECT_UNAUTHORIZED=0`.
4. **No commitees secretos.** Si ya está commiteado, avisa y da los pasos de rotación.
5. **No añadas `unsafe-inline` ni `unsafe-eval`** a la CSP para que funcione una librería. Cambia la librería.
6. **No hagas público un bucket** "temporalmente".
7. **No borres ni suavices** las instrucciones de seguridad del prompt de sistema en `schema.ts`.
8. **No le des herramientas con efectos secundarios al modelo** sin discutirlo antes.
9. **No muevas lógica de decisión de negocio al prompt.**
10. **No inventes datos de seguridad.** Si no sabes si un servicio soporta algo, dilo y verifícalo en la documentación oficial de AWS — no lo afirmes en un comentario ni en un ADR.
11. **No uses PartiQL / `ExecuteStatement`** en DynamoDB: reintroduce una superficie de inyección que este diseño no tiene.
12. **No proceses un documento antes de validar sus magic bytes.**

---

## 8. Cuando algo no esté claro

- **Ante la duda, la opción restrictiva.** Un permiso de menos se detecta en un test; uno de más se detecta en un pen test.
- Si una petición del usuario requiere romper una regla de aquí: **para, nombra la regla, explica el riesgo concreto en una frase y propón la alternativa.** No pidas permiso genérico ("¿seguro?"): da la alternativa.
- Si una funcionalidad nueva abre una superficie que este documento no cubre (por ejemplo: importar desde URL, webhooks entrantes, compartir documentos entre tenants, exportación masiva), **añade primero su sección aquí** y luego impleméntala.
- No asumas comportamientos de servicios de AWS: verifícalos en la documentación oficial. Este sistema va a ser defendido en una entrevista técnica y **una afirmación falsa cuesta más que una funcionalidad ausente**.
