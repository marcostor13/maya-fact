import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import { fn } from './lambda-defaults.js';

export interface PipelineProps {
  table: dynamodb.TableV2;
  uploads: s3.Bucket;
  modelId: string;
  prod: boolean;
}

export class Pipeline extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: PipelineProps) {
    super(scope, id);

    const src = (f: string) => path.join(__dirname, `../../services/src/pipeline/${f}`);
    const env = { TABLE_NAME: props.table.tableName };

    // ---- Cola y DLQ ---------------------------------------------------------
    this.dlq = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    // SQS Standard, NO FIFO. FIFO no da exactly-once de extremo a extremo: da
    // deduplicación de 5 minutos sobre SendMessage y orden por grupo, a cambio
    // de throughput. Lo que necesitamos es que reprocesar no cueste dos veces,
    // y eso es un candado condicional en DynamoDB (consumer.ts), no una
    // propiedad de la cola.
    this.queue = new sqs.Queue(this, 'Queue', {
      // Debe ser >= 6x el timeout de la función consumidora.
      visibilityTimeout: Duration.seconds(180),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
    });

    // ---- Pasos del pipeline -------------------------------------------------
    const classify = fn(this, 'Classify', {
      entry: src('classify.ts'),
      environment: env,
      memorySize: 1024,
      timeout: Duration.seconds(60),
    });
    props.uploads.grantRead(classify);

    const dedupe = fn(this, 'Dedupe', { entry: src('dedupe.ts'), environment: env });
    props.table.grantReadWriteData(dedupe);

    const extract = fn(this, 'Extract', {
      entry: src('extract.ts'),
      environment: { ...env, MODEL_ID: props.modelId },
      memorySize: 1024,
      timeout: Duration.seconds(120),
    });
    props.uploads.grantRead(extract);
    extract.addToRolePolicy(this.bedrockPolicy(props.modelId));

    // ---- OCR: la ruta cara, y por eso condicional ---------------------------
    const ocrStart = fn(this, 'OcrStart', { entry: src('ocr-start.ts'), timeout: Duration.seconds(60) });
    const ocrCollect = fn(this, 'OcrCollect', {
      entry: src('ocr-collect.ts'),
      memorySize: 1024,
      timeout: Duration.seconds(60),
    });
    props.uploads.grantRead(ocrStart);
    for (const f of [ocrStart, ocrCollect]) {
      f.addToRolePolicy(
        new iam.PolicyStatement({
          // Nombradas una a una. Nada de textract:* : esta función no necesita
          // AnalyzeDocument, que es hasta 43x más cara por página. Que IAM no
          // se lo permita convierte una decisión de coste en un control.
          actions: [
            'textract:DetectDocumentText',
            'textract:StartDocumentTextDetection',
            'textract:GetDocumentTextDetection',
          ],
          resources: ['*'], // Textract no soporta permisos por recurso
        }),
      );
    }

    const decide = fn(this, 'DecideAndPersist', {
      entry: src('decide-and-persist.ts'),
      environment: env,
      timeout: Duration.seconds(30),
    });
    props.table.grantReadWriteData(decide);

    const finalize = fn(this, 'Finalize', { entry: src('finalize.ts'), environment: env });
    props.table.grantWriteData(finalize);

    // ---- Máquina de estados -------------------------------------------------
    // Standard, no Express: el pipeline puede durar minutos, Express solo
    // soporta integraciones request-response (sin waitForTaskToken) y su
    // historial no es consultable por API.
    /**
     * `error: true` pasa `$.error` a la Lambda de cierre, y solo se activa en
     * los estados a los que se llega por un `addCatch` con
     * `resultPath: '$.error'`. Fuera de ellos ese campo no existe y la
     * referencia rompería la ejecución **en tiempo de ejecución**, que es
     * justo donde falla el lenguaje de estados y no el sintetizador.
     *
     * Sin esto, `finalize` recibía el motivo de la FASE («falló la
     * clasificación») y nunca el código concreto («no es un PDF»). El campo
     * `error` existía en su interfaz desde el principio: simplemente no se lo
     * mandaba nadie. Un parámetro opcional que nunca llega es indistinguible
     * de uno que no existe, y por eso duró tanto.
     */
    const cerrar = (
      nombre: string,
      status: string,
      motivo: string,
      opciones: { original?: boolean; error?: boolean } = {},
    ) =>
      new tasks.LambdaInvoke(this, nombre, {
        lambdaFunction: finalize,
        payloadResponseOnly: true,
        payload: sfn.TaskInput.fromObject({
          'tenantId.$': '$.tenantId',
          'documentId.$': '$.documentId',
          status,
          motivo,
          ...(opciones.original ? { 'documentIdOriginal.$': '$.dedupe.documentIdOriginal' } : {}),
          ...(opciones.error ? { 'error.$': '$.error' } : {}),
        }),
      });

    // Un fallo permanente (magic bytes desconocidos, 50.000 páginas) NO es un
    // error del sistema: es un documento que no se puede procesar. Se cierra
    // como QUARANTINED y NO pasa por la DLQ. Si apareciera en la DLQ, la
    // clasificación transitorio/permanente estaría mal.
    const enCuarentena = cerrar('Cuarentena', 'QUARANTINED', 'CLASIFICACION_FALLIDA', { error: true });
    // Degradación elegante: si la extracción no sale, el documento no se pierde
    // ni la ejecución falla. Cae a revisión humana: más lento, pero correcto.
    const aRevision = cerrar('ARevisionManual', 'NEEDS_REVIEW', 'EXTRACCION_FALLIDA', { error: true });
    const cerrarDuplicado = cerrar('CerrarDuplicado', 'DUPLICATE', 'CONTENIDO_YA_PROCESADO', { original: true });

    const classifyTask = new tasks.LambdaInvoke(this, 'Clasificar', {
      lambdaFunction: classify,
      payloadResponseOnly: true,
      resultPath: '$.classification',
    });
    classifyTask.addCatch(enCuarentena, { errors: ['States.ALL'], resultPath: '$.error' });

    const dedupeTask = new tasks.LambdaInvoke(this, 'Deduplicar', {
      lambdaFunction: dedupe,
      payloadResponseOnly: true,
      resultPath: '$.dedupe',
      payload: sfn.TaskInput.fromObject({
        'tenantId.$': '$.tenantId',
        'documentId.$': '$.documentId',
        'sha256.$': '$.classification.sha256',
      }),
    });

    const extractTask = new tasks.LambdaInvoke(this, 'Extraer', {
      lambdaFunction: extract,
      payloadResponseOnly: true,
      resultPath: '$.extraction',
      payload: sfn.TaskInput.fromObject({
        'tenantId.$': '$.tenantId',
        'documentId.$': '$.documentId',
        'bucket.$': '$.bucket',
        'key.$': '$.key',
        'route.$': '$.classification.route',
        'detectedMime.$': '$.classification.detectedMime',
        // Necesario para el tope de tokens de entrada (CLAUDE.md §2.5).
        'pageCount.$': '$.classification.pageCount',
      }),
    });

    // Reintentos declarativos: no hay que escribir backoff a mano en cada
    // Lambda. Solo se reintenta lo transitorio.
    const reintentarTransitorios = (t: tasks.LambdaInvoke) =>
      t.addRetry({
        errors: ['TransientError', 'ThrottlingException', 'ModelTimeoutException', 'Lambda.TooManyRequestsException'],
        interval: Duration.seconds(2),
        maxAttempts: 4,
        backoffRate: 2,
        maxDelay: Duration.seconds(30),
        jitterStrategy: sfn.JitterType.FULL,
      });
    reintentarTransitorios(extractTask);
    extractTask.addCatch(aRevision, { errors: ['States.ALL'], resultPath: '$.error' });

    const decideTask = new tasks.LambdaInvoke(this, 'DecidirYPersistir', {
      lambdaFunction: decide,
      payloadResponseOnly: true,
      resultPath: '$.decision',
      payload: sfn.TaskInput.fromObject({
        'tenantId.$': '$.tenantId',
        'documentId.$': '$.documentId',
        'sha256.$': '$.classification.sha256',
        'pageCount.$': '$.classification.pageCount',
        'extraction.$': '$.extraction',
      }),
    });

    // ---- La rama que compra OCR, y solo cuando compra algo ------------------
    // Aquí se materializa el ADR-011. El OCR no se paga por adelantado: se paga
    // cuando ya SABEMOS que un humano va a mirar el documento, que es cuando
    // las coordenadas y la confianza calibrada valen algo. En el resto del
    // volumen —la inmensa mayoría— Textract no se llama nunca.
    const ocrStartTask = new tasks.LambdaInvoke(this, 'OcrIniciar', {
      lambdaFunction: ocrStart,
      payloadResponseOnly: true,
      resultPath: '$.ocr',
      payload: sfn.TaskInput.fromObject({
        'documentId.$': '$.documentId',
        'bucket.$': '$.bucket',
        'key.$': '$.key',
        'pageCount.$': '$.classification.pageCount',
      }),
    });
    reintentarTransitorios(ocrStartTask);

    const ocrCollectTask = new tasks.LambdaInvoke(this, 'OcrRecoger', {
      lambdaFunction: ocrCollect,
      payloadResponseOnly: true,
      resultPath: '$.ocrCollect',
      payload: sfn.TaskInput.fromObject({
        'documentId.$': '$.documentId',
        'jobId.$': '$.ocr.jobId',
      }),
    });
    reintentarTransitorios(ocrCollectTask);

    // El Wait vive en la máquina, no dentro de una Lambda. Esperar a otro
    // servicio pagando tiempo de cómputo es el antipatrón de facturación más
    // común de un pipeline serverless; un Wait de Standard no cuesta cómputo.
    const esperarOcr = new sfn.Wait(this, 'EsperarOcr', { time: sfn.WaitTime.duration(Duration.seconds(5)) });

    // Normalizamos las dos procedencias posibles del OCR (síncrona y asíncrona)
    // en un solo sitio, para que exista UNA sola tarea de re-extracción.
    const ocrSincrono = new sfn.Pass(this, 'OcrSincrono', {
      resultPath: '$.ocrFinal',
      parameters: { 'resultado.$': '$.ocr.resultado' },
    });
    const ocrAsincrono = new sfn.Pass(this, 'OcrAsincrono', {
      resultPath: '$.ocrFinal',
      parameters: { 'resultado.$': '$.ocrCollect.resultado' },
    });

    const extractR3Task = new tasks.LambdaInvoke(this, 'ExtraerConGeometria', {
      lambdaFunction: extract,
      payloadResponseOnly: true,
      resultPath: '$.extraction',
      payload: sfn.TaskInput.fromObject({
        'tenantId.$': '$.tenantId',
        'documentId.$': '$.documentId',
        'bucket.$': '$.bucket',
        'key.$': '$.key',
        route: 'R3_TEXTRACT',
        'detectedMime.$': '$.classification.detectedMime',
        'pageCount.$': '$.classification.pageCount',
        'ocr.$': '$.ocrFinal.resultado',
      }),
    });
    reintentarTransitorios(extractR3Task);
    extractR3Task.addCatch(aRevision, { errors: ['States.ALL'], resultPath: '$.error' });

    // La segunda decisión es un estado APARTE, no un bucle de vuelta al primero.
    // Deliberado: un bucle podría pedir OCR otra vez sobre un documento que ya
    // lo tuvo, y eso es exactamente el gasto que este diseño existe para evitar.
    const decideR3Task = new tasks.LambdaInvoke(this, 'DecidirTrasOcr', {
      lambdaFunction: decide,
      payloadResponseOnly: true,
      resultPath: '$.decision',
      payload: sfn.TaskInput.fromObject({
        'tenantId.$': '$.tenantId',
        'documentId.$': '$.documentId',
        'sha256.$': '$.classification.sha256',
        'pageCount.$': '$.classification.pageCount',
        'extraction.$': '$.extraction',
      }),
    });

    const fin = new sfn.Succeed(this, 'Fin');

    // La rama de OCR corre DESPUÉS de que el documento ya tiene su decisión
    // persistida. Si Textract falla aquí, el resultado no se pierde: el
    // documento sigue en NEEDS_REVIEW, solo que sin coordenadas — el revisor
    // verá el campo dudoso sin resaltar. Degradar la UI es aceptable; hacer
    // fallar una ejecución que ya hizo su trabajo, no: ensuciaría la tasa de
    // error del pipeline con fallos que no afectan al resultado.
    const sinGeometria = new sfn.Pass(this, 'SinGeometria', {
      comment: 'El OCR no salió. El documento conserva su decisión, sin bbox.',
      resultPath: sfn.JsonPath.DISCARD,
    });
    sinGeometria.next(fin);
    for (const t of [ocrStartTask, ocrCollectTask]) {
      t.addCatch(sinGeometria, { errors: ['States.ALL'], resultPath: '$.errorOcr' });
    }

    const ocrListo = new sfn.Choice(this, 'OcrYaDisponible')
      .when(sfn.Condition.booleanEquals('$.ocr.listo', true), ocrSincrono)
      .otherwise(esperarOcr);

    const ocrTermino = new sfn.Choice(this, 'OcrTermino')
      .when(sfn.Condition.stringEquals('$.ocrCollect.estado', 'SUCCEEDED'), ocrAsincrono)
      .otherwise(esperarOcr);

    esperarOcr.next(ocrCollectTask);
    ocrCollectTask.next(ocrTermino);
    ocrSincrono.next(extractR3Task);
    ocrAsincrono.next(extractR3Task);
    extractR3Task.next(decideR3Task);
    decideR3Task.next(fin);

    const necesitaGeometria = new sfn.Choice(this, 'NecesitaGeometria')
      .when(
        sfn.Condition.and(
          sfn.Condition.stringEquals('$.decision.status', 'NEEDS_REVIEW'),
          // Guardarraíl: si ya vino por R3, no se vuelve a comprar OCR.
          sfn.Condition.not(sfn.Condition.stringEquals('$.classification.route', 'R3_TEXTRACT')),
        ),
        ocrStartTask,
      )
      .otherwise(fin);

    ocrStartTask.next(ocrListo);
    decideTask.next(necesitaGeometria);

    // Hay DOS puertas de entrada a la rama de OCR, y son conceptualmente
    // distintas:
    //  - esta: el clasificador dice que el modelo no puede leer el archivo
    //    (TIFF). El OCR es el único camino, no una mejora.
    //  - `NecesitaGeometria`, más abajo: el documento ya se extrajo y va a
    //    revisión humana. El OCR compra coordenadas y confianza calibrada.
    // Las dos convergen en la misma rama y ninguna puede disparar a la otra:
    // el guardarraíl de `NecesitaGeometria` excluye los que ya vinieron por R3.
    const necesitaOcrDeEntrada = new sfn.Choice(this, 'ModeloPuedeLeerlo')
      .when(
        sfn.Condition.stringEquals('$.classification.route', 'R3_TEXTRACT'),
        ocrStartTask,
      )
      .otherwise(extractTask.next(decideTask));

    const esDuplicado = new sfn.Choice(this, 'EsDuplicado')
      .when(sfn.Condition.booleanEquals('$.dedupe.duplicado', true), cerrarDuplicado)
      .otherwise(necesitaOcrDeEntrada);

    this.stateMachine = new sfn.StateMachine(this, 'Sm', {
      definitionBody: sfn.DefinitionBody.fromChainable(
        classifyTask.next(dedupeTask).next(esDuplicado),
      ),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: Duration.minutes(15),
      tracingEnabled: true,
      logs: {
        // removalPolicy explícito: un LogGroup de CDK es RETAIN por defecto, así
        // que sin esta línea `cdk destroy` deja el grupo de logs atrás y el
        // siguiente despliegue choca con un nombre ya existente.
        destination: new logs.LogGroup(this, 'SmLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: props.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });

    // ---- Consumidor ---------------------------------------------------------
    const consumer = fn(this, 'Consumer', {
      entry: src('consumer.ts'),
      environment: { ...env, STATE_MACHINE_ARN: this.stateMachine.stateMachineArn },
      timeout: Duration.seconds(30),
    });
    // grantWriteData incluye DeleteItem, que el consumidor necesita para
    // liberar el candado de idempotencia si StartExecution falla.
    props.table.grantWriteData(consumer);
    this.stateMachine.grantStartExecution(consumer);

    consumer.addEventSource(
      new lambdaEventSources.SqsEventSource(this.queue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        // Sin esto, un mensaje malo en un lote de diez reprocesa los diez.
        reportBatchItemFailures: true,
        // Techo de concurrencia: protege a Bedrock y a Textract de nuestro
        // propio pico de fin de mes, y protege la factura de un abuso.
        maxConcurrency: 20,
      }),
    );

    // ---- S3 -> EventBridge -> SQS -------------------------------------------
    // Se podría ir de S3 directo a SQS (un salto menos). Elegimos EventBridge
    // por el filtrado declarativo y porque mañana habrá fan-out (auditoría,
    // facturación, webhooks) sin tocar el productor.
    new events.Rule(this, 'ObjectCreatedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.uploads.bucketName] },
          object: { key: [{ prefix: 'tenants/' }] },
        },
      },
      targets: [new targets.SqsQueue(this.queue)],
    });
  }

  /**
   * Permiso de Bedrock acotado a UN modelo. El detalle que casi siempre está
   * mal: `us.amazon.nova-lite-v1:0` NO es un foundation model, es un perfil de
   * inferencia entre regiones. Invocarlo exige DOS permisos —el perfil, que es
   * un recurso de tu cuenta, y los modelos base de cada región a la que el
   * perfil enruta— y el id del modelo base no lleva el prefijo `us.`.
   * Conceder solo el ARN de foundation-model con el prefijo puesto es un
   * AccessDenied garantizado en la primera invocación.
   */
  private bedrockPolicy(modelId: string): iam.PolicyStatement {
    const esPerfil = /^(us|eu|apac|global)\./.test(modelId);
    const modeloBase = modelId.replace(/^(us|eu|apac|global)\./, '');
    return new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/${modeloBase}`,
        ...(esPerfil ? [`arn:aws:bedrock:*:*:inference-profile/${modelId}`] : []),
      ],
    });
  }
}
