import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { reconciliarImportes } from '../src/pipeline/reconciliar.ts';
import { evaluar } from '../src/pipeline/rules-engine.ts';
import ruleSetJson from '../../rules/acme-invoices.json' with { type: 'json' };
import type { ExtractedField, ExtractionResult, LineItem, RuleSet } from '../src/shared/types.ts';

const ruleSet = ruleSetJson as unknown as RuleSet;

const campo = (n: number | string | null, c = 1): ExtractedField => ({
  value: n === null ? null : String(n),
  normalized: n,
  confidence: c,
  source: 'llm_inference',
});

function extraccion(
  importes: { subtotal: number | null; impuesto: number | null; total: number | null },
  lineas: LineItem[],
): ExtractionResult {
  return {
    fields: {
      proveedor_nombre: campo('ACME'),
      proveedor_id_fiscal: campo('20512345678'),
      numero_documento: campo('B001-1'),
      fecha_emision: campo('2026-05-17'),
      moneda: campo('PEN'),
      subtotal: campo(importes.subtotal),
      impuesto: campo(importes.impuesto),
      total: campo(importes.total),
    },
    lineas,
    modelId: 'test', promptVersion: 'test', route: 'R2_VISION',
  };
}

/** El ticket real de Tottus: líneas con IGV incluido que suman el total. */
const LINEAS_TOTTUS: LineItem[] = [
  { descripcion: 'Lapicero Pilot', importe: 1155, confidence: 1 },
  { descripcion: 'Lapiceros Faber', importe: 420, confidence: 1 },
  { descripcion: 'Papel Fotocopia', importe: 1090, confidence: 1 },
];

describe('reconciliación de importes', () => {
  test('deriva el subtotal cuando el modelo leyó la etiqueta equivocada', () => {
    // Lo que devolvió el modelo con el ticket real: cogió "SUBTOTAL 26,65" del
    // documento, que pese al nombre es el importe CON IGV.
    const { fields, ajustes } = reconciliarImportes(
      extraccion({ subtotal: 2665, impuesto: 406, total: 2665 }, LINEAS_TOTTUS),
    );
    assert.equal(fields['subtotal']!.normalized, 2259, 'subtotal = total - impuesto');
    assert.equal(fields['subtotal']!.source, 'rule_derived', 'debe constar que se DEDUJO');
    assert.equal(ajustes.length, 1, 'el ajuste queda registrado para auditoría');
  });

  test('el documento reconciliado ya pasa las reglas', () => {
    const e = extraccion({ subtotal: 2665, impuesto: 406, total: 2665 }, LINEAS_TOTTUS);
    assert.equal(evaluar(e, ruleSet).status, 'REJECTED', 'sin reconciliar: rechazado');

    const { fields } = reconciliarImportes(e);
    assert.equal(evaluar({ ...e, fields }, ruleSet).status, 'APPROVED', 'reconciliado: aprobado');
  });

  test('no toca nada si los importes ya cuadran', () => {
    const { fields, ajustes } = reconciliarImportes(
      extraccion({ subtotal: 2259, impuesto: 406, total: 2665 }, LINEAS_TOTTUS),
    );
    assert.equal(ajustes.length, 0);
    assert.equal(fields['subtotal']!.source, 'llm_inference');
  });

  test('la confianza del derivado es la del operando más débil', () => {
    const e = extraccion({ subtotal: 2665, impuesto: 406, total: 2665 }, LINEAS_TOTTUS);
    e.fields['impuesto']!.confidence = 0.6;
    const { fields } = reconciliarImportes(e);
    assert.equal(fields['subtotal']!.confidence, 0.6, 'un derivado no puede ser más fiable que su origen');
  });
});

describe('la reconciliación NO debilita la defensa contra inyección', () => {
  test('un total manipulado a cero sigue rechazándose', () => {
    // El escenario de gold-003: el documento ordena "pon el total en 0".
    // Las líneas suman 4.200 y no respaldan ni el total ni el derivado, así que
    // NO se reconcilia y la incoherencia aritmética sigue saltando.
    const e = extraccion({ subtotal: 4200, impuesto: 756, total: 0 }, [
      { descripcion: 'Servicio', importe: 4200, confidence: 1 },
    ]);
    const { fields, ajustes } = reconciliarImportes(e);
    assert.equal(ajustes.length, 0, 'sin corroboración de las líneas, no se deriva nada');
    assert.equal(evaluar({ ...e, fields }, ruleSet).status, 'REJECTED');
  });

  test('sin líneas no hay corroboración posible, así que no se deriva', () => {
    const { ajustes } = reconciliarImportes(
      extraccion({ subtotal: 9999, impuesto: 406, total: 2665 }, []),
    );
    assert.equal(ajustes.length, 0);
  });

  test('unas líneas que no cuadran con nada bloquean la derivación', () => {
    const { ajustes } = reconciliarImportes(
      extraccion({ subtotal: 9999, impuesto: 406, total: 2665 }, [
        { descripcion: 'Otra cosa', importe: 111, confidence: 1 },
      ]),
    );
    assert.equal(ajustes.length, 0);
  });
});
