import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("OPERADOR_BODEGA receives only Mermas read grants", async () => {
  const migration = await read("supabase/migrations/20261026130000_mermas_operator_read_access.sql");
  for (const permission of [
    "logistica.mermas.account.view", "logistica.mermas.pending.view",
    "logistica.mermas.stock_exit.view", "logistica.mermas.authorization.view",
    "logistica.mermas.settings.view",
  ]) assert.match(migration, new RegExp(permission.replaceAll(".", "\\.")));
  assert.match(migration, /role\.name = 'OPERADOR_BODEGA'/);
  assert.doesNotMatch(migration, /logistica\.mermas\.(authorize|sync)/);
});

test("read-only UI and server actions remain separated from writes", async () => {
  const actions = await read("src/app/actions/logistica/mermas.ts");
  const authorizationPanel = await read("src/modules/logistica/mermas/mermas-authorization-panel.tsx");
  const stockPanel = await read("src/modules/logistica/mermas/mermas-stock-exit-panel.tsx");
  const navigation = await read("src/app/dashboard/logistica/wms-navigation.ts");
  assert.match(actions, /requireMermasAuthorizationView\(\)/);
  assert.match(actions, /requireWmsPermission\("logistica\.mermas\.stock_exit\.view"\)/);
  assert.match(authorizationPanel, /bootstrap\.canAuthorize &&/);
  assert.match(stockPanel, /bootstrap\.isSuperUser && <button/);
  assert.match(navigation, /logistica\.mermas\.authorization\.view/);
  assert.match(navigation, /logistica\.mermas\.settings\.view/);
});
