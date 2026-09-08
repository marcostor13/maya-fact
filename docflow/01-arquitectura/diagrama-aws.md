# Vista de despliegue en AWS

El diagrama que van a mirar. Cajas por servicio, flechas con el protocolo y
**los límites de confianza dibujados**.

```mermaid
graph TB
    navegador["🌐 Navegador<br/>Angular SPA"]

    subgraph borde["🛡️ BORDE — límite de confianza público"]
        waf["AWS WAF<br/><i>3 grupos gestionados<br/>+ rate limit /api/uploads</i>"]
        cdn["CloudFront<br/><i>OAC · security headers<br/>un solo origen para UI y API</i>"]
        cffn["CloudFront Function<br/><i>quita el prefijo /api</i>"]
    end

    subgraph cuenta["☁️ CUENTA AWS — us-east-1"]
        subgraph plano_control["Plano de control (síncrono)"]
            s3web[("S3<br/>frontend<br/><i>privado</i>")]
            apigw["API Gateway<br/><b>HTTP API</b><br/><i>authorizer JWT</i>"]
            cognito["Cognito User Pool<br/><i>+ trigger pre-token</i>"]
            lup["λ CreateUpload"]
            lget["λ GetDocument"]
            llist["λ ListDocuments"]
        end

        s3docs[("S3 documentos<br/><i>SSE · versionado<br/>ciclo de vida 90d/7a</i>")]

        subgraph plano_datos["Plano de datos (asíncrono)"]
            eb["EventBridge<br/><i>filtrado declarativo</i>"]
            sqs["SQS Standard<br/><i>amortigua el pico 10×</i>"]
            dlq["SQS DLQ<br/><i>alarma con 1 mensaje</i>"]
            lcons["λ Consumer<br/><i>candado idempotencia<br/>lote parcial</i>"]
            sfn["Step Functions<br/><b>STANDARD</b><br/><i>21 estados</i>"]
        end

        subgraph pasos["Pasos del pipeline"]
            lclas["λ Classify<br/><i>magic bytes · sha256<br/>DECIDE LA RUTA</i>"]
            ldedup["λ Dedupe<br/><i>hash de contenido</i>"]
            lext["λ Extract<br/><i>Bedrock Converse</i>"]
            locr["λ OcrStart / OcrCollect<br/><i>solo ruta R3</i>"]
            ldec["λ Decide<br/><i>motor de reglas</i>"]
            lfin["λ Finalize<br/><i>cierra estados terminales</i>"]
        end

        ddb[("DynamoDB<br/><i>single-table · GSI1<br/>PITR · TTL</i>")]
        bedrock["Bedrock<br/><i>1 model id, no *</i>"]
        textract["Textract<br/><i>solo DetectDocumentText</i>"]
        cw["CloudWatch<br/><i>3 alarmas · dashboard<br/>EMF · X-Ray</i>"]
        budget["AWS Budgets<br/><i>previsión 80%</i>"]
    end

    navegador -->|"HTTPS"| waf
    waf --> cdn
    cdn -->|"/*"| s3web
    cdn -->|"api/*"| cffn
    cffn -->|"HTTPS"| apigw
    navegador ==>|"<b>POST directo<br/>presigned</b>"| s3docs

    apigw --> lup & lget & llist
    apigw -.->|"valida JWT"| cognito
    lup -->|"firma permiso"| s3docs
    lup & lget & llist --> ddb

    s3docs -->|"Object Created"| eb --> sqs --> lcons
    sqs -.->|"maxReceiveCount 3"| dlq
    lcons -->|"StartExecution"| sfn
    lcons --> ddb

    sfn --> lclas --> ldedup --> lext --> ldec
    sfn -.->|"solo si NEEDS_REVIEW<br/>o TIFF"| locr --> textract
    sfn -.->|"caminos de fallo"| lfin
    lext --> bedrock
    ldec & lfin --> ddb
    lclas & lext & locr -->|"lee"| s3docs

    ddb & sqs & dlq & sfn -.-> cw
    cw -.-> budget

    classDef borde fill:#4a3a14,stroke:#f39c12,stroke-width:3px,color:#fff
    classDef datos fill:#14304a,stroke:#3498db,stroke-width:2px,color:#fff
    classDef almacen fill:#1e4a2e,stroke:#27ae60,stroke-width:2px,color:#fff
    classDef ml fill:#3d1a4a,stroke:#9b59b6,stroke-width:2px,color:#fff
    classDef alerta fill:#4a1e1e,stroke:#c0392b,stroke-width:2px,color:#fff

    class waf,cdn,cffn borde
    class ddb,s3docs,s3web almacen
    class bedrock,textract ml
    class dlq alerta
    class eb,sqs,sfn datos
```

## Las cinco cosas que hay que mirar en este diagrama

1. **La flecha gruesa del navegador a S3 no pasa por la API.** Es la decisión
   más visible del diseño (ADR-002). El backend firma un permiso; nunca toca los
   bytes. Elimina el límite de 10 MB, el coste de transferencia y la superficie
   de ataque de mover archivos por Lambda.

2. **Una sola distribución de CloudFront sirve la UI y la API.** No es estética:
   una HTTP API no admite WAF asociado, y ponerla detrás de CloudFront lo
   recupera. De propina, al compartir origen desaparece el preflight CORS.

3. **La CloudFront Function existe por una razón concreta.** El prefijo `/api`
   es un artefacto del navegador; la API no lo conoce. Sin el rewrite,
   CloudFront reenvía `/api/uploads` y API Gateway devuelve 404 a todo.

4. **Las flechas punteadas hacia OCR son condicionales, y ahí está el dinero.**
   Textract solo se llama en dos casos: cuando el modelo no puede leer el
   formato (TIFF) o cuando la decisión ya salió `NEEDS_REVIEW`. En el resto del
   volumen —la inmensa mayoría— **no se llama nunca** (ADR-011).

5. **Los límites de confianza están dibujados, no implícitos.** El borde es
   público; la cuenta es privada; y el plano de datos no tiene ninguna entrada
   desde fuera: solo se alimenta de eventos de S3.

## Lo que NO hay, y es deliberado

| Ausencia | Por qué |
|---|---|
| **VPC, subredes, NAT** | Ningún componente necesita red privada: todo son servicios gestionados con endpoints públicos autenticados por IAM. Una VPC aquí añadiría NAT Gateways (~$32/mes cada uno) y complejidad operativa para proteger nada |
| **Segunda región** | RTO de 4 h se cubre con PITR y versionado (ADR-010) |
| **API Gateway REST** | Más cara y de mayor latencia; su ventaja (WAF directo, usage plans) se recupera o no se necesita (ADR-001) |
| **WebSockets** | El *polling* con backoff resuelve el problema a este volumen |
| **Caché de API / provisioned concurrency** | Optimizarían el 5% de la factura |
