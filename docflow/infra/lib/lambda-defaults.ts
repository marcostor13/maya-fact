import { Duration, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Valores por defecto aplicados a TODAS las funciones. Que estén en un solo
 * sitio es lo que hace que "todas las Lambdas tienen tracing y retención de
 * logs acotada" sea una verdad verificable y no una intención.
 */
export function fn(scope: Construct, id: string, props: NodejsFunctionProps): NodejsFunction {
  return new NodejsFunction(scope, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    // ARM64: el precio por GB-segundo es 20% menor. El cargo por invocación es
    // idéntico, así que el ahorro real de una función corta es menor de 20%.
    architecture: lambda.Architecture.ARM_64,
    memorySize: 512,
    timeout: Duration.seconds(30),
    tracing: lambda.Tracing.ACTIVE,
    // El gasto silencioso que nadie mira hasta que llega la factura.
    // logGroup explícito, no la propiedad `logRetention` (deprecada: creaba una
    // Lambda custom-resource extra solo para ajustar la retención).
    logGroup: new logs.LogGroup(scope, `${id}Logs`, {
      // El nombre lleva el del stack: sin él, desplegar DocFlow-Dev y
      // DocFlow-Prod en la misma cuenta choca por nombre de log group y el
      // segundo despliegue falla a mitad.
      logGroupName: `/aws/lambda/${Stack.of(scope).stackName.toLowerCase()}-${id.toLowerCase()}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    }),
    bundling: { minify: true, sourceMap: true },
    ...props,
    // OJO AL ORDEN: `environment` va DESPUÉS de `...props`, no antes.
    // Estaba antes, y el spread la sobrescribía entera con la del llamante:
    // ninguna función recibía POWERTOOLS_* ni --enable-source-maps, así que los
    // logs estructurados salían sin nombre de servicio y los stack traces
    // apuntaban al bundle minificado. Un fallo de una línea que anulaba toda la
    // observabilidad sin romper el despliegue: el peor tipo de fallo.
    environment: {
      NODE_OPTIONS: '--enable-source-maps',
      POWERTOOLS_SERVICE_NAME: id,
      POWERTOOLS_METRICS_NAMESPACE: 'DocFlow',
      ...props.environment,
    },
  });
}
