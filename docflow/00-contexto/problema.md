# El problema, los actores y el alcance

## En cinco líneas

Las empresas medianas reciben facturas de sus proveedores en PDF y en papel
escaneado. Alguien las teclea a mano en el ERP: entre 3 y 8 minutos por
documento, con una tasa de error de tecleo que nadie mide pero que aparece en la
conciliación de fin de mes. **DocFlow recibe esos documentos, extrae sus campos,
los valida contra las reglas de negocio del cliente y devuelve un resultado
auditable** — o los manda a una cola de revisión humana cuando no está seguro.

El producto no es "leer facturas con IA". El producto es **una decisión que se
puede defender ante una auditoría seis meses después**.

## Quién lo sufre

| Actor | Qué hace hoy | Qué le duele |
|---|---|---|
| **Administrativo de cuentas por pagar** | Teclea 60–120 facturas al día | Trabajo mecánico; los errores se descubren tarde |
| **Responsable financiero** | Firma pagos | No puede explicar por qué se rechazó una factura sin llamar a quien la tecleó |
| **Auditor (interno o externo)** | Muestrea documentos | Necesita saber de dónde salió cada importe, no que "el sistema lo calculó" |
| **Equipo de integración del cliente** | Conecta el ERP | Necesita una API estable y un contrato de datos, no un CSV |
| **Nosotros (operación)** | Mantenemos el pipeline | Necesitamos saber, por cliente, cuánto cuesta y qué se atasca |

El **proveedor que emite la factura** no es usuario del sistema, pero **sí es
parte del modelo de amenazas**: es quien controla el contenido del documento que
entra en nuestro pipeline. Esa distinción es la que convierte la inyección de
prompts de una curiosidad en un riesgo de primer nivel (ver `03-nfr/seguridad.md`).

## Por qué este dominio y no un CRUD

Cuatro cosas que un CRUD no obliga a resolver y este caso sí:

1. **Un flujo asíncrono que puede fallar a la mitad.** El OCR y la extracción
   tardan segundos o minutos. No hay forma honesta de hacerlo síncrono, así que
   hay que resolver de verdad reintentos, idempotencia, mensajes venenosos y
   estado parcial.
2. **Aislamiento entre clientes sobre datos sensibles.** Una factura lleva
   identificadores fiscales, importes y nombres. Multi-tenancy no es una columna
   `tenant_id`: es una propiedad que hay que poder demostrar.
3. **Un componente probabilístico cuyo resultado hay que poder auditar.** Un
   modelo que extrae campos se equivoca. La pregunta de arquitectura no es cómo
   evitarlo, sino **qué estructura hace que equivocarse sea recuperable**.
4. **Un modelo de costes donde más del 90% de la factura no está en el cómputo.**
   Lambda, DynamoDB y API Gateway son ruido estadístico frente a una sola llamada
   de ML. Eso invierte por completo dónde merece la pena optimizar.

## Alcance

**Dentro:**

- Ingesta de PDF e imagen (JPEG, PNG, TIFF) hasta 20 MB y 50 páginas.
- Clasificación de ruta de procesamiento, extracción estructurada y validación
  por reglas declarativas versionadas por cliente.
- API REST para subir, listar y consultar; UI mínima de revisión.
- Multi-tenancy con aislamiento en dos capas, observabilidad y control de coste.

**Fuera, y a propósito:**

1. **Integración con ERPs concretos.** Exponemos una API y webhooks; no
   construimos conectores. Cada ERP es un proyecto propio y no aporta nada al
   problema de arquitectura.
2. **Corrección de documentos.** No enderezamos escaneos, no rotamos, no
   mejoramos contraste. Si un documento es ilegible, va a revisión humana. El
   preprocesado de imagen es un pozo sin fondo con retorno decreciente.
3. **Flujo de aprobación multinivel.** Devolvemos `APPROVED`, `NEEDS_REVIEW`,
   `REJECTED`, `DUPLICATE` o `QUARANTINED`. Quién aprueba qué, en qué orden y
   con qué delegaciones es lógica del ERP del cliente, no nuestra.

Decir esto en voz alta importa: **el alcance que se descarta con argumento vale
más que el que se acepta sin pensarlo.**

## El recorrido, en una frase

El navegador pide un permiso de subida firmado, sube **directo a S3 sin pasar
por la API**, S3 emite un evento, ese evento entra en una cola que absorbe el
pico, un orquestador procesa el documento paso a paso con reintentos, y el
resultado aterriza en DynamoDB con su rastro de auditoría.
