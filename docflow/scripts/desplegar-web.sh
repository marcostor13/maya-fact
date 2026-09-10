#!/usr/bin/env bash
# Genera, compila y despliega la SPA de Angular.
#
# El workspace de Angular NO esta en el repositorio a proposito: son cientos de
# ficheros generados que nadie va a leer y que no demuestran nada. En `web/src`
# viven solo las tres piezas que tienen una decision dentro; este script
# construye el andamiaje alrededor cuando hace falta.
#
# Uso: ./scripts/desplegar-web.sh
set -euo pipefail

STACK=${STACK:-DocFlow-Dev}
REGION=${REGION:-us-east-1}
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$RAIZ/web/.build"          # ignorado por git

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "No hay credenciales de AWS validas."; exit 2
fi

out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

POOL=$(out UserPoolId); CLIENT=$(out UserPoolClientId)
WEB_BUCKET=$(out WebBucket); CDN=$(out CdnUrl)

echo "==> 1/4 Preparando el workspace"
if [ ! -d "$BUILD/node_modules" ]; then
  # `ng new` rechaza un nombre de proyecto que empiece por punto, asi que se
  # genera con nombre valido y se renombra la carpeta. El nombre del PROYECTO
  # sigue siendo maya-fact-web dentro de angular.json, y por eso mas abajo la
  # carpeta de salida se busca en vez de darse por supuesta.
  rm -rf "$BUILD" "$RAIZ/web/maya-fact-web"
  ( cd "$RAIZ/web" && npx --yes @angular/cli@latest new maya-fact-web \
      --style=scss --ssr=false --routing=false --skip-git --skip-tests --defaults )
  mv "$RAIZ/web/maya-fact-web" "$BUILD"
  ( cd "$BUILD" && npm install aws-amplify --no-audit --no-fund )
fi

echo "==> 2/4 Copiando la aplicacion"

# Guard: si falta un fichero, `ng new` deja el SUYO por defecto y la compilacion
# sale bien. Eso ya paso una vez con app.config.ts: sin el, Angular usaba su
# plantilla —sin interceptor— y todas las peticiones salian sin cabecera
# Authorization. La API respondia 401 a todo y el frontend parecia correcto.
#
# Un fichero que falta y se sustituye por un valor por defecto plausible es peor
# que un fichero que falta y rompe: el primero se descubre en produccion.
for f in app.ts app.html app.scss app.config.ts auth.service.ts auth.interceptor.ts \
         documents.service.ts icon.ts; do
  [ -f "$RAIZ/web/src/app/$f" ] || { echo "FALTA web/src/app/$f — no compilo con el andamiaje por defecto"; exit 1; }
done
# Todo lo que define la aplicacion vive en el repositorio; el workspace generado
# solo aporta el andamiaje de compilacion. Se sobrescribe la plantilla que crea
# Angular por defecto, incluida `app.html`, que trae una pagina de bienvenida.
cp "$RAIZ"/web/src/app/*.ts   "$BUILD/src/app/"
cp "$RAIZ"/web/src/app/*.html "$BUILD/src/app/"
cp "$RAIZ"/web/src/app/*.scss "$BUILD/src/app/"
cp "$RAIZ"/web/src/index.html "$BUILD/src/"
cp "$RAIZ"/web/src/styles.scss "$BUILD/src/"
mkdir -p "$BUILD/public"
cp "$RAIZ"/web/public/*.svg "$BUILD/public/"
# El favicon.ico que genera Angular sobra: usamos SVG, que escala y pesa 400 bytes.
rm -f "$BUILD/public/favicon.ico"

# La configuracion de Amplify se INYECTA desde los outputs del stack. Ni los
# ids del user pool ni el del cliente son secretos —viajan en cada login— pero
# tenerlos escritos a mano en el codigo es como se despliega contra el entorno
# equivocado sin enterarse.
cat > "$BUILD/src/main.ts" <<EOF
import { bootstrapApplication } from '@angular/platform-browser';
import { Amplify } from 'aws-amplify';
import { appConfig } from './app/app.config';
import { App } from './app/app';

Amplify.configure({
  Auth: { Cognito: { userPoolId: '$POOL', userPoolClientId: '$CLIENT' } },
});

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
EOF

# Angular limita cada hoja de componente a 8 kB y falla la compilacion al
# pasarse. El presupuesto existe para que nadie meta un framework CSS entero en
# un componente, y es buena idea; pero esta es la UNICA hoja de estilos de la
# aplicacion, asi que el limite se sube a proposito, no se desactiva.
#
# Y ya avisto una vez: al aniadir la ficha de documento —el motivo, el visor y
# los datos extraidos— la hoja paso de 11 a 15 kB y la compilacion FALLO. Eso es
# exactamente lo que se le pedia. Se revisa que el crecimiento tenga razon de
# ser, se sube el techo con margen y se deja el guard vivo: un presupuesto que
# se desactiva la primera vez que molesta no era un presupuesto.
node -e '
const fs = require("fs");
const ruta = process.argv[1];
const j = JSON.parse(fs.readFileSync(ruta, "utf8"));
const b = j.projects[Object.keys(j.projects)[0]].architect.build;
b.configurations.production.budgets = [
  { type: "initial", maximumWarning: "700kB", maximumError: "1MB" },
  { type: "anyComponentStyle", maximumWarning: "16kB", maximumError: "20kB" },
];

// inlineCritical: false — y esto NO es una preferencia de rendimiento.
//
// Con la opcion activada (el valor por defecto), Angular emite la hoja de
// estilos como:
//     <link rel="stylesheet" href="..." media="print" onload="this.media=,all,">
// Es un truco clasico para no bloquear el primer pintado. El problema es que
// `onload=` es un manejador de eventos EN LINEA, y nuestra CSP declara
// `script-src self`: el navegador lo bloquea, el `media` se queda en "print" y
// **la hoja de estilos global no se aplica nunca**.
//
// El sintoma es silencioso: los estilos de componente viajan dentro del JS, asi
// que la pagina se ve casi bien y solo falta lo global. La consola avisa con un
// error de CSP que parece de seguridad y en realidad es de maquetacion.
//
// Se desactiva la optimizacion en vez de aniadir 'unsafe-hashes' a la CSP:
// relajar la politica para que un truco de carga funcione seria pagar seguridad
// real por unos milisegundos.
b.configurations.production.optimization = {
  scripts: true,
  styles: { minify: true, inlineCritical: false },
  fonts: true,
};
fs.writeFileSync(ruta, JSON.stringify(j, null, 2));
' "$BUILD/angular.json"

echo "==> 3/4 Compilando"
( cd "$BUILD" && npx ng build --configuration production )

echo "==> 4/4 Subiendo y invalidando la cache"
# La carpeta de salida depende del nombre del proyecto dentro de angular.json,
# no del nombre de la carpeta. Se busca en vez de suponerla: dar por hecha una
# ruta que Angular decide es como se rompen los despliegues al actualizar el CLI.
SALIDA=$(find "$BUILD/dist" -maxdepth 2 -type d -name browser | head -1)
[ -n "$SALIDA" ] || { echo "No encuentro la carpeta compilada bajo $BUILD/dist"; exit 1; }
aws s3 sync "$SALIDA" "s3://$WEB_BUCKET" --delete --region "$REGION" >/dev/null
DIST=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?DomainName=='${CDN#https://}'].Id" --output text)
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*' \
  --query 'Invalidation.Status' --output text

echo
echo "Listo: $CDN"
echo "La invalidacion tarda 1-2 minutos en propagarse."
