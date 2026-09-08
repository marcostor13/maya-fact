# Resiliencia

## 1. La distinción que lo gobierna todo: transitorio contra permanente

`services/src/shared/errors.ts`

| | Transitorio | Permanente |
|---|---|---|
| **Ejemplos** | Throttling de Bedrock, timeout de red, 5xx | PDF corrupto, magic bytes desconocidos, 50.000 páginas, formato no soportado |
| **Qué se hace** | Reintentar con backoff exponencial + jitter | **NO reintentar.** Consumir el mensaje y cerrar el documento en `QUARANTINED` |
| **Por qué** | El problema pasa solo | Reintentar un error permanente tres veces son **tres facturas de OCR** y tres entradas de ruido en las métricas |

**La verificación es directa:** sube un `.txt` renombrado a `.pdf`. Debe acabar
en `QUARANTINED` **sin pasar por la DLQ**. Si aparece en la DLQ, la
clasificación está mal.

Que un error permanente **no** llegue a la DLQ es lo que hace que la alarma de
DLQ con umbral 0 sea sostenible: si la basura del día a día acabara ahí, la
alarma sonaría constantemente y se ignoraría.

## 2. Idempotencia

**Candado condicional en DynamoDB**, no FIFO (ADR-003):

```ts
Item: { pk: `IDEM#${key}#${etag}`, sk: 'LOCK', expiresAt: ttlIn(7*24*3600) },
ConditionExpression: 'attribute_not_exists(pk)'
```

Tres barreras encadenadas:

1. **El candado**: deduplica para siempre (hasta el TTL), no 5 minutos.
2. **El nombre determinista de la ejecución** (`<documentId>-<etag>`): Step Functions rechaza duplicados. Se trata `ExecutionAlreadyExists` como **éxito**, no como fallo.
3. **`ClientRequestToken` en Textract**: si Step Functions reintenta el paso, no se arranca un segundo trabajo de OCR — un trabajo duplicado son páginas pagadas dos veces.

**El agujero que hay que cerrar y que casi nadie cierra:** el candado se pone
*antes* de `StartExecution`, que es lo correcto (si no, dos entregas simultáneas
arrancarían dos ejecuciones). Pero si `StartExecution` falla y el candado se
queda puesto, el reintento se suprime como "duplicado" y **el documento no se
procesa nunca sin llegar a la DLQ**, porque desde fuera parece un éxito. Por eso
se libera explícitamente en el camino de fallo.

## 3. El documento nunca se pierde

Cada camino de fallo **escribe un estado terminal** en DynamoDB, dentro de una
transacción, con su evento de auditoría y quitando el TTL del intent.

| Situación | Resultado | Ejecución |
|---|---|---|
| Clasificación falla (permanente) | `QUARANTINED` | SUCCEEDED |
| Extracción falla tras 4 reintentos | `NEEDS_REVIEW` | SUCCEEDED |
| Esquema inválido dos veces | `NEEDS_REVIEW` | SUCCEEDED |
| Contenido duplicado | `DUPLICATE` | SUCCEEDED |
| **OCR de enriquecimiento falla** | Conserva su decisión, **sin bbox** | SUCCEEDED |
| Fallo no clasificado | — | **FAILED → alarma** |

**Degradación elegante, no excepción.** Un timeout no es un error: es un camino
más lento pero correcto.

> **La trampa que costó caro:** un estado `Pass` de Step Functions **no escribe
> nada**. Los caminos de fallo *parecían* implementados y solo devolvían un
> objeto: el documento se quedaba en `PENDING` con el TTL de 24 h puesto y
> desaparecía al día siguiente. La ejecución acababa en `SUCCEEDED` y nada
> aparecía en la DLQ. **Era pérdida de datos con aspecto de éxito.**

## 4. Reintentos

`addRetry` declarativo por paso: 4 intentos, intervalo inicial 2 s, `backoffRate`
2, tope 30 s, **jitter completo**.

El jitter no es un detalle: sin él, 500 mensajes que fallan a la vez por
throttling de Bedrock reintentan **todos a la vez** a los 2 segundos, y vuelven a
throttlear. Es la estampida sincronizada.

Se reintenta **solo lo transitorio**: la lista de errores es explícita
(`TransientError`, `ThrottlingException`, `ModelTimeoutException`,
`Lambda.TooManyRequestsException`), no `States.ALL`.

**`visibilityTimeout` ≥ 6× el timeout de la función** (180 s frente a 30 s): si
no, SQS reentrega mensajes que aún se están procesando y aparece trabajo
duplicado que la idempotencia tiene que absorber sin necesidad.

## 5. Respuesta parcial de lote

`reportBatchItemFailures: true`. Sin esto, **un mensaje malo en un lote de diez
hace que los diez se reprocesen**. Con esto, se devuelven solo los que fallaron.

## 6. DLQ y procedimiento de redrive

`maxReceiveCount: 3`, DLQ dedicada, retención 14 días, **alarma con un solo
mensaje**.

> *"La DLQ tiene 400 mensajes. Es lunes 8 a.m. ¿Qué haces, en orden?"*

1. **NO hacer redrive.** Reinyectar 400 mensajes sin saber por qué fallaron es repetir el fallo 400 veces, y si la causa es de coste, pagarlo otra vez.
2. **Mirar un mensaje**, no cuatrocientos. ¿Mismo `documentId`? ¿Mismo tenant? ¿Mismo error?
3. **Correlacionar con la ventana temporal**: ¿coincide con un despliegue, con un pico, con una incidencia de AWS?
4. **Clasificar la causa.** Si los 400 son del mismo tenant con el mismo error, es un cambio en lo que manda ese cliente, no un fallo nuestro.
5. **Arreglar la causa** y verificar con **uno** reinyectado a mano.
6. **Redrive por lotes**, vigilando la tasa de error y el coste, no los 400 de golpe.
7. **Revisar el estado de los documentos**: pueden estar en `PENDING` esperando desde el viernes, y hay clientes que ya se dieron cuenta.

## 7. Radio de impacto

**Una función por paso, un rol por función.** Si se compromete la Lambda de
extracción, lo máximo que alcanza es leer objetos del bucket de documentos e
invocar **un** model id de Bedrock. **No toca DynamoDB en absoluto**: eso lo
hace otra función con otro rol.

Colas separadas por criticidad, y el aislamiento de tenant reforzado en IAM
(ADR-008).

## 8. Preguntas de resiliencia con respuesta corta

| Pregunta | Respuesta |
|---|---|
| **Textract se cae 30 minutos** | Nada se pierde. Solo afecta al ~5% que va por R3, y solo al enriquecimiento: el documento **ya tiene su decisión persistida**. El `addCatch` lo lleva a `SinGeometria` y la ejecución termina bien. El revisor ve el campo sin resaltar |
| **Un cliente sube 50.000 documentos en 10 minutos** | Lo primero que se rompe no es un servicio: es el **presupuesto**. La cola absorbe, `maxConcurrency: 20` limita, pero 50.000 extracciones se pagan. Los controles son el rate limit de WAF y las cuotas por tenant; la alarma de previsión de gasto es la que avisa |
| **El procesamiento tarda más que el visibility timeout** | No ocurre: el consumidor solo arranca la ejecución (< 1 s). El trabajo largo vive en Step Functions, que no tiene visibility timeout. **Desacoplar el portero del trabajador es lo que elimina esta clase de problema** |
| **Desplegar sin perder mensajes en vuelo** | Lambda drena las invocaciones en curso; los mensajes no confirmados vuelven a la cola. Step Functions usa la definición del momento del arranque. El riesgo real es un cambio **incompatible en el formato del estado** entre versiones |
| **Se cae una zona de disponibilidad** | Todos los servicios usados son multi-AZ por defecto. Se degrada la latencia, no la disponibilidad |
| **Estado inconsistente en DynamoDB** | No puede darse en la escritura de la decisión: es una **transacción**. Documento, campos y auditoría entran juntos o no entra ninguno |
| **Fallo de región** | RTO 4 h con PITR + IaC. Aceptado explícitamente (ADR-010) |

## 9. Lo que no está probado

- **El plan de recuperación ante fallo de región no está ensayado.** Un plan sin ensayo es una hipótesis.
- **No hay pruebas de caos.** Ni inyección de fallos de Bedrock, ni de throttling, ni de reentrega masiva.
- El comportamiento bajo el pico real de 10× **está razonado, no medido**.
