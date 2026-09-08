import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { authInterceptor } from './auth.interceptor';

/**
 * Este fichero es OBLIGATORIO en el repositorio, y su ausencia fue un fallo real.
 *
 * Durante un tiempo solo existió en la carpeta de compilación local. El
 * despliegue funcionaba desde mi máquina y fallaba desde el CI, que regenera el
 * andamiaje de Angular desde cero: sin este fichero, `ng new` deja el suyo por
 * defecto —sin `provideHttpClient` y, sobre todo, sin el interceptor— así que
 * las peticiones salían **sin la cabecera `Authorization`** y la API respondía
 * 401 a todo.
 *
 * El síntoma engañaba: el frontend llamaba al endpoint correcto, con el token
 * correcto guardado en el navegador y sin caducar. Lo que faltaba era la línea
 * que une las dos cosas.
 *
 * La lección no es sobre Angular: **si tu build depende de un fichero que el
 * repositorio no contiene, tu build no es reproducible**, y el CI es lo que
 * acaba descubriéndolo.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // El interceptor es lo que añade el token — y solo a nuestro origen.
    provideHttpClient(withInterceptors([authInterceptor])),
  ],
};
