import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import { createHash } from 'node:crypto';
import { PermanentError } from '../shared/errors.js';
import type { Route } from '../shared/types.js';

const logger = new Logger({ serviceName: 'classify' });
const s3 = new S3Client({});

const MAX_PAGES = 50;

/** Firmas de archivo. NUNCA confiar en la extensión ni en el Content-Type. */
const MAGIC: Array<{ mime: string; bytes: number[] }> = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },          // %PDF
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
];

export interface ClassifyInput {
  tenantId: string;
  documentId: string;
  bucket: string;
  key: string;
}

export interface ClassifyOutput {
  route: Route;
  detectedMime: string;
  pageCount: number;
  sha256: string;
  hasTextLayer: boolean;
}

/**
 * Este paso NO clasifica el documento: DECIDE SU RUTA DE PROCESAMIENTO.
 *
 * Es la palanca de coste más grande de toda la arquitectura. Según los propios
 * números de AWS, mandar el documento directo al modelo sale ~16x más barato
 * que poner Textract delante. Así que Textract se paga solo donde compra algo
 * concreto: confianza calibrada por palabra, coordenadas para la revisión
 * humana, o un artefacto de texto reutilizable.
 */
export const handler = async (input: ClassifyInput): Promise<ClassifyOutput> => {
  const obj = await s3.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
  const buf = Buffer.from(await obj.Body!.transformToByteArray());

  const detectedMime = detectMime(buf);
  if (!detectedMime) {
    throw new PermanentError('Tipo de archivo no reconocido por sus magic bytes', 'MIME_DESCONOCIDO');
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  const isPdf = detectedMime === 'application/pdf';
  const pageCount = isPdf ? countPdfPages(buf) : 1;

  // Bomba de descompresión / documento absurdamente largo: es a la vez un
  // control de disponibilidad y uno de presupuesto (denial of wallet).
  if (pageCount > MAX_PAGES) {
    throw new PermanentError(`Documento de ${pageCount} páginas supera el límite de ${MAX_PAGES}`, 'DEMASIADAS_PAGINAS');
  }

  const hasTextLayer = isPdf && hasPdfTextLayer(buf);

  let route: Route;
  if (detectedMime === 'image/tiff') {
    // TIFF es el caso que descoloca el atajo "si es imagen, al modelo". Los
    // modelos de Bedrock aceptan jpeg, png, gif y webp — TIFF no está en la
    // lista, y mandárselo falla en tiempo de ejecución. Textract sí lo lee.
    //
    // Es la mejor ilustración de por qué este paso decide RUTAS y no tipos: el
    // formato del archivo no determina qué es el documento, determina qué
    // servicios pueden leerlo. Aquí el OCR no se compra por calidad ni por
    // geometría: se compra porque es el único camino que existe.
    route = 'R3_TEXTRACT';
  } else if (hasTextLayer) {
    route = 'R1_PDF_TEXT';      // el texto ya está: cero coste de OCR
  } else {
    route = 'R2_VISION';        // escaneo o foto: al modelo multimodal
  }

  logger.info('ruta decidida', { documentId: input.documentId, route, detectedMime, pageCount, hasTextLayer });
  return { route, detectedMime, pageCount, sha256, hasTextLayer };
};

function detectMime(buf: Buffer): string | null {
  for (const sig of MAGIC) {
    if (sig.bytes.every((b, i) => buf[i] === b)) return sig.mime;
  }
  return null;
}

/** Heurística barata: contar objetos /Type /Page. Suficiente para un límite. */
function countPdfPages(buf: Buffer): number {
  const matches = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches?.length ?? 1;
}

/**
 * ¿El PDF trae capa de texto o es un escaneo?
 *
 * Heurística deliberadamente simple: buscar operadores de texto. En producción
 * se sustituye por una librería de parseo; la decisión de arquitectura —rutar
 * según haya o no texto— no cambia.
 */
function hasPdfTextLayer(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 2_000_000)).toString('latin1');
  return /\bBT\b[\s\S]{0,4000}?\bTj\b/.test(head) || /\bTJ\b/.test(head);
}
