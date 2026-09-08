# ADR-002 — El archivo sube directo a S3 con un presigned POST

**Estado:** aceptada · **Código:** `services/src/api/create-upload.ts`

## Contexto

El usuario sube facturas de hasta **20 MB**. La forma intuitiva —y la que
propone casi cualquier borrador— es un endpoint `POST /documents` que recibe el
archivo, lo valida y lo guarda en S3.

## Decisión

**El archivo nunca pasa por la API.** `POST /uploads` devuelve un **presigned
POST** de S3 con condiciones estrictas, y el navegador sube directamente al
bucket. La API firma un permiso; jamás toca los bytes.

```ts
Conditions: [
  ['content-length-range', 1, MAX_BYTES],
  ['eq', '$Content-Type', body.contentType],
  ['starts-with', '$key', `tenants/${caller.tenantId}/inbox/`],
]
```

La clave del objeto **la genera el servidor** e incluye el tenant sacado del
token. El cliente no elige dónde escribe.

## Alternativas evaluadas

| Opción | Por qué no |
|---|---|
| **Subida por la API (multipart o base64)** | API Gateway tiene un límite **duro de 10 MB** de payload, en REST y en HTTP API. Un PDF de 20 MB no cabe: no es una cuestión de configuración. En base64 además el payload crece un 33% |
| **Presigned URL (`PUT`)** | Funciona, pero **solo puede restringir la clave exacta**. No admite `content-length-range` ni condiciones sobre `Content-Type`: no hay forma de impedir que suban 5 GB |
| **Subida en dos fases con validación previa** | Añade un viaje y no aporta nada: la validación real es por contenido, y para eso hay que tener el contenido |

## Consecuencias

**Buenas**

- Se elimina el límite de 10 MB.
- No se paga transferencia, invocación ni memoria de Lambda por mover bytes.
- **El archivo no toca el backend antes de estar validado.** Un PDF hostil no llega a la memoria de ninguna función nuestra: aterriza en un bucket privado y se analiza después, en un paso aislado.
- **Las condiciones las aplica S3, no nuestro código.** Aunque el cliente manipule el formulario en el navegador —y lo hará—, S3 rechaza lo que no cumpla. Es un control que no depende de que no tengamos bugs.

**Malas**

- El cliente hace **dos llamadas** en vez de una, y hay que documentarlo.
- **Puede existir un intent sin archivo**: si el usuario pide el permiso y nunca sube. Se resuelve con TTL de 24 h sobre el ítem `PENDING`, y ese TTL hay que acordarse de **quitarlo** al llegar a un estado terminal — si no, un documento procesado desaparece al día siguiente.
- El bucket necesita **CORS** para el navegador, y el origen es el dominio de CloudFront, que no existe hasta que se crea la distribución. Parece una dependencia circular (no lo es: son buckets distintos), y es un fallo que **no aparece en desarrollo** y sí en producción.
- La expiración de 5 minutos es el tiempo de *subir*, no el de guardar el enlace. Con conexiones lentas y archivos de 20 MB puede quedarse corta.

## Cuándo revisaría esta decisión

- Si los archivos superasen los **5 GB**: habría que pasar a *multipart upload* con presigned por parte.
- Si un cliente exigiera **cifrado del lado del cliente** antes de subir: cambia el flujo de claves, no la decisión.
- Si hiciera falta **rechazar por contenido antes de almacenar** (por ejemplo, obligación de no persistir jamás un ejecutable). Hoy escribimos primero y validamos después, y esa es la contrapartida honesta de este diseño: el objeto malicioso *existe* en nuestro bucket durante unos segundos, aislado en el prefijo `inbox/`, antes de ir a `QUARANTINED`.
