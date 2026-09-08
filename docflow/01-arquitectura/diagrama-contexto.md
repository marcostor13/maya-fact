# Diagrama de contexto (C4 nivel 1)

Quién usa el sistema, con qué sistemas habla, y **dónde está la frontera de
confianza**. Nada de servicios de AWS todavía: eso es el siguiente diagrama.

```mermaid
graph TB
    subgraph externo[" "]
        admin["👤 Administrativo<br/>de cuentas por pagar<br/><i>sube y revisa documentos</i>"]
        finanzas["👤 Responsable financiero<br/><i>consulta decisiones</i>"]
        auditor["👤 Auditor<br/><i>reproduce decisiones pasadas</i>"]
        erp["🖥️ ERP del cliente<br/><i>consume resultados vía API/webhook</i>"]
    end

    docflow["<b>DocFlow</b><br/>Ingesta y extracción<br/>de documentos<br/>multi-tenant"]

    subgraph proveedores["Servicios gestionados de AWS"]
        idp["Cognito<br/><i>identidad</i>"]
        ml["Bedrock · Textract<br/><i>extracción y OCR</i>"]
        correo["SNS<br/><i>notificación</i>"]
    end

    emisor["🏢 Proveedor emisor<br/><i>NO es usuario del sistema:<br/>controla el CONTENIDO del documento</i>"]

    admin -->|"sube facturas<br/>revisa dudosas"| docflow
    finanzas -->|"consulta estado<br/>y motivos"| docflow
    auditor -->|"pide la traza de<br/>una decisión"| docflow
    erp <-->|"API REST + webhooks"| docflow

    emisor -.->|"emite la factura que<br/>el administrativo sube"| admin

    docflow -->|"valida tokens"| idp
    docflow -->|"extrae campos"| ml
    docflow -->|"notifica resultados"| correo

    classDef amenaza fill:#4a1e1e,stroke:#c0392b,stroke-width:3px,color:#fff
    classDef sistema fill:#1a3a52,stroke:#3498db,stroke-width:3px,color:#fff
    classDef persona fill:#2c3e50,stroke:#7f8c8d,color:#fff
    classDef aws fill:#3d2f14,stroke:#e67e22,color:#fff

    class emisor amenaza
    class docflow sistema
    class admin,finanzas,auditor,erp persona
    class idp,ml,correo aws
```

## Lo que este diagrama dice y otros no

**El proveedor emisor está dibujado aunque no toque el sistema.** Es la caja más
importante del diagrama y la que casi nadie pone. No tiene credenciales, no
tiene cuenta, no hace ninguna petición — y sin embargo **controla por completo
el contenido que entra en nuestro pipeline de extracción**.

Esa es la frontera de confianza real: no está entre "usuario autenticado" y
"anónimo", está entre **nuestro código** y **el contenido del documento**. Un
administrativo legítimo, con un token legítimo, sube un documento hostil sin
saberlo.

De ahí salen dos decisiones que se ven más adelante:

- La validación del archivo se hace por **magic bytes**, no por lo que declare
  quien lo sube — porque quien lo sube también fue engañado.
- El motor de reglas **no lee el documento**: lee el JSON ya validado. Esa
  separación es lo que impide que el contenido hostil alcance la decisión
  (ADR-012).

Y una consecuencia de producto: **el sistema no confía en su propio usuario**, no
porque sospeche de él, sino porque el usuario tampoco controla lo que reenvía.
