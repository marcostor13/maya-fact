#!/usr/bin/env bash
# Borra TODO lo que este proyecto crea en AWS, y despues VERIFICA que no quedo
# nada. La verificacion es la mitad importante: un `cdk destroy` que dice "OK"
# puede haber dejado atras buckets con DeletionPolicy=Retain, que siguen
# cobrando y que ademas bloquean el siguiente despliegue.
#
# Uso:
#   ./scripts/destruir.sh              # borra el stack de la aplicacion
#   ./scripts/destruir.sh --todo       # ademas borra el bootstrap de CDK
#   ./scripts/destruir.sh --verificar  # NO borra: solo dice que hay desplegado
set -euo pipefail

STACK=${STACK:-DocFlow-Dev}
REGION=${REGION:-us-east-1}
MODO=${1:-normal}

azul()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
verde() { printf '\033[1;32m%s\033[0m\n' "$*"; }
rojo()  { printf '\033[1;31m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# Comprobacion de credenciales, ANTES de nada.
#
# Sin esto el script miente: cada consulta lleva `|| true` para tolerar
# permisos parciales, asi que con credenciales invalidas TODAS devuelven vacio
# y la verificacion final anuncia "limpio, no queda nada" cuando en realidad no
# ha podido mirar. Un verificador que falla en abierto es peor que no tenerlo,
# porque da una confianza que no ha ganado.
# ---------------------------------------------------------------------------
if ! IDENT=$(aws sts get-caller-identity --output text --query 'Account' 2>&1); then
  rojo "No hay credenciales de AWS validas. La verificacion seria un falso negativo."
  echo "  $IDENT"
  echo "Ejecuta 'aws configure' (o 'aws sso login') y vuelve a intentarlo."
  exit 2
fi
echo "Cuenta AWS: $IDENT · region: $REGION"

# ---------------------------------------------------------------------------
# Inventario: que hay ahora mismo con el nombre de este proyecto
# ---------------------------------------------------------------------------
inventario() {
  local encontrado=0

  echo "  Stacks de CloudFormation:"
  local stacks
  stacks=$(aws cloudformation list-stacks --region "$REGION" \
    --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE \
    --query "StackSummaries[?contains(StackName, 'DocFlow')].StackName" --output text 2>/dev/null || true)
  if [ -n "$stacks" ]; then echo "    $stacks"; encontrado=1; else echo "    (ninguno)"; fi

  echo "  Buckets S3:"
  local buckets
  buckets=$(aws s3api list-buckets --query "Buckets[?contains(Name, 'docflow')].Name" --output text 2>/dev/null || true)
  if [ -n "$buckets" ]; then echo "    $buckets"; encontrado=1; else echo "    (ninguno)"; fi

  echo "  Tablas DynamoDB:"
  local tablas
  tablas=$(aws dynamodb list-tables --region "$REGION" \
    --query "TableNames[?contains(@, 'DocFlow')]" --output text 2>/dev/null || true)
  if [ -n "$tablas" ]; then echo "    $tablas"; encontrado=1; else echo "    (ninguna)"; fi

  echo "  Grupos de logs:"
  local grupos
  grupos=$(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "/aws/lambda/docflow" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null || true)
  if [ -n "$grupos" ]; then echo "    $grupos"; encontrado=1; else echo "    (ninguno)"; fi

  echo "  User pools de Cognito:"
  local pools
  pools=$(aws cognito-idp list-user-pools --region "$REGION" --max-results 60 \
    --query "UserPools[?contains(Name, 'DocFlow')].Name" --output text 2>/dev/null || true)
  if [ -n "$pools" ]; then echo "    $pools"; encontrado=1; else echo "    (ninguno)"; fi

  echo "  Distribuciones de CloudFront (globales):"
  local dist
  dist=$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?contains(Comment, 'DocFlow') || contains(Origins.Items[0].Id, 'DocFlow')].Id" \
    --output text 2>/dev/null || true)
  if [ -n "$dist" ]; then echo "    $dist"; encontrado=1; else echo "    (ninguna)"; fi

  return $encontrado
}

if [ "$MODO" = "--verificar" ]; then
  azul "== Que hay desplegado ahora mismo =="
  inventario || true
  exit 0
fi

# ---------------------------------------------------------------------------
azul "== 1/3 · Antes de borrar =="
inventario || true

echo
rojo "Se va a BORRAR el stack '$STACK' en $REGION, con todos sus datos."
echo "La distribucion de CloudFront tarda 15-25 minutos en eliminarse: CloudFormation"
echo "la desactiva primero y espera a que se propague. Es normal, no esta colgado."
echo
read -r -p "Escribe BORRAR para confirmar: " confirma
[ "$confirma" = "BORRAR" ] || { echo "Cancelado."; exit 1; }

azul "== 2/3 · Destruyendo =="
(cd "$(dirname "$0")/../infra" && npx cdk destroy "$STACK" --force)

if [ "$MODO" = "--todo" ]; then
  azul "== Bootstrap de CDK =="
  # OJO: el bootstrap es COMPARTIDO por todos los proyectos CDK de la cuenta y
  # region. Borrarlo rompe el despliegue de cualquier otro stack que uses. Por
  # eso no va en el modo normal y hay que pedirlo a proposito.
  BSTACK=CDKToolkit
  BUCKET=$(aws cloudformation describe-stack-resources --stack-name "$BSTACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text 2>/dev/null || true)
  if [ -n "$BUCKET" ]; then
    echo "Vaciando el bucket de staging $BUCKET (CloudFormation no borra buckets con contenido)..."
    aws s3 rm "s3://$BUCKET" --recursive --region "$REGION" >/dev/null 2>&1 || true
  fi
  aws cloudformation delete-stack --stack-name "$BSTACK" --region "$REGION"
  aws cloudformation wait stack-delete-complete --stack-name "$BSTACK" --region "$REGION" || true
fi

azul "== 3/3 · Verificacion posterior =="
if inventario; then
  verde "Limpio: no queda nada de DocFlow en $REGION."
else
  echo
  rojo "Han quedado recursos. Revisa la lista de arriba."
  echo "Causas habituales:"
  echo "  - Un bucket con objetos que el auto-vaciado no alcanzo (versiones antiguas)."
  echo "  - Un grupo de logs creado por Lambda ANTES de que existiera el explicito."
  echo "  - La distribucion de CloudFront, que sigue en estado 'Disabled' unos minutos."
  echo "Vuelve a ejecutar --verificar en 10 minutos antes de borrar nada a mano."
  exit 1
fi

echo
echo "Nota: lo que NO borra este script porque no cuesta nada y caduca solo:"
echo "  - Trazas de X-Ray (30 dias) y metricas de CloudWatch (15 meses)."
echo "  - El historial de ejecuciones de Step Functions (se va con la maquina)."
echo "  - El acceso concedido a modelos en Bedrock (es configuracion de cuenta)."
