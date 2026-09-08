import { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Single-table design. Las claves salen de los access patterns, no al revés.
 *
 *  PK                              SK                       Qué es
 *  TENANT#<tid>                    DOC#<docId>              metadata del documento
 *  TENANT#<tid>                    DOC#<docId>#FIELD#<n>    campo extraído
 *  TENANT#<tid>                    DOC#<docId>#EVT#<ts>     evento de auditoría
 *  TENANT#<tid>#HASH#<sha256>      DEDUPE                   deduplicación por contenido
 *  IDEM#<clave>                    LOCK                     candado de idempotencia (TTL)
 *
 *  GSI1: listar documentos de un tenant por estado, más recientes primero.
 *  GSI1PK = TENANT#<tid>#ST#<estado>   GSI1SK = <createdAt>#<docId>
 */
export class Data extends Construct {
  public readonly table: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: { prod: boolean }) {
    super(scope, id);

    this.table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      // On-demand: el tráfico tiene picos de 10x a fin de mes. Migrar a
      // provisioned + autoscaling cuando el ratio pico/media baje de 4x.
      billing: dynamodb.Billing.onDemand(),
      // TTL para los candados de idempotencia y los datos con retención corta.
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.INCLUDE,
          nonKeyAttributes: ['documentId', 'status', 'fileName', 'pageCount', 'route'],
        },
      ],
      removalPolicy: props.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
  }
}
