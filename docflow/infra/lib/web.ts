import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface WebProps {
  webBucket: s3.Bucket;
  httpApi: apigw.HttpApi;
  region: string;
  prod: boolean;
  /**
   * El Web ACL de CloudFront SOLO existe en us-east-1. En cualquier otra región
   * hay que desplegarlo en un stack aparte y pasar su ARN. Lo hacemos explícito
   * en vez de fallar en el despliegue con un error críptico.
   */
  deployWaf: boolean;
}

/**
 * Una sola distribución sirve el Angular y la API.
 *
 * Dos consecuencias que valen la decisión:
 *  1. Recuperamos AWS WAF, que no se puede asociar a una HTTP API.
 *  2. Al compartir origen, el navegador deja de hacer preflight CORS contra la
 *     API: menos latencia y una superficie de configuración menos.
 */
export class Web extends Construct {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebProps) {
    super(scope, id);

    /**
     * Los hosts van con la REGIÓN literal, nunca con un comodín intermedio.
     *
     * La primera versión de esta política decía `https://cognito-idp.*.amazonaws.com`,
     * que parece razonable y **no funciona**: en CSP el comodín solo es válido
     * como componente más a la izquierda del host (`*.amazonaws.com` sí,
     * `cognito-idp.*.amazonaws.com` no). El navegador no lo hace coincidir con
     * nada, bloquea la llamada a Cognito y el error que ve el usuario es un
     * `NetworkError` genérico — que parece un problema de red o de credenciales
     * y manda a depurar al sitio equivocado.
     *
     * Y no se arregla poniendo `https://*.amazonaws.com`: eso abriría la
     * política a CUALQUIER servicio de AWS de cualquier cuenta. Con la región
     * fijada como decisión de arquitectura, el host exacto se conoce.
     */
    const s3Host = `https://*.s3.${props.region}.amazonaws.com`;
    const cognitoHost = `https://cognito-idp.${props.region}.amazonaws.com`;

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            // El navegador sube DIRECTO a S3 con el presigned POST, y habla con
            // Cognito para autenticarse. Nada más sale de esta página.
            `connect-src 'self' ${s3Host} ${cognitoHost}`,
            "frame-ancestors 'none'",
            "base-uri 'self'",
            // form-action hacia S3 no es un descuido: el presigned POST es
            // literalmente un <form> que apunta a S3. Sin esta directiva, la
            // propia CSP rompería la subida.
            `form-action 'self' ${s3Host}`,
          ].join('; '),
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN },
      },
    });

    /**
     * El prefijo /api existe SOLO para el navegador: es lo que permite que la
     * SPA y la API compartan origen y desaparezca el preflight CORS. La API no
     * sabe nada de él — sus rutas son /uploads y /documents.
     *
     * Sin este rewrite, CloudFront reenvía /api/uploads tal cual y API Gateway
     * devuelve 404 a todas las llamadas. Es el fallo más fácil de cometer con
     * este patrón y el más difícil de diagnosticar, porque el 404 lo devuelve
     * la API y todo el mundo mira el frontend.
     */
    const stripApiPrefix = new cloudfront.Function(this, 'StripApiPrefix', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Quita el prefijo /api antes de llegar a API Gateway',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  request.uri = request.uri.replace(/^\\/api/, '') || '/';
  return request;
}`),
    });

    const apiDomain = `${props.httpApi.apiId}.execute-api.${props.region}.amazonaws.com`;

    /**
     * El bucket de logs de CloudFront, explícito y NO por defecto.
     *
     * Si se deja que CloudFront lo cree solo (`enableLogging: true` sin
     * `logBucket`), CDK genera un bucket con DeletionPolicy=Retain. Consecuencia:
     * `cdk destroy` deja atrás un bucket que sigue recibiendo y cobrando logs, y
     * que además no se puede borrar a mano hasta vaciarlo. Es la fuga más
     * silenciosa de todo el stack: nadie la ve porque el destroy dice "OK".
     *
     * `objectOwnership: OBJECT_WRITER` no es opcional: el logging estándar de
     * CloudFront escribe mediante ACLs, y los buckets nuevos las traen
     * deshabilitadas (BUCKET_OWNER_ENFORCED). Sin esta línea el despliegue falla
     * con un error sobre ACLs que no menciona a CloudFront.
     */
    const logBucket = new s3.Bucket(this, 'CdnLogs', {
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Los logs de acceso son forenses, no un archivo histórico. 30 días cubren
      // cualquier investigación de incidente y evitan el gasto que nadie mira.
      lifecycleRules: [{ id: 'expirar-logs', expiration: Duration.days(30) }],
      removalPolicy: props.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !props.prod,
    });

    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      // OAC, no OAI: OAI es legacy, AWS ya no lo recomienda y no soporta SSE-KMS.
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(props.webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        'api/*': {
          origin: new origins.HttpOrigin(apiDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // Nunca cachear respuestas de la API, y reenviar el Authorization.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // EXCEPT_HOST_HEADER es obligatorio: si CloudFront reenviara el Host
          // del visitante, API Gateway no reconocería la petición como suya.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
          functionAssociations: [
            { function: stripApiPrefix, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
      defaultRootObject: 'index.html',
      // Angular es una SPA: las rutas del cliente no existen en S3.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
      // minimumProtocolVersion solo tiene efecto con certificado propio; con el
      // certificado por defecto de CloudFront la política es fija. Se activa
      // junto con el dominio propio.
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      logBucket,
      webAclId: props.deployWaf ? this.webAcl().attrArn : undefined,
    });
  }

  /**
   * El Web ACL. Su regla más importante NO es ninguna de las gestionadas.
   *
   * Es el rate limit sobre POST /api/uploads, y la razón es económica, no de
   * disponibilidad: cada permiso de subida que se concede se convierte en un
   * documento que cuesta tokens de Bedrock. Un atacante con un JWT válido no
   * necesita tumbar el servicio para hacer daño — le basta con pedir permisos
   * de subida en bucle y dejar que la factura crezca. Ese es el ataque de
   * "denial of wallet", y es el que casi nadie modela.
   *
   * El WAF es la primera de tres capas contra él: aquí el rate limit, en la
   * cola `maxConcurrency: 20`, y en AWS Budgets la alarma de gasto previsto.
   */
  private webAcl(): wafv2.CfnWebACL {
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName,
    });

    return new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: visibility('docflow-waf'),
      rules: [
        {
          name: 'RateLimitUploads',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 300, // peticiones por IP en 5 minutos
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/api/uploads',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: visibility('rate-limit-uploads'),
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
          },
          visibilityConfig: visibility('common-rules'),
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' },
          },
          visibilityConfig: visibility('bad-inputs'),
        },
        {
          name: 'AWSManagedRulesAmazonIpReputationList',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' },
          },
          visibilityConfig: visibility('ip-reputation'),
        },
      ],
    });
  }
}
