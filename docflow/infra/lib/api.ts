import { Duration } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import { Construct } from 'constructs';
import { fn } from './lambda-defaults.js';

export interface ApiProps {
  table: dynamodb.TableV2;
  uploads: s3.Bucket;
  userPool: cognito.UserPool;
  client: cognito.UserPoolClient;
  region: string;
}

export class Api extends Construct {
  public readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const src = (f: string) => path.join(__dirname, `../../services/src/api/${f}`);
    const env = { TABLE_NAME: props.table.tableName, UPLOADS_BUCKET: props.uploads.bucketName };

    const createUpload = fn(this, 'CreateUpload', { entry: src('create-upload.ts'), environment: env });
    const getDocument = fn(this, 'GetDocument', { entry: src('get-document.ts'), environment: env });
    const listDocuments = fn(this, 'ListDocuments', { entry: src('list-documents.ts'), environment: env });

    // ---- IAM de grano fino --------------------------------------------------
    // No usamos table.grantReadData(): concede dynamodb:Query y GetItem sobre
    // TODA la tabla, sin restricción de partición. Aquí la restringimos.
    /**
     * La condición que hace que un bug de código no se convierta en una fuga
     * entre tenants. `ForAllValues:` no es decorativo: sin ese modificador, la
     * condición se cumple si CUALQUIERA de las claves pedidas encaja, no si
     * encajan todas — es decir, no hace lo que parece que hace.
     */
    const tenantScoped = (actions: string[], resources: string[]) =>
      new iam.PolicyStatement({
        actions,
        resources,
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] },
        },
      });

    // Nota honesta, y hay que decirla sin esperar a que la saquen: con una
    // Lambda compartida por todos los tenants, el patrón solo puede ser
    // `TENANT#*`, así que la condición es un límite de FORMA de clave, no de
    // VALOR. Impide leer la partición IDEM# o hacer un Scan encubierto, pero no
    // impide que el tenant A lea al B si el código se equivoca — eso lo impide
    // la clave de partición, que es la primera capa. El aislamiento por valor
    // exige credenciales por sesión (STS AssumeRole con tags o Identity Pools)
    // y su coste está evaluado en ADR-008.
    createUpload.addToRolePolicy(tenantScoped(['dynamodb:PutItem'], [props.table.tableArn]));
    getDocument.addToRolePolicy(
      tenantScoped(['dynamodb:GetItem', 'dynamodb:Query'], [props.table.tableArn]),
    );
    listDocuments.addToRolePolicy(
      tenantScoped(['dynamodb:Query'], [`${props.table.tableArn}/index/GSI1`]),
    );

    // El emisor del presigned NO necesita s3:PutObject: firma, no escribe.
    // Pero la firma solo es válida para lo que su rol podría hacer, así que sí
    // lo necesita, restringido al prefijo de inbox y a nada más.
    createUpload.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [props.uploads.arnForObjects('tenants/*/inbox/*')],
      }),
    );

    // ---- HTTP API -----------------------------------------------------------
    // HTTP API y no REST API: más barata y de menor latencia. Se pierde WAF
    // asociado directamente, y por eso la API se sirve detrás de la misma
    // distribución de CloudFront que el frontend (ver web.ts): recuperamos WAF
    // y, de paso, al compartir origen desaparece el preflight CORS.
    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwt',
      `https://cognito-idp.${props.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.client.userPoolClientId] },
    );

    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      description: 'DocFlow API',
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        allowHeaders: ['authorization', 'content-type'],
        allowOrigins: ['http://localhost:4200'], // solo desarrollo local
        maxAge: Duration.hours(1),
      },
    });

    this.httpApi.addRoutes({
      path: '/uploads',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('CreateUploadInt', createUpload),
    });
    this.httpApi.addRoutes({
      path: '/documents',
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration('ListDocumentsInt', listDocuments),
    });
    this.httpApi.addRoutes({
      path: '/documents/{documentId}',
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration('GetDocumentInt', getDocument),
    });
  }
}
