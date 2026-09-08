# ADR-001 — HTTP API en vez de REST API, servida detrás de CloudFront

**Estado:** aceptada · **Código:** `infra/lib/api.ts`, `infra/lib/web.ts`

## Contexto

Necesitamos una API HTTP autenticada con tres rutas (`POST /uploads`,
`GET /documents`, `GET /documents/{id}`) para 40 clientes y ~100.000 documentos
al mes. API Gateway ofrece dos productos que resuelven esto y que la gente trata
como si fueran versiones del mismo: **REST API** y **HTTP API**.

## Decisión

**HTTP API**, y para compensar lo que se pierde, **servida detrás de la misma
distribución de CloudFront que el frontend**, bajo el prefijo `/api`.

## Alternativas evaluadas

| Opción | Por qué no |
|---|---|
| **REST API** | ~3,5× más cara por millón de peticiones y con más latencia. Sus ventajas reales —WAF asociado directamente, *usage plans* y API keys nativos, validación de petición por modelo— o no las necesito hoy o las recupero por otra vía |
| **ALB + Lambda** | Un ALB cuesta ~$16/mes solo por existir, aunque no reciba tráfico. A este volumen es más caro que toda la API |
| **HTTP API expuesta directamente** | Es lo que descarto con la segunda mitad de la decisión: sin CloudFront delante no hay forma de asociarle WAF |

## Consecuencias

**Buenas**

- Menor coste y menor latencia por petición.
- El *authorizer* JWT nativo valida firma, `iss`, `aud` y `exp` sin escribir código. Menos código de seguridad propio es menos superficie de error.
- **Desaparece el preflight CORS.** Al compartir origen con la SPA, el navegador deja de hacer `OPTIONS` antes de cada llamada: menos latencia y una configuración menos donde equivocarse (el CORS con comodín es OWASP A05).
- Recupero **WAF y Shield Standard** en el borde, aplicados por igual a la UI y a la API.

**Malas, y son reales**

- **Aparece una pieza que no existiría si no.** El prefijo `/api` es un artefacto del navegador: la API no lo conoce, sus rutas son `/uploads` y `/documents`. Hace falta una CloudFront Function que lo elimine en *viewer-request*. Es código en el borde, y el borde es el sitio más incómodo para depurar. **Sin ese rewrite, todas las llamadas devuelven 404** — y el 404 lo devuelve API Gateway, así que se investiga el frontend, que está bien.
- Sin *usage plans* nativos: la cuota por cliente hay que resolverla en la capa de autorización.
- Sin validación de petición por modelo: la validación de entrada es código nuestro.
- CloudFront añade un salto y ~10–20 ms; irrelevante frente al presupuesto de 300 ms de p95.

## Cuándo revisaría esta decisión

- Si necesito **cuotas y facturación por cliente desde la propia API**: los *usage plans* de REST API son un producto terminado, y reimplementarlos deja de compensar.
- Si aparece **mTLS o dominios personalizados por cliente** con certificados propios.
- Si el rewrite del prefijo `/api` empieza a acumular lógica. Una CloudFront Function que hace una cosa es aceptable; una que hace cinco es un servicio sin observabilidad, y entonces prefiero pagar REST API.
- Si el coste de WAF (~$5/mes + $1 por millón de peticiones) superara al ahorro de HTTP API frente a REST API. A este volumen no ocurre.
