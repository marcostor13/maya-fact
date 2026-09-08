import { Injectable } from '@angular/core';
// Ruta `aws-amplify/auth`, no `@aws-amplify/auth`: en Amplify v6 la primera es
// la API pública; la segunda es un paquete interno que solo funciona si el
// gestor de paquetes lo eleva a la raíz de node_modules. Depender de eso es
// depender de un detalle de instalación.
import { fetchAuthSession, signIn, signOut } from 'aws-amplify/auth';

/**
 * La única puerta al token en todo el frontend.
 *
 * Tres decisiones que caben en un fichero de 40 líneas y que hay que poder
 * defender:
 *
 * 1. **Devolvemos el ACCESS token, no el ID token.** Es el que valida el
 *    authorizer JWT de API Gateway y el que lleva el claim `tenant_id` que
 *    inyecta el trigger de pre-token-generation. Mandar el id token es el error
 *    más común de un frontend con Cognito: parece funcionar en desarrollo si el
 *    authorizer no comprueba la audiencia, y falla en cuanto sí la comprueba.
 *
 * 2. **El token NO se guarda en localStorage por nuestra cuenta.** Amplify
 *    gestiona su almacenamiento y su renovación; duplicarlo en una variable
 *    nuestra solo añade una copia que caduca sin que nadie la refresque. Un
 *    token en localStorage es además legible por cualquier XSS — por eso la
 *    CSP de la distribución no permite scripts de terceros.
 *
 * 3. **`fetchAuthSession` en cada petición, no en el arranque.** Es la que
 *    renueva silenciosamente con el refresh token cuando el access token está a
 *    punto de expirar. Con validez de 15 minutos, cachearlo al arrancar la SPA
 *    significa que la aplicación deja de funcionar a los 15 minutos de uso.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  async accessToken(): Promise<string | null> {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.accessToken?.toString() ?? null;
    } catch {
      // Sesión ausente o expirada sin refresh válido. Devolver null y dejar que
      // la petición salga sin cabecera es correcto: la API responderá 401 y el
      // enrutador llevará al login. Tragarse el error aquí y reintentar en
      // bucle es lo que produce las tormentas de peticiones al expirar.
      return null;
    }
  }

  async entrar(email: string, password: string): Promise<void> {
    await signIn({ username: email, password });
  }

  async salir(): Promise<void> {
    // global: revoca el refresh token en Cognito, no solo borra el local.
    // Sin esto, "cerrar sesión" solo limpia el navegador: el refresh token
    // sigue siendo válido durante 30 días para quien lo tenga.
    await signOut({ global: true });
  }
}
