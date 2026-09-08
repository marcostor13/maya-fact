# ADR-011 — El clasificador no clasifica documentos: decide rutas de procesamiento

**Estado:** aceptada · **Código:** `services/src/pipeline/classify.ts`, `ocr-start.ts`, `ocr-collect.ts`, `ocr.ts`, `dedupe.ts`

> Este es el ADR que mueve la factura. La decisión que aquí se toma vale más
> dinero que todas las demás juntas.

## Contexto

El pipeline canónico de *intelligent document processing* es: **Textract →
modelo**. Es lo que propone cualquier guía y lo que proponen los asistentes.

Pero los propios números de AWS lo contradicen. En el blog oficial de IDP con
Bedrock Data Automation, sobre 100 documentos de 20 páginas:

| Ruta | Coste medido |
|---|---|
| Textract + modelo | **$31,36** |
| Modelo solo (documento directo) | **$1,90** |

**~16× más barato sin OCR.** Y hay una segunda razón, técnica: el OCR de texto
plano **aplana el layout**. Una tabla convertida en flujo de líneas pierde la
asociación columna–valor. En documentos con estructura compleja, darle la imagen
al modelo suele funcionar *mejor*.

A 300.000 páginas/mes, la elección de API de Textract va de **$450**
(`DetectDocumentText`, $1,50/1.000) a **$19.500** (`AnalyzeDocument` Forms+Tables,
$65/1.000): un factor **43×** dentro del mismo diagrama, en una caja que no
cambia de sitio.

## Decisión

**El OCR no es un requisito: es una compra.** Y compra exactamente tres cosas:

1. **Confianza calibrada por palabra.** Textract devuelve `Confidence` por cada `WORD`: la salida de un modelo entrenado para esa tarea estrecha. La "confianza" que un LLM se autoasigna en un campo JSON **es un token que generó**, no una probabilidad.
2. **Geometría.** `BoundingBox` por palabra: es lo que permite resaltar el campo dudoso sobre la página, y responder "este importe salió de aquí" en una auditoría.
3. **Un artefacto de texto barato y reutilizable**, para re-extraer documentos históricos sin re-pagar el procesamiento visual.

**Donde no hacen falta esas tres cosas, no se compra.**

### Las rutas

| Ruta | Cuándo | Coste |
|---|---|---|
| `R1_PDF_TEXT` | PDF con capa de texto — la mayoría del volumen B2B: facturas emitidas por software | sin OCR |
| `R2_VISION` | Escaneo o foto, layout normal | ~1.500 tokens/página |
| `R3_TEXTRACT` | Ver abajo | el más caro |
| `R4_MANUAL` | No procesable | — |

### Y aquí está el matiz que refina la decisión

Mi primera versión activaba R3 **en el clasificador**, por tipo de documento. Es
peor, y me corregí: comprar OCR al recibir el documento es comprar a ciegas,
porque todavía no sé si alguien va a mirarlo.

**R3 se activa DESPUÉS de la decisión, cuando el resultado sale `NEEDS_REVIEW`.**
Solo entonces sé que un humano va a mirar ese documento, que es exactamente
cuando las coordenadas valen algo. Entonces Textract entra, se re-extrae con
geometría, y cada campo se **ancla** a sus palabras: gana `bbox` y su
`confidence` pasa a ser **la calibrada de Textract**, no la que se autoasignó el
modelo (`services/src/pipeline/ocr.ts`).

Hay una **segunda puerta** a R3, conceptualmente distinta: **TIFF**. Bedrock
acepta jpeg, png, gif y webp — TIFF no. Ahí el OCR no se compra por calidad ni
por geometría: **es el único camino que existe**. Que ambas puertas converjan en
la misma rama, y que el guardarraíl impida que una dispare a la otra, es lo que
hace que "el clasificador decide rutas" sea literal y no retórico.

### La palanca gemela: deduplicación por contenido

Antes de extraer nada, un `ConditionExpression` sobre `TENANT#<tid>#HASH#<sha256>`
detecta si ese contenido exacto ya se procesó. En B2B reenviar la misma factura
es rutina. **Es el mismo mecanismo del ADR-003 aplicado a otro eje: un
mecanismo, dos beneficios** — no procesar dos veces y no *pagar* dos veces.

Diferencia deliberada: el candado de entrega **tiene TTL**; el registro de
contenido **no**. Ponerle TTL sería reintroducir justo el problema de FIFO: una
ventana de deduplicación finita.

## Alternativas evaluadas

| Opción | Por qué no |
|---|---|
| **Textract siempre, con Forms+Tables** | $19.500/mes frente a ~$450. Es el 43× |
| **Textract siempre, con `DetectDocumentText`** | ~$450/mes de OCR que en su mayoría no compra nada, y encima aplana el layout |
| **Nunca Textract** | Tentador y equivocado: se pierden coordenadas y confianza calibrada justo en los documentos que van a revisión humana, que son los que más las necesitan |
| **Bedrock Data Automation** | Ver ADR-014 |

## Consecuencias

**Buenas**

- Reduce el componente dominante de la factura en más de un orden de magnitud.
- El coste por documento **se adapta a lo que el documento necesita**.
- La compuerta de confianza mejora donde importa: en revisión, la confianza es real.
- IAM refuerza la decisión: el rol solo puede invocar `DetectDocumentText`, **no** `AnalyzeDocument`. Una decisión de coste convertida en un control.

**Malas**

- **Más caminos = más superficie de prueba.** Cuatro rutas y dos puertas a R3 son más estados que probar y más formas de equivocarse.
- **La detección de capa de texto es una heurística sobre bytes en crudo** (busca `BT`/`Tj`). Falla con PDFs de streams comprimidos, que son mayoría en generadores modernos. Un falso negativo manda a R2 un documento que podría ir por R1: más caro, no incorrecto. Es la deuda más grande de este ADR.
- **La re-extracción en R3 se paga dos veces**: la primera extracción ya ocurrió. Es deliberado —solo pasa en el ~5% que va a revisión— pero hay que decirlo.
- El anclaje por cita literal falla si el modelo parafrasea. Cuando no ancla, el campo queda como `llm_inference`, que es la respuesta correcta: **la ausencia de anclaje es señal de alucinación**, no un fallo de la función.

## Cuándo revisaría esta decisión

- Si Bedrock publicara precios que cambiaran el ratio de 16×.
- Si el % de documentos en `NEEDS_REVIEW` subiera por encima del ~20%: entonces R3 dejaría de ser la excepción y saldría más barato pagar Textract de entrada.
- Si apareciera un requisito de **auditoría con coordenadas para el 100%** de los documentos: R3 pasaría a ser la ruta por defecto y este ADR se invertiría.
- Cuando sustituya la heurística de capa de texto por una librería de parseo, revisaría la distribución real R1/R2 — puede que hoy esté pagando visión por documentos que tienen texto.

## La frase para la defensa

> ¿Para qué OCR si el modelo ve el documento? Porque el OCR no es un requisito,
> es una compra: compro confianza calibrada, coordenadas y un texto reutilizable.
> Y solo lo compro en los documentos que las necesitan, que son los que van a
> revisión humana. Según los propios números de AWS, eso es la diferencia entre
> $1,90 y $31,36 por cada cien documentos.
