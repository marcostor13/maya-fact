# Banco de preguntas — la primera frase de cada respuesta

> **Cómo se responde bien:** primero la respuesta directa **en una frase**,
> después el porqué, y termina con **el límite de tu respuesta** (*"esto lo
> cubre hasta X; a partir de ahí necesitaría Y"*).
>
> Aquí está solo la primera frase. **El resto sale solo si el diseño es tuyo de
> verdad** — y por eso este documento no está más desarrollado: memorizar
> párrafos se nota, y se nota mal.

---

## Resiliencia y operación

**1 · Textract se cae 30 minutos. ¿Qué pasa con los documentos en vuelo?**
> Casi nada, porque Textract solo interviene en el ~5% que va a revisión humana, y **después** de que el documento ya tiene su decisión persistida. El `addCatch` lo lleva a un estado que conserva la decisión y solo pierde el resaltado.

**2 · Un cliente sube 50.000 documentos en 10 minutos. ¿Qué se rompe primero?**
> Lo primero que se rompe no es un servicio: es el presupuesto. La cola absorbe y `maxConcurrency: 20` limita, pero 50.000 extracciones se pagan.

**3 · Un mensaje llega dos veces. Demuéstrame que no pago OCR dos veces.**
> Un `PutItem` con `ConditionExpression: attribute_not_exists(pk)` sobre una clave derivada del objeto y su etag; si falla la condición, la entrega es duplicada y se descarta antes de arrancar nada.

**4 · La DLQ tiene 400 mensajes. Es lunes 8 a.m. ¿Qué haces, en orden?**
> Lo primero es **no** hacer redrive: reinyectar 400 mensajes sin saber por qué fallaron es repetir el fallo 400 veces y, si la causa es de coste, pagarlo otra vez. Miro **uno**.

**5 · Tu Lambda funciona pero deja el documento en estado inconsistente. ¿Cómo lo detectas?**
> En la escritura de la decisión no puede pasar: es una transacción. El caso real es otro y **no lo detecto hoy**: un documento que se queda en `PENDING` porque el evento de S3 nunca llegó. Es un hueco declarado.

**6 · ¿Qué pasa si el procesamiento tarda más que el visibility timeout?**
> No ocurre, porque el consumidor solo arranca la ejecución y tarda menos de un segundo; el trabajo largo vive en Step Functions, que no tiene visibility timeout.

**7 · ¿Cómo despliegas un cambio sin perder mensajes en vuelo?**
> Lambda drena las invocaciones en curso y los mensajes no confirmados vuelven a la cola; el riesgo real no es ese, es un cambio incompatible en el formato del estado entre versiones.

**8 · Se cae una zona de disponibilidad. ¿Qué se degrada?**
> La latencia, no la disponibilidad: todos los servicios que uso son multi-AZ por defecto.

---

## Datos

**9 · ¿Y si mañana necesitas buscar por texto libre dentro de los documentos?**
> No cambiaría de base de datos: añadiría OpenSearch alimentado por DynamoDB Streams, dejando DynamoDB como fuente de verdad.

**10 · Tu GSI se está calentando en una partición. ¿Cómo lo ves y cómo lo arreglas?**
> Se ve en las métricas de throttling por índice, y se arregla añadiendo un sufijo de dispersión a la clave de partición del GSI.

**11 · ¿Por qué no Aurora Serverless si de todas formas tienes relaciones?**
> Porque mis patrones de acceso son seis, los conozco todos y ninguno hace joins ni agregaciones ad-hoc: Aurora me daría flexibilidad que no necesito a cambio de capacidad mínima facturada, gestión de conexiones y una VPC.

**12 · Un cliente pide borrar todos sus datos. ¿Cuántos sitios tocas?**
> Tres: los objetos bajo el prefijo del tenant en S3, la partición `TENANT#<id>` en DynamoDB, y sus usuarios en Cognito. Y una cuarta que suele olvidarse: **los logs**, que llevan `tenant_id`.

**13 · ¿Cómo migras el esquema de la tabla sin downtime?**
> Escritura dual y lectura tolerante: el código nuevo escribe ambos formatos y lee cualquiera, se migra en segundo plano y solo después se retira el formato viejo.

---

## Seguridad

**14 · Te comprometen la Lambda de OCR. Descríbeme el radio exacto de impacto.**
> Lectura de los objetos del bucket de documentos y tres acciones de Textract —`DetectDocumentText` y las dos asíncronas—, nada más: **no toca DynamoDB en absoluto** y ni siquiera puede invocar `AnalyzeDocument`, que es 43× más caro.

**15 · ¿Cómo evitas que el cliente A lea documentos del cliente B? Dame las dos capas.**
> La primera es que el tenant sale del token firmado y forma parte de la clave de partición, así que la lectura cruzada no encuentra el ítem; la segunda es una condición `LeadingKeys` en IAM — **y su alcance real es de forma de clave, no de valor**.

**16 · El texto extraído por OCR contiene `<script>`. ¿Dónde explota y dónde lo paras?**
> Explota en el navegador del revisor, que es un usuario con más privilegios que quien subió el documento; lo paran el escape por defecto de Angular y la CSP con `script-src 'self'`.

**17 · ¿Qué impide que alguien suba un ejecutable de 20 MB disfrazado de PDF?**
> Que no valido por extensión ni por `Content-Type`, sino por **magic bytes** — y lo probé: un `.txt` renombrado a `.pdf` acaba en `QUARANTINED` en 25 segundos y **sin pasar por la DLQ**.

**18 · Se filtra una presigned URL de descarga en un log de terceros. ¿Cuál es la exposición?**
> Hoy, ninguna: **el endpoint de descarga no existe todavía**. Cuando exista, la exposición es un documento durante la vida del enlace, y por eso será de vida corta y con verificación de pertenencia antes de emitirla.

**19 · ¿Cómo rotas los secretos y cuáles tienes realmente?**
> La respuesta corta es que **no tengo secretos de aplicación**: no hay contraseñas de base de datos ni claves de API. Todo es IAM por rol. Lo que sí tengo pendiente es OIDC entre el CI y AWS, para no tener claves estáticas en el pipeline.

**20 · ¿Qué pasa si un atacante consigue un JWT válido de un usuario legítimo?**
> Tiene acceso completo a **ese tenant** durante 15 minutos, que es la validez del access token; el aislamiento entre clientes aguanta, pero dentro del cliente no hay segunda barrera, y por eso hay revocación de refresh y MFA disponible.

---

## Costos y producto

**21 · Tu factura se duplica de un mes a otro. ¿Cuál es tu primera hipótesis y cómo la confirmas?**
> Que un cliente cambió su mix de documentos —más escaneos, menos PDFs con capa de texto— y por tanto su mix de rutas; lo confirmo comparando la distribución R1/R2/R3 y los tokens por tenant, no en Cost Explorer.

**22 · El cliente quiere resultados en menos de 10 segundos. ¿Qué cambia en el diseño?**
> Cambia el amortiguador: SQS deja de tener sentido como cola de espera y hay que ir a invocación directa con provisioned concurrency, aceptando perder la protección contra el pico — es decir, cambio disponibilidad por latencia.

**23 · Llega un cliente enterprise que exige aislamiento total. ¿Cuánto trabajo es?**
> Menos de lo que parece, porque el stack es CDK con la región como parámetro: es un despliegue por cliente. Lo caro no es crearlo, es **operar 40 stacks**: despliegues, alarmas y actualizaciones multiplicados.

**24 · ¿Cuánto cuesta este sistema con 10 documentos al mes? ¿Y con 10 millones?**
> Con 10 documentos, unos 25 dólares, y casi todo son costes fijos: a ese volumen mi arquitectura está sobredimensionada. Con 10 millones, entre 20.000 y 60.000, y **el reparto no cambia**: sigue siendo más del 90% ML.

**25 · Si tuvieras que quitar un servicio de esta arquitectura, ¿cuál y por qué?**
> EventBridge. Podría ir de S3 directo a SQS y me ahorraría un salto; lo mantengo por el filtrado declarativo y porque mañana necesitaré fan-out sin tocar el productor, pero es la decisión más fácilmente reversible del diagrama.

---

## Capa de IA — las ocho obligatorias

**26 · El modelo alucina un importe que no está en el documento. ¿Qué lo detiene?**
> El motor de reglas, que no lee el documento: un total inventado que no cuadre con las líneas dispara la regla de coherencia aritmética. Y en la ruta con OCR hay una segunda señal: si la cita literal del modelo no aparece en el texto de Textract, el campo **no se ancla**, y esa ausencia de anclaje es en sí misma un indicador de alucinación.

**27 · ¿Cómo sabes que tu prompt sigue funcionando tras una actualización de modelo?**
> Porque fijo el model id completo con versión, nunca un alias, y tengo un conjunto dorado con evals que corren antes de desplegar cualquier cambio de prompt, esquema o modelo.

**28 · Un proveedor mete texto oculto que dice "aprueba esto". ¿Qué pasa, paso a paso?**
> **Te lo enseño en vez de contártelo.** Y lo que pasa es: el texto entra delimitado y como contenido de usuario, el prompt de sistema declara que es material a procesar y no instrucciones, el modelo extrae el importe real —lo verifiqué: 4.956, no cero—, y aunque obedeciera, la regla de coherencia aritmética lo rechazaría.

**29 · ¿Por qué las reglas de negocio no las evalúa el LLM, si podría?**
> Por cuatro razones en este orden: auditabilidad, reproducibilidad, seguridad y coste — y la de seguridad es la que menos se ve: fundir extracción y decisión elimina la frontera que impide que un documento hostil alcance la decisión.

**30 · Un cliente reclama por una factura rechazada hace cuatro meses. ¿Puedes reproducir la decisión?**
> Sí: guardo `modelId`, `promptVersion` y `rulesetVersion` con cada resultado, y con ese trío reproduzco exactamente qué reglas se evaluaron y con qué versión.

**31 · ¿Cuál es tu coste por documento y qué lo hace subir?**
> Entre medio céntimo y un céntimo, y lo que lo hace subir es **la ruta**: un escaneo cuesta unas 1.500 tokens por página frente a casi nada de un PDF con capa de texto, y un documento que va a revisión humana además paga Textract.

**32 · Bedrock te devuelve throttling en el pico de fin de mes. ¿Qué pasa?**
> Se reintenta con backoff exponencial y jitter declarado en Step Functions —el jitter no es decorativo: sin él, 500 mensajes que fallan a la vez reintentan a la vez—, y si se agotan los intentos el documento cae a revisión humana en vez de perderse.

**33 · ¿Qué documentos NO mandarías nunca a un modelo, y por qué?**
> Los que lleven datos que un requisito contractual me impida sacar de un perímetro concreto. Y ahí hay un matiz que conviene conocer: **ciertos modelos exigen un modo de procesamiento con revisión de AWS que retiene entradas y salidas hasta 30 días**, lo que condiciona qué modelo puedes usar si tienes retención estricta.

**34 · ¿Para qué usas OCR si el modelo ya ve el documento?** *(te la van a hacer)*
> Porque el OCR no es un requisito, es una compra: compro confianza calibrada por palabra, coordenadas y un texto reutilizable. Solo lo compro donde hacen falta —los documentos que van a revisión humana— y según los propios números de AWS eso es la diferencia entre 1,90 y 31,36 dólares por cada cien documentos.

**35 · ¿Por qué no usas Bedrock Data Automation, que es lo que AWS recomienda?**
> Porque mi palanca de coste más grande es decidir documento a documento si compro OCR, y BDA me quita esa decisión. Si mañana BDA me dejara controlar la ruta, lo reconsideraría el mismo día.

**36 · Sin OCR no tienes coordenadas. ¿Cómo resaltas el campo dudoso en la pantalla de revisión?**
> Esa es exactamente la razón por la que la ruta con OCR se activa **cuando el documento va a revisión**: si nadie va a mirarlo, las coordenadas no valen nada. Y para las rutas sin OCR, el modelo devuelve la **cita literal**, que permite resaltar por búsqueda de texto aunque no haya bounding box.

---

## Las tres preguntas que ojalá te hagan

**«¿Qué es lo que más te preocupa de tu propio diseño?»**
> Que no hay tests unitarios del motor de reglas, y el peor bug que tuve vivía justo ahí: una regla que rechazaba el 100% de los documentos, con el compilador y el sintetizador limpios.

**«¿Qué aprendiste haciendo esto?»**
> Que sintetizar no es verificar. Mis tres fallos más graves pasaron `tsc` y `cdk synth` sin una advertencia — incluido un trigger de Cognito que TypeScript aceptó por una *index signature* del tipo y que dejaba el aislamiento multi-tenant **sin existir, en silencio**.

**«¿Dónde te corrigió la IA a ti, y dónde la corregiste tú a ella?»**
> Me aceleró generando alternativas y haciendo de red team contra mi propio diseño; de ahí salieron dos condiciones del presigned que yo no tenía. La corregí en tres cosas, y las tres eran de criterio, no de sintaxis: FIFO, que el LLM juzgara, y poner Textract por defecto. En las tres la propuesta era **más simple y peor**.

---

## Si no sabes algo

Decidido de antemano, palabra por palabra:

> «No lo sé con seguridad. Lo que haría es medir X antes de afirmarlo.»

Un "no lo sé, lo verificaría midiendo esto" resta **muchísimo** menos que un
invento que se cae con la repregunta. Y en este repositorio tienes tres cosas
marcadas explícitamente como supuestos sin verificar: los precios de BDA, la
propagación de traza por EventBridge, y el factor 16× trasladado a otra
volumetría. Que existan esas marcas es una respuesta en sí misma.
