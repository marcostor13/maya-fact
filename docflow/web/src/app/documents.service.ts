import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

@Injectable({ providedIn: 'root' })
export class DocumentsService {
  private http = inject(HttpClient);
  // Mismo origen que la SPA: la API va detrás de la misma distribución de
  // CloudFront. Por eso no hay preflight CORS ni una URL de API distinta.
  private base = '/api';

  async subir(file: File): Promise<string> {
    // 1) Pedimos permiso de subida. El backend firma; no recibe el archivo.
    const { documentId, upload } = await firstValueFrom(
      this.http.post<{ documentId: string; upload: PresignedPost }>(`${this.base}/uploads`, {
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      }),
    );

    // 2) El archivo va DIRECTO a S3. Nunca pasa por API Gateway ni por Lambda.
    //    Las condiciones del presigned (prefijo, tamaño, content-type) las
    //    aplica S3, así que manipular este formulario no sirve de nada.
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
    form.append('file', file);

    const res = await fetch(upload.url, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`S3 rechazó la subida: ${res.status}`);

    return documentId;
  }

  listar(status = 'NEEDS_REVIEW') {
    return this.http.get<{ items: unknown[]; cursor: string | null }>(
      `${this.base}/documents`, { params: { status } },
    );
  }

  obtener(documentId: string) {
    return this.http.get<{ document: Record<string, unknown>; fields: unknown[] }>(
      `${this.base}/documents/${documentId}`,
    );
  }
}
