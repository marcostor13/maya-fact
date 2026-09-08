# ADR-005 — DynamoDB con diseño de tabla única

**Estado:** aceptada · **Código:** `infra/lib/data.ts`, `services/src/shared/ddb.ts`

## Contexto

Hay que guardar documentos, sus campos extraídos, sus eventos de auditoría, los
candados de idempotencia y los registros de deduplicación. Para 40 clientes y
100.000 documentos al mes, con picos de 10×.

## Decisión

**Una sola tabla de DynamoDB**, con las claves derivadas de los patrones de
acceso — **declarados primero**, tabla después. Si se empieza por la tabla, se
acaba haciendo `Scan`.

| # | Patrón de acceso | Cómo se resuelve |
|---|---|---|
| 1 | Documento por id, dentro de un tenant | `pk=TENANT#<tid>`, `sk=DOC#<docId>` |
| 2 | Documentos de un tenant por estado, recientes primero | GSI1: `TENANT#<tid>#ST#<estado>` / `<createdAt>#<docId>` |
| 3 | Campos extraídos de un documento | `begins_with(sk, 'DOC#<docId>#FIELD#')` |
| 4 | Duplicado por contenido | `pk=TENANT#<tid>#HASH#<sha256>` |
| 5 | Candado de idempotencia | `pk=IDEM#<clave>` con TTL |
| 6 | Auditoría de un documento | `begins_with(sk, 'DOC#<docId>#EVT#')` |

**El tenant es siempre el principio de la clave de partición.** Eso no es
organización: es la primera capa de la defensa contra IDOR, y lo que hace
posible la condición IAM del ADR-008.

## Alternativas evaluadas

| Opción | Por qué no |
|---|---|
| **Aurora Serverless v2 (PostgreSQL)** | Es la pregunta obvia y merece respuesta seria. Mis patrones de acceso **son seis, los conozco todos y ninguno hace joins ni agregaciones ad-hoc**. Aurora aportaría flexibilidad de consulta que no necesito, a cambio de: capacidad mínima facturada aunque no haya tráfico, gestión de conexiones desde Lambda (RDS Proxy, otra pieza), y una VPC —con sus NAT Gateways— que hoy el diseño no tiene. Con picos de 10× y tráfico irregular, el modelo de pago por uso de DynamoDB encaja mucho mejor |
| **Varias tablas (una por entidad)** | Obligaría a varias llamadas para componer la vista de un documento, y perdería la posibilidad de escribir documento + campos + auditoría en **una sola transacción** |
| **DynamoDB + OpenSearch desde el día 1** | No hay ningún patrón de búsqueda por texto libre en la lista. Añadir un cluster para un requisito que no existe es la definición de sobreingeniería |

## Consecuencias

**Buenas**

- Latencia predecible de un dígito de milisegundos, sin gestión de conexiones ni VPC.
- Escala con el pico sin intervención.
- **Escritura transaccional**: documento, campos y evento de auditoría entran juntos o no entra ninguno. Un documento nunca queda a medio escribir.
- El TTL nativo limpia solo los candados y los intents abandonados.

**Malas, y hay que decirlas**

- **No hay consultas ad-hoc.** Un patrón de acceso nuevo puede exigir un GSI nuevo, o una migración. Es el precio real de esta decisión.
- **El diseño de tabla única tiene una curva de aprendizaje empinada.** Un desarrollador que llega no entiende la tabla mirándola: necesita este documento. Por eso los constructores de clave viven en un único sitio (`shared/ddb.ts`).
- **Un `Put` reemplaza el ítem entero.** Es la trampa clásica, y aquí se materializó: la persistencia de la decisión hacía `Put` sobre el documento y se llevaba por delante `fileName`, `s3Key`, `createdAt` y `uploadedBy`, que escribió otro paso. Ahora es un `Update`.
- Sin agregaciones: "cuántos documentos rechazados este mes" no es una consulta, es una métrica de CloudWatch o un proceso aparte.

## Cuándo revisaría esta decisión

- **Búsqueda por texto libre dentro de los documentos.** Es la petición de producto más probable. No cambiaría de base de datos: añadiría **OpenSearch alimentado por DynamoDB Streams**, dejando DynamoDB como fuente de verdad.
- **Informes analíticos** sobre datos históricos: exportación a S3 y Athena, no un motor OLTP distinto.
- Si aparecieran **más de 3 o 4 patrones de acceso nuevos por trimestre**, sería la señal de que el dominio no está tan acotado como creía, y ahí una base relacional empezaría a ganar.
- Si un GSI se **calienta en una partición** (por ejemplo, todos los documentos de un tenant grande en estado `NEEDS_REVIEW`): se ve con las métricas de throttling por índice y se corrige añadiendo un sufijo de dispersión a `GSI1PK`.
