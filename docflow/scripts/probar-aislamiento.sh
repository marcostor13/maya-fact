#!/usr/bin/env bash
# La prueba de seguridad que debes poder ejecutar EN VIVO durante la defensa.
# El tenant B intenta leer un documento del tenant A por TODAS las puertas.
#
# Se prueban las dos, y no es por completismo: cada endpoint que toca la tabla
# es una puerta nueva, y CLAUDE.md §2.4 exige que ninguna se añada sin su
# prueba aqui. El dia que alguien escriba mal una clave, esto lo dice.
#
#   GET /documents/{id}          -> metadatos y campos extraidos
#   GET /documents/{id}/content  -> enlace firmado al documento original
#
# El segundo importa mas: un fallo ahi no filtra metadatos, filtra el PDF.
set -euo pipefail
STACK=${STACK:-DocFlow-Dev}
REGION=${REGION:-us-east-1}
API=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
DOC_DE_OTRO=${1:?Uso: ./scripts/probar-aislamiento.sh <documentId-del-tenant-A>}
TOKEN_B=${TOKEN_B:?Exporta TOKEN_B con el access token del tenant B}

FALLOS=0

probar() {
  local ruta="$1" descripcion="$2"
  local cuerpo; cuerpo=$(mktemp)
  local code
  code=$(curl -sS -o "$cuerpo" -w '%{http_code}' "$API$ruta" -H "authorization: Bearer $TOKEN_B")
  echo "  $descripcion"
  echo "    HTTP $code — $(cat "$cuerpo")"
  rm -f "$cuerpo"

  # 404 y no 403: "no existe" y "no es tuyo" tienen que ser indistinguibles, o
  # el codigo de estado se convierte en un oraculo para enumerar documentos.
  if [ "$code" = "404" ]; then
    echo "    OK  aislamiento correcto"
  else
    echo "    FALLO  se esperaba 404 y llego $code"
    FALLOS=$((FALLOS + 1))
  fi
}

echo "Tenant B intentando leer el documento $DOC_DE_OTRO del tenant A..."
probar "/documents/$DOC_DE_OTRO"         "metadatos y campos extraidos"
probar "/documents/$DOC_DE_OTRO/content" "enlace al documento original"

echo
if [ "$FALLOS" -gt 0 ]; then
  echo "FALLO DE AISLAMIENTO en $FALLOS de 2 puertas."
  exit 1
fi
echo "Aislamiento correcto en las 2 puertas: 404, no 403. No filtramos si el documento existe."
