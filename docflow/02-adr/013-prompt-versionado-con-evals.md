# ADR-013 — El prompt es código: versión, conjunto dorado y evals en CI

**Estado:** aceptada · **Código:** `evals/run-evals.ts`, `evals/golden-set/casos.json`, `services/src/pipeline/schema.ts`

## Contexto

Un prompt es la lógica de negocio del paso de extracción. Y, sin embargo, lo
habitual es tratarlo como una constante: se edita, se prueba a ojo con dos
documentos, y se despliega.

Hay además un problema que no depende de nosotros: **el modelo puede cambiar
debajo**. AWS documenta un ciclo de vida —`Active`, `Legacy`, `EOL`— y se
compromete a mantener un modelo al menos 12 meses desde su lanzamiento y al
menos 6 meses en `Legacy` antes de retirarlo.

Eso da margen, pero el compromiso es de **aviso, no de compatibilidad**.

## Decisión

**El prompt tiene número de versión, tests de regresión y despliegue
controlado**, igual que la Lambda.

- `PROMPT_VERSION = 'invoice-v3'`, guardado con **cada resultado**.
- **El model id va completo y con versión**, nunca un alias.
- **Conjunto dorado**: documentos reales etiquetados a mano, cubriendo **los casos raros, no los fáciles**.
- **Métrica: exactitud a nivel de CAMPO**, no de documento.
- **Criterio de corte: el PEOR campo**, no la media.
- Ningún cambio de prompt, esquema o modelo se despliega sin superar el umbral.

```bash
MODEL_ID=us.amazon.nova-lite-v1:0 npx tsx evals/run-evals.ts --umbral 0.9
```

### Por qué exactitud por campo y peor caso

*"El 92% de los documentos salieron perfectos"* oculta que fallas
**sistemáticamente** en un campo. Si `proveedor_id_fiscal` sale al 60% y todo lo
demás al 99%, la media queda en 94% y el producto está roto: ese campo es el que
identifica al proveedor.

Por eso el corte es el peor campo. Un campo crítico al 60% hunde el producto
aunque la media salga bien.

### El conjunto dorado prueba también el motor de reglas

Cada caso puede declarar `statusEsperado`. Los cuatro casos actuales incluyen
**un ataque de inyección** (`gold-003`: texto oculto que ordena poner el total a
0, y el esperado sigue siendo el importe real, con status `APPROVED`) y **un caso
de aritmética inconsistente** (`gold-004`, esperado `REJECTED`).

Eso convierte los evals en la prueba de que el ADR-012 **funciona**, no solo de
que está escrito. Sin un caso que espere `APPROVED`, el bug que rechazaba el
100% de los documentos no se detecta nunca.

## Alternativas evaluadas

| Opción | Por qué no |
|---|---|
| **Probar a mano antes de desplegar** | No escala, no es reproducible y no detecta regresiones sutiles |
| **Solo validar el formato de salida** | Confunde "el JSON es válido" con "los datos son correctos". Un JSON perfecto con el importe equivocado pasa |
| **Alias de modelo (`:latest`)** | Es lo cómodo y es lo peligroso: el motor de extracción cambiaría sin que nadie lo decida |
| **Framework de evals de terceros** (Ragas, promptfoo) | Razonable en un equipo. 100 líneas propias que puedo defender valen más aquí, y no añaden dependencia |

## Consecuencias

**Buenas**

- Cambiar de versión de modelo deja de ser un salto sin red: se corre el conjunto dorado y se ve la regresión **antes que el cliente**.
- El trío `modelId` + `promptVersion` + `rulesetVersion` hace cada decisión reproducible.
- **El bucle que cierra el sistema:** cada corrección humana en la cola de revisión es una etiqueta nueva para el conjunto dorado. Es la diferencia entre un sistema que mejora con el uso y uno que se degrada.

**Malas**

- **Correr los evals cuesta dinero**: son invocaciones reales al modelo. Con 200 documentos y ejecución en cada PR, hay que acotar cuándo se corren (en cambios de prompt/esquema/modelo, no en cada commit).
- **Etiquetar 100–200 documentos a mano es trabajo real**, y aburrido, y hay que rehacerlo cuando cambia el esquema.
- Los evals son **no deterministas**: el mismo modelo puede dar resultados distintos. Con `temperature: 0` se reduce, no se elimina. Un umbral demasiado ajustado produce fallos intermitentes que erosionan la confianza en el propio test.
- **Hoy el conjunto dorado tiene 4 casos, no 200.** Suficiente para demostrar que el mecanismo existe y corre; insuficiente para confiar en el umbral. Es una deuda declarada, no un descuido.

## Cuándo revisaría esta decisión

- Cuando el conjunto dorado pase de ~200 casos: haría falta muestreo estratificado por tipo de documento y ejecución nocturna en vez de por PR.
- Si el coste de los evals se acercara al 5% del coste de inferencia en producción: pasaría a un subconjunto de humo por PR y el conjunto completo semanal.
- **Cuando AWS anuncie el paso a `Legacy` del modelo fijado.** Ese es el momento para el que existe todo esto, y el ensayo hay que hacerlo antes.
- Si la tasa de revisión humana subiera sin que los evals lo detectaran: señal de que el conjunto dorado no representa el tráfico real y hay que re-muestrear desde producción.
