# Entrega

`Maya-Fact-Entrega.docx` — el documento con los cuatro entregables:
diagrama de arquitectura, documento de diseño con ADRs, fragmentos de
código y nota de uso de IA.

Los diagramas se generan con código (`diagramas.py`) y el documento con
`documento.py`, así que ambos son reproducibles y versionables:

```bash
python entrega/diagramas.py entrega
python entrega/documento.py entrega entrega/Maya-Fact-Entrega.docx
```

Un diagrama que se dibuja a mano en una herramienta gráfica se desactualiza
en cuanto cambia la arquitectura, y nadie lo revisa en un pull request.
Generarlo desde código lo pone bajo control de versiones como el resto.
