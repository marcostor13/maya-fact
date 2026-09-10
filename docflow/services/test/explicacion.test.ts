import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PermanentError } from '../src/shared/errors.ts';
import { codigoDeCausa, explicarCierre, explicarDecision } from '../src/shared/explicacion.ts';
import type { Decision } from '../src/shared/types.ts';

/**
 * Tests del catálogo de motivos.
 *
 * Lo que se prueba aquí no es texto bonito: es que **el motivo concreto llegue
 * hasta el final**. El fallo que estos tests existen para impedir no era una
 * frase mal escrita, era una cadena rota — el código del error se perdía en el
 * salto a Step Functions y todos los documentos en cuarentena decían lo mismo,
 * daba igual por qué hubieran fallado.
 *
 * Deterministas, sin AWS y sin modelo: corren en cada push sin coste.
 */

const decision = (parcial: Partial<Decision> = {}): Decision => ({
  status: 'APPROVED',
  hits: [],
  camposBajoUmbral: [],
  rulesetVersion: '2026-09-08.4',
  ...parcial,
});

describe('el código del error sobrevive al salto a Step Functions', () => {
  test('un PermanentError lleva su código dentro del mensaje', () => {
    const err = new PermanentError('Tipo de archivo no reconocido', 'MIME_DESCONOCIDO');
    assert.match(err.message, /^\[MIME_DESCONOCIDO\]/);
    // El name NO se toca: Step Functions selecciona los reintentos por él.
    assert.equal(err.name, 'PermanentError');
  });

  test('se recupera el código de un Cause con la forma que emite Lambda', () => {
    const cause = JSON.stringify({
      errorType: 'PermanentError',
      errorMessage: '[DEMASIADAS_PAGINAS] Documento de 900 páginas supera el límite',
      trace: ['PermanentError: ...', '    at handler (/var/task/index.js:1:1)'],
    });
    assert.equal(codigoDeCausa(cause), 'DEMASIADAS_PAGINAS');
  });

  test('un Cause que no es JSON no rompe nada', () => {
    assert.equal(codigoDeCausa('States.Timeout'), undefined);
    assert.equal(codigoDeCausa(undefined), undefined);
  });

  /**
   * Este es el test que parece paranoia y no lo es: el `Cause` es una cadena
   * que no controlamos del todo, y lo que sale de aquí elige el texto que lee
   * un cliente. Sin lista blanca, un mensaje de error que empezara por algo
   * con forma de código haría que la interfaz mostrara una frase inventada.
   */
  test('un código desconocido se descarta en vez de propagarse', () => {
    const cause = JSON.stringify({ errorMessage: '[BORRA_TODO] cualquier cosa' });
    assert.equal(codigoDeCausa(cause), undefined);
  });
});

describe('explicación de un cierre por el camino de fallo', () => {
  test('el código concreto manda sobre el motivo de fase', () => {
    const conCodigo = explicarCierre('CLASIFICACION_FALLIDA', 'MIME_DESCONOCIDO');
    const sinCodigo = explicarCierre('CLASIFICACION_FALLIDA');
    assert.notEqual(conCodigo.resumen, sinCodigo.resumen);
    assert.match(conCodigo.resumen, /PDF|imagen/i);
  });

  test('sin código sigue habiendo una frase útil, no un hueco', () => {
    const e = explicarCierre('EXTRACCION_FALLIDA');
    assert.ok(e.resumen.length > 0);
    assert.ok(e.detalles.length > 0);
  });

  test('un motivo que no existe no deja al usuario sin respuesta', () => {
    const e = explicarCierre('MOTIVO_QUE_NO_EXISTE_TODAVIA');
    assert.ok(e.resumen.length > 0);
  });

  test('el duplicado explica que el original sigue siendo válido', () => {
    const e = explicarCierre('CONTENIDO_YA_PROCESADO');
    assert.match(`${e.resumen} ${e.detalles.join(' ')}`, /idéntico|mismo contenido/i);
  });
});

describe('explicación de una decisión del motor de reglas', () => {
  test('un rechazo enumera las reglas con su identificador', () => {
    const e = explicarDecision(
      decision({
        status: 'REJECTED',
        hits: [{ id: 'R-002', severidad: 'BLOCK', mensaje: 'Subtotal + impuesto no cuadra con el total (495600)' }],
      }),
    );
    assert.match(e.resumen, /Rechazada/);
    // El identificador es lo que se cita en una reclamación: tiene que estar.
    assert.ok(e.detalles.some((d) => d.includes('R-002')));
  });

  test('un campo dudoso NO se cuenta como regla incumplida', () => {
    const e = explicarDecision(
      decision({ status: 'NEEDS_REVIEW', camposBajoUmbral: ['total', 'numero_documento'] }),
    );
    assert.doesNotMatch(e.resumen, /Rechazada/);
    // Y se nombra en castellano, no con la clave del esquema.
    assert.ok(e.detalles.some((d) => d.includes('importe total')));
    assert.ok(e.detalles.every((d) => !d.includes('numero_documento')));
  });

  test('una aprobación también dice que lo es', () => {
    const e = explicarDecision(decision());
    assert.match(e.resumen, /Aprobada/);
  });

  /**
   * Un importe deducido en vez de leído se enseña SIEMPRE, también cuando la
   * factura se aprueba. Esconderlo en una aprobación sería corregir en
   * silencio, que es justo lo que `source: 'rule_derived'` existe para evitar.
   */
  test('los ajustes automáticos se enseñan incluso en las aprobadas', () => {
    const e = explicarDecision(decision(), ['subtotal recalculado como total - impuesto']);
    assert.ok(e.detalles.some((d) => d.includes('subtotal recalculado')));
  });

  test('el plural cuadra con el número de reglas', () => {
    const una = explicarDecision(
      decision({ status: 'REJECTED', hits: [{ id: 'R-001', severidad: 'BLOCK', mensaje: 'x' }] }),
    );
    const dos = explicarDecision(
      decision({
        status: 'REJECTED',
        hits: [
          { id: 'R-001', severidad: 'BLOCK', mensaje: 'x' },
          { id: 'R-002', severidad: 'BLOCK', mensaje: 'y' },
        ],
      }),
    );
    assert.match(una.resumen, /una comprobación obligatoria no se cumple/);
    assert.match(dos.resumen, /2 comprobaciones obligatorias/);
  });
});
