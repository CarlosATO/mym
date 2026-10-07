import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const evidenceForm = await readFile("src/modules/logistica/mermas/new-merma-form-with-evidence.tsx", "utf8");
const legacyForm = await readFile("src/modules/logistica/mermas/new-merma-form.tsx", "utf8");
const migration = await readFile("supabase/migrations/20261007140000_mermas_wms_optional_traceability.sql", "utf8");

function selectable(product) {
  return !product.is_pack && product.stock_available !== null && product.stock_available > 0;
}

function allocateLine(bsaleStock, wmsStock, quantity) {
  return bsaleStock !== null && bsaleStock > 0 && quantity <= bsaleStock && wmsStock >= quantity
    ? quantity
    : 0;
}

test("Bsale controls product selection, not WMS", () => {
  assert.equal(selectable({ is_pack: false, stock_available: 51, wms_stock_available: null }), true);
  assert.equal(selectable({ is_pack: false, stock_available: 10, wms_stock_available: 0 }), true);
  assert.equal(selectable({ is_pack: false, stock_available: 0, wms_stock_available: 10 }), false);
  assert.equal(selectable({ is_pack: false, stock_available: null, wms_stock_available: 10 }), false);
  assert.equal(selectable({ is_pack: true, stock_available: 10, wms_stock_available: 10 }), false);
});

test("WMS allocation is complete-or-zero per line", () => {
  assert.equal(allocateLine(51, 0, 1), 0);
  assert.equal(allocateLine(10, 10, 2), 2);
  assert.equal(allocateLine(10, 2, 3), 0);
  assert.equal(allocateLine(2, 10, 3), 0);
});

test("frontend does not retain WMS blocking validations", () => {
  assert.doesNotMatch(evidenceForm, /stock disponible en WMS|supera el stock disponible en WMS/);
  assert.doesNotMatch(legacyForm, /No hay stock WMS disponible|supera el stock WMS disponible/);
  assert.match(evidenceForm, /Sin trazabilidad/);
  assert.match(legacyForm, /Sin trazabilidad/);
});

test("forward migration skips incomplete lines without partial reservations", () => {
  assert.match(migration, /IF v_available_total < v_remaining THEN CONTINUE; END IF/);
  assert.doesNotMatch(migration, /RAISE EXCEPTION 'Stock WMS insuficiente para la línea/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION mermas\.reserve_wms_allocations/);
});
