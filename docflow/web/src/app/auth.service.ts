import { Injectable } from '@angular/core';
// Ruta `aws-amplify/auth`, no `@aws-amplify/auth`: en Amplify v6 la primera es
// la API pública; la segunda es un paquete interno que solo funciona si el
// gestor de paquetes lo eleva a la raíz de node_modules. Depender de eso es
// depender de un detalle de instalación.
import { fetchAuthSession, getCurrentUser, signIn, signOut } from 'aws-amplify/auth';

/**
 * La única puerta al token en todo el frontend.
 *
 * Tres decisiones que caben en un fichero pequeño y que hay que poder defender:
 *
 * 1. **Devolvemos el ACCESS token, no el ID token.** Es el que valida el
 *    authorizer JWT de API Gateway y el que lleva el claim `tenant_id` que
 *    inyecta el trigger de pre-token-generation. Mandar el id token es el error
 *    más común de un frontend con Cognito: parece funcionar en desarrollo si el
 *    authorizer no comprueba la audiencia, y falla en cuanto sí la comprueba.
 *
 * 2. **El token NO se guarda en localStorage por nuestra cuenta.** Amplify
 *    gestiona su almacenamiento y su renovación; duplicarlo en una variable
 *    nuestra solo añade una copia que caduca sin que nadie la refresque.
 *
 * 3. **`fetchAuthSession` en cada petición, no en el arranque.** Es la que
 *    renueva silenciosamente con el refresh token. Con validez de 15 minutos,
 *    cachearlo al arrancar significa que la aplicación deja de funcionar a los
 *    15 minutos de uso.
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

  /**
   * El correo del usuario con sesión abierta, o `null` si no hay ninguna.
   *
   * Amplify guarda la sesión en el navegador y **sobrevive a recargar la
   * página y a cerrar la pestaña**. Sin este método la aplicación no puede
   * saberlo, así que enseñaría el formulario de acceso a alguien que ya está
   * dentro — y ahí empieza el problema que resuelve `entrar()`.
   */
  async sesionActiva(): Promise<string | null> {
    try {
      const { signInDetails, username } = await getCurrentUser();
      // Comprobamos que además haya tokens utilizables: puede existir un
      // usuario en almacenamiento cuyo refresh token ya no valga.
      const session = await fetchAuthSession();
      if (!session.tokens?.accessToken) return null;
      return signInDetails?.loginId ?? username;
    } catch {
      return null;
    }
  }

  /**
   * Inicia sesión, contemplando que ya hubiera una abierta.
   *
   * **Este es el bug que rompía la aplicación entera.** `signIn()` de Amplify v6
   * lanza `UserAlreadyAuthenticatedException` si ya hay un usuario dentro, y la
   * versión anterior la trataba como un fallo cualquiera: mostraba «no se pudo
   * iniciar sesión», el usuario se quedaba fuera y, como no se autenticaba,
   * **el frontend no llegaba a llamar a ningún endpoint**. El síntoma —"la API
   * no responde"— apuntaba al backend, que estaba perfectamente.
   *
   * Es un caso de manual de por qué un `catch` que trata todos los errores
   * igual es peor que no tenerlo: convirtió "ya estás dentro" en "no puedes
   * entrar".
   */
  async entrar(email: string, password: string): Promise<void> {
    const correo = email.trim().toLowerCase();
    const abierta = await this.sesionActiva();

    if (abierta) {
      // Misma persona: ya está dentro, no hay nada que hacer.
      if (abierta.toLowerCase() === correo) return;
      // Otra persona: hay que cerrar la sesión anterior antes de abrir la nueva,
      // o Amplify rechaza el acceso y el usuario queda atrapado en la cuenta de
      // quien usara el navegador antes.
      await signOut();
    }

    await signIn({ username: correo, password });
  }

  async salir(): Promise<void> {
    // global: revoca el refresh token en Cognito, no solo borra el local.
    // Sin esto, "cerrar sesión" solo limpia el navegador: el refresh token
    // sigue siendo válido durante 30 días para quien lo tenga.
    await signOut({ global: true });
  }
}
