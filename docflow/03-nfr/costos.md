# Costos

> Presentado como **modelo con variables**, no como tarifa. Un arquitecto que
> dice "esta es una estimación gruesa, este es el modelo y estas son las tres
> variables que la mueven" es más creíble que uno que da una cifra con dos
> decimales.
>
> ⚠️ **Precios a revalidar antes de comprometerse.** Los de Textract están en la
> página oficial. Los de Bedrock varían por modelo, región y perfil de
> inferencia (los globales son ~10% más baratos). Los de BDA **no pude leerlos**
> en la página de precios.

## El titular

> La parte de mi arquitectura que todo el mundo mira —Lambda, DynamoDB, API
> Gateway— es **menos del 5% de la factura**. Más del 90% es una sola llamada de
> ML, y dentro de esa llamada hay un factor **43×** entre la opción barata y la
> cara. Optimizar cold starts aquí es optimizar el ruido: **la decisión de
> arquitectura que mueve la factura es el clasificador que decide qué ruta
> tomar.**

## Base de cálculo

100.000 documentos/mes × 3 páginas = **300.000 páginas/mes**.

## El factor 43× que no está en ninguna caja del diagrama

Precios de Textract, primer tramo, us-east-1:

| API de Textract | USD / 1.000 págs | Factor | **A 300k págs/mes** |
|---|---|---|---|
| `DetectDocumentText` (solo texto) | 1,50 | 1× | **$450** |
| `AnalyzeExpense` (facturas) | 10,00 | 6,7× | $3.000 |
| `AnalyzeDocument` — Tables | 15,00 | 10× | $4.500 |
| `AnalyzeDocument` — Queries | 15,00 | 10× | $4.500 |
| `AnalyzeDocument` — Forms | 50,00 | 33× | $15.000 |
| `AnalyzeDocument` — Forms + Tables | 65,00 | 43× | **$19.500** |

**El mismo diagrama, las mismas cajas, y una diferencia de 43×.** No hay ninguna
flecha que cambie de sitio entre la primera fila y la última.

**Nuestra elección: `DetectDocumentText`**, y solo en la ruta R3. La estructura
la saca el modelo. Además, IAM **no permite** invocar `AnalyzeDocument`: la
decisión de coste es un control técnico, no una convención.

## Comparativa de arquitecturas

| Ruta | Composición | 100k docs/mes |
|---|---|---|
| **A′ — OCR con formularios** | Textract Forms+Tables | ~$19.500 |
| **A — OCR estructurado** | Textract AnalyzeExpense | ~$3.000 |
| **B — OCR barato + LLM** | `DetectDocumentText` + modelo pequeño | ~$470–850 |
| **C — Documento directo al modelo** | Sin OCR: `DocumentBlock` o imagen | **el más barato** |
| **Nuestro diseño** | C por defecto, R3 solo en el ~5% que va a revisión | **≈ C + 5% de B** |

El único dato oficial de AWS sobre el salto B→C (blog de IDP con BDA, 100 docs ×
20 págs) mide **$31,36 con Textract+modelo frente a $1,90 con el modelo solo**:
~**16×**. No traslado el factor literalmente —son documentos más largos y otro
perfil— pero sí el orden de magnitud y la dirección.

## El resto de la factura

| Servicio | Estimación | Comentario |
|---|---|---|
| **Bedrock (extracción)** | **$200–600** | El componente dominante. Escala con páginas y tokens |
| **Textract (solo R3, ~5%)** | ~$25 | 15.000 páginas × $1,50/1.000 |
| Lambda (12 funciones, ARM64) | ~$15–30 | |
| DynamoDB on-demand | ~$25–40 | ~1,3M escrituras/mes |
| Step Functions Standard | ~$25 | 21 estados × 100k ejecuciones |
| S3 (almacenamiento + peticiones) | ~$15 | Con ciclo de vida a IA/Glacier |
| CloudFront + WAF | ~$15 | WAF: $5 fijos + $1/millón |
| SQS, EventBridge, Cognito, SNS | **< $10** | Ruido estadístico |
| CloudWatch (logs, métricas, alarmas) | ~$20 | **El gasto silencioso**: retención acotada a 30 días |
| **Total** | **~$350–800/mes** | Frente a los ~$19.500 de la ruta ingenua |

**Coste por documento: ~$0,004–0,008.** El objetivo del NFR-8 era < $0,05: hay
un orden de magnitud de margen.

## Palancas, en orden de impacto

1. **No pagar OCR donde no hace falta** (ADR-011). Con diferencia, la más grande: es la diferencia entre $19.500 y ~$500.
2. **Deduplicación por hash del contenido.** En B2B reenviar la misma factura es rutina. Un `ConditionExpression` evita pagar la extracción dos veces. Es **el mismo mecanismo** que da idempotencia: un mecanismo, dos beneficios. La métrica `DuplicateSuppressed` está en el dashboard **junto a** los tokens consumidos, para ver el ahorro al lado del gasto.
3. **Enrutamiento por complejidad.** Modelo pequeño por defecto; escalar al grande solo con confianza baja. La mayoría de las facturas son aburridas.
4. **Caché de prompt de Bedrock.** Hasta 90% de descuento en los tokens cacheados; el prompt de sistema y el esquema son idénticos en cada invocación. **Ojo al detalle fino:** hay un mínimo de tokens por punto de caché (en algunos modelos, 4.096). Si el prompt es más corto, **la caché no se activa y no avisa**.
5. **Inferencia por lotes al 50%.** El pico de fin de mes es masivo y **no todo es urgente**: separar la cola urgente de la diferida y mandar la segunda a batch es una decisión de arquitectura que se traduce directamente en factura. 🟡 No implementado.
6. **Cuotas por tenant**, para que el abuso no se convierta en factura.
7. **Lambda en ARM64/Graviton.** El precio por GB-segundo es exactamente **20% menor**, pero **el cargo por invocación es idéntico**: el ahorro real de una función corta es menor del 20%. No confundir con el "hasta 34% mejor precio-rendimiento" que comunica AWS, que mezcla precio y velocidad.
8. **Ciclo de vida de S3**: Standard → IA a 90 días → Glacier IR a 365.
9. **Retención de logs acotada** (30 días) y muestreo de trazas.

## Escalado: los dos extremos

**Con 10 documentos/mes:** ~$25/mes, y **casi todo son costes fijos** que no
dependen del uso: WAF ($5), CloudFront con logging, las alarmas de CloudWatch
($0,10 cada una), el user pool. La arquitectura serverless escala a cero en
cómputo, **no en superficie de control**. A ese volumen, este diseño está
sobredimensionado y lo correcto sería una Lambda y una tabla.

**Con 10 millones de documentos/mes** (100× el volumen):

- Bedrock y Textract escalan **linealmente**: ~$20.000–60.000/mes. Siguen siendo >90%.
- DynamoDB: **aquí sí** habría que migrar a provisioned (ADR-006), y el ahorro pasa a ser de miles.
- Step Functions: ~$2.500/mes. Empezaría a compensar mover tramos a Express anidado.
- Textract entraría en **tramos de descuento por volumen** a partir del millón de páginas.
- Aparecerían límites de servicio (concurrencia de Lambda, TPS de Bedrock) que hoy no son un problema.

**Lo que no cambia con el volumen:** que el 90% de la factura sigue siendo ML, y
que la palanca sigue siendo el clasificador.

## El gasto como señal de salud

En un sistema cuyo coste dominante es **por unidad procesada**, un pico de coste
no es un problema de finanzas: **es un pico de abuso o un bug**.

Por eso AWS Budgets con notificación por **previsión al 80%** está en el mismo
plano que las alarmas de la DLQ, y por eso los tokens consumidos son una métrica
de negocio en el dashboard.

*"Tu factura se duplica de un mes a otro, ¿cuál es tu primera hipótesis?"* — Que
un tenant cambió su mix de documentos: más escaneos, menos PDFs con capa de
texto, así que más volumen por R2/R3. Se confirma comparando la distribución de
rutas y los tokens por tenant, no mirando Cost Explorer.
