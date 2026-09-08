# Requisitos y volumetría

> **Los números primero.** Sin volumetría, una arquitectura no se puede evaluar:
> solo se puede opinar sobre ella. Todo lo que hay en `01-arquitectura/` y en
> `02-adr/` se deriva de esta página. Los números son supuestos declarados, no
> mediciones — pero son **consistentes en todo el repositorio**.

## Volumetría

| Magnitud | Valor | De dónde sale |
|---|---|---|
| Clientes (tenants) | 40 | B2B: pocos clientes, muchos documentos cada uno |
| Documentos / mes | 100.000 | ~2.500 por cliente y mes |
| Páginas por documento | 3 de media | Factura con detalle de líneas |
| **Páginas / mes** | **300.000** | La unidad que factura el OCR y el modelo |
| Tamaño medio / máximo | 500 KB / 20 MB | El máximo fija el límite del presigned |
| Páginas máximo por documento | 50 | Límite duro: control de coste y de disponibilidad |
| **Concentración del pico** | **40% del volumen en los últimos 3 días del mes** | Cierre contable |
| Ratio pico / media | **~10×** | Consecuencia directa de lo anterior |

Ese **10×** es el número que más decisiones explica: es la razón de SQS como
amortiguador, de DynamoDB on-demand, de `maxConcurrency: 20` y de la alarma de
antigüedad del mensaje más viejo.

## Requisitos funcionales

| # | Requisito |
|---|---|
| RF-1 | Un usuario autenticado obtiene un permiso de subida y sube un documento **sin que el archivo pase por la API** |
| RF-2 | El sistema valida el archivo por su contenido (magic bytes), no por su extensión ni su `Content-Type` |
| RF-3 | El sistema extrae los campos de la factura y devuelve, por cada uno, valor, valor normalizado, confianza y procedencia |
| RF-4 | El sistema aplica las reglas de negocio **del cliente**, versionadas, y emite una decisión con las reglas que se dispararon |
| RF-5 | Un usuario consulta el estado y el resultado de sus documentos, y solo de los suyos |

## Requisitos no funcionales, cuantificados

Un NFR sin número no es un requisito: es un deseo.

| # | Dimensión | Objetivo | Cómo se mide |
|---|---|---|---|
| NFR-1 | **Latencia de procesamiento** | p95 subida→resultado **< 5 min**; p99 < 15 min | % de documentos con resultado dentro de ventana |
| NFR-2 | **Disponibilidad de la API** | **99,9% mensual** (error budget: 43 min) | % de respuestas no-5xx en API Gateway |
| NFR-3 | **Latencia de la API** | p95 de `POST /uploads` **< 300 ms** | Métrica de API Gateway |
| NFR-4 | **Corrección** | **> 95%** de documentos resueltos sin intervención humana | `APPROVED` / total |
| NFR-5 | **Aislamiento** | **Cero** lecturas entre tenants, verificable | `scripts/probar-aislamiento.sh` debe devolver 404 |
| NFR-6 | **Recuperación** | **RTO 4 h · RPO 5 min** | PITR de DynamoDB + versionado de S3 |
| NFR-7 | **Retención** | 90 días en caliente; **7 años** en archivo (fiscal) | Reglas de ciclo de vida de S3 |
| NFR-8 | **Coste unitario** | **< $0,05 por documento** procesado | Coste mensual / documentos |

## Los dos requisitos que nadie pidió

Y que el sistema necesita:

- **NFR-9 — Trazabilidad de la decisión.** Toda decisión debe ser reproducible
  seis meses después. Se cumple guardando `modelId` + `promptVersion` +
  `rulesetVersion` junto a cada resultado. Sin esto, el producto no se puede
  vender a nadie con obligaciones de auditoría — es un impedimento de venta, no
  una mejora técnica.
- **NFR-10 — Coste atribuible por cliente.** Todo recurso etiquetado
  (`app`, `env`) y las métricas de tokens emitidas por tenant. Sin esto no se
  puede responder "¿cuánto me cuesta este cliente?", que es la pregunta que
  aparece el día que uno de ellos consume el 60% de la factura.

## Cómo se relacionan los números con las decisiones

| Número | Decisión que provoca |
|---|---|
| 20 MB máximo | El límite de 10 MB de API Gateway lo hace imposible → presigned POST (ADR-002) |
| Pico 10× | SQS como amortiguador + DynamoDB on-demand (ADR-004, ADR-006) |
| 300.000 páginas/mes | Un factor 43× entre APIs de Textract mueve la factura de $450 a $19.500 → ADR-011 |
| p95 < 5 min | Alarma de antigüedad del mensaje a 300 s: avisa **antes** de incumplir |
| 50 páginas máximo | Control de *denial of wallet*, no solo de memoria |
| 40 tenants | Modelo *pool*, no *silo*: 40 stacks separados no se justifican (ADR-008) |
