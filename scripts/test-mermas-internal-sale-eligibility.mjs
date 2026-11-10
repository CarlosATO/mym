import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const action = await readFile("src/app/actions/logistica/mermas.ts", "utf8");
const migration = await readFile(
  "supabase/migrations/20261105130000_mermas_internal_sale_current_expiry.sql",
  "utf8",
);
const saleMigration = await readFile(
  "supabase/migrations/20261105130000_mermas_internal_sale_current_expiry.sql",
  "utf8",
);

test("catalog uses current date instead of a five-day buffer", () => {
  assert.match(action, /const today = todayInSantiago\(\)/);
  assert.match(action, /p_today_plus_five: today/);
  assert.match(migration, /p_today_plus_five date/);
  assert.match(migration, /stock\.expiration_date >= p_today_plus_five/);
  assert.match(migration, /stock\.expiration_date IS NULL AND coalesce\(product\.requires_expiration, false\) = false/);
  assert.doesNotMatch(migration, /p_today_plus_five \+ 5/);
});

test("catalog and transaction both reject expired stock", () => {
  assert.match(migration, /stock\.expiration_date >= p_today_plus_five/);
  assert.match(saleMigration, /sc\.expiration_date >= v_today/);
  assert.match(saleMigration, /sc\.expiration_date IS NULL AND coalesce\(p\.requires_expiration, false\) = false/);
});
