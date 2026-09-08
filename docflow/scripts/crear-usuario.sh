#!/usr/bin/env bash
# Crea un usuario de prueba con su tenant asignado.
set -euo pipefail
STACK=${STACK:-DocFlow-Dev}
REGION=${REGION:-us-east-1}
EMAIL=${1:?Uso: ./scripts/crear-usuario.sh email@ejemplo.com <tenantId>}
TENANT=${2:-acme}
PASS=${PASSWORD:-'Docflow-Prueba-2026!'}

POOL=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL" --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true Name=custom:tenant_id,Value="$TENANT" \
  --message-action SUPPRESS >/dev/null
aws cognito-idp admin-set-user-password --region "$REGION" --user-pool-id "$POOL" --username "$EMAIL" --password "$PASS" --permanent
aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$POOL" --username "$EMAIL" --group-name reviewer
echo "Usuario $EMAIL creado en el tenant '$TENANT'. Contraseña: $PASS"
