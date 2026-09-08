# ADR-014 — Pipeline propio en vez de Bedrock Data Automation

**Estado:** aceptada · **Código:** todo `services/src/pipeline/`

> Este ADR descarta **lo que AWS recomienda explícitamente** para este caso de
> uso. Por eso tiene que estar mejor argumentado que el resto.

## Contexto

**Bedrock Data Automation (BDA)** es el servicio gestionado de AWS para
procesamiento inteligente de documentos. Hace, de fábrica, casi todo lo que
construimos: extracción estructurada, *bounding boxes*, confianza, y
**blueprints** que permiten definir el esquema en lenguaje natural.

En el blog oficial de IDP, AWS lo recomienda como la opción por defecto. En la
comparación de costes queda en medio: $20,11 por 100 documentos de 20 páginas,
frente a $31,36 de Textract+modelo y $1,90 del modelo solo.

## Decisión

**Pipeline propio** con Bedrock Converse, motor de reglas propio y clasificador
propio.

## Las razones, y son tres

**1. Control del punto de decisión de coste.** La palanca del ADR-011 —decidir,
documento a documento, si se compra OCR— es *mi* decisión sobre *mi* clasificador.
Con BDA, el procesamiento interno es del servicio: se paga su precio por página
y no se puede decir "este documento no necesita geometría". **Estaría regalando
la palanca más grande de mi arquitectura.**

**2. La frontera del ADR-012.** BDA devuelve resultados extraídos; el motor de
reglas seguiría siendo mío. Pero la separación *"el modelo no ve las reglas y las
reglas no ven el documento"* es más difícil de demostrar cuando el extractor es
una caja negra gestionada. Y esa demostración es mi mitigación de inyección de
prompts.

**3. Reproducibilidad.** El trío `modelId` + `promptVersion` + `rulesetVersion`
(ADR-013) exige fijar la versión del modelo. Con BDA, el modelo subyacente y su
versión los elige AWS. **No puedo prometer a un auditor que reproduzco una
decisión de hace seis meses si no controlo el motor que la produjo.**

## Alternativas evaluadas

| Opción | A favor | Por qué no |
|---|---|---|
| **BDA con blueprints** | Menos código, bboxes y confianza de fábrica, mantenido por AWS | Las tres razones de arriba. Y una práctica: su **disponibilidad regional es más limitada**, lo que condiciona dónde puedo desplegar |
| **Textract Analyze Expense** | Especializado en facturas, campos normalizados | $10/1.000 páginas (~$3.000/mes) y **encadena al esquema de AWS**: si un cliente necesita un campo propio, no hay dónde ponerlo |
| **Servicio de terceros** (Rossum, Klippa) | Producto terminado | Los documentos salen de nuestra cuenta. Con PII y datos fiscales, es una conversación de cumplimiento que no quiero tener en la v1 |

## Consecuencias

**Buenas**

- Control total sobre la ruta, el coste y el modelo.
- La decisión de coste vive en nuestro código, donde se puede medir y cambiar.
- Sin dependencia de la disponibilidad regional de un servicio nuevo.
- Portabilidad: cambiar de modelo es una variable de entorno más un paso por los evals.

**Malas, y hay que reconocerlas**

- **Mantenemos código que AWS mantendría por nosotros.** El clasificador, el anclaje de geometría, el manejo del OCR asíncrono: todo eso es nuestro, con nuestros bugs.
- **La heurística de detección de capa de texto es peor que la de BDA**, casi con seguridad. BDA no tendría el problema de los PDFs con streams comprimidos.
- **Hemos reimplementado cosas que BDA da hechas**: bounding boxes, confianza por campo, normalización.
- BDA mejora con el tiempo sin que hagamos nada. Nuestro pipeline solo mejora si trabajamos.
- **No pude leer los precios por página de BDA** en la página oficial de precios. Mi comparación se apoya en un blog, no en una tarifa. Lo marco como supuesto.

## Cuándo revisaría esta decisión

- **Si BDA expusiera control sobre la ruta de procesamiento** (poder decirle "para este documento no necesito geometría"). Eso eliminaría la razón #1, que es la más fuerte.
- Si BDA permitiera **fijar y consultar la versión del modelo** subyacente: caería la razón #3.
- Si el coste de mantener este pipeline —medido en horas de incidencias— superara la diferencia de precio. **Con un equipo de una persona, ese umbral llega antes de lo que parece.**
- Al añadir un **tipo de documento nuevo** (contratos, albaranes): si construir un clasificador y un esquema propios por tipo se vuelve repetitivo, los *blueprints* en lenguaje natural de BDA empiezan a ganar por velocidad de entrega.

## La frase para la defensa

> Descarto BDA sabiendo que es lo que AWS recomienda. Lo descarto porque mi
> palanca de coste más grande es decidir documento a documento si compro OCR, y
> BDA me quita esa decisión. Si mañana BDA me dejara controlar la ruta, lo
> reconsideraría el mismo día: estaría cambiando código propio por código
> mantenido sin perder nada.
