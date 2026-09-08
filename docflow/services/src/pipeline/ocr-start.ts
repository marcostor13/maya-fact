import {
  DetectDocumentTextCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { PermanentError, TransientError, isTransient } from '../shared/errors.js';
import { palabrasDesdeBloques, textoDesdeBloques, type OcrResultado } from './ocr.js';

const logger = new Logger({ serviceName: 'ocr-start' });
const metrics = new Metrics({ namespace: 'DocFlow', serviceName: 'ocr' });
const textract = new TextractClient({});

export interface OcrStartInput {
  documentId: string;
  bucket: string;
  key: string;
  pageCount: number;
}

export type OcrStartOutput =
  | { listo: true; jobId: null; resultado: OcrResultado }
  | { listo: false; jobId: string; resultado: null };

/**
 * Arranca el OCR. Usa DELIBERADAMENTE dos APIs distintas según el documento.
 *
 * `DetectDocumentText` es síncrona y devuelve el resultado en la misma llamada,
 * pero solo acepta una página. `StartDocumentTextDetection` es asíncrona y
 * acepta PDFs multipágina, pero obliga a esperar.
 *
 * Elegir la síncrona cuando se puede no es un atajo: ahorra tres estados de la
 * máquina, la espera y el riesgo de quedarse colgado. Y ambas cuestan lo mismo
 * por página ($1,50/1.000 en DetectDocumentText), así que la decisión es
 * puramente de latencia y complejidad, no de dinero.
 *
 * Nota de coste que conviene tener presente al defender esto: usamos
 * DetectDocumentText (solo texto), NO AnalyzeDocument con Forms+Tables. La
 * estructura la saca el modelo. Esa sola elección es un factor 33x en la
 * factura de Textract, y no cambia ni una caja del diagrama.
 */
export const handler = async (input: OcrStartInput): Promise<OcrStartOutput> => {
  try {
    if (input.pageCount <= 1) {
      const res = await textract.send(
        new DetectDocumentTextCommand({
          Document: { S3Object: { Bucket: input.bucket, Name: input.key } },
        }),
      );
      metrics.addMetric('OcrPaginas', MetricUnit.Count, 1);
      metrics.publishStoredMetrics();
      logger.info('OCR síncrono completado', { documentId: input.documentId });
      return {
        listo: true,
        jobId: null,
        resultado: {
          palabras: palabrasDesdeBloques(res.Blocks),
          texto: textoDesdeBloques(res.Blocks),
        },
      };
    }

    const res = await textract.send(
      new StartDocumentTextDetectionCommand({
        DocumentLocation: { S3Object: { Bucket: input.bucket, Name: input.key } },
        // Idempotencia también aquí: si Step Functions reintenta este paso,
        // Textract no arranca un segundo trabajo por el mismo documento — y un
        // trabajo duplicado son páginas pagadas dos veces.
        ClientRequestToken: input.documentId.slice(0, 64),
        JobTag: input.documentId.slice(0, 64),
      }),
    );
    if (!res.JobId) throw new TransientError('Textract no devolvió JobId', 'OCR_SIN_JOBID');

    metrics.addMetric('OcrPaginas', MetricUnit.Count, input.pageCount);
    metrics.publishStoredMetrics();
    logger.info('OCR asíncrono arrancado', { documentId: input.documentId, jobId: res.JobId });
    return { listo: false, jobId: res.JobId, resultado: null };
  } catch (err) {
    if (isTransient(err)) throw new TransientError(`Textract no disponible: ${(err as Error).message}`, 'OCR_TRANSITORIO');
    // UnsupportedDocumentException, InvalidS3ObjectException, DocumentTooLarge:
    // reintentar cualquiera de estas es pagar tres veces por el mismo no.
    throw new PermanentError(`Textract rechazó el documento: ${(err as Error).name}`, 'OCR_PERMANENTE');
  }
};
