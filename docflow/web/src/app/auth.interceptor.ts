import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Añade el access token a las llamadas a nuestra API — y SOLO a ellas.
 *
 * El `startsWith('/api')` no es cosmético: sin él, la subida a S3 llevaría la
 * cabecera Authorization, que rompe la firma del presigned POST y además filtra
 * el token a un host distinto.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api')) return next(req);
  const auth = inject(AuthService);
  return from(auth.accessToken()).pipe(
    switchMap((token) =>
      next(token ? req.clone({ setHeaders: { authorization: `Bearer ${token}` } }) : req),
    ),
  );
};
