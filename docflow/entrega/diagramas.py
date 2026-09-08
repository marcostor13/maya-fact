# -*- coding: utf-8 -*-
"""Genera los dos diagramas del entregable como PNG de alta resolucion."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle

ROJO      = "#d91e36"; ROJO_BG  = "#fbeef0"
TINTA     = "#191317"
TENUE     = "#6e6268"
LINEA     = "#cfc3c8"
PANEL     = "#ffffff"
FONDO     = "#f7f5f6"
AZUL      = "#17548f"; AZUL_BG  = "#e9f0f8"
VERDE     = "#0f7a49"; VERDE_BG = "#e8f4ed"
AMBAR     = "#96620a"; AMBAR_BG = "#fbf1e0"

plt.rcParams["font.family"] = "DejaVu Sans"


def caja(ax, x, y, w, h, titulo, sub=None, borde=LINEA, relleno=PANEL,
         color_txt=TINTA, tam=9.5):
    ax.add_patch(FancyBboxPatch((x, y), w, h,
                 boxstyle="round,pad=0,rounding_size=0.05",
                 linewidth=1.2, edgecolor=borde, facecolor=relleno, zorder=3))
    if sub:
        ax.text(x + w/2, y + h*0.62, titulo, ha="center", va="center",
                fontsize=tam, fontweight="bold", color=color_txt, zorder=4)
        ax.text(x + w/2, y + h*0.27, sub, ha="center", va="center",
                fontsize=tam - 2.3, color=TENUE, zorder=4, style="italic",
                linespacing=1.5)
    else:
        ax.text(x + w/2, y + h/2, titulo, ha="center", va="center",
                fontsize=tam, fontweight="bold", color=color_txt, zorder=4)


def zona(ax, x, y, w, h, etiqueta, color=LINEA, guiones=(6, 4), lado="izq"):
    ax.add_patch(Rectangle((x, y), w, h, linewidth=1.3, edgecolor=color,
                 facecolor="none", linestyle=(0, guiones), zorder=1))
    ex = x + 0.6 if lado == "izq" else x + w - 0.6
    ax.text(ex, y + h, etiqueta, ha=lado == "izq" and "left" or "right",
            va="center", fontsize=8, color=color, fontweight="bold", zorder=2,
            bbox=dict(boxstyle="round,pad=0.3", fc=FONDO, ec="none"))


def flecha(ax, p1, p2, color=TENUE, grosor=1.4, curva=0.0, estilo="-", escala=11):
    ax.add_patch(FancyArrowPatch(p1, p2, arrowstyle="-|>", mutation_scale=escala,
                 linewidth=grosor, color=color, zorder=5, linestyle=estilo,
                 connectionstyle="arc3,rad=%.2f" % curva, shrinkA=2, shrinkB=3))


def etiqueta(ax, x, y, texto, color=TENUE, tam=7.4, negrita=False):
    ax.text(x, y, texto, ha="center", va="center", fontsize=tam, color=color,
            zorder=6, fontweight="bold" if negrita else "normal",
            bbox=dict(boxstyle="round,pad=0.25", fc=FONDO, ec="none"))


def codo(ax, pts, color=TENUE, grosor=1.4):
    """Conector en ángulo recto: evita que las flechas crucen cajas."""
    for i in range(len(pts) - 2):
        ax.plot([pts[i][0], pts[i+1][0]], [pts[i][1], pts[i+1][1]],
                color=color, lw=grosor, zorder=5, solid_capstyle="round")
    ax.add_patch(FancyArrowPatch(pts[-2], pts[-1], arrowstyle="-|>",
                 mutation_scale=11, linewidth=grosor, color=color, zorder=5,
                 shrinkA=0, shrinkB=3))


# ══════════════════════════════════════════════════════════════════
def despliegue(destino):
    fig, ax = plt.subplots(figsize=(15.5, 9.2), dpi=170)
    fig.patch.set_facecolor(FONDO); ax.set_facecolor(FONDO)
    ax.set_xlim(0, 100); ax.set_ylim(0, 60); ax.axis("off")

    ax.text(2, 57.6, "Maya Fact · vista de despliegue en AWS", fontsize=15.5,
            fontweight="bold", color=TINTA)
    ax.text(2, 55.6, "Los recuadros discontinuos son límites de confianza. "
                     "La flecha gruesa es la subida directa a S3: el archivo nunca pasa por la API.",
            fontsize=8.8, color=TENUE)

    caja(ax, 2, 43, 11, 5.2, "Navegador", "Angular SPA")

    zona(ax, 16, 40, 23, 10.5, "BORDE · público", color=AMBAR)
    caja(ax, 17.5, 45.5, 9.5, 4.2, "AWS WAF", "3 grupos + rate limit", borde=AMBAR, relleno=AMBAR_BG, tam=8.6)
    caja(ax, 28, 45.5, 9.5, 4.2, "CloudFront", "OAC · cabeceras", borde=AMBAR, relleno=AMBAR_BG, tam=8.6)
    caja(ax, 22.8, 41, 9.5, 3.6, "CF Function", "quita /api", borde=AMBAR, relleno=AMBAR_BG, tam=8.6)

    zona(ax, 41, 3.5, 57, 48, "CUENTA AWS · us-east-1", color=LINEA, lado="der")

    zona(ax, 42.5, 39, 33, 11, "Plano de control · síncrono", color=VERDE, guiones=(3, 3))
    caja(ax, 44, 44.4, 10.5, 4.4, "API Gateway", "HTTP API · JWT", borde=VERDE, relleno=VERDE_BG, tam=8.6)
    caja(ax, 56, 44.4, 8.5, 4.4, "Cognito", "pre-token V2", borde=VERDE, relleno=VERDE_BG, tam=8.6)
    caja(ax, 44, 39.8, 30, 3.6, "λ CreateUpload   ·   λ GetDocument   ·   λ ListDocuments",
         borde=VERDE, relleno=VERDE_BG, tam=8.4)

    caja(ax, 79, 43, 16.5, 6.0, "S3 · documentos", "SSE · versionado · ciclo de vida",
         borde=AZUL, relleno=AZUL_BG, tam=9)

    zona(ax, 42.5, 24.5, 53, 13, "Plano de datos · asíncrono", color=ROJO, guiones=(3, 3))
    caja(ax, 44, 30.5, 11, 4.6, "EventBridge", "filtrado", borde=ROJO, relleno=ROJO_BG, tam=8.6)
    caja(ax, 57, 30.5, 11, 4.6, "SQS Standard", "amortigua 10×", borde=ROJO, relleno=ROJO_BG, tam=8.6)
    caja(ax, 70, 30.5, 10.5, 4.6, "λ Consumer", "idempotencia", borde=ROJO, relleno=ROJO_BG, tam=8.6)
    caja(ax, 82.5, 30.5, 11.5, 4.6, "Step Functions", "STANDARD · 21", borde=ROJO, relleno=ROJO_BG, tam=8.6)
    caja(ax, 57, 25.2, 11, 3.8, "SQS · DLQ", "alarma con 1", borde=ROJO, relleno=PANEL, tam=8.4)

    zona(ax, 42.5, 12.5, 53, 10.5, "Pasos del pipeline", color=LINEA, guiones=(3, 3))
    for i, (t, s) in enumerate([("λ Classify", "decide la RUTA"), ("λ Dedupe", "hash sha256"),
                                ("λ Extract", "Bedrock Converse"), ("λ Decide", "motor de reglas")]):
        caja(ax, 44 + i*12.9, 17.4, 11.6, 4.4, t, s, tam=8.4)
    caja(ax, 44, 13.2, 24.5, 3.6, "λ OcrStart  ·  λ OcrCollect   (solo ruta R3)", tam=8.2)
    caja(ax, 70.5, 13.2, 25, 3.6, "λ Finalize   (cierra estados terminales)", tam=8.2)

    caja(ax, 44, 4.5, 15.5, 5.4, "DynamoDB", "tabla única · GSI1 · PITR", borde=AZUL, relleno=AZUL_BG, tam=9)
    caja(ax, 62, 4.5, 14.5, 5.4, "Bedrock", "1 model id, no *", borde=ROJO, relleno=ROJO_BG, tam=9)
    caja(ax, 79, 4.5, 16.5, 5.4, "Textract", "solo DetectDocumentText", borde=ROJO, relleno=ROJO_BG, tam=9)

    # ── Flechas ──
    flecha(ax, (13, 45.8), (17.5, 47.0)); etiqueta(ax, 15.0, 47.4, "HTTPS")
    flecha(ax, (32.7, 45.5), (32.7, 44.7))
    flecha(ax, (32.3, 42.8), (44, 46.4)); etiqueta(ax, 39.0, 44.0, "api/*")
    flecha(ax, (54.5, 46.6), (56, 46.6))
    flecha(ax, (49.2, 44.4), (49.2, 43.5))

    ax.add_patch(FancyArrowPatch((13, 47.8), (79, 46.5), arrowstyle="-|>",
                 mutation_scale=17, linewidth=3.1, color=ROJO, zorder=6,
                 connectionstyle="arc3,rad=-0.18", shrinkA=3, shrinkB=3))
    ax.text(46, 54.6, "POST directo a S3 con permiso firmado", fontsize=9.2,
            color=ROJO, fontweight="bold", ha="center", zorder=7,
            bbox=dict(boxstyle="round,pad=0.32", fc=FONDO, ec=ROJO, lw=1.1))

    codo(ax, [(87.2, 43), (87.2, 38.6), (49.5, 38.6), (49.5, 35.1)], color=ROJO)
    etiqueta(ax, 70, 38.6, "Object Created", color=ROJO)

    for a, b in [(55, 57), (68, 70), (80.5, 82.5)]:
        flecha(ax, (a, 32.8), (b, 32.8), color=ROJO)
    flecha(ax, (62.5, 30.5), (62.5, 29.0), color=ROJO)
    etiqueta(ax, 68.6, 29.7, "3 intentos", color=ROJO)
    flecha(ax, (88.2, 30.5), (88.2, 23.0), color=ROJO)

    for x, quien in [(51.75, "λ Dedupe · λ Decide"), (69.25, "λ Extract"), (87.25, "λ OcrStart")]:
        flecha(ax, (x, 12.5), (x, 9.9), estilo=":")
        etiqueta(ax, x, 11.2, quien, tam=6.9)

    # ── Leyenda ──
    ax.text(2, 36.5, "LEYENDA", fontsize=8, fontweight="bold", color=TENUE)
    for i, (c, bg, t) in enumerate([(AMBAR, AMBAR_BG, "Borde público"),
                                    (VERDE, VERDE_BG, "Plano de control"),
                                    (ROJO, ROJO_BG, "Plano de datos e IA"),
                                    (AZUL, AZUL_BG, "Persistencia")]):
        ax.add_patch(Rectangle((2, 33.4 - i*2.5), 1.5, 1.5, facecolor=bg, edgecolor=c, linewidth=1.2))
        ax.text(4.2, 34.15 - i*2.5, t, fontsize=8, color=TENUE, va="center")

    ax.text(2, 20.5, "NO HAY, Y ES DELIBERADO", fontsize=8, fontweight="bold", color=TENUE)
    for i, t in enumerate(["VPC ni NAT: nada necesita red privada",
                           "Multi-región: RTO 4 h con PITR + IaC",
                           "WebSockets: sondeo con retroceso basta",
                           "REST API: HTTP API detrás de CloudFront"]):
        ax.text(2, 18.2 - i*2.0, "·  " + t, fontsize=7.6, color=TENUE)

    fig.tight_layout(pad=0.4)
    fig.savefig(destino, facecolor=FONDO, bbox_inches="tight")
    plt.close(fig)
    print("  ", destino)


# ══════════════════════════════════════════════════════════════════
def flujo(destino):
    fig, ax = plt.subplots(figsize=(15.5, 9.8), dpi=170)
    fig.patch.set_facecolor(FONDO); ax.set_facecolor(FONDO)
    ax.set_xlim(0, 100); ax.set_ylim(0, 64); ax.axis("off")

    ax.text(2, 61.4, "Maya Fact · flujo asíncrono, con el camino de fallo",
            fontsize=15.5, fontweight="bold", color=TINTA)
    ax.text(2, 59.4, "Ningún fallo pierde el documento: cada camino escribe un estado terminal. "
                     "Un error permanente NO llega a la DLQ.", fontsize=8.8, color=TENUE)

    y = 49.5
    for i, (t, s) in enumerate([("Clasificar", "magic bytes · sha256\npáginas · ¿capa de texto?"),
                                ("Deduplicar", "ConditionExpression\nsobre el hash"),
                                ("Extraer", "Bedrock Converse\nsalida por esquema"),
                                ("Decidir", "reconciliar + reglas\ntransacción")]):
        x = 4 + i*19
        caja(ax, x, y, 16, 7.2, t, s, borde=ROJO if i in (0, 3) else LINEA,
             relleno=ROJO_BG if i in (0, 3) else PANEL, tam=10.5)
        if i < 3:
            flecha(ax, (x + 16, y + 3.6), (x + 19, y + 3.6))

    caja(ax, 80, y, 16, 7.2, "APROBADA", "estado terminal", borde=VERDE,
         relleno=VERDE_BG, color_txt=VERDE, tam=10.5)
    flecha(ax, (76, y + 3.6), (80, y + 3.6), color=VERDE)

    yf = 36
    for i, (x, t, s, c, bg) in enumerate([
            (4,  "CUARENTENA", "magic bytes\n· 50.000 págs", ROJO, PANEL),
            (23, "DUPLICADA",  "mismo sha256\nsin extraer: 0 €", AZUL, AZUL_BG),
            (42, "REVISIÓN",   "extracción falla\ntras 4 intentos", AMBAR, AMBAR_BG),
            (61, "RECHAZADA",  "regla BLOCK\ncon motivo", ROJO, ROJO_BG)]):
        caja(ax, x, yf, 16, 6.4, t, s, borde=c, relleno=bg, color_txt=c, tam=9.4)

    for x, txt, c in [(12, "permanente", ROJO), (31, "ya visto", AZUL),
                      (50, "agotado", AMBAR), (69, "R-002", ROJO)]:
        flecha(ax, (x, y), (x, yf + 6.4), color=c)
        etiqueta(ax, x - 5.6, 45.0, txt, color=c)

    # La geometría cuelga de REVISIÓN: es un enriquecimiento de ese camino.
    caja(ax, 42, 27.5, 16, 5.6, "+ GEOMETRÍA", "Textract solo si\nva a revisión", tam=9.4)
    flecha(ax, (50, yf), (50, 33.1), estilo=":")
    etiqueta(ax, 63.5, 30.3, "compra tardía de OCR: coordenadas y confianza calibrada", tam=7.2)

    # Consumidor
    ax.add_patch(FancyBboxPatch((4, 13), 44, 10.5,
                 boxstyle="round,pad=0,rounding_size=0.05", linewidth=1.2,
                 edgecolor=LINEA, facecolor=PANEL, zorder=3))
    ax.text(6, 21.4, "El consumidor: portero, no trabajador", fontsize=10,
            fontweight="bold", color=TINTA, zorder=4)
    ax.text(6, 18.9, "1 · Candado  IDEM#<clave>#<etag>  con ConditionExpression\n"
                     "2 · StartExecution con nombre determinista\n"
                     "3 · Si falla el arranque, LIBERA el candado", fontsize=8.2,
            color=TENUE, zorder=4, linespacing=1.85, va="top")

    caja(ax, 52, 15.5, 20, 6.4, "DLQ", "solo fallos transitorios\ntras 3 intentos",
         borde=ROJO, relleno=PANEL, color_txt=ROJO, tam=10)
    caja(ax, 76, 15.5, 20, 6.4, "Alarma P1", "umbral 0, no 10", borde=ROJO,
         relleno=ROJO_BG, color_txt=ROJO, tam=10)
    flecha(ax, (72, 18.7), (76, 18.7), color=ROJO)
    ax.text(74, 13.2, "Un .txt renombrado a .pdf NO aparece aquí: va a cuarentena.\n"
                      "Si apareciera, la clasificación transitorio/permanente estaría mal.",
            fontsize=7.6, color=TENUE, ha="center", va="top", linespacing=1.6)

    ax.text(4, 7.6, "Por qué esto importa", fontsize=9.4, fontweight="bold", color=TINTA)
    ax.text(4, 5.6, "Un estado Pass de Step Functions no escribe nada. La primera versión de este pipeline "
                    "usaba Pass en los caminos de fallo: la ejecución\nterminaba en SUCCEEDED, el documento "
                    "se quedaba en PENDING con su TTL de 24 h y desaparecía al día siguiente.\n"
                    "Era pérdida de datos con aspecto de éxito.",
            fontsize=8, color=TENUE, va="top", linespacing=1.75)

    fig.tight_layout(pad=0.4)
    fig.savefig(destino, facecolor=FONDO, bbox_inches="tight")
    plt.close(fig)
    print("  ", destino)


if __name__ == "__main__":
    import sys
    d = sys.argv[1]
    print("Generando diagramas:")
    despliegue(d + "/arq-despliegue.png")
    flujo(d + "/arq-flujo.png")
