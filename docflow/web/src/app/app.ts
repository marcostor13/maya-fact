import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { DocumentsService, type Contenido } from './documents.service';
import { ETIQUETA_ESTADO, ICONO_POR_ESTADO, Icono, type NombreIcono } from './icon';

interface Doc {
  documentId: string;
  status: string;
  fileName?: string;
  route?: string;
  updatedAt?: string;
}

/** La frase y las razones que escribió el pipeline, no el frontend. */
interface Explicacion {
  resumen: string;
  detalles: string[];
}

interface Hit {
  id: string;
  severidad: string;
  mensaje: string;
}

interface Campo {
  nombre: string;
  value: string | null;
  normalized: string | number | null;
  confidence: number;
  source: string;
  quote?: string;
}

interface DocumentoCompleto extends Doc {
  contentType?: string;
  explicacion?: Explicacion;
  hits?: Hit[];
  camposBajoUmbral?: string[];
  ajustes?: string[];
  documentIdOriginal?: string | null;
  modelId?: string;
  promptVersion?: string;
  rulesetVersion?: string;
}

interface Detalle {
  document: DocumentoCompleto;
  fields: Campo[];
  original: { documentId: string; fileName?: string; status?: string } | null;
}

/** Importes que el esquema normaliza a la unidad menor de la moneda. */
const CAMPOS_IMPORTE = new Set(['subtotal', 'impuesto', 'total']);

const ETIQUETA_CAMPO: Record<string, string> = {
  proveedor_nombre: 'Proveedor',
  proveedor_id_fiscal: 'Identificador fiscal',
  numero_documento: 'Nº de documento',
  fecha_emision: 'Fecha de emisión',
  moneda: 'Moneda',
  subtotal: 'Base imponible',
  impuesto: 'Impuesto',
  total: 'Total',
};

const ETIQUETA_PROCEDENCIA: Record<string, string> = {
  ocr_geometry: 'leído con OCR',
  llm_inference: 'leído por el modelo',
  rule_derived: 'deducido por una regla',
};

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
  // Escape cierra la ficha. Es lo que hace todo el mundo sin pensarlo, y una
  // ventana que solo se cierra con el ratón es una ventana que atrapa a quien
  // navega con teclado.
  host: { '(document:keydown.escape)': 'cerrarDetalle()' },
})
export class App {
  private auth = inject(AuthService);
  private docs = inject(DocumentsService);

  readonly filtros = FILTROS;

  email = signal('');
  password = signal('');
  verPassword = signal(false);
  autenticado = signal(false);
  /** Mientras se comprueba si ya hay sesión, no se enseña ninguna de las dos vistas. */
  comprobandoSesion = signal(true);
  entrando = signal(false);
  error = signal('');

  subiendo = signal(false);
  arrastrando = signal(false);
  progreso = signal('');
  ultimoEstado = signal('');

  cargando = signal(false);
  documentos = signal<Doc[]>([]);
  filtro = signal<string>('APPROVED');

  // ---- Detalle y visor ---------------------------------------------------
  detalle = signal<Detalle | null>(null);
  cargandoDetalle = signal(false);
  visor = signal<Contenido | null>(null);
  cargandoVisor = signal(false);
  errorVisor = signal('');

  /**
   * El `<iframe>` del visor de PDF.
   *
   * La referencia existe porque su `src` se asigna a mano, y eso NO es un
   * atajo: en Angular, `iframe[src]` es un contexto `RESOURCE_URL` y una
   * interpolación normal exigiría `bypassSecurityTrustResourceUrl`, que este
   * repositorio prohíbe (CLAUDE.md I-6) y la auditoría bloquea. Y la prohíbe
   * con razón: abrir esa puerta «solo para el visor» es exactamente como se
   * acaba confiando en una URL que sí venía de un documento.
   *
   * Asignar la propiedad del DOM directamente no la abre: aquí la URL es un
   * `blob:` que ha creado esta misma pestaña, con un tipo de una lista blanca.
   * No hay nada de terceros en ese valor.
   */
  private marco = viewChild<ElementRef<HTMLIFrameElement>>('marco');

  /** El texto del filtro activo, para el encabezado de la lista. */
  filtroTexto = computed(
    () => FILTROS.find((f) => f.valor === this.filtro())?.texto ?? '',
  );

  tipoVisor = computed<'pdf' | 'imagen' | 'sin-vista-previa' | null>(() => {
    const tipo = this.visor()?.contentType;
    if (!tipo) return null;
    if (tipo === 'application/pdf') return 'pdf';
    if (tipo === 'image/jpeg' || tipo === 'image/png') return 'imagen';
    // TIFF entra por la puerta de subida y ningún navegador lo pinta. Decirlo y
    // ofrecer la descarga es mejor que un recuadro en blanco que parece un bug.
    return 'sin-vista-previa';
  });

  constructor() {
    effect(() => {
      const marco = this.marco();
      const contenido = this.visor();
      if (marco && contenido && this.tipoVisor() === 'pdf') {
        marco.nativeElement.src = contenido.url;
      }
    });
    void this.restaurarSesion();
  }

  /**
   * Amplify guarda la sesión en el navegador y sobrevive a recargar la página.
   * Sin esta comprobación al arrancar, alguien que ya estaba dentro veía el
   * formulario de acceso — y al intentar entrar de nuevo se topaba con
   * `UserAlreadyAuthenticatedException`. Restaurar la sesión no es una comodidad:
   * es lo que hace que el estado de la aplicación coincida con la realidad.
   */
  private async restaurarSesion(): Promise<void> {
    try {
      const correo = await this.auth.sesionActiva();
      if (correo) {
        this.email.set(correo);
        this.autenticado.set(true);
        await this.listar();
      }
    } finally {
      this.comprobandoSesion.set(false);
    }
  }

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
      // El mensaje al usuario es genérico a propósito: distinguir "no existe"
      // de "contraseña incorrecta" permite enumerar cuentas. El detalle, al log.
      this.error.set('No se pudo iniciar sesión. Revisa tus credenciales.');
      console.error(e);
    } finally {
      this.entrando.set(false);
    }
  }

  async salir(): Promise<void> {
    await this.auth.salir();
    this.autenticado.set(false);
    this.verPassword.set(false);
    this.documentos.set([]);
    this.progreso.set('');
    this.ultimoEstado.set('');
    // Cerrar sesión tiene que llevarse también el documento que hubiera en
    // pantalla: el `blob:` sigue vivo en memoria aunque el token ya no valga.
    this.cerrarDetalle();
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
    this.cerrarDetalle();
    await this.listar();
  }

  // ---- Detalle -----------------------------------------------------------
  /**
   * Abre la ficha de un documento: por qué acabó como acabó, qué se extrajo y
   * el original para poder mirarlo.
   *
   * El visor NO se carga aquí. Ver el porqué es barato —ya está en DynamoDB—
   * y ver el documento cuesta una descarga: separarlos evita traerse veinte
   * megas cada vez que alguien solo quería leer el motivo del rechazo.
   */
  async abrirDetalle(documentId: string): Promise<void> {
    this.cerrarVisor();
    this.detalle.set(null);
    this.cargandoDetalle.set(true);
    try {
      const res = await firstValueFrom(this.docs.obtener(documentId));
      this.detalle.set({
        document: res.document as unknown as DocumentoCompleto,
        fields: this.ordenarCampos(res.fields as Campo[]),
        original: res.original as Detalle['original'],
      });
    } catch (e) {
      this.error.set('No se pudo abrir el documento.');
      console.error(e);
    } finally {
      this.cargandoDetalle.set(false);
    }
  }

  cerrarDetalle(): void {
    this.cerrarVisor();
    this.detalle.set(null);
  }

  /** Del duplicado a su original, sin salir de la ficha. */
  async irAlOriginal(documentId: string): Promise<void> {
    await this.abrirDetalle(documentId);
  }

  /** El orden del esquema, no el alfabético de DynamoDB: se lee como la factura. */
  private ordenarCampos(campos: Campo[]): Campo[] {
    const orden = Object.keys(ETIQUETA_CAMPO);
    return [...(campos ?? [])].sort(
      (a, b) => indiceDe(orden, a.nombre) - indiceDe(orden, b.nombre),
    );
  }

  etiquetaCampo(nombre: string): string {
    return ETIQUETA_CAMPO[nombre] ?? nombre;
  }

  procedencia(source: string): string {
    return ETIQUETA_PROCEDENCIA[source] ?? source;
  }

  /**
   * Los importes se guardan como enteros en la unidad menor de la moneda
   * (CLAUDE.md §2.2: nunca `float` para dinero). Aquí es donde se vuelven a
   * dividir, en el último momento y solo para enseñarlos.
   */
  valorCampo(campo: Campo, moneda: string): string {
    if (campo.normalized === null || campo.normalized === undefined) return '—';
    if (CAMPOS_IMPORTE.has(campo.nombre) && typeof campo.normalized === 'number') {
      const cantidad = (campo.normalized / 100).toLocaleString('es', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return moneda ? `${cantidad} ${moneda}` : cantidad;
    }
    return String(campo.normalized);
  }

  monedaDe(campos: Campo[]): string {
    const m = campos.find((c) => c.nombre === 'moneda')?.normalized;
    return typeof m === 'string' ? m : '';
  }

  porcentaje(confianza: number): string {
    return `${Math.round((confianza ?? 0) * 100)}%`;
  }

  esDudoso(campo: Campo): boolean {
    return (this.detalle()?.document.camposBajoUmbral ?? []).includes(campo.nombre);
  }

  // ---- Visor -------------------------------------------------------------
  /**
   * Trae el documento original y lo deja listo para pintar.
   *
   * Se pide bajo demanda y con un enlace de dos minutos: la URL firmada no se
   * cachea, no se guarda y no llega al DOM. Volver a pulsar «ver» pide otra.
   */
  async verDocumento(): Promise<void> {
    const documentId = this.detalle()?.document.documentId;
    if (!documentId || this.cargandoVisor()) return;

    this.cerrarVisor();
    this.cargandoVisor.set(true);
    this.errorVisor.set('');
    try {
      this.visor.set(await this.docs.contenido(documentId));
    } catch (e) {
      this.errorVisor.set('No se pudo cargar el documento original.');
      console.error(e);
    } finally {
      this.cargandoVisor.set(false);
    }
  }

  /**
   * Un `blob:` vive hasta que alguien lo libera o hasta que se cierra la
   * pestaña. Sin esto, abrir veinte documentos deja veinte copias en memoria:
   * la clase de fuga que no rompe nada y solo se nota en una sesión larga.
   */
  cerrarVisor(): void {
    const abierto = this.visor();
    if (abierto) URL.revokeObjectURL(abierto.url);
    this.visor.set(null);
    this.errorVisor.set('');
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

/** Lo que no está en el orden conocido va al final, no al principio. */
function indiceDe(orden: string[], nombre: string): number {
  const i = orden.indexOf(nombre);
  return i === -1 ? orden.length : i;
}
