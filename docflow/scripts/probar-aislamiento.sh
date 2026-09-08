#!/usr/bin/env bash
# La prueba de seguridad que debes poder ejecutar EN VIVO durante la defensa.
# Crea dos tenants, sube un documento con uno e intenta leerlo con el otro.
set -euo pipefail
STACK=${STACK:-DocFlow-Dev}
REGION=${REGION:-us-east-1}
API=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
DOC_DE_OTRO=${1:?Uso: ./scripts/probar-aislamiento.sh <documentId-del-tenant-A>}
TOKEN_B=${TOKEN_B:?Exporta TOKEN_B con el access token del tenant B}

echo "Tenant B intentando leer el documento del tenant A..."
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' "$API/documents/$DOC_DE_OTRO" -H "authorization: Bearer $TOKEN_B")
echo "HTTP $CODE — $(cat /tmp/r.json)"
[ "$CODE" = "404" ] && echo "✓ Aislamiento correcto: 404, no 403. No filtramos si el documento existe." \
                    || { echo "✗ FALLO DE AISLAMIENTO"; exit 1; }
