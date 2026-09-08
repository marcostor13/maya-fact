import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type NombreIcono =
  | 'subir' | 'aprobado' | 'revision' | 'rechazado' | 'duplicado' | 'cuarentena'
  | 'pendiente' | 'salir' | 'documento' | 'escudo' | 'candado' | 'refrescar';

/**
 * Iconos en SVG en línea, dentro de la plantilla.
 *
 * Dos decisiones que parecen de estilo y son de arquitectura:
 *
 * 1. **No hay librería de iconos por CDN.** La CSP de la distribución declara
 *    `default-src 'self'`: cualquier fuente de iconos externa se bloquearía en
 *    silencio y el resultado sería una interfaz llena de cuadrados vacíos —
 *    solo en producción, porque en desarrollo no hay CSP.
 *
 * 2. **No se usa `[innerHTML]` para inyectar el SVG.** Sería lo cómodo: un mapa
 *    de nombre a cadena y a correr. Pero `[innerHTML]` es exactamente el vector
 *    del XSS almacenado que documento en `03-nfr/seguridad.md`, y tener esa
 *    puerta abierta "solo para iconos" es como se acaba pintando con ella el
 *    texto extraído de un documento. Aquí el SVG es contenido estático de
 *    plantilla: Angular lo compila, nadie lo interpreta en tiempo de ejecución.
 */
@Component({
  selector: 'mf-icono',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="tamano()" [attr.height]="tamano()"
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      @switch (nombre()) {
        @case ('subir') {
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M17 8l-5-5-5 5" /><path d="M12 3v12" />
        }
        @case ('aprobado') {
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <path d="M22 4L12 14.01l-3-3" />
        }
        @case ('revision') {
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <path d="M12 9v4" /><path d="M12 17h.01" />
        }
        @case ('rechazado') {
          <circle cx="12" cy="12" r="10" />
          <path d="M15 9l-6 6" /><path d="M9 9l6 6" />
        }
        @case ('duplicado') {
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        }
        @case ('cuarentena') {
          <circle cx="12" cy="12" r="10" />
          <path d="M4.93 4.93l14.14 14.14" />
        }
        @case ('pendiente') {
          <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
        }
        @case ('salir') {
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="M16 17l5-5-5-5" /><path d="M21 12H9" />
        }
        @case ('documento') {
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" />
        }
        @case ('escudo') {
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="M9 12l2 2 4-4" />
        }
        @case ('candado') {
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        }
        @case ('refrescar') {
          <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
          <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
        }
      }
    </svg>
  `,
  styles: `:host { display: inline-flex; line-height: 0; }`,
})
export class Icono {
  nombre = input.required<NombreIcono>();
  tamano = input(18);
}

/** Cada estado del documento tiene su icono. Un vistazo, no una lectura. */
export const ICONO_POR_ESTADO: Record<string, NombreIcono> = {
  APPROVED: 'aprobado',
  NEEDS_REVIEW: 'revision',
  REJECTED: 'rechazado',
  DUPLICATE: 'duplicado',
  QUARANTINED: 'cuarentena',
  PENDING: 'pendiente',
  RECEIVED: 'pendiente',
  PROCESSING: 'pendiente',
};

/** Etiquetas en castellano: la interfaz no habla en constantes. */
export const ETIQUETA_ESTADO: Record<string, string> = {
  APPROVED: 'Aprobada',
  NEEDS_REVIEW: 'Revisión',
  REJECTED: 'Rechazada',
  DUPLICATE: 'Duplicada',
  QUARANTINED: 'Cuarentena',
  PENDING: 'Pendiente',
  RECEIVED: 'Recibida',
  PROCESSING: 'Procesando',
};
