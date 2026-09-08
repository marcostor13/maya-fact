import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { ddb, keys, ttlIn } from '../shared/ddb.js';
import { isTransient } from '../shared/errors.js';
import { required } from '../shared/env.js';

const logger = new Logger({ serviceName: 'consumer' });
const metrics = new Metrics({ namespace: 'DocFlow', serviceName: 'consumer' });
const sfn = new SFNClient({});

const TABLE = required('TABLE_NAME');
const STATE_MACHINE_ARN = required('STATE_MACHINE_ARN');

interface S3EventBridgeDetail {
  bucket: { name: string };
  object: { key: string; size: number; etag: string };
}

/**
 * Consumidor de la cola. Hace tres cosas y solo tres:
 *   1. Garantiza idempotencia (un documento se procesa una vez).
 *   2. Arranca la ejecución de Step Functions.
 *   3. Reporta fallos ITEM A ITEM, no por lote.
 *
 * El procesamiento real vive en la máquina de estados. Esta función es un
 * portero, no un trabajador: así se mantiene rápida, barata y fácil de razonar.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      if (isTransient(err)) {
        // Reintentable: lo devolvemos a la cola. Tras maxReceiveCount va a la DLQ.
        logger.error('fallo transitorio, se reintentará', { messageId: record.messageId, err });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        metrics.addMetric('TransientFailure', MetricUnit.Count, 1);
      } else {
        // Permanente: reintentarlo son tres facturas de OCR por nada.
        // Se consume el mensaje y el documento queda en cuarentena.
        logger.error('fallo permanente, no se reintenta', { messageId: record.messageId, err });
        metrics.addMetric('PermanentFailure', MetricUnit.Count, 1);
      }
    }
  }

  metrics.publishStoredMetrics();

  // ReportBatchItemFailures: sin esto, un solo mensaje malo en un lote de diez
  // hace que los diez se reprocesen.
  return { batchItemFailures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  const body = JSON.parse(record.body) as { detail: S3EventBridgeDetail };
  const { bucket, object } = body.detail;

  // La clave es tenants/<tenantId>/inbox/<documentId>
  const parts = object.key.split('/');
  const tenantId = parts[1];
  const documentId = parts[3];
  if (!tenantId || !documentId || parts[2] !== 'inbox') {
    // Un objeto en un sitio inesperado no es un error transitorio: es basura.
    logger.warn('clave S3 con forma inesperada, se descarta', { key: object.key });
    return;
  }

  // ---- Candado de idempotencia -------------------------------------------
  // La clave combina el objeto y su etag: si el usuario re-sube el MISMO
  // contenido, no se reprocesa; si sube contenido distinto sobre la misma
  // clave, sí. Esto es lo que sustituye a SQS FIFO, y lo hace mejor: FIFO
  // deduplica 5 minutos, esto deduplica para siempre (o hasta el TTL).
  const idemKey = `${object.key}#${object.etag}`;
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: keys.idemPk(idemKey),
          sk: 'LOCK',
          documentId,
          tenantId,
          lockedAt: new Date().toISOString(),
          expiresAt: ttlIn(7 * 24 * 3600),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      logger.info('entrega duplicada ignorada', { documentId, idemKey });
      metrics.addMetric('DuplicateSuppressed', MetricUnit.Count, 1);
      return; // éxito: ya está hecho
    }
    throw err;
  }

  // ---- Arranque, con liberación del candado si falla ----------------------
  // El candado se pone ANTES de arrancar la ejecución, que es lo correcto: si
  // se pusiera después, dos entregas simultáneas arrancarían dos ejecuciones.
  // Pero eso abre un agujero: si StartExecution falla, el candado queda puesto
  // y el reintento se suprime como "duplicado". El documento no se procesa
  // nunca y NO llega a la DLQ, porque desde fuera parece un éxito.
  // Por eso el candado se libera explícitamente en el camino de fallo.
  try {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        // Nombre determinista: segunda barrera contra ejecuciones duplicadas.
        name: `${documentId}-${object.etag}`.slice(0, 80),
        input: JSON.stringify({
          tenantId,
          documentId,
          bucket: bucket.name,
          key: object.key,
          sizeBytes: object.size,
          etag: object.etag,
        }),
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ExecutionAlreadyExists') {
      // La segunda barrera hizo su trabajo. Es un éxito, no un fallo.
      logger.info('la ejecución ya existía', { documentId });
      metrics.addMetric('DuplicateSuppressed', MetricUnit.Count, 1);
      return;
    }
    await liberarCandado(idemKey);
    throw err;
  }

  metrics.addMetric('ExecutionStarted', MetricUnit.Count, 1);
  logger.info('ejecución arrancada', { documentId, tenantId });
}

/** Deja el candado libre para que el reintento de SQS pueda volver a intentarlo. */
async function liberarCandado(idemKey: string): Promise<void> {
  try {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: keys.idemPk(idemKey), sk: 'LOCK' } }));
  } catch (err) {
    // Si tampoco se puede borrar, el TTL lo limpiará. Lo peor que pasa es que
    // el documento espere; que quede registrado es lo que permite verlo.
    logger.error('no se pudo liberar el candado de idempotencia', { idemKey, err });
  }
}
