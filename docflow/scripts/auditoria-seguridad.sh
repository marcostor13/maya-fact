#!/usr/bin/env bash
# Auditoria de los 12 invariantes de CLAUDE.md.
#
# Dos formas de comprobar, y la eleccion importa:
#
#   - Sobre el CODIGO FUENTE, para lo que es una regla de escritura (de donde
#     sale el tenant, que no haya innerHTML). Se excluyen los comentarios: un
#     guard que no distingue codigo de documentacion acaba desactivandose por
#     ruidoso, y ya nos paso una vez.
#
#   - Sobre la PLANTILLA SINTETIZADA, para todo lo que es infraestructura. Es
#     lo que de verdad se despliega. Un `grep` sobre CDK comprueba lo que
#     quisiste escribir; la plantilla comprueba lo que sale. Hoy mismo un
#     trigger de Cognito paso el compilador y no llego a la plantilla.
#
# Uso:  ./scripts/auditoria-seguridad.sh
# Salida: 0 si todos los invariantes pasan, 1 si alguno falla.
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"

PLANTILLA="infra/cdk.out/DocFlow-Dev.template.json"
FALLOS=0
AVISOS=0
EJECUTADAS=0
TOTAL=13

# El interprete se resuelve UNA vez y se exige. En Git Bash existe `python`
# pero no `python3`: la primera version de este script llamaba a `python3`,
# las cuatro comprobaciones de la plantilla no se ejecutaban y el resumen
# anunciaba igualmente "los 12 invariantes se cumplen".
#
# Era exactamente el fallo contra el que existe este documento: un control
# que falla EN ABIERTO. Un auditor que no puede mirar debe decirlo, no
# aprobar.
PY=$(command -v python3 || command -v python || true)

rojo()  { printf '\033[1;31m%s\033[0m\n' "$*"; }
verde() { printf '\033[1;32m%s\033[0m\n' "$*"; }
ambar() { printf '\033[1;33m%s\033[0m\n' "$*"; }
gris()  { printf '\033[0;90m%s\033[0m\n' "$*"; }

ok()    { verde "  OK    $1"; EJECUTADAS=$((EJECUTADAS+1)); }
falla() { rojo  "  FALLO $1"; FALLOS=$((FALLOS+1)); EJECUTADAS=$((EJECUTADAS+1)); [ -n "${2:-}" ] && echo "$2" | sed 's/^/        /'; }
avisa() { ambar "  AVISO $1"; AVISOS=$((AVISOS+1)); [ -n "${2:-}" ] && echo "$2" | sed 's/^/        /'; }

# Busca en el codigo IGNORANDO lineas de comentario.
codigo_sin_comentarios() {
  grep -rnE "$1" ${2:-services/src} --include=*.ts 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//|/\*)' || true
}

echo
gris "Auditoria de seguridad · CLAUDE.md"
gris "=================================================================="

# ── I-1 ────────────────────────────────────────────────────────────
H=$(codigo_sin_comentarios "(pathParameters|queryStringParameters)[?]?\.[A-Za-z]*[Tt]enant|body[?]?\.[A-Za-z]*[Tt]enant")
[ -z "$H" ] && ok "I-1  el tenantId solo sale del JWT" \
             || falla "I-1  el tenantId viaja en el request" "$H"

# ── I-2 ────────────────────────────────────────────────────────────
H=$(codigo_sin_comentarios "ScanCommand|new Scan\(")
[ -z "$H" ] && ok "I-2  sin Scan en DynamoDB" \
             || falla "I-2  hay un Scan" "$H"

# ── I-3 e I-12 · sobre la plantilla ────────────────────────────────
if [ -z "$PY" ]; then
  falla "I-3/10/11/12  no hay interprete de Python: no puedo auditar la plantilla"         "Instala Python o ejecuta la auditoria donde exista."
elif [ ! -f "$PLANTILLA" ]; then
  avisa "I-3  sin plantilla sintetizada" "Ejecuta: cd infra && npx cdk synth"
  avisa "I-10 sin plantilla sintetizada" ""
  avisa "I-11 sin plantilla sintetizada" ""
  avisa "I-12 sin plantilla sintetizada" ""
else
"$PY" - "$PLANTILLA" <<'PY'
import json, sys

t = json.load(open(sys.argv[1], encoding="utf-8"))
recursos = t["Resources"]
fallos = []

DATOS = ("dynamodb:", "s3:", "bedrock:", "secretsmanager:", "kms:")

def como_lista(v):
    return v if isinstance(v, list) else [v]

def es_comodin(r):
    return r == "*"

# ── I-3 · ninguna politica de servicio de datos con recurso "*" ────
malos = []
for nombre, r in recursos.items():
    if r["Type"] not in ("AWS::IAM::Policy", "AWS::IAM::Role"):
        continue
    props = r.get("Properties", {})
    docs = []
    if "PolicyDocument" in props:
        docs.append(props["PolicyDocument"])
    for p in props.get("Policies", []):
        docs.append(p.get("PolicyDocument", {}))
    for d in docs:
        for st in d.get("Statement", []):
            acciones = [a for a in como_lista(st.get("Action", [])) if isinstance(a, str)]
            recs = como_lista(st.get("Resource", []))
            if any(a.startswith(DATOS) for a in acciones) and any(
                    isinstance(x, str) and es_comodin(x) for x in recs):
                malos.append("%s -> %s" % (nombre, ", ".join(acciones)[:90]))
            # bedrock:* o dynamodb:* nunca
            for a in acciones:
                if a.endswith(":*") and a.startswith(DATOS):
                    malos.append("%s -> accion comodin %s" % (nombre, a))

print("I3:" + ("|".join(sorted(set(malos))) if malos else ""))

# ── I-10 · buckets ─────────────────────────────────────────────────
malos = []
for nombre, r in recursos.items():
    if r["Type"] != "AWS::S3::Bucket":
        continue
    p = r.get("Properties", {})
    pab = p.get("PublicAccessBlockConfiguration", {})
    if not all(pab.get(k) is True for k in
               ("BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets")):
        malos.append("%s sin BlockPublicAccess completo" % nombre)
for nombre, r in recursos.items():
    if r["Type"] == "AWS::CloudFront::CloudFrontOriginAccessIdentity":
        malos.append("%s usa OAI (legacy) en vez de OAC" % nombre)
print("I10:" + ("|".join(malos) if malos else ""))

# ── I-11 · visibilityTimeout >= 6x el timeout de la funcion ────────
malos = []
colas = {n: r for n, r in recursos.items() if r["Type"] == "AWS::SQS::Queue"}
funcs = {n: r for n, r in recursos.items() if r["Type"] == "AWS::Lambda::Function"}
mapeos = [r for r in recursos.values() if r["Type"] == "AWS::Lambda::EventSourceMapping"]
for m in mapeos:
    p = m.get("Properties", {})
    fn_ref = p.get("FunctionName", {})
    fn_nombre = fn_ref.get("Ref") if isinstance(fn_ref, dict) else None
    tout = None
    if fn_nombre and fn_nombre in funcs:
        tout = funcs[fn_nombre]["Properties"].get("Timeout")
    arn = p.get("EventSourceArn", {})
    cola = arn.get("Fn::GetAtt", [None])[0] if isinstance(arn, dict) else None
    vis = colas.get(cola, {}).get("Properties", {}).get("VisibilityTimeout") if cola else None
    if tout and vis and vis < tout * 6:
        malos.append("%s: visibility %ss < 6x timeout %ss" % (cola, vis, tout))
# toda cola con consumidor debe tener DLQ
for n, c in colas.items():
    props = c.get("Properties", {})
    if "RedrivePolicy" not in props and not n.lower().startswith(("dlq",)) and "Dlq" not in n:
        malos.append("%s sin RedrivePolicy (DLQ)" % n)
print("I11:" + ("|".join(malos) if malos else ""))

# ── I-12 · bedrock acotado a un model id ───────────────────────────
malos = []
for nombre, r in recursos.items():
    if r["Type"] not in ("AWS::IAM::Policy",):
        continue
    for st in r["Properties"]["PolicyDocument"].get("Statement", []):
        acciones = [a for a in como_lista(st.get("Action", [])) if isinstance(a, str)]
        if not any(a.startswith("bedrock:") for a in acciones):
            continue
        for rec in como_lista(st.get("Resource", [])):
            texto = json.dumps(rec)
            if '"*"' == texto or "foundation-model/*" in texto:
                malos.append("%s: recurso demasiado amplio" % nombre)
print("I12:" + ("|".join(malos) if malos else ""))
PY
fi > /tmp/mf_audit.txt 2>&1

if [ -n "$PY" ] && [ -f "$PLANTILLA" ]; then
  while IFS= read -r linea; do
    clave="${linea%%:*}"; valor="${linea#*:}"
    case "$clave" in
      I3)  [ -z "$valor" ] && ok "I-3  ninguna politica de datos con recurso *" || falla "I-3  politica demasiado amplia" "$(echo "$valor" | tr '|' '\n')" ;;
      I10) [ -z "$valor" ] && ok "I-10 buckets privados, OAC y no OAI"          || falla "I-10 bucket o distribucion insegura" "$(echo "$valor" | tr '|' '\n')" ;;
      I11) [ -z "$valor" ] && ok "I-11 visibilityTimeout >= 6x y DLQ presente"  || falla "I-11 cola mal configurada" "$(echo "$valor" | tr '|' '\n')" ;;
      I12) [ -z "$valor" ] && ok "I-12 Bedrock acotado a un model id"           || falla "I-12 permiso de Bedrock demasiado amplio" "$(echo "$valor" | tr '|' '\n')" ;;
    esac
  done < <(grep -E '^I(3|10|11|12):' /tmp/mf_audit.txt)
  grep -qE '^Traceback|^  File' /tmp/mf_audit.txt && avisa "el analisis de la plantilla fallo" "$(tail -3 /tmp/mf_audit.txt)"
fi

# ── I-4 ────────────────────────────────────────────────────────────
H=$(grep -rnEi "aws_secret_access_key[[:space:]]*=|BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-|AKIA[0-9A-Z]{16}" \
      services infra web scripts evals rules 2>/dev/null \
      --include=*.ts --include=*.json --include=*.sh --include=*.yml | grep -v node_modules || true)
[ -z "$H" ] && ok "I-4  sin secretos literales en el repositorio" \
             || falla "I-4  posible secreto en el codigo" "$H"

# ── I-5 ────────────────────────────────────────────────────────────
if grep -q "detectMime(buf)" services/src/pipeline/classify.ts 2>/dev/null \
   && grep -q "MIME_DESCONOCIDO" services/src/pipeline/classify.ts 2>/dev/null; then
  ok "I-5  validacion por magic bytes antes de procesar"
else
  falla "I-5  classify.ts no valida magic bytes" ""
fi

# ── I-6 ────────────────────────────────────────────────────────────
H=$(codigo_sin_comentarios "innerHTML|bypassSecurityTrust|execSync|child_process" "services/src web/src")
[ -z "$H" ] && ok "I-6  sin innerHTML, sin bypass del sanitizador, sin shell" \
             || falla "I-6  entrada de tercero hacia un interprete o HTML" "$H"

# ── I-7 ────────────────────────────────────────────────────────────
H=$(codigo_sin_comentarios "err\.stack|JSON\.stringify\(err" "services/src/api")
[ -z "$H" ] && ok "I-7  errores genericos hacia fuera" \
             || falla "I-7  el error revela detalle interno" "$H"

# ── I-8 ────────────────────────────────────────────────────────────
H=$(codigo_sin_comentarios "fail\(403" "services/src/api")
[ -z "$H" ] && ok "I-8  no existe y no es tuyo devuelven lo mismo (404)" \
             || avisa "I-8  hay un 403: solo vale para rol, nunca para pertenencia" "$H"

# ── I-9 ────────────────────────────────────────────────────────────
H=$(grep -rn "new NodejsFunction(" infra/lib --include=*.ts 2>/dev/null | grep -v "lambda-defaults.ts" || true)
[ -z "$H" ] && ok "I-9  todas las Lambdas se crean con fn()" \
             || falla "I-9  hay una Lambda que no pasa por lambda-defaults" "$H"

# ── Extra · promesa de eliminabilidad ──────────────────────────────
if [ -n "$PY" ] && [ -f "$PLANTILLA" ]; then
  H=$("$PY" -c "
import json,sys
t=json.load(open(sys.argv[1],encoding='utf-8'))
m=[(v['Type'],k) for k,v in t['Resources'].items()
   if v.get('DeletionPolicy','Delete')!='Delete' or v.get('UpdateReplacePolicy','Delete')!='Delete']
print('\n'.join('%s  %s'%x for x in sorted(m)))" "$PLANTILLA")
  [ -z "$H" ] && ok "EXTRA todo el stack se puede destruir sin residuos" \
               || falla "EXTRA quedarian recursos huerfanos al destruir" "$H"
fi

# ── Resumen ────────────────────────────────────────────────────────
gris "=================================================================="
echo
if [ "$FALLOS" -gt 0 ]; then
  rojo "$FALLOS invariante(s) INCUMPLIDO(S)"
  [ "$AVISOS" -gt 0 ] && ambar "$AVISOS aviso(s)"
  echo
  gris "Un permiso de menos se detecta en un test; uno de mas, en un pen test."
  exit 1
fi
if [ "$EJECUTADAS" -lt "$TOTAL" ]; then
  ambar "Solo se ejecutaron $EJECUTADAS de $TOTAL comprobaciones."
  gris "Las que faltan necesitan la plantilla sintetizada: cd infra && npx cdk synth"
  gris "No se aprueba lo que no se ha podido comprobar."
  exit 1
fi
verde "Las $TOTAL comprobaciones de CLAUDE.md pasan."
[ "$AVISOS" -gt 0 ] && ambar "$AVISOS aviso(s) — revisalos, no bloquean."
exit 0
