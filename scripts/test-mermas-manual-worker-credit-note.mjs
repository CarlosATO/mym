import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/20261026120000_mermas_manual_worker_credit_notes.sql", "utf8");
const action = readFileSync("src/app/actions/logistica/mermas.ts", "utf8");
const panel = readFileSync("src/modules/logistica/mermas/worker-account-panel.tsx", "utf8");

function available(original, notes, paid) {
  return Math.max(original - notes - paid, 0);
}

test("saldo de NC total y parcial", () => {
  assert.equal(available(100, 0, 0), 100);
  assert.equal(available(100, 40, 0), 60);
});

test("NC previa y pago reducen el saldo de la misma Boleta", () => {
  assert.equal(available(100, 30, 0), 70);
  assert.equal(available(100, 0, 40), 60);
  assert.equal(available(100, 0, 40) >= 70, false);
});

test("contrato de seguridad y trazabilidad", () => {
  assert.match(migration, /source_type = 'BSALE_BOLETA'/);
  assert.match(migration, /source_type = 'BSALE_NOTA_CREDITO'/);
  assert.match(migration, /reversal_of_charge_id/);
  assert.match(migration, /metadata->>'credit_note_number'/);
  assert.match(migration, /MERMA_NC_MANUAL/);
  assert.match(migration, /worker_credit_note_evidence/);
  assert.match(migration, /p_amount > v_available/);
  assert.match(migration, /p_mime_type <> 'application\/pdf'/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /logistica\.mermas\.authorize/);
});

test("folio duplicado, cargo inválido y evidencia obligatoria quedan bloqueados", () => {
  assert.match(migration, /mermas_manual_credit_note_folio_uidx/);
  assert.match(migration, /El cargo seleccionado no es una Boleta Bsale activa/);
  assert.match(migration, /El PDF de la Nota de Crédito no existe/);
  assert.match(action, /registerManualWorkerCreditNote/);
  assert.match(panel, /Agregar nota de crédito/);
  assert.match(panel, /disabled=\{busy \|\| !file/);
});
