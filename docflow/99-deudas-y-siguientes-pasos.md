# Deudas conocidas y qué haría con dos semanas más

> Escrito por mí, antes de que lo encuentren. Una sección así no me protege de
> las preguntas: cambia de qué van. Deja de ser *"¿te diste cuenta de esto?"* y
> pasa a ser *"¿por qué lo priorizaste así?"*, que es una conversación mucho
> mejor.

## 1. Lo que está en el diseño y NO en el código

Lo peor que puede pasar es que un diagrama prometa un control que el sistema no
tiene. Estos son los que faltan, con su razón:

| Ausencia | Dónde se prometía | Por qué no está |
|---|---|---|
| **GuardDuty Malware Protection for S3** | ADR-009, `seguridad.md` | Activación de consola con coste por GB. Meterlo a medias —activarlo sin consumir el evento de resultado— sería **peor que no tenerlo**: el diagrama diría que hay análisis y el pipeline procesaría igual los objetos infectados |
| **Bedrock Guardrails** (filtro de *prompt attacks*, enmascarado de PII) | `seguridad.md` §3 · **`CLAUDE.md` §2.5** | Las otras cuatro capas están implementadas y son las estructurales. Guardrails es defensa en profundidad, no el control principal. **Es la única regla de `CLAUDE.md` que el código incumple hoy**, y está declarada como tal |
| **CloudTrail** | `CLAUDE.md` §2.10 | Es configuración de cuenta, no del stack. Hay que verificarlo en la cuenta destino, no darlo por hecho |
| **Cuotas por tenant** | `CLAUDE.md` §2.5, OWASP A04 | Hoy el *denial of wallet* lo acotan tres capas (rate limit de WAF, `maxConcurrency`, tope de tokens de entrada) pero **ninguna es por cliente**: un tenant puede consumir el presupuesto de todos |
| ~~OIDC entre CI y AWS~~ | OWASP A08 | ✅ **Implementado**: `infra/lib/cicd.ts` + `.github/workflows/ci-cd.yml` |
| **SBOM y escaneo de dependencias** | OWASP A06 | Sigue pendiente. El pipeline ya existe, así que ahora es añadir un paso |
| **Inferencia por lotes al 50%** | `costos.md`, palanca 5 | Exige separar cola urgente de diferida: es una rama de arquitectura, no un flag |
| **Descarga del documento original** | Implícita en la UI de revisión | El endpoint no existe. Cuando exista: presigned de vida corta y verificación de pertenencia **antes** de emitirla |
| **Notificación por SNS / webhooks** | `diagrama-contexto.md` | La UI hace polling. El fan-out por EventBridge está preparado, no cableado |

## 2. Deudas técnicas dentro del código

**`hasPdfTextLayer` y `countPdfPages` son heurísticas sobre bytes en crudo.**
Buscan operadores `BT`/`Tj` y objetos `/Type /Page` en el PDF sin parsearlo.
Fallan con streams comprimidos y *object streams*, que son mayoría en
generadores modernos. Un falso negativo manda a `R2_VISION` un documento que
podía ir por `R1`: **más caro, no incorrecto**. La decisión de arquitectura
—rutar según haya o no texto— no cambia; la implementación pide una librería.

> Y hay una tensión real aquí: las librerías de parseo de PDF son
> **históricamente el peor barrio del ecosistema** en CVEs, que es justo el
> riesgo A06 que documento. Meter una para mejorar una heurística de coste es un
> intercambio que quiero hacer con SBOM y escaneo en CI ya montados, no antes.

**`LeadingKeys` limita la forma de la clave, no su valor** (ADR-008). Con una
Lambda compartida el patrón solo puede ser `TENANT#*`. El aislamiento por valor
exige credenciales por sesión (STS con tags). La primera capa —la clave de
partición— sigue siendo la que aísla de verdad.

**La re-extracción de R3 se paga dos veces.** Deliberado: solo ocurre en el ~5%
que va a revisión. Pero es un coste que un diseño con clasificación perfecta de
entrada no tendría.

**El anclaje de geometría depende de la cita literal.** Si el modelo parafrasea,
el campo no ancla y queda como `llm_inference`. Es la respuesta correcta —**la
ausencia de anclaje es señal de alucinación**— pero significa que la cobertura
de `bbox` no es del 100% ni lo será.

~~**Sin tests unitarios.**~~ → **Cerrada.** `services/test/rules-engine.test.ts`:
15 tests deterministas que corren sin AWS y sin modelo, así que se ejecutan en
cada push sin coste. Cubren la aritmética, las reglas de formato sobre campos
ausentes, la compuerta de confianza por campo y el escenario de inyección de
prompts. **El primero es el que parece trivial y no lo es**: comprueba que una
factura coherente se apruebe, que es lo único que detecta una regla que se
dispare siempre — el fallo que tuvo este repositorio.

Lo que sigue sin cubrir: el clasificador (`classify.ts`) y el anclaje de
geometría (`ocr.ts`), que necesitan ficheros de prueba binarios.

**El conjunto dorado tiene 4 casos, no 200.** Con 4 casos, un campo pasa del 75%
al 100% con un solo acierto: el umbral no significa gran cosa todavía.

## 3. Huecos de observabilidad

**No hay detección de documentos huérfanos.** Un documento que se queda en
`PENDING` porque el evento de S3 nunca llegó **no dispara ninguna alarma**: la
cola está vacía, no hay error, y el TTL lo borra a las 24 h. Silenciosamente.
Haría falta un chequeo periódico de `PENDING` más viejos que el SLO. Es el hueco
que más me molesta porque es exactamente la clase de fallo que este repositorio
ya tuvo una vez.

**El eslabón navegador → API no está instrumentado.** Identificado, no cerrado.

**Las alarmas de calidad de la IA no existen.** Los SLIs están definidos y las
métricas se emiten; las alarmas sobre exactitud contra el conjunto dorado, no.

## 4. Lo que no está probado

- ~~Nunca desplegado end-to-end~~ → **Desplegado y probado en AWS real**
  (`us-east-1`). Camino feliz `APPROVED` en 35 s, ataque de
  inyección resistido, `.txt` renombrado a `QUARANTINED` con la DLQ vacía,
  deduplicación funcionando. **Y aparecieron tres fallos que `tsc` y `cdk synth`
  no detectaron** — incluido un trigger de Cognito que el compilador aceptó por
  una *index signature* y que dejaba el aislamiento multi-tenant sin existir.
  Es la mejor prueba de que sintetizar no es verificar.
- **Probado con un solo tipo de documento y un solo tenant.** No hay prueba
  multi-tenant real (dos usuarios, dos tenants) más allá del script de
  aislamiento, ni con facturas reales de proveedores distintos.
- El plan de recuperación ante fallo de región **no está ensayado**. Un plan sin
  ensayo es una hipótesis.
- El comportamiento bajo el pico real de 10× está **razonado, no medido**.
- Sin pruebas de carga ni de caos.

## 5. Supuestos marcados, no verificados

- Los precios de **Bedrock** varían por modelo, región y perfil de inferencia. Los de **BDA** no pude leerlos en la página de precios: la comparación del ADR-014 se apoya en un blog, no en una tarifa.
- El factor **~16×** es sobre documentos de 20 páginas: traslado el orden de magnitud y la dirección, no el número.
- La propagación de traza de X-Ray a través de **EventBridge y Step Functions** la afirmo con menos seguridad que el salto por SQS, que sí está documentado vía `AWSTraceHeader`.
- **Toda la volumetría es inventada** — pero es consistente en todo el repositorio, y todas las decisiones se derivan de ella.

## 6. Con dos semanas más, en este orden

**Semana 1 — hacer que lo que hay sea de fiar**

1. ~~Desplegarlo de verdad~~ ✅ · ~~Tests del motor de reglas~~ ✅ · ~~Pipeline de CI con OIDC~~ ✅
2. **Detección de documentos huérfanos.** Cierra el agujero silencioso: hoy es la única pérdida de datos posible que ninguna alarma ve.
3. **GuardDuty Malware Protection**, con el evento consumido.
4. **Tests del clasificador y del anclaje de geometría**, con ficheros de prueba binarios.
5. **SBOM y escaneo de dependencias** en el pipeline, que ya existe.

**Semana 2 — cerrar la distancia con producción**

6. **Conjunto dorado a 100 casos** con documentos reales.
7. **Bedrock Guardrails** y captura de las correcciones humanas como etiquetas.
8. **Endpoint de descarga** con presigned de vida corta.
9. **Sustituir la heurística de PDF** por una librería, con SBOM ya montado.
10. **Ensayar el redespliegue en otra región**, cronometrado, para convertir el RTO de 4 h de estimación en medición.

## 7. Lo que NO haría, aunque sobrara tiempo

Y esto importa tanto como la lista de arriba:

- **Multi-región activo-activo.** ADR-010: cuesta el doble, cambia el modelo de consistencia y rompe las garantías del candado de idempotencia.
- **WebSockets** para notificar. El polling con backoff resuelve el problema a este volumen.
- **Optimizar cold starts o provisioned concurrency.** Sería optimizar el 5% de la factura.
- **Migrar DynamoDB a provisioned.** Todavía no: el criterio está escrito (ratio pico/media < 4×) y aún no se cumple.
- **Añadir OpenSearch.** No hay ningún patrón de búsqueda por texto libre en la lista de requisitos. Sería sobreingeniería con nombre de servicio.
