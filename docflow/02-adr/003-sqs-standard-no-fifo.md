# ADR-003 — SQS Standard con idempotencia en los datos, no FIFO

**Estado:** aceptada · **Código:** `services/src/pipeline/consumer.ts`, `infra/lib/pipeline.ts`

> Si solo se lee un ADR de este repositorio, que sea este.

## Contexto

Procesar un documento dos veces cuesta dinero real: una extracción con modelo y,
en la ruta cara, páginas de Textract. Necesitamos que un documento se procese
**una sola vez**, y necesitamos absorber un pico de **10×** los últimos 3 días
del mes.

La respuesta refleja —y la que propone casi cualquier asistente al oír "no
quiero procesar dos veces"— es **SQS FIFO**, "porque garantiza exactly-once".

## Decisión

**SQS Standard.** La garantía de no-duplicación se implementa en la capa de
datos, con un candado condicional en DynamoDB:

```ts
Item: { pk: `IDEM#${key}#${etag}`, sk: 'LOCK', expiresAt: ttlIn(7*24*3600) },
ConditionExpression: 'attribute_not_exists(pk)'
```

Y una segunda barrera: el nombre de la ejecución de Step Functions es
determinista (`<documentId>-<etag>`), y Step Functions rechaza nombres repetidos.

## Alternativas evaluadas

**SQS FIFO — rechazada, y la premisa es falsa**

FIFO **no da exactly-once de extremo a extremo**. Da dos cosas concretas:

1. **Deduplicación en una ventana de 5 minutos**, y solo sobre `SendMessage`. Cubre reintentos del *productor*, no del consumidor.
2. **Orden dentro de un *message group***, a cambio de serializar el procesamiento de ese grupo.

El agujero es el consumidor: si procesa el mensaje y muere **antes** de
borrarlo, el mensaje reaparece al vencer el *visibility timeout*. Con FIFO
también. **El reprocesamiento no se elimina: se traslada.**

Y el precio es alto para nuestro caso: límites de throughput y serialización por
grupo, justo lo contrario de lo que hace falta con un pico de 10×. Incluso en
*high-throughput* FIFO el agujero del consumidor sigue ahí.

**Yo no necesito orden.** Las facturas son independientes: que la #7 se procese
antes que la #3 no cambia nada. Necesito que reprocesar no cueste dos veces, y
eso es **idempotencia**, que vive en los datos, no en la cola.

| Otras opciones | Por qué no |
|---|---|
| **Powertools Idempotency** | Hace exactamente esto, bien. No lo uso porque el candado explícito son 15 líneas que puedo defender línea a línea, y aquí eso vale más que una dependencia. En un equipo real, usaría Powertools |
| **Deduplicar en el paso de extracción** | Demasiado tarde: para entonces ya se arrancó la ejecución y se leyó el objeto |

## Consecuencias

**Buenas**

- **Deduplica para siempre** (hasta el TTL de 7 días), no 5 minutos.
- Sin límites de throughput: la cola absorbe el pico sin serializar nada.
- La clave combina objeto **y `etag`**: re-subir el mismo contenido no reprocesa; subir contenido distinto sobre la misma clave sí. Es la semántica correcta, y una ventana temporal no la puede expresar.
- El mismo mecanismo, aplicado al `sha256`, da **deduplicación de contenido** (ADR-011): un mecanismo, dos beneficios.

**Malas**

- **Una escritura extra en DynamoDB por mensaje.** Coste despreciable, pero es un punto de fallo más en el camino crítico.
- **Sin orden garantizado.** Si mañana un caso de uso lo exigiera, esta decisión no lo cubre.
- **El candado hay que liberarlo si el arranque falla.** Ponerlo antes de `StartExecution` es correcto (si no, dos entregas simultáneas arrancarían dos ejecuciones), pero abre un agujero: si `StartExecution` falla y el candado se queda puesto, el reintento se suprime como "duplicado" y **el documento no se procesa nunca sin llegar a la DLQ**, porque desde fuera parece un éxito. El código lo libera explícitamente; es la parte de esta decisión que más fácil es implementar mal.

## Cuándo revisaría esta decisión

- Si apareciera un requisito de **orden real** (por ejemplo, notas de crédito que deban aplicarse después de su factura). Incluso entonces, primero intentaría resolverlo con una máquina de estados por documento antes que con una cola FIFO.
- Si el volumen creciera hasta que **la escritura del candado fuese un cuello de botella**, lo que a 100k/mes no ocurre ni de lejos.
- Si el equipo creciera: cambiaría el candado a mano por **Powertools Idempotency**, para que la garantía no dependa de que todo el mundo entienda la sutileza.

## La frase para la defensa

> No uso FIFO. FIFO no da exactly-once: da deduplicación de 5 minutos sobre
> `SendMessage` y orden por grupo, a cambio de throughput. Y aunque lo usara, si
> mi consumidor muere después de procesar y antes de borrar, el mensaje vuelve
> igual. Lo que yo necesito es que reprocesar no cueste dos veces, y eso es una
> condición en DynamoDB, no una propiedad de la cola.
