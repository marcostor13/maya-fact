import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { ddb, keys } from '../shared/ddb.js';
import { required } from '../shared/env.js';

const logger = new Logger({ serviceName: 'dedupe' });
const metrics = new Metrics({ namespace: 'DocFlow', serviceName: 'dedupe' });
const TABLE = required('TABLE_NAME');

export interface DedupeInput {
  tenantId: string;
  documentId: string;
  sha256: string;
}

export interface DedupeOutput {
  duplicado: boolean;
  documentIdOriginal: string | null;
}

/**
 * Deduplicación por hash del CONTENIDO, dentro del tenant.
 *
 * Es la palanca de coste más simple del sistema y la más fácil de olvidar. En
 * B2B reenviar la misma factura es rutina: el proveedor la manda por email, el
 * administrativo la vuelve a subir, un reintento del cliente la duplica. Sin
 * esto, cada reenvío es una extracción pagada otra vez.
 *
 * Fíjate en que es EL MISMO mecanismo que da idempotencia en el consumidor —un
 * `ConditionExpression` sobre una clave derivada del contenido— aplicado a otro
 * eje. Un mecanismo, dos beneficios: no pagar dos veces y no procesar dos veces.
 *
 * Y una diferencia deliberada con el candado del consumidor: aquí NO hay TTL.
 * El candado de entrega es temporal porque protege de una reentrega de SQS; el
 * registro de contenido es permanente porque protege de que el mismo documento
 * vuelva dentro de seis meses. Ponerle TTL sería reintroducir el problema que
 * FIFO tiene y que este diseño evita: una ventana de deduplicación finita.
 */
export const handler = async (input: DedupeInput): Promise<DedupeOutput> => {
  const pk = keys.dedupePk(input.tenantId, input.sha256);

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk,
          sk: 'DEDUPE',
          documentId: input.documentId,
          tenantId: input.tenantId,
          sha256: input.sha256,
          createdAt: new Date().toISOString(),
        },
        // Quien gane esta condición es el original. El resto son copias.
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return { duplicado: false, documentIdOriginal: null };
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }

  const original = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk, sk: 'DEDUPE' } }));
  const documentIdOriginal = (original.Item?.documentId as string | undefined) ?? null;

  // Esta métrica es dinero, no salud: cada punto es una extracción que no se
  // pagó. Está en el dashboard junto a los tokens consumidos precisamente para
  // poder enseñar el ahorro al lado del gasto.
  metrics.addMetric('DuplicateSuppressed', MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
  logger.info('contenido duplicado, se omite la extracción', {
    documentId: input.documentId,
    documentIdOriginal,
    sha256: input.sha256,
  });

  return { duplicado: true, documentIdOriginal };
};
