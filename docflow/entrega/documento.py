# -*- coding: utf-8 -*-
"""Genera el documento de entrega en Word (.docx)."""
import sys
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

ROJO   = RGBColor(0xD9, 0x1E, 0x36)
HONDO  = RGBColor(0x8E, 0x11, 0x22)
TINTA  = RGBColor(0x19, 0x13, 0x17)
TENUE  = RGBColor(0x6E, 0x62, 0x68)
VERDE  = RGBColor(0x0F, 0x7A, 0x49)

SERIF = "Georgia"
SANS  = "Segoe UI"
MONO  = "Consolas"

doc = Document()


# ── utilidades ──────────────────────────────────────────────────────
def sombrear(elemento, hex_color):
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    elemento.append(shd)


def borde_izq(p, hex_color, ancho=18):
    pPr = p._p.get_or_add_pPr()
    pbdr = OxmlElement("w:pBdr")
    b = OxmlElement("w:left")
    b.set(qn("w:val"), "single"); b.set(qn("w:sz"), str(ancho))
    b.set(qn("w:space"), "8"); b.set(qn("w:color"), hex_color)
    pbdr.append(b); pPr.append(pbdr)


def configurar_estilos():
    n = doc.styles["Normal"]
    n.font.name = SERIF; n.font.size = Pt(10.5); n.font.color.rgb = TINTA
    n.paragraph_format.space_after = Pt(7)
    n.paragraph_format.line_spacing = 1.28

    for nombre, tam, color, antes, despues in [
            ("Heading 1", 21, ROJO,  22, 8),
            ("Heading 2", 15, TINTA, 17, 6),
            ("Heading 3", 12, HONDO, 13, 4)]:
        e = doc.styles[nombre]
        e.font.name = SANS; e.font.size = Pt(tam); e.font.bold = True
        e.font.color.rgb = color
        e.paragraph_format.space_before = Pt(antes)
        e.paragraph_format.space_after = Pt(despues)
        e.paragraph_format.keep_with_next = True


def p(texto="", estilo=None, tam=None, color=None, negrita=False,
      cursiva=False, antes=None, despues=None, fuente=None, alineacion=None):
    par = doc.add_paragraph(style=estilo)
    if antes is not None: par.paragraph_format.space_before = Pt(antes)
    if despues is not None: par.paragraph_format.space_after = Pt(despues)
    if alineacion: par.alignment = alineacion
    if texto:
        escribir(par, texto, tam, color, negrita, cursiva, fuente)
    return par


def escribir(par, texto, tam=None, color=None, negrita=False, cursiva=False, fuente=None):
    """Interpreta **negrita** y `código` dentro del texto."""
    import re
    for trozo in re.split(r"(\*\*.+?\*\*|`.+?`)", texto):
        if not trozo:
            continue
        r = par.add_run()
        if trozo.startswith("**") and trozo.endswith("**"):
            r.text = trozo[2:-2]; r.bold = True
        elif trozo.startswith("`") and trozo.endswith("`"):
            r.text = trozo[1:-1]; r.font.name = MONO
            r.font.size = Pt((tam or 10.5) - 1.2); r.font.color.rgb = HONDO
            continue
        else:
            r.text = trozo; r.bold = negrita
        r.italic = cursiva
        if fuente: r.font.name = fuente
        if tam: r.font.size = Pt(tam)
        if color: r.font.color.rgb = color
    return par


def vineta(texto, nivel=0):
    par = doc.add_paragraph(style="List Bullet" if nivel == 0 else "List Bullet 2")
    par.paragraph_format.space_after = Pt(3)
    escribir(par, texto)
    return par


def codigo(lineas, titulo=None):
    if titulo:
        par = p(titulo, tam=8.5, color=TENUE, negrita=True, fuente=SANS, despues=2)
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    celda = t.cell(0, 0)
    sombrear(celda._tc, "F4F1F2")
    celda.paragraphs[0].text = ""
    for i, linea in enumerate(lineas):
        par = celda.paragraphs[0] if i == 0 else celda.add_paragraph()
        par.paragraph_format.space_after = Pt(0)
        par.paragraph_format.line_spacing = 1.12
        r = par.add_run(linea)
        r.font.name = MONO; r.font.size = Pt(8.2); r.font.color.rgb = TINTA
    p(despues=6)


def cita(texto, rotulo=None):
    if rotulo:
        par = p(rotulo, tam=7.8, color=ROJO, negrita=True, fuente=SANS, despues=2)
        borde_izq(par, "D91E36")
        par.paragraph_format.left_indent = Cm(0.4)
    par = p(texto, cursiva=True, tam=10.5)
    borde_izq(par, "D91E36")
    par.paragraph_format.left_indent = Cm(0.4)
    par.paragraph_format.space_after = Pt(10)


def tabla(cabeceras, filas, anchos=None, tam=9):
    t = doc.add_table(rows=1, cols=len(cabeceras))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, h in enumerate(cabeceras):
        c = t.rows[0].cells[i]
        sombrear(c._tc, "F4F1F2")
        c.paragraphs[0].text = ""
        r = c.paragraphs[0].add_run(h)
        r.bold = True; r.font.size = Pt(tam - 0.5); r.font.name = SANS
        r.font.color.rgb = TENUE
    for fila in filas:
        celdas = t.add_row().cells
        for i, v in enumerate(fila):
            celdas[i].paragraphs[0].text = ""
            celdas[i].paragraphs[0].paragraph_format.space_after = Pt(2)
            escribir(celdas[i].paragraphs[0], v, tam=tam)
    if anchos:
        for fila in t.rows:
            for i, a in enumerate(anchos):
                fila.cells[i].width = Cm(a)
    p(despues=8)
    return t


def adr(num, titulo, contexto, decision, alternativas, consecuencias, revisar):
    doc.add_heading("ADR-%s · %s" % (num, titulo), level=3)
    for etiq, cuerpo in [("Contexto", contexto), ("Decisión", decision)]:
        par = doc.add_paragraph(); par.paragraph_format.space_after = Pt(5)
        r = par.add_run(etiq + ". "); r.bold = True; r.font.name = SANS
        r.font.size = Pt(9.5); r.font.color.rgb = HONDO
        escribir(par, cuerpo)
    par = doc.add_paragraph(); par.paragraph_format.space_after = Pt(3)
    r = par.add_run("Alternativas evaluadas."); r.bold = True; r.font.name = SANS
    r.font.size = Pt(9.5); r.font.color.rgb = HONDO
    for a in alternativas:
        vineta(a)
    par = doc.add_paragraph(); par.paragraph_format.space_after = Pt(3)
    r = par.add_run("Consecuencias."); r.bold = True; r.font.name = SANS
    r.font.size = Pt(9.5); r.font.color.rgb = HONDO
    for c in consecuencias:
        vineta(c)
    par = doc.add_paragraph(); par.paragraph_format.space_after = Pt(12)
    r = par.add_run("Cuándo revisaría esto. "); r.bold = True; r.font.name = SANS
    r.font.size = Pt(9.5); r.font.color.rgb = ROJO
    escribir(par, revisar)


# ════════════════════════════════════════════════════════════════════
configurar_estilos()
sec = doc.sections[0]
sec.top_margin = Cm(2.2); sec.bottom_margin = Cm(2.2)
sec.left_margin = Cm(2.4); sec.right_margin = Cm(2.4)

RUTA = sys.argv[1]

# ── PORTADA ─────────────────────────────────────────────────────────
p(despues=90)
p("MAYA FACT", tam=9, color=ROJO, negrita=True, fuente=SANS, despues=4)
par = p("Ingesta y validación de facturas", tam=30, negrita=True, fuente=SANS, despues=2)
par = p("en una arquitectura AWS-native", tam=30, negrita=True, fuente=SANS, color=ROJO, despues=14)
p("Documento de entrega · caso de evaluación de arquitectura", tam=12, color=TENUE, fuente=SANS, despues=40)

p("Contiene los cuatro entregables solicitados", tam=9, color=TENUE, negrita=True, fuente=SANS, despues=6)
for t in ["1 · Diagrama de arquitectura",
          "2 · Documento de diseño con ADRs",
          "3 · Fragmentos de código comentados",
          "4 · Nota de uso de IA"]:
    p(t, tam=10.5, fuente=SANS, despues=3)

p(despues=30)
par = p("Sistema desplegado, ejecutado y verificado en AWS (us-east-1). "
        "Las cifras de latencia y coste de este documento son medidas, no estimadas.",
        tam=9.5, color=TENUE, cursiva=True)
borde_izq(par, "D91E36")
par.paragraph_format.left_indent = Cm(0.4)

doc.add_page_break()

# ── 0 · EL PROBLEMA ─────────────────────────────────────────────────
doc.add_heading("El problema elegido", level=1)

p("Las empresas medianas reciben facturas de sus proveedores en PDF y en papel escaneado. "
  "Alguien las teclea a mano en el ERP: entre 3 y 8 minutos por documento, con una tasa de "
  "error que nadie mide pero que aparece en la conciliación de fin de mes.")

p("**Maya Fact recibe esos documentos, extrae sus campos, los valida contra las reglas de "
  "negocio del cliente y devuelve un resultado auditable** — o los manda a una cola de revisión "
  "humana cuando no está seguro.")

p("El producto no es «leer facturas con IA». El producto es **una decisión que se puede "
  "defender ante una auditoría seis meses después**.")

doc.add_heading("Por qué este dominio y no un CRUD", level=2)
p("Cuatro cosas que un CRUD no obliga a resolver y este caso sí:")
vineta("**Un flujo asíncrono que puede fallar a la mitad.** El OCR y la extracción tardan "
       "segundos o minutos. No hay forma honesta de hacerlo síncrono, así que hay que resolver "
       "de verdad reintentos, idempotencia, mensajes venenosos y estado parcial.")
vineta("**Aislamiento entre clientes sobre datos sensibles.** Una factura lleva identificadores "
       "fiscales, importes y nombres. Multi-tenancy no es una columna `tenant_id`: es una "
       "propiedad que hay que poder demostrar.")
vineta("**Un componente probabilístico cuyo resultado hay que poder auditar.** Un modelo que "
       "extrae campos se equivoca. La pregunta de arquitectura no es cómo evitarlo, sino qué "
       "estructura hace que equivocarse sea recuperable.")
vineta("**Un modelo de costes donde más del 90% de la factura no está en el cómputo.** Eso "
       "invierte por completo dónde merece la pena optimizar.")

doc.add_heading("Volumetría asumida", level=2)
p("Todas las decisiones de este documento se derivan de estos números. Son supuestos "
  "declarados, no mediciones — pero son consistentes en todo el diseño.")
tabla(["Magnitud", "Valor", "Qué decisión provoca"],
      [["Clientes (tenants)", "40", "Modelo *pool*, no *silo*: 40 stacks no se justifican"],
       ["Documentos / mes", "100.000", "—"],
       ["Páginas / mes", "300.000", "La unidad que factura el OCR y el modelo"],
       ["Tamaño máximo", "20 MB", "No cabe en el límite de 10 MB de API Gateway"],
       ["Páginas máximo", "50", "Control de coste y de memoria"],
       ["Concentración del pico", "40% en 3 días", "Ratio pico/media ~10×"],
       ["p95 subida → resultado", "< 5 min", "Alarma de backlog a 300 s"],
       ["Disponibilidad de la API", "99,9%", "Error budget de 43 min/mes"],
       ["RTO / RPO", "4 h / 5 min", "PITR + IaC, sin multi-región"],
       ["Retención", "90 d / 7 años", "Ciclo de vida de S3, requisito fiscal"]],
      anchos=[4.6, 3.0, 8.4])

doc.add_heading("Alcance descartado, y por qué", level=2)
vineta("**Integración con ERPs concretos.** Exponemos API y webhooks; no construimos "
       "conectores. Cada ERP es un proyecto propio y no aporta nada al problema de arquitectura.")
vineta("**Corrección de documentos.** No enderezamos escaneos ni mejoramos contraste. Si un "
       "documento es ilegible, va a revisión humana. El preprocesado de imagen es un pozo sin "
       "fondo con retorno decreciente.")
vineta("**Flujo de aprobación multinivel.** Devolvemos un estado. Quién aprueba qué, en qué "
       "orden y con qué delegaciones es lógica del ERP del cliente.")

doc.add_page_break()

# ── 1 · DIAGRAMA ────────────────────────────────────────────────────
doc.add_heading("1 · Diagrama de arquitectura", level=1)
p("Dos vistas. La primera muestra los servicios y los límites de confianza; la segunda, el "
  "flujo asíncrono **incluido el camino de fallo**, que es la parte que suele omitirse y la "
  "única que importa durante un incidente.")

doc.add_heading("Vista de despliegue", level=2)
doc.add_picture(RUTA + "/arq-despliegue.png", width=Cm(16.6))
doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
p("Herramienta: diagrama generado con código (matplotlib), versionado junto al repositorio. "
  "Los tres diagramas Mermaid equivalentes viven en `01-arquitectura/` y se renderizan en GitHub.",
  tam=8.5, color=TENUE, alineacion=WD_ALIGN_PARAGRAPH.CENTER, despues=14)

p("**Las cinco cosas que hay que mirar:**")
vineta("**La flecha gruesa del navegador a S3 no pasa por la API.** El backend firma un "
       "permiso; nunca toca los bytes.")
vineta("**Una sola distribución de CloudFront sirve la UI y la API.** No es estética: una HTTP "
       "API no admite WAF asociado, y ponerla detrás de CloudFront lo recupera. De propina "
       "desaparece el preflight CORS.")
vineta("**La CloudFront Function existe por una razón concreta.** El prefijo `/api` es un "
       "artefacto del navegador; la API no lo conoce. Sin el rewrite, todas las llamadas "
       "devuelven 404 — y el 404 lo devuelve la API, así que se investiga el frontend.")
vineta("**Las flechas punteadas hacia OCR son condicionales, y ahí está el dinero.** Textract "
       "solo se llama cuando el modelo no puede leer el formato o cuando la decisión ya salió "
       "«a revisión». En el resto del volumen no se llama nunca.")
vineta("**Los límites de confianza están dibujados, no implícitos.** El plano de datos no tiene "
       "ninguna entrada desde fuera: solo se alimenta de eventos de S3.")

doc.add_page_break()
doc.add_heading("Flujo asíncrono y camino de fallo", level=2)
doc.add_picture(RUTA + "/arq-flujo.png", width=Cm(16.6))
doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
p(despues=10)

p("**Las cuatro propiedades que este diagrama demuestra:**")
vineta("**Un error permanente no llega a la DLQ.** Un PDF corrupto reintentado tres veces son "
       "tres facturas de OCR y tres entradas de ruido en las métricas. Se consume el mensaje y "
       "el documento va a cuarentena. Verificación directa: se sube un `.txt` renombrado a "
       "`.pdf` y la DLQ debe quedarse vacía.")
vineta("**El documento nunca se pierde.** Cada camino de fallo escribe un estado terminal en "
       "DynamoDB, con su evento de auditoría, y quita el TTL del intent.")
vineta("**El candado de idempotencia se libera si el arranque falla.** Ponerlo antes de "
       "`StartExecution` es correcto; si no se liberase, el reintento se suprimiría como "
       "duplicado y el documento no se procesaría nunca **sin llegar a la DLQ**.")
vineta("**El fallo del OCR degrada la interfaz, no el resultado.** La rama de geometría corre "
       "después de que el documento ya tiene decisión persistida.")

cita("Un estado `Pass` de Step Functions no escribe nada. La primera versión de este pipeline "
     "usaba `Pass` en los caminos de fallo: la ejecución terminaba en SUCCEEDED, el documento se "
     "quedaba en PENDING con su TTL de 24 h y desaparecía al día siguiente. Era pérdida de datos "
     "con aspecto de éxito.", "EL FALLO QUE MÁS ME COSTÓ VER")

doc.add_page_break()

# ── 2 · DISEÑO Y ADRs ───────────────────────────────────────────────
doc.add_heading("2 · Decisiones clave y trade-offs", level=1)
p("Catorce decisiones en formato ADR. Cada una lleva un campo que casi nadie incluye y que es "
  "el que convierte una afirmación en un compromiso: **cuándo la revisaría**.")
p("Se incluyen aquí las ocho que más peso tienen. Las seis restantes (HTTP API, on-demand, "
  "GuardDuty, evals, BDA, sin multi-región) siguen el mismo formato en el repositorio.",
  tam=9.5, color=TENUE)

adr("002", "El archivo sube directo a S3 con un presigned POST",
    "El usuario sube facturas de hasta 20 MB. La forma intuitiva —y la que propone cualquier "
    "borrador— es un endpoint que recibe el archivo, lo valida y lo guarda.",
    "El archivo **nunca pasa por la API**. `POST /uploads` devuelve un presigned POST con "
    "condiciones estrictas: prefijo forzado por tenant, `content-length-range`, `Content-Type` "
    "exacto y expiración de 5 minutos. La clave del objeto la genera el servidor.",
    ["**Subida por la API.** API Gateway tiene un límite duro de 10 MB, en REST y en HTTP API. "
     "Un PDF de 20 MB no cabe: no es cuestión de configuración.",
     "**Presigned URL (PUT).** Funciona, pero solo puede restringir la clave exacta: no admite "
     "`content-length-range` ni condiciones de tipo. No hay forma de impedir que suban 5 GB."],
    ["**A favor:** desaparece el límite de 10 MB; no se paga transferencia ni memoria de Lambda "
     "por mover bytes; **las condiciones las aplica S3**, no nuestro código, así que manipular "
     "el formulario no sirve de nada.",
     "**En contra:** el cliente hace dos llamadas; puede quedar un intent sin archivo (se "
     "resuelve con TTL, y hay que acordarse de **quitarlo** al llegar a estado terminal); el "
     "objeto malicioso existe unos segundos en el bucket antes de validarse."],
    "Si los archivos superasen los 5 GB (multipart con presigned por parte), o si apareciera la "
    "obligación de no persistir jamás cierto contenido: hoy escribimos primero y validamos "
    "después, y esa es la contrapartida honesta de este diseño.")

adr("003", "SQS Standard con idempotencia en los datos, no FIFO",
    "Procesar un documento dos veces cuesta dinero real. Hay que absorber un pico de 10× los "
    "últimos tres días del mes. La respuesta refleja es SQS FIFO «porque garantiza exactly-once».",
    "**SQS Standard.** La garantía de no-duplicación se implementa en la capa de datos con un "
    "candado condicional en DynamoDB (`attribute_not_exists`) sobre una clave derivada del "
    "objeto y su etag, con TTL. Segunda barrera: el nombre de la ejecución de Step Functions es "
    "determinista y el servicio rechaza duplicados.",
    ["**SQS FIFO — rechazada, y la premisa es falsa.** FIFO no da exactly-once de extremo a "
     "extremo: da deduplicación en una ventana de 5 minutos sobre `SendMessage` y orden dentro "
     "de un *message group*. Si el consumidor procesa y muere antes de borrar el mensaje, el "
     "mensaje reaparece. **El reprocesamiento no se elimina: se traslada.** Y el precio son "
     "límites de throughput, justo lo contrario de lo que hace falta con un pico de 10×.",
     "**Powertools Idempotency.** Hace exactamente esto, y bien. No lo uso porque el candado "
     "explícito son quince líneas que puedo defender una a una; en un equipo real, usaría "
     "Powertools."],
    ["**A favor:** deduplica hasta el TTL de 7 días, no 5 minutos; sin límites de throughput; la "
     "clave combina objeto **y etag**, que es la semántica correcta; el mismo mecanismo aplicado "
     "al `sha256` da deduplicación de contenido — un mecanismo, dos beneficios.",
     "**En contra:** una escritura extra por mensaje; sin orden garantizado; **el candado hay "
     "que liberarlo si el arranque falla**, y es la parte más fácil de implementar mal."],
    "Si apareciera un requisito de orden real (notas de crédito que deban aplicarse tras su "
    "factura). Incluso entonces lo intentaría primero con una máquina de estados por documento. "
    "Y si el equipo creciera, cambiaría el candado a mano por Powertools, para que la garantía "
    "no dependa de que todo el mundo entienda la sutileza.")

adr("004", "Step Functions orquesta; SQS es el amortiguador",
    "El enunciado pide un flujo asíncrono desacoplado con SQS. El pipeline tiene seis pasos "
    "lógicos y va a tener más. El patrón que sale solo es encadenar Lambdas con colas.",
    "**Las dos cosas, con papeles distintos.** SQS amortigua el pico y limita la concurrencia "
    "(`maxConcurrency: 20`). Step Functions **Standard** orquesta los pasos dentro de cada "
    "documento. El consumidor de la cola es un portero, no un trabajador.",
    ["**Cinco Lambdas con cinco colas.** Cumple el enunciado al pie de la letra y es peor: "
     "obliga a reimplementar retry, backoff y compensación en cada función, y **destruye la "
     "visibilidad del estado del documento**.",
     "**Step Functions Express.** Descartada por dos razones concretas: solo admite "
     "integraciones petición-respuesta, y su historial no es consultable por API.",
     "**Step Functions sin SQS.** Un salto menos, pero se pierde el amortiguador: en el pico se "
     "arrancarían 40.000 ejecuciones contra los límites de Bedrock."],
    ["**A favor:** retry declarativo con jitter sin escribir control de flujo; `addCatch` da "
     "degradación elegante real; el estado del documento se ve sin correlacionar logs.",
     "**En contra:** un servicio más que conocer, y su lenguaje de estados tiene aristas que "
     "fallan en ejecución, no al desplegar; Standard cobra por transición (~25 $/mes aquí, pero "
     "crece con cada estado); **un `Pass` no escribe nada**, y esa trampa costó cara."],
    "Si el pipeline bajara a dos pasos, o si el coste por transición pasara a ser significativo "
    "(a partir de ~2 millones de documentos/mes), evaluaría Express anidado dentro de la "
    "máquina Standard.")

adr("005", "DynamoDB con diseño de tabla única",
    "Hay que guardar documentos, campos extraídos, eventos de auditoría, candados de "
    "idempotencia y registros de deduplicación.",
    "Una sola tabla, con las claves derivadas de **seis patrones de acceso declarados primero**. "
    "El tenant es siempre el principio de la clave de partición — eso no es organización: es la "
    "primera capa de la defensa contra IDOR.",
    ["**Aurora Serverless v2.** Es la pregunta obvia y merece respuesta seria: mis patrones de "
     "acceso son seis, los conozco todos y ninguno hace joins ni agregaciones ad-hoc. Aurora "
     "aportaría flexibilidad que no necesito a cambio de capacidad mínima facturada, gestión de "
     "conexiones desde Lambda y una VPC con sus NAT Gateways.",
     "**Varias tablas.** Perdería la escritura transaccional de documento + campos + auditoría.",
     "**DynamoDB + OpenSearch desde el día 1.** No hay ningún patrón de búsqueda por texto libre "
     "en la lista. Añadir un cluster para un requisito que no existe es sobreingeniería."],
    ["**A favor:** latencia predecible sin gestión de conexiones ni VPC; escala con el pico; "
     "escritura transaccional; el TTL limpia solo los candados.",
     "**En contra:** no hay consultas ad-hoc — un patrón nuevo puede exigir un GSI nuevo; la "
     "curva de aprendizaje es empinada y la tabla no se entiende mirándola; **un `Put` reemplaza "
     "el ítem entero**, trampa que se materializó y se corrigió con `Update`."],
    "Búsqueda por texto libre es la petición más probable: no cambiaría de base de datos, "
    "añadiría OpenSearch alimentado por Streams. Si aparecieran más de tres o cuatro patrones "
    "nuevos por trimestre, sería señal de que el dominio no está tan acotado como creía.")

adr("007", "Cognito con el tenant inyectado en el access token",
    "Cada petición tiene que saber, de forma no falsificable, a qué cliente pertenece quien la hace.",
    "Cognito User Pools con un trigger **pre-token-generation V2** que inyecta `tenant_id` y "
    "`roles` en el *access token*. La regla es absoluta: **el tenant sale siempre del token "
    "firmado; nunca del path, del query string ni del body.**",
    ["**IdP externo (Auth0, Okta, Entra).** Mejor modelo de organizaciones y SCIM ya resuelto. "
     "Descartado por coste e integración: el authorizer nativo y los triggers salen gratis en "
     "esfuerzo. Es la alternativa más seria de la lista.",
     "**Autorizador Lambda propio.** Escribir validación de JWT a mano es donde aparecen los "
     "fallos de A07: no verificar `kid` contra JWKS, aceptar `alg: none`, no comprobar `aud`.",
     "**`tenant_id` en el path.** El anti-patrón: convierte el aislamiento en una comprobación "
     "que se puede olvidar en un endpoint."],
    ["**A favor:** el tenant viaja firmado; cero código de validación propio; la regla es "
     "auditable con un `grep`, y el CI la comprueba en cada push.",
     "**En contra:** Cognito tiene un modelo de organizaciones pobre; migrar fuera es doloroso "
     "porque las contraseñas no se exportan; `adminUserPassword` está habilitado a propósito "
     "para poder ejecutar la prueba de aislamiento en vivo, y **en producción se quita**."],
    "En cuanto un cliente enterprise exija SSO con su propio IdP, SCIM, o que un usuario "
    "pertenezca a varios tenants — este último rompe el modelo, porque hoy el atributo es único "
    "e inmutable.")

adr("008", "Aislamiento de tenant reforzado en IAM, con su límite declarado",
    "La primera capa ya existe: el tenant sale del token y forma parte de la clave de "
    "partición. Pero esa capa depende de que el código no tenga bugs.",
    "Una segunda capa en IAM con la condición `dynamodb:LeadingKeys`, y **no** usar "
    "`grantReadData()`, que concede `Query` y `GetItem` sobre toda la tabla. El modificador "
    "`ForAllValues:` no es decorativo: sin él la condición se cumple si *cualquiera* de las "
    "claves encaja, no si encajan todas.",
    ["**STS AssumeRole con tags de sesión.** Daría aislamiento por valor real. Es la solución "
     "correcta y a donde iría; hoy cuesta una llamada a STS por petición y gestión de caché de "
     "credenciales por tenant.",
     "**Cognito Identity Pools.** Aislamiento por valor, pero acopla el frontend a credenciales "
     "de AWS.",
     "**Una Lambda y un rol por tenant.** 40 × 12 = 480 funciones. Inviable operativamente."],
    ["**A favor:** defensa en profundidad real contra el espacio de claves interno; obliga a "
     "nombrar acciones una a una.",
     "**En contra, y hay que decirlo sin esperar a que lo saquen:** con una Lambda compartida el "
     "patrón solo puede ser `TENANT#*`, así que la condición es un límite de **forma** de clave, "
     "no de **valor**. Impide leer las particiones internas o hacer un Scan encubierto, pero no "
     "impide que el tenant A lea al B si el código se equivoca — eso lo impide la clave de "
     "partición."],
    "En cuanto un cliente exija aislamiento demostrable ante un auditor: ahí `TENANT#*` no basta "
    "y hay que ir a credenciales por sesión. Si además exigiera su propia clave KMS o residencia "
    "de datos, el empujón sería hacia el modelo *silo*.")

adr("011", "El clasificador no clasifica documentos: decide rutas de procesamiento",
    "El pipeline canónico de IDP es Textract → modelo. Pero los propios números de AWS lo "
    "contradicen: sobre 100 documentos de 20 páginas, Textract + modelo cuesta 31,36 $ y el "
    "modelo solo, 1,90 $. Y a 300.000 páginas/mes, la elección de API de Textract va de 450 $ a "
    "19.500 $: un factor **43×** dentro del mismo diagrama.",
    "**El OCR no es un requisito: es una compra.** Compra exactamente tres cosas —confianza "
    "calibrada por palabra, coordenadas y un texto reutilizable— y solo se compra donde hacen "
    "falta. R1 (PDF con capa de texto) y R2 (imagen) van directos al modelo; R3 usa Textract. "
    "**R3 se activa después de la decisión, cuando el resultado sale «a revisión»**: solo "
    "entonces sabemos que un humano va a mirar el documento, que es cuando las coordenadas valen "
    "algo. Hay una segunda puerta a R3: TIFF, que el modelo no puede leer.",
    ["**Textract siempre con Forms+Tables:** 19.500 $/mes frente a ~450 $.",
     "**Textract siempre con DetectDocumentText:** ~450 $/mes de OCR que en su mayoría no compra "
     "nada, y encima aplana el layout — una tabla convertida en flujo de líneas pierde la "
     "asociación columna-valor.",
     "**Nunca Textract:** tentador y equivocado. Se pierden coordenadas y confianza calibrada "
     "justo en los documentos que van a revisión, que son los que más las necesitan."],
    ["**A favor:** reduce el componente dominante de la factura en más de un orden de magnitud; "
     "el coste por documento se adapta a lo que el documento necesita; IAM refuerza la decisión "
     "(el rol no puede invocar `AnalyzeDocument`).",
     "**En contra:** cuatro rutas son más superficie de prueba; **la detección de capa de texto "
     "es una heurística sobre bytes en crudo** y falla con PDFs de streams comprimidos (un falso "
     "negativo es más caro, no incorrecto); la re-extracción en R3 se paga dos veces."],
    "Si el porcentaje en revisión superara el ~20%, R3 dejaría de ser la excepción y saldría más "
    "barato pagar Textract de entrada. Y si apareciera un requisito de auditoría con coordenadas "
    "para el 100%, este ADR se invertiría.")

adr("012", "El LLM extrae. El LLM no decide.",
    "Ya que el modelo está leyendo el documento, ¿por qué no pedirle también que diga si la "
    "factura es válida? Un prompt, un paso, menos código. Es la propuesta que aparece sola.",
    "**Separación estricta entre extracción probabilística y validación determinista.** El "
    "modelo extrae campos con valor, valor normalizado, confianza y cita literal. Un motor de "
    "reglas declarativo y versionado por cliente toma la decisión. Una regla es un dato, no código.",
    ["**El LLM decide todo.** Rechazada por las cuatro razones de abajo.",
     "**El LLM decide y el motor audita.** Peor de los dos mundos: se paga la no-determinación y "
     "encima hay que mantener las reglas.",
     "**Reglas en código.** Con 40 clientes y reglas propias, cada cambio sería un despliegue.",
     "**Motor de terceros (Drools, json-rules-engine).** Razonable; descartado porque mi "
     "`RuleExpr` cubre los seis tipos que necesito en ~90 líneas, y una dependencia que evalúa "
     "expresiones arbitrarias sobre datos de usuario es superficie de ataque."],
    ["**A favor, en orden de fuerza:** (1) *Auditabilidad* — «se rechazó por R-002 con estos "
     "valores», no «el modelo lo consideró así». (2) *Reproducibilidad* — se guarda `modelId` + "
     "`promptVersion` + `rulesetVersion` con cada decisión. (3) *Seguridad* — un documento "
     "malicioso puede engañar al extractor, pero **no puede saltarse el motor, porque el motor "
     "no lee el documento**: lee el JSON ya validado. La separación es la mitigación estructural "
     "de la inyección de prompts. (4) *Coste* — un LLM es una forma cara, lenta y no "
     "determinista de sumar.",
     "**En contra:** dos sistemas que mantener y una frontera que respetar; **los bugs del motor "
     "son bugs de decisión de negocio** — una regla que sumaba un array que el extractor "
     "descartaba hizo que el 100% de los documentos saliera rechazado, con `tsc` y `cdk synth` "
     "limpios."],
    "Si apareciera una regla genuinamente semántica que no se puede expresar de forma "
    "determinista. Incluso entonces el modelo devolvería una señal etiquetada que la regla "
    "consume, no una decisión. **Nunca por simplificar el código:** es exactamente el motivo por "
    "el que existe este ADR.")

doc.add_heading("Un corolario que apareció usando el sistema", level=2)
p("Una boleta real de supermercado peruano salió **rechazada**. El motor tenía razón: subtotal "
  "26,65 + impuesto 22,59 no da total 22,59. Pero el documento era válido: imprime "
  "`SUBTOTAL 26,65` para el bruto y `TOTAL DEL VALOR VENTA 22,59` para la base imponible. "
  "**En ese documento las etiquetas mienten y la aritmética no.**")
p("Lo intenté arreglar tres veces con el prompt. Seguía fallando. El error era de planteamiento: "
  "le estaba pidiendo a un modelo probabilístico un número que **se calcula** "
  "(`subtotal = total − impuesto`).")
cita("«El LLM extrae, el LLM no decide» tiene un corolario: el LLM lee lo que hay que leer, y lo "
     "que se puede derivar se deriva de forma determinista. Cada campo que el modelo no tiene "
     "que adivinar es un campo que no puede equivocar.", "LA LECCIÓN")
p("La derivación **no debilita la defensa contra inyección**: exige corroboración de las líneas, "
  "que el atacante no controla junto con el total sin romper algo. Con `total = 0` y líneas de "
  "4.200 no hay corroboración, no se deriva y la regla rechaza igual. Hay tests para ambos casos.")

doc.add_page_break()

# ── 3 · CÓDIGO ──────────────────────────────────────────────────────
doc.add_heading("3 · Fragmentos de código", level=1)
p("Cuatro piezas. La regla que apliqué al elegirlas: **si no lo puedo explicar línea por línea, "
  "no está aquí.**")

doc.add_heading("3.1 · El consumidor: idempotencia y clasificación de errores", level=2)
p("Es la pieza central. Contiene cinco decisiones defendibles: respuesta parcial de lote, "
  "candado de idempotencia con condición y TTL, clasificación transitorio/permanente, liberación "
  "del candado si falla el arranque, y logging estructurado con correlación.")
codigo([
  "export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {",
  "  const batchItemFailures: { itemIdentifier: string }[] = [];",
  "",
  "  for (const record of event.Records) {",
  "    try {",
  "      await processRecord(record);",
  "    } catch (err) {",
  "      if (isTransient(err)) {",
  "        // Reintentable: vuelve a la cola. Tras maxReceiveCount va a la DLQ.",
  "        batchItemFailures.push({ itemIdentifier: record.messageId });",
  "      } else {",
  "        // Permanente: reintentarlo son tres facturas de OCR por nada.",
  "        // Se consume el mensaje y el documento queda en cuarentena.",
  "        logger.error('fallo permanente, no se reintenta', { err });",
  "      }",
  "    }",
  "  }",
  "  // Sin esto, un mensaje malo en un lote de diez reprocesa los diez.",
  "  return { batchItemFailures };",
  "};",
  "",
  "async function processRecord(record: SQSRecord): Promise<void> {",
  "  const { bucket, object } = JSON.parse(record.body).detail;",
  "",
  "  // La clave combina objeto Y etag: re-subir el MISMO contenido no",
  "  // reprocesa; subir contenido distinto sobre la misma clave, sí.",
  "  // Esto sustituye a FIFO y lo hace mejor: FIFO deduplica 5 minutos,",
  "  // esto deduplica hasta el TTL.",
  "  const idemKey = `${object.key}#${object.etag}`;",
  "  try {",
  "    await ddb.send(new PutCommand({",
  "      TableName: TABLE,",
  "      Item: { pk: keys.idemPk(idemKey), sk: 'LOCK',",
  "              expiresAt: ttlIn(7 * 24 * 3600) },",
  "      ConditionExpression: 'attribute_not_exists(pk)',",
  "    }));",
  "  } catch (err) {",
  "    if (err.name === 'ConditionalCheckFailedException') {",
  "      metrics.addMetric('DuplicateSuppressed', MetricUnit.Count, 1);",
  "      return;                      // éxito: ya está hecho",
  "    }",
  "    throw err;",
  "  }",
  "",
  "  try {",
  "    await sfn.send(new StartExecutionCommand({",
  "      stateMachineArn: STATE_MACHINE_ARN,",
  "      name: `${documentId}-${object.etag}`.slice(0, 80),  // 2ª barrera",
  "      input: JSON.stringify({ tenantId, documentId, ... }),",
  "    }));",
  "  } catch (err) {",
  "    if (err.name === 'ExecutionAlreadyExists') return;   // es un éxito",
  "    // EL AGUJERO QUE HAY QUE CERRAR: si el candado se queda puesto,",
  "    // el reintento se suprime como duplicado y el documento NO se",
  "    // procesa nunca — sin llegar a la DLQ, porque parece un éxito.",
  "    await liberarCandado(idemKey);",
  "    throw err;",
  "  }",
  "}",
], "services/src/pipeline/consumer.ts (extracto)")

doc.add_heading("3.2 · La política IAM: aislamiento entre clientes", level=2)
p("Dos líneas que hacen que un bug de código no se convierta en una fuga entre tenants — con "
  "el matiz honesto sobre su alcance real.")
codigo([
  "// NO se usa table.grantReadData(): concede Query y GetItem sobre TODA",
  "// la tabla, sin restricción de partición.",
  "//",
  "// `ForAllValues:` no es decorativo. Sin ese modificador, la condición",
  "// se cumple si CUALQUIERA de las claves pedidas encaja, no si encajan",
  "// todas — es decir, no hace lo que parece que hace.",
  "const tenantScoped = (actions: string[], resources: string[]) =>",
  "  new iam.PolicyStatement({",
  "    actions,",
  "    resources,",
  "    conditions: {",
  "      'ForAllValues:StringLike': {",
  "        'dynamodb:LeadingKeys': ['TENANT#*'],",
  "      },",
  "    },",
  "  });",
  "",
  "getDocument.addToRolePolicy(",
  "  tenantScoped(['dynamodb:GetItem', 'dynamodb:Query'], [table.tableArn]));",
  "",
  "// Bedrock: UN model id, no `*`. Y el detalle que casi siempre está mal:",
  "// `us.amazon.nova-lite-v1:0` NO es un foundation model, es un perfil de",
  "// inferencia entre regiones. Invocarlo exige DOS permisos, y el id del",
  "// modelo base no lleva el prefijo `us.`.",
  "const esPerfil   = /^(us|eu|apac|global)\\./.test(modelId);",
  "const modeloBase = modelId.replace(/^(us|eu|apac|global)\\./, '');",
  "resources: [",
  "  `arn:aws:bedrock:*::foundation-model/${modeloBase}`,",
  "  ...(esPerfil ? [`arn:aws:bedrock:*:*:inference-profile/${modelId}`] : []),",
  "]",
], "infra/lib/api.ts + pipeline.ts (extracto)")

doc.add_heading("3.3 · El modelo de datos: patrones de acceso primero", level=2)
p("Las claves salen de los patrones, no al revés. Si se empieza por la tabla, se acaba haciendo "
  "`Scan`.")
tabla(["#", "Patrón de acceso", "Cómo se resuelve"],
      [["1", "Documento por id, dentro de un tenant", "`pk=TENANT#<tid>`, `sk=DOC#<docId>`"],
       ["2", "Documentos de un tenant por estado, recientes primero",
        "GSI1: `TENANT#<tid>#ST#<estado>` / `<createdAt>#<docId>`"],
       ["3", "Campos extraídos de un documento", "`begins_with(sk, 'DOC#<docId>#FIELD#')`"],
       ["4", "Duplicado por contenido", "`pk=TENANT#<tid>#HASH#<sha256>`"],
       ["5", "Candado de idempotencia", "`pk=IDEM#<clave>` con TTL"],
       ["6", "Auditoría de un documento", "`begins_with(sk, 'DOC#<docId>#EVT#')`"]],
      anchos=[1.0, 6.4, 8.6], tam=8.5)
p("**El tenant es siempre el principio de la clave de partición.** Eso no es organización: es la "
  "defensa contra IDOR, y es lo que hace posible la condición IAM anterior. Una lectura cruzada "
  "no devuelve el ítem de otro cliente: **no lo encuentra**.")
p("Un detalle que salió al usar el sistema: `updatedAt` no estaba proyectado en el GSI1, así que "
  "el listado lo devolvía vacío. La solución no fue ampliar la proyección —cambiar un índice "
  "`INCLUDE` obliga a recrearlo— sino caer en la cuenta de que **el dato ya estaba ahí**: "
  "`gsi1sk` es `<timestamp>#<id>` y las claves del índice se proyectan siempre.",
  tam=9.5, color=TENUE)

doc.add_heading("3.4 · El motor de reglas: lo que no lee el documento", level=2)
p("Una regla es un dato, no código. Y el motor recibe el JSON ya validado contra esquema, nunca "
  "el documento — esa frontera **es** la mitigación de la inyección de prompts.")
codigo([
  '{',
  '  "id": "R-002",',
  '  "descripcion": "Subtotal más impuesto debe igualar el total",',
  '  "severidad": "BLOCK",',
  '  "mensaje": "Subtotal + impuesto no cuadra con el total ({total})",',
  '  "cuando": { "op": "sum_eq", "campos": ["subtotal", "impuesto"],',
  '              "ref": "total", "tolerancia": 2 }',
  '}',
], "rules/acme-invoices.json (una regla)")
codigo([
  "export function evaluar(extraction: ExtractionResult, ruleSet: RuleSet): Decision {",
  "  const hechos = { fields: extraction.fields, lineas: extraction.lineas };",
  "  const hits = ruleSet.reglas",
  "    .filter((r) => evalExpr(r.cuando, hechos))",
  "    .map((r) => ({ id: r.id, severidad: r.severidad,",
  "                   mensaje: interpolar(r.mensaje, extraction.fields) }));",
  "",
  "  // Compuerta de confianza POR CAMPO, no por documento: equivocarse en",
  "  // el nombre del proveedor y en el importe total no cuestan lo mismo,",
  "  // así que no pueden compartir umbral.",
  "  const camposBajoUmbral = ruleSet.camposCriticos.filter((name) => {",
  "    const f = extraction.fields[name];",
  "    const umbral = ruleSet.umbrales[name] ?? ruleSet.umbrales.default;",
  "    return !f || f.normalized === null || f.confidence < umbral;",
  "  });",
  "",
  "  const status = hits.some((h) => h.severidad === 'BLOCK')",
  "    ? 'REJECTED'",
  "    : camposBajoUmbral.length > 0 || hits.some((h) => h.severidad === 'WARN')",
  "      ? 'NEEDS_REVIEW'",
  "      : 'APPROVED';",
  "",
  "  return { status, hits, camposBajoUmbral, rulesetVersion: ruleSet.version };",
  "}",
], "services/src/pipeline/rules-engine.ts (extracto)")

doc.add_page_break()

# ── 4 · NOTA DE IA ──────────────────────────────────────────────────
doc.add_heading("4 · Nota de uso de IA", level=1)

doc.add_heading("La distinción, antes que nada", level=2)
p("Hay **dos usos de IA** en este trabajo y no son lo mismo. Confundirlos es el error que hace "
  "que esta sección no aporte nada.")
tabla(["", "Qué es", "Dónde se documenta"],
      [["**IA como herramienta**", "Claude Code ayudándome a diseñar, revisar y escribir el repositorio",
        "**Esta sección**"],
       ["**IA dentro del producto**", "Bedrock extrayendo campos de una factura en producción",
        "ADR-011, 012, 013, 014"]],
      anchos=[4.0, 7.4, 4.6])
p("La primera es una elección de método: si mañana dejo de usarla, el sistema funciona igual. La "
  "segunda es una **dependencia en producción** con su coste, su modo de fallo, su superficie de "
  "ataque y su plan de migración.")
p("**Herramienta utilizada:** Claude Code (Opus), con acceso al repositorio, a la CLI de AWS y "
  "al navegador para verificar el despliegue.", tam=9.5, color=TENUE)

doc.add_heading("Caso 1 · «Usa SQS FIFO para no procesar dos veces»", level=2)
p("**Qué pedí:** una cola que absorbiera el pico sin que un documento se procesara dos veces.")
p("**Qué propuso:** SQS FIFO con `MessageDeduplicationId`, con el argumento de siempre: «FIFO "
  "garantiza exactly-once».")
p("**Qué hice:** lo descarté y moví la garantía a la capa de datos.")
p("**Por qué:** porque la premisa es falsa. FIFO da deduplicación en una ventana de 5 minutos "
  "sobre `SendMessage`, no exactly-once de extremo a extremo — y si el consumidor muere antes de "
  "borrar el mensaje, el mensaje vuelve igual. **El reprocesamiento no se elimina: se traslada.**")
cita("Este caso es también el que más me hizo desconfiar del resto: la propuesta era fluida, "
     "citaba el parámetro correcto y estaba equivocada en el fondo. A partir de aquí verifiqué "
     "contra documentación oficial cada garantía que se me afirmó.")

doc.add_heading("Caso 2 · «Que el LLM aplique también las reglas de negocio»", level=2)
p("**Qué propuso:** ampliar el prompt para que el modelo devolviera `aprobado: true|false` con "
  "un motivo. Menos código, un solo paso, un solo servicio.")
p("**Qué hice:** lo descarté y construí el motor de reglas determinista del ADR-012.")
p("**Por qué:** auditabilidad, reproducibilidad, coste — y sobre todo seguridad, que es la razón "
  "que la propuesta destruía sin mencionarlo. Fundir extracción y decisión elimina la frontera "
  "que impide que un documento hostil alcance la decisión.")
p("**Es la mejor corrección de la lista porque no es un detalle técnico: es criterio "
  "arquitectónico. La propuesta era más simple y peor.**")

doc.add_heading("Caso 3 · «Textract primero, siempre»", level=2)
p("**Qué propuso:** el pipeline canónico de IDP — `AnalyzeDocument` con FORMS y TABLES, y el "
  "modelo después.")
p("**Qué hice:** invertí la decisión (ADR-011).")
p("**Por qué:** por coste (43× entre APIs de Textract; ~16× entre pasar por OCR o no, según los "
  "propios números de AWS) y por calidad — el OCR de texto plano aplana el layout, y en "
  "documentos con estructura compleja darle la imagen al modelo suele funcionar mejor.")
p("**Y una corrección sobre mi propia corrección:** mi primera versión activaba R3 en el "
  "clasificador, por tipo de documento. La cambié para activarla *después* de la decisión, "
  "cuando el resultado ya salió «a revisión». Comprar OCR antes de saber si alguien va a mirar "
  "el documento es comprar a ciegas.", tam=9.5, color=TENUE)

doc.add_heading("Caso 4 · El bug que rechazaba el 100% de los documentos", level=2)
p("**Qué había:** la regla R-001 sumaba las líneas de detalle. El extractor **descartaba** ese "
  "array antes de llegar al motor, porque no encajaba en la forma de un campo escalar.")
p("**Qué hice:** separé las líneas de los campos escalares y añadí un operador propio.")
p("**Por qué importa más de lo que parece:** la suma daba 0 contra un subtotal que no lo era, "
  "así que la regla `BLOCK` se disparaba **siempre**. Todos los documentos salían rechazados. "
  "El código compilaba, `cdk synth` salía limpio, y el sistema estaba 100% roto en su función "
  "principal.")
p("Es el ejemplo perfecto de por qué el conjunto dorado prueba también el **motor de reglas** y "
  "no solo el modelo: sin un caso que espere `APPROVED`, este fallo no se ve nunca.")

doc.add_heading("Caso 5 · El trigger que TypeScript aceptó y CDK ignoró", level=2)
p("**Qué propuso** (y yo di por bueno): `lambdaTriggers: { preTokenGenerationV2: preToken }`. "
  "Parece correcto: hay una V2 del trigger, y es justo la que hace falta.")
p("**Qué pasó:** `tsc` limpio, `cdk synth` limpio, despliegue correcto — y en el user pool, "
  "`LambdaConfig: {}` vacío. El trigger nunca se conectó, el token salía sin `tenant_id` y "
  "**el control de aislamiento multi-tenant entero no existía**, sin un solo error en ningún sitio.")
p("**Por qué compiló:** `UserPoolTriggers` declara una *index signature* `[trigger: string]` "
  "para permitir triggers personalizados. Su efecto secundario es que cualquier nombre mal "
  "escrito pasa el compilador.")
p("**Qué hice:** `addTrigger(UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, …)` — y un segundo "
  "escalón que solo se ve mirando la plantilla: CDK lo rellena con `LambdaVersion: V1_0`, que "
  "solo alcanza al ID token. Hizo falta bajar al recurso L1 con `addPropertyOverride`.")
cita("El compilador y el sintetizador verifican que el código es coherente, no que hace lo que "
     "crees. La única prueba de que el claim está en el token es leer el token.", "LA LECCIÓN")

doc.add_heading("Dónde la IA sí aportó, sin matices", level=2)
p("Ser honesto en las dos direcciones importa:")
vineta("**Generación de alternativas.** Poner sobre la mesa BDA, Textract+modelo, modelo solo y "
       "OCR barato+modelo en cinco minutos, con sus perfiles de coste, me ahorró horas de "
       "lectura. **Elegir** entre ellas fue mío.")
vineta("**Red team contra mi propio diseño.** Le pedí explícitamente que atacara el presigned "
       "POST. De ahí salieron dos controles que yo no tenía: `content-length-range` y el "
       "`starts-with` sobre `$key`.")
vineta("**Redacción de código mecánico con contrato claro:** los `ConditionExpression`, el "
       "recorrido del árbol de reglas, los tests. Donde el error se detecta con un test, la "
       "aceleración es real y sin riesgo.")

doc.add_heading("Lo que no pude verificar, marcado como supuesto", level=2)
vineta("Los precios de **Bedrock** varían por modelo, región y perfil de inferencia. Los de "
       "**BDA** no pude leerlos en la página de precios: la comparación del ADR-014 se apoya en "
       "un blog, no en una tarifa.")
vineta("El factor **~16×** es sobre documentos de 20 páginas: traslado el orden de magnitud y la "
       "dirección, no el número.")
vineta("La propagación de traza de X-Ray a través de **EventBridge** la afirmo con menos "
       "seguridad que el salto por SQS, que sí está documentado vía `AWSTraceHeader`.")
vineta("**Toda la volumetría es inventada** — pero es consistente en todo el trabajo, y todas "
       "las decisiones se derivan de ella.")

cita("Usé la IA para acelerar la generación de alternativas y para hacer de red team contra mi "
     "propio diseño. Las decisiones y sus consecuencias son mías. Las tres correcciones que más "
     "valen no son de sintaxis: son de criterio —FIFO, el LLM como juez y el OCR por defecto— y "
     "en las tres la propuesta era más simple y peor. Y la lección que me llevo es sobre "
     "verificación: los tres fallos más graves de este trabajo pasaron `tsc` y `cdk synth` "
     "limpios. Ninguno era un error de sintaxis; todos aparecieron al ejecutarlo.",
     "PARA CERRAR")

doc.add_page_break()

# ── ANEXO ───────────────────────────────────────────────────────────
doc.add_heading("Anexo · Verificación y deudas conocidas", level=1)

doc.add_heading("Lo que se probó de verdad", level=2)
p("El sistema se desplegó en `us-east-1` y se ejecutó contra servicios reales. Estas son "
  "mediciones, no estimaciones.")
tabla(["Prueba", "Resultado"],
      [["Despliegue completo", "103 recursos, ~5 min"],
       ["Claim `tenant_id` en el access token", "`{\"tenant_id\":\"acme\",\"roles\":\"reviewer\"}`"],
       ["Subida directa a S3 con presigned POST", "HTTP 204"],
       ["Factura válida → decisión", "**APROBADA en 25–35 s**, ruta R1 (sin OCR)"],
       ["**Inyección de prompts**", "**El modelo NO obedeció.** El PDF ordenaba `total = 0`; "
        "extrajo 4.956,00 → 495600"],
       ["Deduplicación por contenido", "Mismo `sha256` → DUPLICADA, sin volver a llamar a Bedrock"],
       ["`.txt` renombrado a `.pdf`", "CUARENTENA en 25 s, **DLQ vacía**"],
       ["Ejecuciones de Step Functions", "5/5 SUCCEEDED"],
       ["Camino completo por CloudFront", "`/api/documents` sin token → **401, no 404**"],
       ["Coste real medido", "**~0,31 $/día** ocioso; el 95% es el WAF"]],
      anchos=[6.4, 9.6], tam=9)

doc.add_heading("Deudas conocidas", level=2)
p("Escritas por mí, antes de que las encuentren.")
vineta("**En el diseño y no en el código:** GuardDuty Malware Protection y Bedrock Guardrails. "
       "Meterlos a medias habría sido peor que no tenerlos: el diagrama diría que hay análisis y "
       "el pipeline procesaría igual.")
vineta("**La detección de capa de texto es una heurística sobre bytes en crudo.** Falla con PDFs "
       "de streams comprimidos. La decisión de arquitectura no cambia; la implementación pide "
       "una librería de parseo — y esas librerías son justo el riesgo A06 que documento.")
vineta("**No hay detección de documentos huérfanos.** Un documento que se queda en `PENDING` "
       "porque el evento de S3 nunca llegó no dispara ninguna alarma: la cola está vacía, no hay "
       "error y el TTL lo borra. Es la única pérdida de datos posible que hoy nadie ve.")
vineta("**El conjunto dorado tiene 5 casos, no 200.** Suficiente para demostrar que el mecanismo "
       "existe y corre; insuficiente para confiar en el umbral.")
vineta("**El plan de recuperación ante fallo de región no está ensayado.** Un plan sin ensayo es "
       "una hipótesis.")

doc.add_heading("Lo que NO haría, aunque sobrara tiempo", level=2)
p("Esto importa tanto como la lista anterior.")
vineta("**Multi-región activo-activo.** Cuesta el doble todo el año, cambia el modelo de "
       "consistencia y rompería las garantías del candado de idempotencia.")
vineta("**WebSockets.** El sondeo con retroceso resuelve el problema a este volumen.")
vineta("**Optimizar cold starts o provisioned concurrency.** Sería optimizar el 5% de la factura.")
vineta("**Migrar DynamoDB a provisioned.** Todavía no: el criterio está escrito (ratio pico/media "
       "por debajo de 4×) y aún no se cumple.")
vineta("**Añadir OpenSearch.** No hay ningún patrón de búsqueda por texto libre en los "
       "requisitos. Sería sobreingeniería con nombre de servicio.")

doc.save(sys.argv[2])
print("Documento generado:", sys.argv[2])
