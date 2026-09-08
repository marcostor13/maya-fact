# ADR-006 — DynamoDB on-demand ahora, provisioned cuando la curva se estabilice

**Estado:** aceptada · **Código:** `infra/lib/data.ts`

## Contexto

DynamoDB cobra de dos formas: **on-demand** (por petición, sin planificar) o
**provisioned** (capacidad reservada, más barata por unidad, con autoscaling).
Provisioned puede salir hasta ~7× más barato *si la carga es previsible*.

Nuestra carga **no lo es**: el 40% del volumen mensual cae en los últimos 3 días
del mes, con un ratio pico/media de ~10×.

## Decisión

**On-demand desde el principio**, con un criterio de migración **escrito de
antemano**: se pasa a provisioned + autoscaling cuando el **ratio pico/media
sostenido baje de 4×** durante dos meses consecutivos.

## Alternativas evaluadas

| Opción | Por qué no |
|---|---|
| **Provisioned dimensionado al pico** | Se paga el pico los 30 días del mes para usarlo 3. A 10× de ratio, es tirar el dinero |
| **Provisioned dimensionado a la media + autoscaling** | Es la trampa. El autoscaling de DynamoDB reacciona en **minutos**, no en segundos: ante un pico de 10× hay throttling mientras escala. Y el throttling en la escritura del candado de idempotencia significa mensajes reintentados y latencia justo el día que más importa |
| **Provisioned + reserva de capacidad** | Compromiso de 1 o 3 años sobre un patrón de tráfico que todavía no conozco |

## Consecuencias

**Buenas**

- Cero riesgo de throttling durante el cierre contable, que es cuando el cliente mira.
- Cero trabajo de capacity planning en una fase donde los números son supuestos.
- **La decisión tiene una condición de salida escrita.** Eso convierte el ADR de una afirmación en un compromiso revisable.

**Malas**

- **Se paga más por petición.** A 100k documentos/mes son decenas de dólares: irrelevante frente a los ~$1.000–3.000 de la capa de ML. Pero a 10 millones de documentos deja de serlo, y ahí esta decisión se vuelve cara.
- On-demand tiene su propio techo inicial por tabla; con un pico verdaderamente brusco puede hacer falta pedir aumento de límites.

## El contexto que hace correcta esta decisión

Y es el argumento que de verdad importa: **DynamoDB es menos del 2% de la
factura.** El coste dominante es una llamada de ML. Optimizar aquí es optimizar
el ruido.

Elegir on-demand no es "la opción cara": es **negarse a gastar tiempo de
ingeniería y asumir riesgo de throttling en la partida que no mueve la aguja**.
Si dedicara ese esfuerzo a la decisión de ruta del ADR-011, el ahorro sería tres
órdenes de magnitud mayor.

## Cuándo revisaría esta decisión

- **Criterio duro:** ratio pico/media sostenido por debajo de 4× durante dos meses. Es medible con `ConsumedReadCapacityUnits` / `ConsumedWriteCapacityUnits`.
- Si el volumen superara **1 millón de documentos/mes**, aunque el ratio siguiera alto: el ahorro absoluto empezaría a justificar el trabajo.
- Si apareciera una carga de lectura masiva y previsible (por ejemplo, un proceso de re-extracción histórica nocturna): esa tabla o ese periodo sí se beneficiarían de capacidad reservada.
