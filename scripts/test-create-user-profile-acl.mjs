import assert from 'node:assert/strict'
import pg from 'pg'

const { Client } = pg
const connectionString = process.env.DATABASE_RUNTIME_DSN || process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const client = new Client({ connectionString })

await client.connect()
try {
  const { rows } = await client.query(`
    SELECT
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      ) AS public_execute,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'portal'
      AND p.proname = 'create_user_profile'
      AND p.proargtypes = ARRAY[
        'uuid'::regtype::oid,
        'varchar'::regtype::oid,
        'varchar'::regtype::oid,
        'varchar'::regtype::oid,
        'uuid'::regtype::oid,
        'uuid'::regtype::oid
      ]::oidvector
  `)

  assert.equal(rows.length, 1, 'Debe existir exactamente una firma de create_user_profile')
  assert.equal(rows[0].public_execute, false, 'PUBLIC no debe tener EXECUTE')
  assert.equal(rows[0].anon_execute, false, 'anon no debe tener EXECUTE')
  assert.equal(rows[0].authenticated_execute, false, 'authenticated no debe tener EXECUTE')
  assert.equal(rows[0].service_role_execute, true, 'service_role debe conservar EXECUTE')
  console.log('ACL de portal.create_user_profile: correcta')
} finally {
  await client.end()
}
