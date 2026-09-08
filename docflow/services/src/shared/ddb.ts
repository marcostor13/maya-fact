import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// Constructores de clave en un solo sitio: si cambian, cambian una vez.
export const keys = {
  tenant: (tenantId: string) => `TENANT#${tenantId}`,
  doc: (documentId: string) => `DOC#${documentId}`,
  field: (documentId: string, name: string) => `DOC#${documentId}#FIELD#${name}`,
  event: (documentId: string, ts: string) => `DOC#${documentId}#EVT#${ts}`,
  dedupePk: (tenantId: string, sha256: string) => `TENANT#${tenantId}#HASH#${sha256}`,
  idemPk: (key: string) => `IDEM#${key}`,
  gsi1pk: (tenantId: string, status: string) => `TENANT#${tenantId}#ST#${status}`,
  gsi1sk: (createdAt: string, documentId: string) => `${createdAt}#${documentId}`,
};

export const ttlIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;
