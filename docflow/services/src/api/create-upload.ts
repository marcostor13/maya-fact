import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { S3Client } from '@aws-sdk/client-s3';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { ddb, keys, ttlIn } from '../shared/ddb.js';
import { callerFrom } from '../shared/auth-context.js';
import { ok, fail } from '../shared/http.js';
import { required } from '../shared/env.js';

const logger = new Logger({ serviceName: 'create-upload' });
const s3 = new S3Client({});

const BUCKET = required('UPLOADS_BUCKET');
const TABLE = required('TABLE_NAME');

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff']);

/**
 * POST /uploads
 *
 * Devuelve un presigned POST para que el navegador suba DIRECTO a S3.
 *
 * Por qué no subir por la API:
 *  - API Gateway tiene un límite duro de 10 MB de payload (REST y HTTP API).
 *  - Pagarías transferencia, ejecución y memoria de Lambda por mover bytes.
 *  - El archivo tocaría tu backend antes de haber sido validado.
 *
 * Las `conditions` del presigned son controles de seguridad reales, aplicados
 * por S3, no por nuestro código: aunque el cliente manipule el formulario, S3
 * rechaza lo que no cumpla.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const caller = callerFrom(event);
  const body = JSON.parse(event.body ?? '{}') as { fileName?: string; contentType?: string; sizeBytes?: number };

  if (!body.contentType || !ALLOWED.has(body.contentType)) return fail(400, 'CONTENT_TYPE_NO_PERMITIDO');
  if (!body.sizeBytes || body.sizeBytes <= 0 || body.sizeBytes > MAX_BYTES) return fail(400, 'TAMANO_INVALIDO');

  const documentId = randomUUID();
  // La clave la genera el servidor e incluye el tenant. El cliente no elige
  // dónde escribe: el prefijo va fijado en las conditions de abajo.
  const key = `tenants/${caller.tenantId}/inbox/${documentId}`;
  const createdAt = new Date().toISOString();

  const presigned = await createPresignedPost(s3, {
    Bucket: BUCKET,
    Key: key,
    Expires: 300, // 5 minutos: el tiempo de subir, no el de guardar el enlace
    Conditions: [
      ['content-length-range', 1, MAX_BYTES],
      ['eq', '$Content-Type', body.contentType],
      ['starts-with', '$key', `tenants/${caller.tenantId}/inbox/`],
    ],
    Fields: {
      'Content-Type': body.contentType,
      'x-amz-meta-tenant-id': caller.tenantId,
      'x-amz-meta-document-id': documentId,
      'x-amz-meta-uploaded-by': caller.userId,
    },
  });

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: keys.tenant(caller.tenantId),
        sk: keys.doc(documentId),
        gsi1pk: keys.gsi1pk(caller.tenantId, 'PENDING'),
        gsi1sk: keys.gsi1sk(createdAt, documentId),
        documentId,
        tenantId: caller.tenantId,
        status: 'PENDING',
        fileName: body.fileName ?? documentId,
        contentType: body.contentType,
        s3Key: key,
        createdAt,
        uploadedBy: caller.userId,
        // Un intent que nunca se completa se limpia solo en 24 h.
        expiresAt: ttlIn(24 * 3600),
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );

  logger.info('upload intent creado', { documentId, tenantId: caller.tenantId });
  return ok({ documentId, upload: presigned }, 201);
};
