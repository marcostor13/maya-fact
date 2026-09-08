import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb, keys } from '../shared/ddb.js';
import { callerFrom } from '../shared/auth-context.js';
import { ok, fail } from '../shared/http.js';
import { required } from '../shared/env.js';

const TABLE = required('TABLE_NAME');
const VALID = new Set(['PENDING', 'RECEIVED', 'PROCESSING', 'APPROVED', 'NEEDS_REVIEW', 'REJECTED', 'DUPLICATE', 'QUARANTINED']);

/** GET /documents?status=NEEDS_REVIEW&limit=25&cursor=... — usa GSI1. */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const caller = callerFrom(event);
  const status = event.queryStringParameters?.status ?? 'NEEDS_REVIEW';
  if (!VALID.has(status)) return fail(400, 'STATUS_INVALIDO');

  const limit = Math.min(Number(event.queryStringParameters?.limit ?? 25), 100);
  const cursor = event.queryStringParameters?.cursor;

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': keys.gsi1pk(caller.tenantId, status) },
      ScanIndexForward: false, // más recientes primero
      Limit: limit,
      ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : undefined,
    }),
  );

  return ok({
    // `updatedAt` NO está en la proyección del GSI1, así que las consultas al
    // índice lo devolvían vacío. La solución no es ampliar la proyección
    // —cambiar los atributos de un índice INCLUDE obliga a recrearlo— sino caer
    // en la cuenta de que el dato ya está ahí: `gsi1sk` es `<timestamp>#<id>`,
    // y las claves del índice se proyectan SIEMPRE. Se deriva y no se paga
    // almacenamiento extra por duplicar el mismo dato dos veces.
    items: (res.Items ?? []).map((it) => ({
      ...it,
      updatedAt: it['updatedAt'] ?? String(it['gsi1sk'] ?? '').split('#')[0] ?? null,
    })),
    cursor: res.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString('base64url')
      : null,
  });
};
