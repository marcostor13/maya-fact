import { GetDocumentTextDetectionCommand, TextractClient } from '@aws-sdk/client-textract';
import type { Block } from '@aws-sdk/client-textract';
import { Logger } from '@aws-lambda-powertools/logger';
import { PermanentError, TransientError, isTransient } from '../shared/errors.js';
import { palabrasDesdeBloques, textoDesdeBloques, type OcrResultado } from './ocr.js';

const logger = new Logger({ serviceName: 'ocr-collect' });
const textract = new TextractClient({});

/** Tope de páginas del clasificador (50) x ~1.000 bloques por página holgado. */
const MAX_PAGINAS_RESULTADO = 20;

export interface OcrCollectInput {
  documentId: string;
  jobId: string;
}

export type OcrCollectOutput =
  | { estado: 'SUCCEEDED'; resultado: OcrResultado }
  | { estado: 'IN_PROGRESS'; resultado: null };

/**
 * Recoge el resultado del OCR asíncrono.
 *
 * La espera vive en la máquina de estados (Wait + Choice), no aquí dentro.
 * Podría hacerse un bucle de sondeo en la Lambda y sería menos código, pero se
 * pagaría tiempo de Lambda por esperar a otro servicio — el antipatrón de
 * facturación más común en pipelines serverless. Un Wait de Step Functions
 * Standard no cuesta cómputo.
 *
 * Es también la razón concreta por la que la máquina es Standard y no Express:
 * Express tiene un techo de 5 minutos y solo integraciones request-response.
 */
export const handler = async (input: OcrCollectInput): Promise<OcrCollectOutput> => {
  try {
    const bloques: Block[] = [];
    let token: string | undefined;
    let estado = 'IN_PROGRESS';
    let paginas = 0;

    do {
      const res = await textract.send(
        new GetDocumentTextDetectionCommand({ JobId: input.jobId, NextToken: token }),
      );
      estado = res.JobStatus ?? 'IN_PROGRESS';
      if (estado !== 'SUCCEEDED') break;
      bloques.push(...(res.Blocks ?? []));
      token = res.NextToken;
      paginas += 1;
    } while (token && paginas < MAX_PAGINAS_RESULTADO);

    if (estado === 'IN_PROGRESS') {
      logger.info('OCR aún en curso', { documentId: input.documentId, jobId: input.jobId });
      return { estado: 'IN_PROGRESS', resultado: null };
    }
    if (estado !== 'SUCCEEDED') {
      // FAILED o PARTIAL_SUCCESS. El documento no se pierde: la máquina lo
      // manda a revisión humana, que es el camino lento pero correcto.
      throw new PermanentError(`Textract terminó en estado ${estado}`, 'OCR_FALLIDO');
    }

    const resultado: OcrResultado = {
      palabras: palabrasDesdeBloques(bloques),
      texto: textoDesdeBloques(bloques),
    };
    logger.info('OCR completado', {
      documentId: input.documentId,
      palabras: resultado.palabras.length,
    });
    return { estado: 'SUCCEEDED', resultado };
  } catch (err) {
    if (err instanceof PermanentError) throw err;
    if (isTransient(err)) throw new TransientError(`Textract no disponible: ${(err as Error).message}`, 'OCR_TRANSITORIO');
    throw new PermanentError(`Fallo recogiendo el OCR: ${(err as Error).name}`, 'OCR_PERMANENTE');
  }
};
