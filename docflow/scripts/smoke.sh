#!/usr/bin/env bash
# Prueba end-to-end: token -> presigned -> subida a S3 -> polling del resultado.
# Requiere: aws cli, jq, curl. Uso: ./scripts/smoke.sh ruta/a/factura.pdf
set -euo pipefail

STACK=${STACK:-DocFlow-Dev}
# La región va explícita en cada llamada. Si se dejara a la del perfil de AWS,
# el script buscaría el stack donde `aws configure` diga y fallaría con un
# "Stack does not exist" que parece un fallo de despliegue y no lo es.
REGION=${REGION:-us-east-1}

# ---------------------------------------------------------------------------
# jq en Windows escribe en modo texto: termina cada linea en CRLF, no en LF.
# `read -r` solo se come el \n, asi que TODOS los valores arrastran un \r
# invisible. Al mandarlos como campos del formulario, S3 recibe
# "AWS4-HMAC-SHA256\r" y responde:
#
#   <Code>InvalidArgument</Code>
#   <Message>Only AWS4-HMAC-SHA256 is supported</Message>
#   <ArgumentValue>AWS4-HMAC-SHA256</ArgumentValue>
#
# Un error que muestra el valor correcto y lo rechaza igual: el caracter no se
# ve ni en el mensaje de error. El presigned estaba bien; lo que estaba mal era
# el cliente de prueba.
# ---------------------------------------------------------------------------
jq() { command jq "$@" | tr -d '\r'; }
FILE=${1:?Uso: ./scripts/smoke.sh <archivo.pdf>}
EMAIL=${EMAIL:?Exporta EMAIL con el usuario de prueba}
PASSWORD=${PASSWORD:?Exporta PASSWORD}

out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

API=$(out ApiUrl); POOL=$(out UserPoolId); CLIENT=$(out UserPoolClientId)

echo "==> 1/5 Autenticando"
TOKEN=$(aws cognito-idp admin-initiate-auth --region "$REGION" \
  --user-pool-id "$POOL" --client-id "$CLIENT" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=$EMAIL,PASSWORD=$PASSWORD" \
  --query 'AuthenticationResult.AccessToken' --output text)

echo "==> 2/5 Verificando que el token lleva tenant_id"
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{tenant_id, roles, sub}' || true

echo "==> 3/5 Pidiendo presigned POST"
RESP=$(curl -sS -X POST "$API/uploads" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"fileName\":\"$(basename "$FILE")\",\"contentType\":\"application/pdf\",\"sizeBytes\":$(stat -c%s "$FILE")}")
DOC=$(echo "$RESP" | jq -r .documentId)
URL=$(echo "$RESP" | jq -r .upload.url)
echo "    documentId=$DOC"

echo "==> 4/5 Subiendo DIRECTO a S3 (el archivo no pasa por la API)"
ARGS=(); while read -r k v; do ARGS+=(-F "$k=$v"); done < <(echo "$RESP" | jq -r '.upload.fields | to_entries[] | "\(.key) \(.value)"')
curl -sS -o /dev/null -w "    HTTP %{http_code}\n" -X POST "$URL" "${ARGS[@]}" -F "file=@$FILE"

echo "==> 5/5 Esperando el resultado (SLO: p95 < 5 min)"
for i in $(seq 1 60); do
  R=$(curl -sS "$API/documents/$DOC" -H "authorization: Bearer $TOKEN")
  S=$(echo "$R" | jq -r '.document.status // "?"')
  printf "\r    [%02ds] estado=%s" "$((i*5))" "$S"
  # DUPLICATE es terminal: significa que ese contenido ya se proceso y NO se
  # volvio a pagar la extraccion. Omitirlo hacia que el script siguiera
  # sondeando 5 minutos un documento que ya habia terminado — y confundia un
  # ahorro con un cuelgue.
  case "$S" in APPROVED|NEEDS_REVIEW|REJECTED|DUPLICATE|QUARANTINED)
    # `porque` es lo primero que se imprime a proposito: es la unica linea que
    # se entiende sin conocer el sistema, y es la misma frase que ve el cliente
    # en la interfaz — se calcula y se guarda en el pipeline, no en el frontend.
    echo; echo "$R" | jq '{
      status: .document.status,
      porque: .document.explicacion.resumen,
      detalles: .document.explicacion.detalles,
      ruta: .document.route,
      reglas: .document.hits,
      modelo: .document.modelId,
      ruleset: .document.rulesetVersion
    }'; exit 0;;
  esac
  sleep 5
done
echo; echo "Sin resultado en 5 minutos. Revisa la DLQ: $(out DlqUrl)"; exit 1
