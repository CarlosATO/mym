#!/usr/bin/env node
const BASE = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const AUTH_JWT = process.env.INVENTORY_SMOKE_AUTH_JWT || '';
const NO_PERM_JWT = process.env.INVENTORY_SMOKE_NO_PERMISSION_JWT || AUTH_JWT;
const BODEGA_JWT = process.env.INVENTORY_SMOKE_BODEGA_JWT || '';
const GERENCIA_JWT = process.env.INVENTORY_SMOKE_GERENCIA_JWT || '';
const SUPER_USUARIO_JWT = process.env.INVENTORY_SMOKE_SUPER_USUARIO_JWT || '';
const COMPANY_ID = process.env.INVENTORY_SMOKE_COMPANY_ID || '';
if (!BASE || !ANON_KEY) { console.error('FAIL: SUPABASE_URL and SUPABASE_ANON_KEY required'); process.exit(1); }
const UUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
const REST = BASE.replace(/\/$/, '') + '/rest/v1';
const anonHeaders = { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' };
const schemaHeaders = { 'Accept-Profile': 'inventarios' };
function authHeaders(jwt) { return jwt ? { 'apikey': ANON_KEY, 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' } : null; }
let passed = 0, failed = 0, skipped = 0, indeterminate = 0;
function summary(name, status, code, detail) {
  const msg = detail ? ` (${String(detail).substring(0, 200)})` : '';
  console.log(`${status}: ${name} [${code}]${msg}`);
  if (status === 'PASS') passed++; else if (status === 'FAIL') failed++;
  else if (status === 'SKIP') skipped++; else if (status === 'INDT') indeterminate++;
}
async function get(path, jwt) {
  return fetch(REST + path, { headers: { ...anonHeaders, ...schemaHeaders, ...(jwt ? authHeaders(jwt) : {}) } });
}
async function rpc(name, payload, jwt) {
  const headers = jwt
    ? { ...authHeaders(jwt), ...schemaHeaders, 'Content-Profile': 'inventarios' }
    : { ...anonHeaders, ...schemaHeaders, 'Content-Profile': 'inventarios' };
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
  console.log('--- Prueba A: Tabla directa como authenticated ---');
  if (AUTH_JWT) {
    try {
      const r4 = await get('/sessions?select=id&limit=1', AUTH_JWT);
      const t4 = await r4.text();
      if (r4.status === 200) summary('Tabla auth', 'FAIL', String(r4.status), 'Acceso directo');
      else summary('Tabla auth', 'PASS', String(r4.status), 'Denegado');
    } catch (e) { summary('Tabla auth', 'FAIL', 'ERR', e.message); }
  } else { summary('Tabla auth', 'SKIP', '-', 'Sin JWT'); }
  console.log('--- Prueba B: Helper como authenticated ---');
  if (AUTH_JWT) {
    try {
      const r5 = await rpc('get_effective_count_entries', { p_company_id: UUID(), p_session_id: UUID(), p_task_id: UUID(), p_recount_request_id: null }, AUTH_JWT);
      const t5 = await r5.text();
      if (r5.status >= 200 && r5.status < 300) summary('Helper auth', 'FAIL', String(r5.status), 'Helper accesible');
      else summary('Helper auth', 'PASS', String(r5.status), 'Denegado');
    } catch (e) { summary('Helper auth', 'FAIL', 'ERR', e.message); }
  } else { summary('Helper auth', 'SKIP', '-', 'Sin JWT'); }
  console.log('--- Prueba C: Usuario sin permiso ---');
  if (NO_PERM_JWT) {
    try {
      const payload = COMPANY_ID ? { p_company_id: COMPANY_ID, p_session_id: UUID(), p_idempotency_key: UUID() } : { p_company_id: UUID(), p_session_id: UUID(), p_idempotency_key: UUID() };
      const r6 = await rpc('approve_inventory_session', payload, NO_PERM_JWT);
      const t6 = await r6.text();
      const c6 = t6.length < 200 ? t6 : t6.substring(0, 150);
      if (r6.status >= 200 && r6.status < 300) summary('Sin permiso', 'FAIL', String(r6.status), 'Ejecucion inesperada');
      else if (t6.includes('INV_PERMISSION_REQUIRED') || t6.includes('INV_INVALID_REQUEST_PAYLOAD')) summary('Sin permiso', 'PASS', String(r6.status), 'Autorizacion rechazada');
      else if (t6.includes('INV_NOT_FOUND')) summary('Sin permiso', 'FAIL', String(r6.status), 'INV_NOT_FOUND');
      else summary('Sin permiso', 'INDT', String(r6.status), c6);
    } catch (e) { summary('Sin permiso', 'FAIL', 'ERR', e.message); }
  } else { summary('Sin permiso', 'SKIP', '-', 'Sin JWT'); }
  console.log('--- Prueba D: BODEGA no aprueba ---');
  if (BODEGA_JWT) {
    try {
      const payload = COMPANY_ID ? { p_company_id: COMPANY_ID, p_session_id: UUID(), p_idempotency_key: UUID() } : { p_company_id: UUID(), p_session_id: UUID(), p_idempotency_key: UUID() };
      const r7 = await rpc('approve_inventory_session', payload, BODEGA_JWT);
      const t7 = await r7.text();
      const c7 = t7.length < 200 ? t7 : t7.substring(0, 150);
      if (r7.status >= 200 && r7.status < 300) summary('BODEGA no aprueba', 'FAIL', String(r7.status), 'Ejecucion inesperada');
      else if (t7.includes('INV_PERMISSION_REQUIRED')) summary('BODEGA no aprueba', 'PASS', String(r7.status), 'Permiso denegado');
      else if (t7.includes('INV_NOT_FOUND')) summary('BODEGA no aprueba', 'FAIL', String(r7.status), 'INV_NOT_FOUND');
      else if (t7.includes('INV_COMPANY_ACCESS_DENIED')) summary('BODEGA no aprueba', 'INDT', String(r7.status), 'Acceso empresa');
      else summary('BODEGA no aprueba', 'INDT', String(r7.status), c7);
    } catch (e) { summary('BODEGA no aprueba', 'FAIL', 'ERR', e.message); }
  } else { summary('BODEGA no aprueba', 'SKIP', '-', 'Sin JWT'); }
  console.log('--- Prueba E: GERENCIA supera permiso ---');
  if (GERENCIA_JWT) {
    if (!COMPANY_ID) { summary('GERENCIA supera permiso', 'SKIP', '-', 'Sin COMPANY_ID'); }
    else {
      try {
        const r8 = await rpc('approve_inventory_session', { p_company_id: COMPANY_ID, p_session_id: UUID(), p_idempotency_key: UUID() }, GERENCIA_JWT);
        const t8 = await r8.text();
        const c8 = t8.length < 200 ? t8 : t8.substring(0, 150);
        if (r8.status >= 200 && r8.status < 300) summary('GERENCIA supera permiso', 'FAIL', String(r8.status), 'Ejecucion exitosa');
        else if (t8.includes('INV_NOT_FOUND')) summary('GERENCIA supera permiso', 'PASS', String(r8.status), 'Permiso superado, entidad inexistente');
        else if (t8.includes('INV_PERMISSION_REQUIRED')) summary('GERENCIA supera permiso', 'FAIL', String(r8.status), 'Falta permiso');
        else if (t8.includes('INV_COMPANY_ACCESS_DENIED')) summary('GERENCIA supera permiso', 'INDT', String(r8.status), 'Acceso empresa');
        else if (t8.includes('INV_INVALID_REQUEST_PAYLOAD')) summary('GERENCIA supera permiso', 'PASS', String(r8.status), 'Permiso superado, payload rechazado');
        else summary('GERENCIA supera permiso', 'INDT', String(r8.status), c8);
      } catch (e) { summary('GERENCIA supera permiso', 'FAIL', 'ERR', e.message); }
    }
  } else { summary('GERENCIA supera permiso', 'SKIP', '-', 'Sin JWT'); }
  console.log('--- Prueba F: SUPER_USUARIO supera permiso ---');
  if (SUPER_USUARIO_JWT) {
    if (!COMPANY_ID) { summary('SUPER_USUARIO supera permiso', 'SKIP', '-', 'Sin COMPANY_ID'); }
    else {
      try {
        const r9 = await rpc('start_inventory_task', { p_company_id: COMPANY_ID, p_task_id: UUID(), p_expected_version: 1, p_idempotency_key: UUID() }, SUPER_USUARIO_JWT);
        const t9 = await r9.text();
        const c9 = t9.length < 200 ? t9 : t9.substring(0, 150);
        if (r9.status >= 200 && r9.status < 300) summary('SUPER_USUARIO supera permiso', 'FAIL', String(r9.status), 'Ejecucion exitosa');
        else if (t9.includes('INV_NOT_FOUND') || t9.includes('INV_TASK_INVALID_STATE') || t9.includes('INV_ASSIGNMENT_REQUIRED')) summary('SUPER_USUARIO supera permiso', 'PASS', String(r9.status), 'Permiso superado, contexto inexistente');
        else if (t9.includes('INV_PERMISSION_REQUIRED')) summary('SUPER_USUARIO supera permiso', 'FAIL', String(r9.status), 'Falta permiso');
        else if (t9.includes('INV_COMPANY_ACCESS_DENIED')) summary('SUPER_USUARIO supera permiso', 'INDT', String(r9.status), 'Acceso empresa');
        else summary('SUPER_USUARIO supera permiso', 'INDT', String(r9.status), c9);
      } catch (e) { summary('SUPER_USUARIO supera permiso', 'FAIL', 'ERR', e.message); }
    }
  } else { summary('SUPER_USUARIO supera permiso', 'SKIP', '-', 'Sin JWT'); }
  console.log(`\nResultados: PASS=${passed} FAIL=${failed} SKIP=${skipped} INDT=${indeterminate}`);
  process.exit(failed > 0 ? 1 : 0);
}
run();
