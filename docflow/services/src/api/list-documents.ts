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

  /**
   * El cursor es entrada de un tercero y se decodifica DENTRO de un try/catch
   * (CLAUDE.md §2.2).
   *
   * Sin él, un cursor manipulado —`?cursor=xxx`— hace que `JSON.parse` lance,
   * la Lambda termine en error no capturado y API Gateway devuelva un 500. Ese
   * 500 es un regalo para quien esté sondeando: confirma que el parámetro se
   * deserializa en el servidor, y en cuanto alguien active un handler de error
   * más hablador, empieza a filtrar la estructura de las claves de DynamoDB.
   *
   * Un dato de entrada malformado es un 400, nunca un 500: el 500 dice «me has
   * roto», el 400 dice «eso no es válido». Solo uno de los dos invita a seguir.
   */
  let inicio: Record<string, unknown> | undefined;
  const cursor = event.queryStringParameters?.cursor;
  if (cursor) {
    try {
      inicio = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (!inicio || typeof inicio !== 'object' || Array.isArray(inicio)) throw new Error('forma');
    } catch {
      return fail(400, 'CURSOR_INVALIDO');
    }
  }

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': keys.gsi1pk(caller.tenantId, status) },
      ScanIndexForward: false, // más recientes primero
      Limit: limit,
      ExclusiveStartKey: inicio,
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
