import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb, keys } from '../shared/ddb.js';
import { callerFrom } from '../shared/auth-context.js';
import { ok, notFound } from '../shared/http.js';
import { required } from '../shared/env.js';

const TABLE = required('TABLE_NAME');

/**
 * GET /documents/{documentId}
 *
 * Aquí vive el riesgo número uno de todo el sistema: IDOR (OWASP A01).
 *
 * La defensa NO es "comprobar si el documento pertenece al tenant después de
 * leerlo". Es que el tenant forma parte de la CLAVE DE PARTICIÓN, así que una
 * lectura cruzada no devuelve el ítem de otro: no lo encuentra.
 *
 * Y hay una segunda capa que no se ve aquí: la política IAM de esta función
 * lleva una condición dynamodb:LeadingKeys. Aunque este código tuviera un bug,
 * IAM rechazaría la lectura.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const caller = callerFrom(event);
  const documentId = event.pathParameters?.documentId;
  if (!documentId) return notFound();

  const doc = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: keys.tenant(caller.tenantId), sk: keys.doc(documentId) },
    }),
  );

  // 404 tanto si no existe como si es de otro tenant: no filtramos existencia.
  if (!doc.Item) return notFound();

  const fields = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': keys.tenant(caller.tenantId),
        ':prefix': `DOC#${documentId}#FIELD#`,
      },
    }),
  );

  return ok({
    document: doc.Item,
    fields: fields.Items ?? [],
    original: await originalDe(caller.tenantId, doc.Item['documentIdOriginal']),
  });
};

/**
 * El documento del que este es copia, si lo es.
 *
 * «Duplicada» a secas es una respuesta incompleta: la pregunta que sigue
 * siempre es *¿duplicada de cuál?*. El identificador ya estaba guardado desde
 * que existe la deduplicación; lo que faltaba era resolverlo a algo que una
 * persona pueda reconocer —un nombre y una fecha— para poder ir a mirarlo.
 *
 * Se lee de la MISMA partición del tenant que la llamada de arriba, así que no
 * abre ningún camino nuevo: si el original fuera de otro cliente, y no puede
 * serlo porque la clave de deduplicación lleva el tenant dentro, tampoco se
 * encontraría.
 */
async function originalDe(tenantId: string, documentIdOriginal: unknown) {
  if (typeof documentIdOriginal !== 'string' || !documentIdOriginal) return null;

  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: keys.tenant(tenantId), sk: keys.doc(documentIdOriginal) },
      ProjectionExpression: 'documentId, fileName, #st, updatedAt',
      ExpressionAttributeNames: { '#st': 'status' },
    }),
  );

  // Puede no estar: el original se pudo borrar. Devolver el id igualmente es
  // mejor que devolver null, porque sigue siendo la referencia de auditoría.
  return res.Item ?? { documentId: documentIdOriginal };
}
