#!/usr/bin/env node
const BASE = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const AUTH_JWT = process.env.INVENTORY_SMOKE_AUTH_JWT || '';
if (!BASE || !ANON_KEY) { console.error('FAIL: SUPABASE_URL and SUPABASE_ANON_KEY required'); process.exit(1); }
const UUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
const REST = BASE.replace(/\/$/, '') + '/rest/v1';
const anonHeaders = { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' };
const authHeaders = AUTH_JWT ? { 'apikey': ANON_KEY, 'Authorization': `Bearer ${AUTH_JWT}`, 'Content-Type': 'application/json' } : null;
const schemaHeaders = { 'Accept-Profile': 'inventarios' };
let passed = 0, failed = 0, skipped = 0, indeterminate = 0;
function summary(name, status, code, detail) {
  const msg = detail ? ` (${String(detail).substring(0, 200)})` : '';
  console.log(`${status}: ${name} [${code}]${msg}`);
  if (status === 'PASS') passed++; else if (status === 'FAIL') failed++;
  else if (status === 'SKIP') skipped++; else if (status === 'INDT') indeterminate++;
}
async function get(path, extra) {
  return fetch(REST + path, { headers: { ...anonHeaders, ...schemaHeaders, ...(extra || {}) } });
}
async function rpc(name, payload, useAuth) {
  const headers = useAuth ? { ...authHeaders, ...schemaHeaders, 'Content-Profile': 'inventarios' } : { ...anonHeaders, ...schemaHeaders, 'Content-Profile': 'inventarios' };
  return fetch(REST + '/rpc/' + name, { method: 'POST', headers, body: JSON.stringify(payload) });
}
async function run() {
  const ruid = UUID();
  console.log('--- Prueba 1: Tabla directa como anon ---');
  try {
    const r1 = await get('/sessions?select=id&limit=1');
    const t1 = await r1.text();
    const code = t1.length < 300 ? t1 : t1.substring(0, 100);
    if (r1.status === 200) summary('Tabla anon', 'FAIL', String(r1.status), 'Acceso directo inesperado');
    else if (r1.status === 401 || r1.status === 403 || t1.includes('42501') || t1.includes('permission denied')) summary('Tabla anon', 'PASS', String(r1.status), 'Denegado');
    else if (t1.includes('PGRST106')) summary('Tabla anon', 'FAIL', String(r1.status), 'Schema no expuesto (PGRST106)');
    else summary('Tabla anon', 'FAIL', String(r1.status), code);
  } catch (e) { summary('Tabla anon', 'FAIL', 'ERR', e.message); }
  console.log('--- Prueba 2: RPC approve como anon ---');
  try {
    const r2 = await rpc('approve_inventory_session', { p_company_id: UUID(), p_session_id: UUID(), p_idempotency_key: UUID() });
    const t2 = await r2.text();
    const code2 = t2.length < 300 ? t2 : t2.substring(0, 100);
    if (r2.status >= 200 && r2.status < 300) summary('RPC anon', 'FAIL', String(r2.status), 'Ejecucion inesperada');
    else summary('RPC anon', 'PASS', String(r2.status), 'Denegado');
  } catch (e) { summary('RPC anon', 'FAIL', 'ERR', e.message); }
  console.log('--- Prueba 3: Helper get_effective_count_entries como anon ---');
  try {
    const r3 = await rpc('get_effective_count_entries', { p_company_id: UUID(), p_session_id: UUID(), p_task_id: UUID(), p_recount_request_id: null });
    const t3 = await r3.text();
    if (r3.status >= 200 && r3.status < 300) summary('Helper anon', 'FAIL', String(r3.status), 'Helper accesible');
    else summary('Helper anon', 'PASS', String(r3.status), 'Denegado');
  } catch (e) { summary('Helper anon', 'FAIL', 'ERR', e.message); }
  console.log('--- Prueba 4: Tabla directa como authenticated ---');
  if (authHeaders) {
    try {
      const r4 = await get('/sessions?select=id&limit=1', authHeaders);
      const t4 = await r4.text();
      if (r4.status === 200) summary('Tabla auth', 'FAIL', String(r4.status), 'Acceso directo');
      else summary('Tabla auth', 'PASS', String(r4.status), 'Denegado');
    } catch (e) { summary('Tabla auth', 'FAIL', 'ERR', e.message); }
  } else { summary('Tabla auth', 'SKIP', '-', 'Sin JWT'); }
  console.log('--- Prueba 5: Helper como authenticated ---');
  if (authHeaders) {
    try {
      const r5 = await rpc('get_effective_count_entries', { p_company_id: UUID(), p_session_id: UUID(), p_task_id: UUID(), p_recount_request_id: null }, true);
      const t5 = await r5.text();
      if (r5.status >= 200 && r5.status < 300) summary('Helper auth', 'FAIL', String(r5.status), 'Helper accesible');
      else summary('Helper auth', 'PASS', String(r5.status), 'Denegado');
    } catch (e) { summary('Helper auth', 'FAIL', 'ERR', e.message); }
  } else { summary('Helper auth', 'SKIP', '-', 'Sin JWT'); }
  console.log('--- Prueba 6: RPC sin permiso como authenticated ---');
  if (authHeaders) {
    try {
      const r6 = await rpc('approve_inventory_session', { p_company_id: UUID(), p_session_id: UUID(), p_idempotency_key: UUID() }, true);
      const t6 = await r6.text();
      const c6 = t6.length < 200 ? t6 : t6.substring(0, 150);
      if (r6.status >= 200 && r6.status < 300) summary('RPC auth sin permiso', 'FAIL', String(r6.status), 'Ejecucion');
      else if (t6.includes('INV_PERMISSION_REQUIRED') || t6.includes('INV_INVALID_REQUEST_PAYLOAD')) summary('RPC auth sin permiso', 'PASS', String(r6.status), 'Autorizacion rechazada');
      else summary('RPC auth sin permiso', 'INDT', String(r6.status), c6);
    } catch (e) { summary('RPC auth sin permiso', 'FAIL', 'ERR', e.message); }
  } else { summary('RPC auth sin permiso', 'SKIP', '-', 'Sin JWT'); }
  console.log(`\nResultados: PASS=${passed} FAIL=${failed} SKIP=${skipped} INDT=${indeterminate}`);
  process.exit(failed > 0 ? 1 : 0);
}
run();
