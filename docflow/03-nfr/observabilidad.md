# Observabilidad

## 1. SLIs y SLOs — pocos y medibles

| SLO | SLI | Objetivo |
|---|---|---|
| Disponibilidad de la API | % de respuestas no-5xx en API Gateway | **99,9% mensual** |
| Latencia de emisión de presigned | p95 de `POST /uploads` | **< 300 ms** |
| Frescura del procesamiento | % de documentos con resultado en < 5 min | **99%** |
| Corrección de extracción | % de documentos resueltos sin intervención humana | **> 95%** |

**Error budget: 0,1% mensual ≈ 43 minutos.**

Y lo que importa más que el número: **qué se hace al agotarlo.** Se congelan las
features y se prioriza fiabilidad hasta recuperar el presupuesto del mes
siguiente. Un error budget sin política de consumo es un número decorativo.

## 2. Alarmas sobre síntomas, no sobre causas

Tres alarmas. Que sean pocas es la decisión: una alarma que suena y no se
atiende entrena al equipo para ignorar todas.

| Alarma | Umbral | Por qué ese umbral |
|---|---|---|
| **DLQ no vacía** | **> 0**, no > 10 | Un solo mensaje ahí es **el documento de un cliente sin procesar**. No hay un número aceptable de clientes ignorados. Es sostenible **porque los errores permanentes no llegan a la DLQ** (van a `QUARANTINED`): si la basura del día a día acabara ahí, este umbral sería insoportable |
| **Antigüedad del mensaje más viejo** | **> 300 s** | El SLO es 5 minutos. Avisa **antes** de incumplirlo, no después. Una alarma que confirma que ya fallaste no sirve para nada |
| **Ejecuciones fallidas de Step Functions** | **> 0** | Los fallos *esperados* no hacen fallar la ejecución: se cierran como `QUARANTINED` o `NEEDS_REVIEW`. Por eso esta alarma significa algo muy concreto: **se rompió algo que el pipeline no supo clasificar — un bug nuestro**. Sin ella ese caso es invisible: no llega a la DLQ (el mensaje se consumió) y no aparece en el backlog |
| **Presupuesto mensual** | Previsión al **80%** | En un sistema con coste por unidad procesada, **el gasto es una señal de salud**: un pico de coste es abuso o un bug |

**Lo que deliberadamente NO tiene alarma:** cold starts, uso de memoria, duración
de invocación, throttles puntuales. Son causas, no síntomas. Si un cold start
hiciera incumplir el SLO, lo detectaría la alarma de frescura.

## 3. Métricas de negocio con EMF

Powertools `Metrics` emite en **Embedded Metric Format**: las métricas viajan
dentro del log estructurado y CloudWatch las extrae, **sin coste de
`PutMetricData`** ni latencia de una llamada extra.

| Métrica | Qué responde |
|---|---|
| `Decision_APPROVED` / `NEEDS_REVIEW` / `REJECTED` | Calidad de la extracción. `NEEDS_REVIEW` **es el coste operativo humano**: si sube, algo cambió |
| `Decision_DUPLICATE` | El cliente está reenviando — y tú ahorrando |
| `Decision_QUARANTINED` | Cambió lo que te mandan |
| `InputTokens` / `OutputTokens` | **Proxy directo del coste.** Detecta abuso y deriva de prompt |
| `DuplicateSuppressed` | **La prueba de que la idempotencia paga.** Está en el dashboard *junto a* los tokens: el ahorro al lado del gasto |
| `TransientFailure` / `PermanentFailure` | Salud de la clasificación de errores |
| `OcrPaginas` | Páginas de Textract facturadas |

## 4. Logs

JSON estructurado con Powertools `Logger`. Campos fijos: `tenant_id`,
`documentId`, `service`, `level`, y el identificador de traza.

**Dos reglas duras:**

1. **Ningún cuerpo de documento en logs.** Ni el texto OCR, ni la respuesta del modelo, ni los campos extraídos. Solo identificadores. Un log con PII es una fuga con retención de 30 días.
2. **El detalle del error va al log; hacia fuera van errores genéricos.** El `Cause` de Step Functions lleva stack traces y nombres de recursos internos: se registra, **nunca se devuelve**.

Retención acotada a **30 días** en todos los grupos, definida en un solo sitio
(`lambda-defaults.ts`) para que "todas las Lambdas tienen retención acotada" sea
una verdad verificable y no una intención.

> Un fallo que anulaba todo esto: en `lambda-defaults.ts`, el spread `...props`
> iba **después** de `environment` y la sobrescribía. Ninguna función recibía
> `POWERTOOLS_SERVICE_NAME` ni `--enable-source-maps`: los logs salían sin
> nombre de servicio y los stack traces apuntaban al bundle minificado. **La
> observabilidad estaba anulada por un orden de dos líneas, y el despliegue
> funcionaba perfectamente.**

## 5. Trazas

`tracing: ACTIVE` en todas las funciones, y `tracingEnabled` en la máquina de
estados. `documentId` como identificador de correlación en toda la cadena.

**Dónde se rompe la cadena, que es lo que hay que saber:**

| Salto | ¿Cubierto? |
|---|---|
| Lambda → Lambda / servicios AWS | ✅ Nativo |
| **Productor → SQS → consumidor** | ✅ Vía el atributo de sistema `AWSTraceHeader` |
| Step Functions → Lambda | ✅ Con `tracingEnabled` |
| **Navegador → API** | ❌ **El eslabón que nadie cubre** |

**El eslabón débil no es la cola: es el navegador.** Ahí hay que inyectar la
correlación desde el cliente, con CloudWatch RUM o una cabecera propia. Nombrar
el eslabón correcto demuestra que se ha instrumentado un sistema de verdad, no
que se ha leído sobre ello.

> El comportamiento exacto de la propagación a través de **EventBridge** lo
> afirmo con menos seguridad que el salto por SQS, que sí está documentado.
> Marcado como supuesto a validar.

## 6. Observabilidad de la capa de IA

SLIs nuevos que son **de calidad, no de disponibilidad** — y esa es la
diferencia: un modelo puede estar 100% disponible y 100% equivocado.

| Señal | Por qué importa |
|---|---|
| Exactitud a nivel de campo contra el conjunto dorado | Detecta regresión de modelo o de prompt |
| % en `NEEDS_REVIEW` | Es el coste operativo humano |
| Tasa de reintento por esquema inválido | Salud del contrato de salida |
| Tokens y coste por documento | Abuso y deriva de prompt |
| Distribución de rutas R1/R2/R3 | **Predice la factura antes de que llegue** |

**Alarmas de calidad:** caída de exactitud contra el conjunto dorado, tasa de
revisión humana fuera de banda, throttling de Bedrock, coste por documento fuera
de banda.

## 7. Preguntas con respuesta corta

**"Tu Lambda funciona pero deja el documento en estado inconsistente. ¿Cómo lo
detectas?"** — No puede ocurrir en la escritura de la decisión: es una
transacción. El caso real es distinto: un documento que se queda en `PENDING`
para siempre porque el evento de S3 nunca llegó. Eso **no** lo detecta ninguna
alarma actual — la cola está vacía y no hay error. Haría falta un chequeo
periódico de documentos en `PENDING` más viejos que el SLO. **Es un hueco
declarado.**

**"La factura se duplica de un mes a otro."** — Primera hipótesis: cambió el mix
de rutas de algún tenant (más escaneos, menos PDFs con texto). Se confirma
comparando la distribución R1/R2/R3 y los tokens por tenant, no en Cost Explorer.

## 8. Lo que falta

- **Sin chequeo de documentos huérfanos** en `PENDING` (el hueco de arriba).
- **Sin CloudWatch RUM**: el eslabón navegador→API está identificado, no cerrado.
- **Sin alarmas de calidad de IA** implementadas: los SLIs están definidos y las métricas se emiten, pero las alarmas sobre exactitud no están creadas.
- **Sin muestreo configurado de X-Ray**: a volumen alto, el coste de trazas crece.
