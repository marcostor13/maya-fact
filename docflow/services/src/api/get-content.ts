import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb, keys } from '../shared/ddb.js';
import { callerFrom } from '../shared/auth-context.js';
import { ok, notFound } from '../shared/http.js';
import { required } from '../shared/env.js';

const logger = new Logger({ serviceName: 'get-content' });
const s3 = new S3Client({});

const BUCKET = required('UPLOADS_BUCKET');
const TABLE = required('TABLE_NAME');

/**
 * Vida del enlace. **Segundos, no minutos.**
 *
 * El enlace se genera en el momento en que alguien pulsa «ver» y el navegador
 * lo consume acto seguido; nadie lo guarda. Cuanto más corto, menos vale si
 * acaba en el historial de un proxy o en el log de un tercero — que es
 * exactamente el escenario que se pregunta en una revisión de seguridad.
 */
const VALIDEZ_SEGUNDOS = 120;

/**
 * Lo que se puede devolver, y por qué es una lista blanca y no una comprobación.
 *
 * S3 servirá el objeto con el `Content-Type` que le digamos aquí (`Response
 * ContentType` forma parte de la firma, así que el cliente no puede cambiarlo).
 * Si ese tipo saliera del documento, un fichero HTML disfrazado de PDF podría
 * volver como `text/html` y ejecutarse **en el origen de S3, con la sesión del
 * revisor cerca**. Fijándolo a un tipo de esta lista, lo peor que pasa es que
 * el visor no sepa pintarlo.
 */
const TIPOS_SERVIBLES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff']);

/**
 * El nombre viaja en una cabecera `Content-Disposition` que S3 nos devolverá
 * tal cual. Una comilla o un salto de línea ahí es inyección de cabecera, así
 * que no se sanea: se reconstruye con un alfabeto cerrado. Es la diferencia
 * entre quitar lo malo (siempre se escapa algo) y dejar pasar solo lo bueno.
 */
function nombreParaCabecera(nombre: string | undefined, respaldo: string): string {
  const limpio = (nombre ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .trim()
    .slice(0, 80);
  return limpio || respaldo;
}

/**
 * GET /documents/{documentId}/content
 *
 * Devuelve un enlace firmado de vida corta para ver el documento original.
 *
 * ── Las tres comprobaciones, en este orden ───────────────────────────────
 *
 *  1. El documento se lee de **la partición del tenant del token**. Si es de
 *     otro cliente, no se encuentra: no hay un «y luego comparo el tenantId»
 *     que se pueda olvidar (mismo argumento que `get-document.ts`).
 *  2. La clave de S3 se toma **del ítem**, nunca de la petición. El cliente no
 *     dice qué objeto quiere: dice qué documento, y nosotros sabemos dónde vive.
 *  3. Aun así se comprueba que la clave empiece por el prefijo del tenant. Es
 *     redundante —la escribió el servidor en `POST /uploads`— y por eso mismo
 *     merece la pena: el día que alguien introduzca otra forma de escribir esa
 *     clave, esto falla en cerrado en vez de firmar lo que no debe.
 *
 * Y una limitación honesta, la misma del ADR-008: el rol de esta función puede
 * leer el prefijo `inbox` de cualquier tenant, así que el aislamiento por VALOR
 * lo da el paso 1, no IAM. IAM acota la FORMA de lo que se puede firmar.
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
      ProjectionExpression: 's3Key, contentType, fileName, #st',
      ExpressionAttributeNames: { '#st': 'status' },
    }),
  );

  const item = doc.Item as { s3Key?: string; contentType?: string; fileName?: string } | undefined;
  const s3Key = item?.s3Key;
  const contentType = item?.contentType;

  // 404 en los tres casos: no existe, es de otro tenant, o el archivo nunca
  // llegó a subirse. Distinguirlos aquí sería filtrar existencia (I-8).
  if (!s3Key || !contentType || !TIPOS_SERVIBLES.has(contentType)) return notFound();

  const prefijo = `tenants/${caller.tenantId}/inbox/`;
  if (!s3Key.startsWith(prefijo)) {
    logger.error('la clave del documento no cae bajo el prefijo de su tenant', { documentId });
    return notFound();
  }

  const fileName = nombreParaCabecera(item?.fileName, `${documentId}.pdf`);

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      // Ambas van FIRMADAS: forman parte de la URL canónica, así que cambiarlas
      // invalida la firma. El tipo lo decide esta lista blanca, no el fichero.
      ResponseContentType: contentType,
      ResponseContentDisposition: `inline; filename="${fileName}"`,
    }),
    { expiresIn: VALIDEZ_SEGUNDOS },
  );

  logger.info('enlace de visualizacion emitido', {
    documentId,
    tenantId: caller.tenantId,
    validezSegundos: VALIDEZ_SEGUNDOS,
  });

  return ok({ url, contentType, fileName, expiraEnSegundos: VALIDEZ_SEGUNDOS });
};
