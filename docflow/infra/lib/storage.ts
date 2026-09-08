import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class Storage extends Construct {
  /** Documentos subidos por los usuarios. Nunca público. */
  public readonly uploads: s3.Bucket;
  /** Artefactos del frontend Angular. Servido solo vía CloudFront con OAC. */
  public readonly web: s3.Bucket;

  constructor(scope: Construct, id: string, props: { prod: boolean; allowedOrigins: string[] }) {
    super(scope, id);

    const removalPolicy = props.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.uploads = new s3.Bucket(this, 'Uploads', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      // Necesario para que S3 emita eventos a EventBridge (§Pipeline).
      eventBridgeEnabled: true,
      cors: [
        {
          // Solo lo que el presigned POST necesita desde el navegador.
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: props.allowedOrigins,
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: 'abort-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        {
          id: 'tiering',
          // 90 días en caliente; después archivo (requisito fiscal de 7 años).
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(90) },
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(365) },
          ],
        },
      ],
      removalPolicy,
      autoDeleteObjects: !props.prod,
    });

    this.web = new s3.Bucket(this, 'Web', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !props.prod,
    });
  }
}
