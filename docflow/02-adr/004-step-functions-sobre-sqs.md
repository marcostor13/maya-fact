# ADR-004 — Step Functions orquesta el pipeline; SQS es el amortiguador

**Estado:** aceptada · **Código:** `infra/lib/pipeline.ts`

## Contexto

El enunciado pide un flujo asíncrono desacoplado **con SQS**. El pipeline tiene
hoy 6 pasos lógicos (clasificar → deduplicar → extraer → decidir → [OCR →
re-extraer → re-decidir]) y va a tener más.

El patrón que sale solo es encadenar Lambdas con colas entre ellas. Y hay una
lectura estricta del enunciado según la cual eso es lo que se pide.

## Decisión

**Las dos cosas, con papeles distintos.** SQS sigue estando y hace lo que solo
SQS hace: **amortiguar el pico de 10× y limitar la concurrencia**
(`maxConcurrency: 20`). Step Functions **Standard** orquesta los pasos dentro de
cada documento.

El consumidor de la cola es un **portero, no un trabajador**: comprueba
idempotencia y arranca la ejecución. Nada más.

## Alternativas evaluadas

| Opción | Por qué no |
|---|---|
| **5 Lambdas encadenadas con 5 colas** | Cumple el enunciado al pie de la letra y es peor. Obliga a reimplementar a mano retry, backoff con jitter, catch y compensación **en cada función**. Y, sobre todo, **destruye la visibilidad del estado del documento**: para saber por dónde va hay que correlacionar logs de cinco funciones. Con Step Functions, el estado de cada ejecución es consultable por API durante 90 días, gratis |
| **Una sola Lambda con todo dentro** | Un timeout de 15 minutos como techo duro, y un fallo en el paso 4 obliga a repetir del 1 al 3 —incluida la extracción, que es la que cuesta dinero |
| **Step Functions Express** | Descartada por **dos razones concretas**: Express solo admite integraciones *request-response* (nada de `.sync` ni `waitForTaskToken`), y su historial no es consultable por API, solo vía CloudWatch Logs si activas el logging. Además el techo son 5 minutos |
| **Step Functions sin SQS** (EventBridge directo a la máquina) | Un salto menos, pero se pierde el amortiguador. En el pico de fin de mes se arrancarían 40.000 ejecuciones a la vez contra los límites de Bedrock. **SQS es lo que convierte un pico en una cola** |

## Consecuencias

**Buenas**

- **Retry declarativo por paso**, con backoff exponencial y jitter, sin escribir una línea de control de flujo.
- **`addCatch` da degradación elegante real**: si la extracción falla, el documento cae a `NEEDS_REVIEW` en vez de perderse.
- El estado del documento se ve en la consola, paso a paso, sin correlacionar nada. Vale su peso en oro durante un incidente.
- `maxConcurrency: 20` en el *event source* protege a Bedrock, a Textract **y a la factura** del propio pico.

**Malas**

- **Un servicio más que conocer**, y su lenguaje de estados (ASL) tiene aristas: los `resultPath` y `parameters` son la fuente número uno de errores, y fallan en ejecución, no al desplegar.
- **Standard cobra por transición de estado.** Con 21 estados y 100k documentos/mes son ~$25/mes: irrelevante aquí, pero crece linealmente con el volumen y con cada estado que se añada.
- **Un `Pass` no escribe nada.** Es la trampa que cuesta caro: los caminos de fallo *parecían* implementados y solo devolvían un objeto. El documento se quedaba en `PENDING` y moría por TTL. Los estados terminales tienen que invocar una Lambda que persista.
- El techo de 15 minutos de la ejecución acota la espera del OCR asíncrono.

## Cuándo revisaría esta decisión

- Si el pipeline bajara a **2 pasos**: Step Functions dejaría de compensar y una Lambda con retry propio sería más simple.
- Si el coste por transición pasara a ser significativo (a partir de ~2 millones de documentos/mes): evaluaría mover los tramos sin espera a **Express anidado** dentro de la máquina Standard, que es el patrón habitual.
- Si necesitara **paralelismo por página** dentro de un documento: `Map` distribuido cambia la forma del diseño.

## La frase para la defensa

> El reto pide SQS y SQS está: es lo que absorbe el pico de fin de mes y lo que
> me da control de concurrencia. Lo que no hago es usarlo como mecanismo de
> orquestación, porque encadenar cinco colas me obliga a reimplementar retry y
> compensación a mano y me deja sin saber por dónde va un documento.
