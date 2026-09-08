import { TransactWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { ddb, keys } from '../shared/ddb.js';
import { required } from '../shared/env.js';
import { evaluar } from './rules-engine.js';
import { reconciliarImportes } from './reconciliar.js';
import type { Decision, ExtractionResult, RuleSet } from '../shared/types.js';
import ruleSetLocal from '../../../rules/acme-invoices.json';

const logger = new Logger({ serviceName: 'decide-and-persist' });
const metrics = new Metrics({ namespace: 'DocFlow', serviceName: 'decide' });
const TABLE = required('TABLE_NAME');

export interface DecideInput {
  tenantId: string;
  documentId: string;
  sha256: string;
  pageCount: number;
  extraction: ExtractionResult;
}

type TxItem =
  | { Put: { TableName: string; Item: Record<string, unknown> } }
  | {
      Update: {
        TableName: string;
        Key: Record<string, unknown>;
        UpdateExpression: string;
        ExpressionAttributeNames: Record<string, string>;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };

export const handler = async (input: DecideInput): Promise<Decision> => {
  const ruleSet = await cargarRuleSet(input.tenantId);

  // Reconciliación ANTES de las reglas: lo que se puede derivar se deriva, para
  // que el motor juzgue datos coherentes en vez de errores de lectura. Los
  // ajustes se registran: una corrección silenciosa no sería auditable.
  const { fields, ajustes } = reconciliarImportes(input.extraction);
  const extraccion = { ...input.extraction, fields };

  const decision = evaluar(extraccion, ruleSet);
  if (ajustes.length) logger.info('importes reconciliados', { documentId: input.documentId, ajustes });

  const now = new Date().toISOString();

  // Una sola transacción: el documento, sus campos y el evento de auditoría
  // entran juntos o no entra ninguno. Un documento nunca queda a medio escribir.
  const items: TxItem[] = [
    {
      // UPDATE, no PUT. Un Put reemplaza el ítem entero y se llevaría por
      // delante fileName, contentType, s3Key, createdAt y uploadedBy, que los
      // escribió POST /uploads y nadie vuelve a escribir. Además, el REMOVE de
      // expiresAt es lo que desactiva el TTL de 24 h del intent: sin él, un
      // documento ya procesado desaparecería solo al día siguiente.
      Update: {
        TableName: TABLE,
        Key: { pk: keys.tenant(input.tenantId), sk: keys.doc(input.documentId) },
        UpdateExpression:
          'SET #st = :st, gsi1pk = :g1pk, gsi1sk = :g1sk, #rt = :rt, pageCount = :pc, sha256 = :sha,' +
          ' hits = :hits, camposBajoUmbral = :cbu, lineas = :lineas, ajustes = :ajustes,' +
          ' modelId = :model, promptVersion = :pv, rulesetVersion = :rv,' +
          ' inputTokens = :ti, outputTokens = :to, updatedAt = :now' +
          ' REMOVE expiresAt',
        ExpressionAttributeNames: { '#st': 'status', '#rt': 'route' },
        ExpressionAttributeValues: {
          ':st': decision.status,
          ':g1pk': keys.gsi1pk(input.tenantId, decision.status),
          ':g1sk': keys.gsi1sk(now, input.documentId),
          ':rt': input.extraction.route,
          ':pc': input.pageCount,
          ':sha': input.sha256,
          ':hits': decision.hits,
          ':cbu': decision.camposBajoUmbral,
          ':lineas': extraccion.lineas ?? [],
          ':ajustes': ajustes,
          // El trío que hace auditable cualquier decisión, para siempre.
          ':model': input.extraction.modelId,
          ':pv': input.extraction.promptVersion,
          ':rv': decision.rulesetVersion,
          ':ti': input.extraction.inputTokens ?? 0,
          ':to': input.extraction.outputTokens ?? 0,
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
          tipo: 'DECISION',
          status: decision.status,
          hits: decision.hits,
          rulesetVersion: decision.rulesetVersion,
          at: now,
        },
      },
    },
  ];

  for (const [name, f] of Object.entries(extraccion.fields)) {
    items.push({
      Put: {
        TableName: TABLE,
        Item: {
          pk: keys.tenant(input.tenantId),
          sk: keys.field(input.documentId, name),
          documentId: input.documentId,
          nombre: name,
          ...f,
        },
      },
    });
  }

  // TransactWrite admite hasta 100 acciones. El esquema tiene 9 campos + doc +
  // evento = 11, así que una transacción basta y la atomicidad es real. Si
  // alguna vez no cupiera, trocear NO sería la respuesta: dos transacciones no
  // son una transacción. Fallar fuerte es preferible a escribir a medias.
  if (items.length > 100) {
    throw new Error(`Demasiadas acciones (${items.length}) para una transacción atómica`);
  }
  await ddb.send(new TransactWriteCommand({ TransactItems: items }));

  metrics.addMetric(`Decision_${decision.status}`, MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
  logger.info('decisión persistida', {
    documentId: input.documentId,
    status: decision.status,
    reglas: decision.hits.map((h) => h.id),
  });

  return decision;
};

/**
 * En producción esto lee el ruleset del tenant desde DynamoDB con caché en
 * memoria (los rulesets cambian poco y la Lambda se reutiliza). El fichero
 * local es el valor por defecto y el que usan los evals.
 */
async function cargarRuleSet(tenantId: string): Promise<RuleSet> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: keys.tenant(tenantId), sk: 'RULESET#ACTIVE' } }),
  );
  return (res.Item?.ruleSet as RuleSet) ?? (ruleSetLocal as unknown as RuleSet);
}
