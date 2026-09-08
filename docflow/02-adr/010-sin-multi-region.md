# ADR-010 — Sin multi-región activo-activo

**Estado:** aceptada · **Código:** ninguno, y ese es el punto

> El ADR más importante del repositorio es el que documenta algo que **no** hice.

## Contexto

"¿Y si se cae una región?" es la pregunta que todo el mundo hace y casi nadie
cuantifica. La respuesta correcta no empieza por un servicio, empieza por dos
números: **RTO** (cuánto puede estar caído) y **RPO** (cuántos datos puedo
perder).

## Decisión

**Una sola región (us-east-1). Sin réplica activa, sin conmutación automática.**

Objetivos declarados: **RTO 4 horas · RPO 5 minutos**, cubiertos con:

| Mecanismo | Qué protege | Estado |
|---|---|---|
| **PITR de DynamoDB** | Restauración a cualquier segundo de los últimos 35 días | ✅ activado |
| **Versionado de S3** | Recuperación ante borrado o sobrescritura | ✅ activado |
| **Infraestructura como código** | Reconstruir el stack completo en otra región | ✅ `cdk deploy -c region=...` |
| **Replicación entre regiones de S3** | RPO de los documentos ante pérdida de región | ⬜ no activada: se activa el día que el RTO baje |

Con el stack en CDK y los datos en PITR, **redesplegar en otra región es un
comando**. Las 4 horas son holgadas para eso.

## Alternativas evaluadas

| Opción | Coste | Por qué no |
|---|---|---|
| **Activo-activo con Global Tables** | ~2× la factura de datos, más el tráfico entre regiones | Introduce **resolución de conflictos** (last-writer-wins) en un sistema con escrituras condicionales. El candado de idempotencia del ADR-003 **deja de ser fiable** entre regiones: dos escritores en dos regiones pueden ganar la condición a la vez. Multi-región no es "lo mismo, duplicado": es un modelo de consistencia distinto |
| **Activo-pasivo con réplica continua** | ~1,4× | Más razonable, pero exige mantener y **probar** un plan de conmutación. Un failover que no se ensaya no existe |
| **Copias de seguridad a otra región** | ~1,05× | Es hacia donde iría primero si el RTO bajara |

## El argumento honesto

Un fallo de región completa en AWS es un evento **raro** y, cuando ocurre, suele
durar horas, no días. Frente a eso:

- **Cuesta 2× la factura, todo el año, para un evento que puede no ocurrir nunca.**
- **Añade complejidad operativa permanente**, y esa complejidad tiene su propia tasa de fallo. Es perfectamente posible que la probabilidad de romper el sistema *por culpa de* la maquinaria multi-región supere la del fallo que pretende cubrir.
- **Nuestro caso lo tolera.** Es procesamiento asíncrono de facturas, no un sistema de pagos en tiempo real. Si el pipeline está 4 horas parado, los documentos se acumulan en el cliente y se procesan después. Nadie pierde dinero por un retraso de 4 horas en el cierre contable; sí lo pierde por una factura procesada dos veces, y de eso sí me protejo (ADR-003).

## Consecuencias

**Buenas**

- La mitad de coste y una fracción de la complejidad.
- El modelo de consistencia sigue siendo el de una sola región: las escrituras condicionales significan lo que dicen.
- Los objetivos están **declarados y son medibles**, no implícitos.

**Malas, sin adornos**

- **Un fallo de región completa nos deja fuera hasta 4 horas.** Está aceptado, no ignorado.
- El RPO real de los documentos en S3 ante pérdida de región **no es 5 minutos** mientras no esté la replicación: es "los documentos de esa región". El RPO de 5 minutos hoy solo aplica a los metadatos vía PITR. **Es la parte más débil de este ADR y prefiero decirlo.**
- El plan de recuperación **no está ensayado**. Un plan sin ensayo es una hipótesis.

## Cuándo revisaría esta decisión

- **Si un cliente contrata un SLA con RTO inferior a 1 hora.** Es el disparador más probable, y llegaría por ventas, no por ingeniería.
- Si el sistema pasara a estar en un camino crítico de pagos, donde 4 horas sí cuestan dinero.
- Ante un requisito de **residencia de datos** (un cliente europeo que exija que sus documentos no salgan de la UE): eso no es DR, es multi-región por cumplimiento, y cambia el diseño entero.
- **Primer paso si el RTO baja:** activar replicación entre regiones de S3 y ensayar el redespliegue con `cdk deploy -c region=...` cronometrado. Barato, y convierte las 4 horas de estimación en un número medido.
