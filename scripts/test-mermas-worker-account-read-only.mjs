import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function accountCapabilities({ accountView, create, authorize, superUser }) {
  return {
    canView: accountView,
    canRegisterPayment: create,
    canAddCreditNote: authorize,
    canVoidPayment: authorize,
    canRegularizeBoleta: superUser,
  };
}

test("OPERADOR_BODEGA account access is read-only", () => {
  assert.deepEqual(accountCapabilities({ accountView: true, create: false, authorize: false, superUser: false }), {
    canView: true,
    canRegisterPayment: false,
    canAddCreditNote: false,
    canVoidPayment: false,
    canRegularizeBoleta: false,
  });
});

test("worker account UI binds write controls to server capabilities", async () => {
  const panel = await read("src/modules/logistica/mermas/worker-account-panel.tsx");
  assert.match(panel, /const canRegisterPayment = bootstrap\.canCreate/);
  assert.match(panel, /const canAddCreditNote = bootstrap\.canAuthorize/);
  assert.match(panel, /const canVoidPayment = bootstrap\.canAuthorize/);
  assert.match(panel, /getWorkerAccountRegularizationAccess/);
  assert.match(panel, /canRegisterPayment && <button/);
  assert.match(panel, /canAddCreditNote && charge\.source_type/);
  assert.match(panel, /canVoidPayment && payment\.status/);
});
