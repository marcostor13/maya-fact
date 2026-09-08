# El recorrido narrado, de punta a punta

> Para leer en 10 minutos antes de mirar código. Los diagramas están en los
> otros tres ficheros de esta carpeta; esto es la historia que cuentan.

## El camino de un documento

**1 · El navegador pide permiso, no envía el archivo.**
`POST /uploads` con el nombre, el tipo y el tamaño. La Lambda saca el `tenant_id`
**del token firmado** —nunca del body— y genera una clave que ella controla:
`tenants/<tenantId>/inbox/<uuid>`. Devuelve un **presigned POST** con condiciones
que aplica S3, no nuestro código: prefijo forzado, tamaño entre 1 byte y 20 MB,
`Content-Type` exacto, caducidad de 5 minutos. En la misma llamada escribe un
intent en estado `PENDING` con TTL de 24 h, para que un permiso que nadie use se
limpie solo.

**2 · El archivo va directo a S3.**
No pasa por API Gateway ni por Lambda. Ni el límite de 10 MB, ni transferencia
pagada, ni bytes hostiles en la memoria de una función nuestra antes de estar
validados.

**3 · S3 avisa, y una cola absorbe el golpe.**
`Object Created` → EventBridge (filtrado declarativo, y fan-out futuro sin tocar
el productor) → SQS **Standard**. La cola es lo que convierte un pico de 10× a
fin de mes en trabajo ordenado.

**4 · El consumidor es un portero, no un trabajador.**
Escribe un candado condicional `IDEM#<clave>#<etag>` y arranca la ejecución. Si
el candado ya existe, la entrega es duplicada y se descarta. Si `StartExecution`
falla, **libera el candado** para que el reintento pueda volver a intentarlo —
sin eso, el documento se pierde para siempre pareciendo un éxito.

**5 · Clasificar: el paso que decide el dinero.**
Lee los bytes y comprueba **magic bytes** (nunca la extensión ni el
`Content-Type`), calcula el `sha256`, cuenta páginas y detecta si el PDF trae
capa de texto. Con eso **elige la ruta**: `R1` si hay texto (sin OCR), `R2` si es
imagen (al modelo multimodal), `R3` si es TIFF (el modelo no lee ese formato:
Textract sí). Lo que no reconoce, o lo que pasa de 50 páginas, es un error
**permanente** y va a `QUARANTINED` sin gastar un céntimo más.

**6 · Deduplicar: la palanca de coste más barata.**
Un `ConditionExpression` sobre `TENANT#<tid>#HASH#<sha256>`. Si ese contenido ya
se procesó, el documento se cierra como `DUPLICATE` **sin extraer nada**. En B2B
reenviar la misma factura es rutina, no excepción.

**7 · Extraer: el modelo lee, y solo lee.**
El documento va como contenido de usuario **delimitado**, con un prompt de
sistema que declara que es material a procesar y nunca instrucciones. La salida
se fuerza con `toolChoice` contra un esquema donde cada campo lleva valor, valor
normalizado, confianza y **cita literal**. El modelo no invoca herramientas, no
escribe en ningún sitio, no ve otros documentos.

**8 · Decidir: el motor de reglas, que no lee el documento.**
Lee el JSON ya validado y aplica el ruleset **versionado del cliente**. Reglas
`BLOCK` → `REJECTED`. Campos críticos por debajo de su umbral, o reglas `WARN` →
`NEEDS_REVIEW`. Todo lo demás → `APPROVED`. Se persiste en **una transacción**:
documento, campos y evento de auditoría entran juntos o no entra ninguno, junto
al trío `modelId` + `promptVersion` + `rulesetVersion` que hace la decisión
reproducible seis meses después.

**9 · El OCR se compra tarde, y solo si sirve.**
Si la decisión salió `NEEDS_REVIEW`, y solo entonces, entra Textract: ahora sí
sabemos que un humano va a mirar ese documento, que es cuando las coordenadas
valen algo. Se re-extrae y cada campo se **ancla** a las palabras del OCR: gana
su `bbox` y su confianza pasa a ser **la calibrada de Textract**, no la que se
autoasignó el modelo. Si Textract falla, el documento **conserva su decisión** y
solo pierde el resaltado.

## Las tres ideas que sostienen el diseño

**1 · Lo que no se puede evitar, se hace barato.**
Reprocesar no se elimina —ninguna cola lo elimina, tampoco FIFO—, así que se
hace **gratis**: una condición en DynamoDB. El mismo mecanismo, sobre el hash del
contenido, evita además pagar dos veces por el mismo documento. Un mecanismo,
dos beneficios.

**2 · Lo probabilístico se separa de lo determinista.**
El modelo extrae; el motor decide. Da auditabilidad ("se rechazó por R-002",
no "el modelo lo consideró así"), reproducibilidad, y —lo que menos se ve— **es
la mitigación estructural de la inyección de prompts**: un documento hostil
puede engañar al extractor, pero no puede saltarse un motor que no lee
documentos.

**3 · El coste es una decisión de arquitectura, no una consecuencia.**
Más del 90% de la factura es una llamada de ML, y dentro de esa llamada hay un
factor 43× entre la API cara y la barata de Textract, y un ~16× entre pasar por
OCR o no. **La caja que mueve la factura es el clasificador**, y no es la que
nadie mira en el diagrama.

## Dónde está cada cosa

| Quieres entender… | Lee |
|---|---|
| Por qué no FIFO | `02-adr/003` · `services/src/pipeline/consumer.ts` |
| Por qué el archivo no pasa por la API | `02-adr/002` · `services/src/api/create-upload.ts` |
| Por qué el OCR es condicional | `02-adr/011` · `services/src/pipeline/classify.ts`, `ocr.ts` |
| Por qué el LLM no decide | `02-adr/012` · `services/src/pipeline/rules-engine.ts` |
| Cómo se aísla un tenant de otro | `02-adr/007`, `008` · `03-nfr/seguridad.md` |
| Qué pasa cuando algo falla | `03-nfr/resiliencia.md` · `infra/lib/pipeline.ts` |
| Cuánto cuesta y qué lo mueve | `03-nfr/costos.md` |
