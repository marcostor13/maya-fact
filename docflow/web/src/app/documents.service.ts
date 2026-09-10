import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

/** Un documento listo para pintar: el blob ya descargado, no el enlace firmado. */
export interface Contenido {
  /** `blob:` local. Hay que liberarlo con `URL.revokeObjectURL` al cerrarlo. */
  url: string;
  contentType: string;
  fileName: string;
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
    return this.http.get<{
      document: Record<string, unknown>;
      fields: unknown[];
      original: Record<string, unknown> | null;
    }>(`${this.base}/documents/${documentId}`);
  }

  /**
   * Descarga el documento original y lo deja como `blob:` listo para pintar.
   *
   * Son dos saltos, igual que la subida y por los mismos motivos invertidos:
   * nuestra API **firma** un enlace de dos minutos, y el navegador va a S3 a por
   * los bytes. El backend nunca mueve el fichero.
   *
   * Y tres decisiones dentro de estas pocas líneas:
   *
   * 1. **`fetch` y no `HttpClient`.** El interceptor solo añade el token a las
   *    llamadas a `/api`, pero usar `fetch` lo deja fuera de toda duda: mandar
   *    la cabecera `Authorization` a S3 rompería la firma *y* filtraría el token
   *    a otro host.
   * 2. **El tipo del blob es el que dijo NUESTRA API**, no el que devuelva S3.
   *    Un fichero disfrazado no puede acabar interpretado como HTML por mucho
   *    que el objeto almacenado diga otra cosa.
   * 3. **El enlace firmado no se guarda ni se pinta.** Vive lo que dura esta
   *    función; lo que llega a la interfaz es un `blob:` de esta pestaña.
   */
  async contenido(documentId: string): Promise<Contenido> {
    const meta = await firstValueFrom(
      this.http.get<{ url: string; contentType: string; fileName: string }>(
        `${this.base}/documents/${documentId}/content`,
      ),
    );

    const res = await fetch(meta.url);
    if (!res.ok) throw new Error(`El almacenamiento rechazó la lectura: ${res.status}`);

    const blob = new Blob([await res.arrayBuffer()], { type: meta.contentType });
    return { url: URL.createObjectURL(blob), contentType: meta.contentType, fileName: meta.fileName };
  }
}
