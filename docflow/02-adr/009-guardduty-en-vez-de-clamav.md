# ADR-009 — GuardDuty Malware Protection for S3 en vez de ClamAV propio

**Estado:** **aceptada pero NO implementada** — deuda declarada · **Código:** ninguno todavía

> Este ADR documenta una decisión tomada y **no ejecutada**. Aparece aquí, y no
> escondida, porque el diagrama y el documento de seguridad hablan de análisis
> antimalware y el código no lo tiene. Un ADR que registra una ausencia vale más
> que una caja de más en el diagrama.

## Contexto

Aceptamos archivos arbitrarios de usuarios externos, y el contenido lo controla
en última instancia **el proveedor que emitió la factura**, que no es usuario
del sistema. Los PDF son un vector de malware clásico. La validación por magic
bytes (`classify.ts`) confirma que un PDF es un PDF; **no** dice que sea inocuo.

## Decisión

Usar **GuardDuty Malware Protection for S3**, que analiza los objetos al subirse
y los etiqueta con el resultado, en vez de operar nuestro propio motor.

El pipeline consumiría el evento de resultado y solo continuaría con los objetos
marcados como limpios; el resto iría a `QUARANTINED`, que es un estado que el
sistema **ya tiene implementado**.

## Alternativas evaluadas

| Opción | Por qué no |
|---|---|
| **ClamAV en una Lambda** | Es la respuesta refleja y tiene un coste oculto grande: las definiciones de virus pesan cientos de MB y **hay que actualizarlas a diario**. Eso implica una capa o un contenedor, un proceso de refresco, y arranques en frío de varios segundos. Se acaba operando un producto de seguridad, que no es nuestro negocio |
| **ClamAV en Fargate** | Resuelve el arranque en frío y añade un servicio de cómputo con red, escalado y parcheo propios, para un sistema que hoy no tiene ninguno |
| **No analizar** | Defendible solo si nunca se sirve el archivo de vuelta. **No es nuestro caso**: la UI de revisión descarga el original |

## Consecuencias

**Buenas**

- Servicio gestionado: sin firmas que actualizar, sin cómputo que operar.
- Se integra con el evento de S3, que es justo donde ya está el disparador.
- El resultado queda como etiqueta del objeto: auditable.

**Malas**

- **Coste por GB analizado**, que a 50 GB/mes es pequeño pero crece con el volumen y es un coste que ClamAV propio no tendría (a cambio de operarlo).
- **Menos control**: no se elige el motor ni se añaden firmas propias.
- **Añade latencia** entre la subida y el inicio del procesamiento.
- Disponibilidad por región: hay que verificarla antes de comprometerse.

## Por qué no está implementado

Prioricé la coherencia del pipeline y de la capa de IA. Es una activación de
consola con coste por GB, y meterla a medias —activarla sin consumir el evento
de resultado— habría sido peor que no tenerla: el diagrama diría que hay
análisis y el pipeline procesaría igual los objetos infectados.

**Mitigación actual, y es parcial:** magic bytes, límite de 20 MB, límite de 50
páginas, y el archivo nunca se ejecuta — solo se lee como datos y se manda a
Bedrock o Textract. El riesgo residual está en la descarga por parte del
revisor.

## Cuándo revisaría esta decisión

- **Antes de producción, sin excepción.** Es requisito de entrada para cualquier cliente con obligaciones de cumplimiento.
- Si el volumen creciera hasta que el coste por GB superase al de operar ClamAV en Fargate (del orden de varios TB/mes).
- Si un cliente exigiera un motor concreto o firmas propias.
- Si se añadiera la descarga del original por API pública, el riesgo sube y esto pasa a bloqueante.
