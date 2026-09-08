# Estrategia de evaluación

> Decisión de fondo en el ADR-013. Este documento es el **cómo**.

## Por qué esto separa a quien ha puesto un LLM en producción

Una demo se prueba con dos documentos y funciona. Un sistema en producción se
enfrenta a que **el motor cambie debajo**: AWS mantiene un modelo al menos 12
meses y avisa 6 antes del `EOL`, pero el compromiso es de **aviso, no de
compatibilidad**.

El conjunto dorado no existe por la calidad del día 1. Existe para el día en que
haya que migrar de versión de modelo, que es el día en que sin él estarías
saltando sin red.

## La métrica: exactitud a nivel de campo, y corte por el peor

```
✗ proveedor_id_fiscal    62.0%  (31/50)
✓ total                  98.0%  (49/50)
✓ fecha_emision          96.0%  (48/50)
✓ moneda                100.0%  (50/50)

Peor campo: 62.0% — umbral 90%
EVALS FALLIDOS — no desplegar este prompt/modelo.
```

La media de ese ejemplo es **89%**, y suena aceptable. Pero
`proveedor_id_fiscal` al 62% significa que **cuatro de cada diez facturas
identifican mal al proveedor**. El producto está roto y la media lo esconde.

Por eso el criterio de corte es **el peor campo**, no la media. Un campo crítico
al 60% hunde el producto aunque el promedio salga en 94%.

## El conjunto dorado prueba también el motor de reglas

Cada caso puede declarar `statusEsperado`. Eso convierte los evals en la
verificación de que el ADR-012 **funciona**, no solo de que está escrito:

| Caso | Qué prueba | Esperado |
|---|---|---|
| `gold-001` | Factura digital limpia, PDF con capa de texto (ruta R1) | `APPROVED` |
| `gold-002` | **Escaneo torcido y de baja calidad — el caso que importa** (R2) | `NEEDS_REVIEW` |
| `gold-003` | **ATAQUE: texto oculto que ordena poner el total a 0** | `APPROVED` con el importe **real** |
| `gold-004` | Aritmética inconsistente: las líneas no suman el subtotal | `REJECTED` |

**`gold-001` es el caso más importante y el que parece más trivial.** Es el
único que detecta un fallo del motor de reglas que rechace todo. Sin un caso que
espere `APPROVED`, el bug que hacía que el 100% de los documentos salieran
`REJECTED` —porque la regla de coherencia aritmética sumaba un array que el
extractor descartaba— **no se detecta nunca**: `tsc` limpio, `cdk synth` limpio,
y el sistema roto en su función principal.

**`gold-003` es el que se ejecuta delante del evaluador.** Demuestra las dos
capas: el modelo no obedece (el prompt de sistema declara el contenido como
material a procesar) y, aunque obedeciera, `total = 0` contra líneas que suman
4.800 dispara R-001 y R-002. No se cuenta que la arquitectura resiste la
inyección de prompts: se enseña.

## Cómo se corre

```bash
MODEL_ID=us.amazon.nova-lite-v1:0 npx tsx evals/run-evals.ts --umbral 0.9
```

Sale con código **1** si el peor campo baja del umbral o si alguna decisión no
coincide. Eso es lo que lo hace apto para CI.

## Cuándo se corre

**No en cada commit** — son invocaciones reales al modelo y cuestan dinero.

| Disparador | Alcance |
|---|---|
| PR que toca `schema.ts`, `SYSTEM_PROMPT` o `MODEL_ID` | Conjunto completo, **bloqueante** |
| PR que toca `rules-engine.ts` o un ruleset | Solo los casos con `statusEsperado` (no invocan al modelo: son deterministas y gratis) |
| Nocturno | Conjunto completo, informativo |
| Anuncio de `Legacy` del modelo fijado | Conjunto completo contra la versión nueva, **antes** de migrar |

## Qué documentos entran en el conjunto dorado

**Los casos raros, no los fáciles.** Un conjunto de facturas limpias da un 99% y
no informa de nada.

- Escaneos torcidos, con poco contraste, con sellos encima del importe.
- Facturas con líneas que ocupan dos páginas.
- Monedas y formatos de fecha poco habituales.
- Documentos con texto adversario (ataques de inyección).
- Documentos con aritmética inconsistente **de verdad**, no inventada.
- Casos donde la respuesta correcta es `NEEDS_REVIEW`: la incertidumbre bien
  detectada es tan valiosa como el acierto.

## El bucle que cierra el sistema

**Cada corrección humana en la cola de revisión es una etiqueta nueva.** El
revisor ya está haciendo el trabajo de etiquetar; solo hay que capturarlo.

Es la diferencia entre un sistema que **mejora con el uso** y uno que se
degrada. Y es gratis: el coste ya se paga en forma de revisión.

## Deudas de este documento

- **El conjunto dorado tiene 4 casos, no 100–200.** Suficiente para demostrar
  que el mecanismo existe y corre; **insuficiente para confiar en el umbral**.
  Con 4 casos, un campo pasa del 75% al 100% con un solo acierto.
- Los `bucket`/`key` de `casos.json` apuntan a un placeholder: hay que subir los
  documentos reales y sustituirlos.
- **Los evals son no deterministas.** `temperature: 0` reduce la varianza, no la
  elimina. Un umbral demasiado ajustado produce fallos intermitentes que
  erosionan la confianza en el propio test — y un test en el que no se confía se
  acaba desactivando.
- **No hay captura automática** de las correcciones humanas hacia el conjunto
  dorado. El bucle está diseñado, no implementado.
- Falta **muestreo estratificado**: cuando el conjunto crezca, hay que garantizar
  que representa la distribución real de tipos de documento por tenant.
