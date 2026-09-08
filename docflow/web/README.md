# Frontend Angular

No incluyo un workspace de Angular completo: son cientos de ficheros generados
que nadie va a leer y que no demuestran nada. Incluyo las **dos piezas que sí
tienen decisiones dentro** y las instrucciones para montarlas.

```bash
npx @angular/cli@latest new docflow-web --style=scss --ssr=false
cd docflow-web
npm i @aws-amplify/auth aws-amplify        # o amazon-cognito-identity-js
cp ../src/app/*.ts src/app/
```

Registra el interceptor en `app.config.ts`:

```ts
provideHttpClient(withInterceptors([authInterceptor]))
```

## Las dos decisiones que hay aquí

**1. La subida no pasa por la API.** `DocumentsService.subir()` hace dos
llamadas: una a nuestra API para obtener un presigned POST, y otra a S3 con el
archivo. El backend firma un permiso; nunca toca los bytes.

**2. El token va solo a nuestro origen.** El interceptor filtra por `/api`. Sin
ese filtro, la cabecera `Authorization` viajaría también a S3, rompería la firma
del presigned y filtraría el token a otro host.

## Despliegue

```bash
npm run build
aws s3 sync dist/docflow-web/browser "s3://$(aws cloudformation describe-stacks \
  --stack-name DocFlow-Dev --query "Stacks[0].Outputs[?OutputKey=='WebBucket'].OutputValue" \
  --output text)" --delete
aws cloudfront create-invalidation --distribution-id <ID> --paths '/*'
```
