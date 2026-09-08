import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { DocumentsService } from './documents.service';
import { ETIQUETA_ESTADO, ICONO_POR_ESTADO, Icono, type NombreIcono } from './icon';

interface Doc {
  documentId: string;
  status: string;
  fileName?: string;
  route?: string;
  updatedAt?: string;
}

const TERMINALES = ['APPROVED', 'NEEDS_REVIEW', 'REJECTED', 'DUPLICATE', 'QUARANTINED'];

const FILTROS = [
  { valor: 'APPROVED', texto: 'Aprobadas' },
  { valor: 'NEEDS_REVIEW', texto: 'Revisión' },
  { valor: 'REJECTED', texto: 'Rechazadas' },
  { valor: 'DUPLICATE', texto: 'Duplicadas' },
  { valor: 'QUARANTINED', texto: 'Cuarentena' },
  { valor: 'PENDING', texto: 'Pendientes' },
] as const;

@Component({
  selector: 'app-root',
  imports: [FormsModule, Icono],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private auth = inject(AuthService);
  private docs = inject(DocumentsService);

  readonly filtros = FILTROS;

  email = signal('');
  password = signal('');
  autenticado = signal(false);
  entrando = signal(false);
  error = signal('');

  subiendo = signal(false);
  arrastrando = signal(false);
  progreso = signal('');
  ultimoEstado = signal('');

  cargando = signal(false);
  documentos = signal<Doc[]>([]);
  filtro = signal<string>('APPROVED');

  /** El texto del filtro activo, para el encabezado de la lista. */
  filtroTexto = computed(
    () => FILTROS.find((f) => f.valor === this.filtro())?.texto ?? '',
  );

  icono(estado: string): NombreIcono {
    return ICONO_POR_ESTADO[estado] ?? 'documento';
  }

  etiqueta(estado: string): string {
    return ETIQUETA_ESTADO[estado] ?? estado;
  }

  async entrar(): Promise<void> {
    if (this.entrando()) return;
    this.error.set('');
    this.entrando.set(true);
    try {
      await this.auth.entrar(this.email(), this.password());
      this.autenticado.set(true);
      await this.listar();
    } catch (e) {
      // Mensaje genérico y único: no distinguimos "el usuario no existe" de
      // "la contraseña es incorrecta". Distinguirlos permite enumerar cuentas.
      this.error.set('No se pudo iniciar sesión. Revisa tus credenciales.');
      console.error(e);
    } finally {
      this.entrando.set(false);
    }
  }

  async salir(): Promise<void> {
    await this.auth.salir();
    this.autenticado.set(false);
    this.documentos.set([]);
    this.progreso.set('');
    this.ultimoEstado.set('');
  }

  // ---- Subida ------------------------------------------------------------
  alSoltar(evento: DragEvent): void {
    evento.preventDefault();
    this.arrastrando.set(false);
    const file = evento.dataTransfer?.files?.[0];
    if (file) void this.procesar(file);
  }

  alArrastrar(evento: DragEvent, dentro: boolean): void {
    evento.preventDefault();
    this.arrastrando.set(dentro);
  }

  alSeleccionar(evento: Event): void {
    const input = evento.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.procesar(file).finally(() => (input.value = ''));
  }

  /**
   * El flujo completo. Fíjate en que `subir()` hace DOS llamadas a DOS hosts:
   * una a nuestra API para pedir el permiso firmado, y otra a S3 con el
   * archivo. El backend firma; nunca toca los bytes.
   */
  private async procesar(file: File): Promise<void> {
    this.subiendo.set(true);
    this.ultimoEstado.set('');
    this.progreso.set('Pidiendo permiso de subida…');
    try {
      const documentId = await this.docs.subir(file);
      this.progreso.set('Subido a S3. Procesando…');
      await this.sondear(documentId);
    } catch (e) {
      this.progreso.set('');
      this.error.set('No se pudo subir el documento.');
      console.error(e);
    } finally {
      this.subiendo.set(false);
    }
  }

  /**
   * Sondeo con retroceso exponencial, no WebSockets: a 100.000 documentos al
   * mes, el problema que resolvería una conexión persistente no existe.
   */
  private async sondear(documentId: string): Promise<void> {
    for (let intento = 0; intento < 40; intento++) {
      const espera = Math.min(1000 * 2 ** Math.floor(intento / 4), 8000);
      await new Promise((r) => setTimeout(r, espera));
      const res = await firstValueFrom(this.docs.obtener(documentId));
      const estado = String((res.document as { status?: string })?.status ?? '');
      this.progreso.set(`Procesando… (${this.etiqueta(estado)})`);
      if (TERMINALES.includes(estado)) {
        this.progreso.set('');
        this.ultimoEstado.set(estado);
        this.filtro.set(estado);
        await this.listar();
        return;
      }
    }
    this.progreso.set('Sin resultado tras varios minutos.');
  }

  // ---- Listado -----------------------------------------------------------
  async listar(): Promise<void> {
    this.cargando.set(true);
    try {
      const res = await firstValueFrom(this.docs.listar(this.filtro()));
      this.documentos.set(res.items as Doc[]);
    } finally {
      this.cargando.set(false);
    }
  }

  async cambiarFiltro(valor: string): Promise<void> {
    this.filtro.set(valor);
    await this.listar();
  }

  nombreCorto(d: Doc): string {
    return d.fileName || `${d.documentId.slice(0, 8)}…`;
  }

  fecha(iso?: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}
