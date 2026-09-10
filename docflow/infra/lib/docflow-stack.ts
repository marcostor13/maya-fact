import { Annotations, CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Data } from './data.js';
import { Storage } from './storage.js';
import { Auth } from './auth.js';
import { Api } from './api.js';
import { Pipeline } from './pipeline.js';
import { Web } from './web.js';
import { Observability } from './observability.js';

export interface DocFlowStackProps extends StackProps {
  prod: boolean;
  modelId: string;
  alarmEmail?: string;
  monthlyBudgetUsd: number;
}

export class DocFlowStack extends Stack {
  constructor(scope: Construct, id: string, props: DocFlowStackProps) {
    super(scope, id, props);

    // Etiquetas de asignación de coste: sin esto no puedes responder
    // "cuánto me cuesta este cliente".
    Tags.of(this).add('app', 'docflow');
    Tags.of(this).add('env', props.prod ? 'prod' : 'dev');

    const storage = new Storage(this, 'Storage', {
      prod: props.prod,
      allowedOrigins: ['http://localhost:4200'],
    });
    const data = new Data(this, 'Data', { prod: props.prod });
    const auth = new Auth(this, 'Auth', { prod: props.prod });

    const api = new Api(this, 'Api', {
      table: data.table,
      uploads: storage.uploads,
      userPool: auth.userPool,
      client: auth.client,
      region: this.region,
    });

    const pipeline = new Pipeline(this, 'Pipeline', {
      table: data.table,
      uploads: storage.uploads,
      modelId: props.modelId,
      prod: props.prod,
    });

    // El Web ACL de CloudFront SOLO puede crearse en us-east-1. Fuera de ahí, el
    // stack despliega igual pero SIN WAF — y un control de seguridad que
    // desaparece callado es peor que uno que nunca estuvo, porque el diagrama
    // sigue diciendo que está. Por eso se avisa en cada synth.
    const deployWaf = props.env?.region === 'us-east-1';
    if (!deployWaf) {
      Annotations.of(this).addWarning(
        `Región ${props.env?.region ?? '(sin definir)'}: NO se crea el Web ACL de WAF ` +
          '(CloudFront solo lo admite en us-east-1). El rate limit contra denial of wallet ' +
          'queda únicamente en maxConcurrency de SQS y en la alarma de presupuesto. ' +
          'Despliega en us-east-1 o crea el Web ACL en un stack aparte y pasa su ARN.',
      );
    }

    const web = new Web(this, 'Web', {
      webBucket: storage.web,
      httpApi: api.httpApi,
      region: this.region,
      prod: props.prod,
      deployWaf,
    });

    // El CORS del bucket de subidas se añade AQUÍ, no en Storage, porque
    // necesita el dominio de CloudFront, que no existe hasta que Web está
    // creado. Parece una dependencia circular y no lo es: la distribución
    // depende del bucket WEB, y el CORS cuelga del bucket de SUBIDAS. Son
    // buckets distintos, así que el grafo sigue siendo un árbol.
    //
    // Sin esta línea, la SPA desplegada no puede subir nada: el navegador
    // bloquea el POST a S3 porque el único origen permitido era localhost. Es
    // un fallo que no aparece en desarrollo y solo se ve en producción.
    storage.uploads.addCorsRule({
      // POST para subir, GET para que el visor lea el documento original con el
      // enlace firmado que emite GET /documents/{id}/content.
      allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.GET],
      allowedOrigins: [`https://${web.distribution.distributionDomainName}`],
      allowedHeaders: ['*'],
      maxAge: 3000,
    });

    new Observability(this, 'Obs', {
      queue: pipeline.queue,
      dlq: pipeline.dlq,
      stateMachine: pipeline.stateMachine,
      alarmEmail: props.alarmEmail,
      monthlyBudgetUsd: props.monthlyBudgetUsd,
    });

    new CfnOutput(this, 'ApiUrl', { value: api.httpApi.apiEndpoint });
    new CfnOutput(this, 'CdnUrl', { value: `https://${web.distribution.distributionDomainName}` });
    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: auth.client.userPoolClientId });
    new CfnOutput(this, 'UploadsBucket', { value: storage.uploads.bucketName });
    new CfnOutput(this, 'WebBucket', { value: storage.web.bucketName });
    new CfnOutput(this, 'TableName', { value: data.table.tableName });
    new CfnOutput(this, 'DlqUrl', { value: pipeline.dlq.queueUrl });
  }
}
