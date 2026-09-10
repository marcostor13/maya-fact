import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { ddb, keys } from '../shared/ddb.js';
import { required } from '../shared/env.js';
import { codigoDeCausa, explicarCierre } from '../shared/explicacion.js';
import type { DocumentStatus } from '../shared/types.js';

const logger = new Logger({ serviceName: 'finalize' });
const metrics = new Metrics({ namespace: 'DocFlow', serviceName: 'finalize' });
const TABLE = required('TABLE_NAME');

export interface FinalizeInput {
  tenantId: string;
  documentId: string;
  status: Extract<DocumentStatus, 'QUARANTINED' | 'NEEDS_REVIEW' | 'DUPLICATE'>;
  motivo: string;
  /** Solo en DUPLICATE: el documento cuyo contenido ya se procesó. */
  documentIdOriginal?: string;
  /**
   * El objeto de error de Step Functions: `{ Error, Cause }`.
   *
   * Durante un tiempo esta propiedad existía y **nunca llegaba**: la máquina de
   * estados no la pasaba en el payload, así que el motivo que veía el cliente
   * era siempre el genérico de la fase. El `Cause` no sale de aquí —lleva
   * trazas de pila y nombres de recursos (I-7)—, pero el CÓDIGO que trae dentro
   * es lo que convierte «no se pudo procesar» en «esto no es un PDF».
   */
  error?: { Error?: string; Cause?: string };
}

/**
 * Cierra un documento por el camino de fallo.
 *
 * Existe porque el pipeline tenía un agujero silencioso: los estados Pass de
 * cuarentena y revisión no escribían NADA. El documento se quedaba en PENDING
 * con el TTL de 24 h del intent puesto y, al día siguiente, desaparecía. Desde
 * fuera parecía degradación elegante; en realidad era pérdida de datos.
 *
 * Escribir el estado terminal es lo que convierte "el documento no se pierde"
 * de una intención en una propiedad verificable: `smoke.sh` la comprueba, y la
 * prueba del .txt renombrado a .pdf termina en QUARANTINED, no en la DLQ.
 */
export const handler = async (input: FinalizeInput): Promise<{ status: string }> => {
  const now = new Date().toISOString();

  // El código concreto (MIME_DESCONOCIDO, DEMASIADAS_PAGINAS…) manda sobre el
  // motivo de fase: «esto no es un PDF» le sirve al cliente, «falló la
  // clasificación» no le sirve para nada.
  const codigo = codigoDeCausa(input.error?.Cause);
  const explicacion = explicarCierre(input.motivo, codigo);

  // El detalle del error va al log y al evento de auditoría, NUNCA al cliente:
  // un Cause de Step Functions lleva stack traces y nombres de recursos.
  logger.error('documento cerrado por el camino de fallo', {
    documentId: input.documentId,
    tenantId: input.tenantId,
    status: input.status,
    motivo: input.motivo,
    codigo,
    causa: input.error?.Cause,
  });

  try {
    await escribirCierre(input, now, codigo, explicacion);
  } catch (err) {
    // La condición falló: el documento YA tiene una decisión firme. No es un
    // error, es la carrera que la condición existe para ganar. Idempotente.
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      logger.info('el documento ya tenía decisión firme, no se pisa', { documentId: input.documentId });
      return { status: input.status };
    }
    throw err;
  }

  metrics.addMetric(`Decision_${input.status}`, MetricUnit.Count, 1);
  metrics.publishStoredMetrics();

  return { status: input.status };
};

async function escribirCierre(
  input: FinalizeInput,
  now: string,
  codigo: string | undefined,
  explicacion: { resumen: string; detalles: string[] },
): Promise<void> {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { pk: keys.tenant(input.tenantId), sk: keys.doc(input.documentId) },
            // REMOVE expiresAt: el documento deja de ser un intent efímero y
            // pasa a ser un registro con retención de negocio.
            UpdateExpression:
              'SET #st = :st, gsi1pk = :g1pk, gsi1sk = :g1sk, motivo = :motivo,' +
              ' motivoCodigo = :codigo, explicacion = :expl,' +
              ' documentIdOriginal = :orig, updatedAt = :now REMOVE expiresAt',
            // Solo cierra un documento que aún no tiene decisión: si una
            // ejecución tardía llegara después de la buena, no la pisa.
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(rulesetVersion)',
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: {
              ':st': input.status,
              ':g1pk': keys.gsi1pk(input.tenantId, input.status),
              ':g1sk': keys.gsi1sk(now, input.documentId),
              ':motivo': input.motivo,
              // null explícito por la misma razón que `documentIdOriginal`: el
              // atributo existe siempre, así que la interfaz no distingue
              // «sin código» de «documento anterior a esta versión».
              ':codigo': codigo ?? null,
              // Se persiste el TEXTO, no solo el código: dentro de seis meses
              // el catálogo puede haber cambiado y el registro debe seguir
              // diciendo lo que se le dijo al cliente aquel día.
              ':expl': explicacion,
              // null explícito y no ausencia: el atributo existe siempre, así
              // que la UI no tiene que distinguir "no es duplicado" de "campo
              // que todavía no escribíamos en la versión anterior del pipeline".
              ':orig': input.documentIdOriginal ?? null,
              ':now': now,
            },
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: {
              pk: keys.tenant(input.tenantId),
              sk: keys.event(input.documentId, now),
              tipo: 'FALLO',
              status: input.status,
              motivo: input.motivo,
              motivoCodigo: codigo ?? null,
              explicacion: explicacion.resumen,
              errorTipo: input.error?.Error,
              at: now,
            },
          },
        },
      ],
    }),
  );
}
