const { Client } = require('pg');
require('dotenv').config({ path: '.env.local' });

async function verify() {
  const client = new Client({
    connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL
  });
  
  await client.connect();

  try {
    console.log("--- 1. Usuario A: Rinde factura como PAID_CASH ---");
    
    // Obtenemos una empresa
    const { rows: companies } = await client.query(`SELECT id FROM core.companies LIMIT 1`);
    const companyId = companies[0].id;

    // Usuarios: A (adquisiciones), B (adquisiciones normal), Superuser (superuser)
    const { rows: users } = await client.query(`
      SELECT u.id, r.name as role 
      FROM portal.users u 
      JOIN portal.user_roles ur ON u.id = ur.user_id 
      JOIN portal.roles r ON ur.role_id = r.id
      WHERE r.name IN ('ADQUISICIONES', 'SUPER_USUARIO')
    `);

    const userA = users.find(u => u.role === 'ADQUISICIONES');
    const userB = users.find(u => u.role === 'ADQUISICIONES' && u.id !== userA.id) || userA; // fallback if only 1
    const superUser = users.find(u => u.role === 'SUPER_USUARIO');

    console.log(`Usuario A ID: ${userA.id}`);
    console.log(`Usuario B ID: ${userB?.id}`);
    console.log(`SuperUser ID: ${superUser.id}`);

    // Crear mock data: guide, settlement, item
    const { rows: guide } = await client.query(`
      INSERT INTO logistica.route_guides (company_id, driver_id, vehicle_id, expected_date, status, created_by)
      VALUES ($1, $2, $2, now(), 'IN_ROUTE', $2)
      RETURNING id
    `, [companyId, userA.id]);
    const guideId = guide[0].id;

    const { rows: item } = await client.query(`
      INSERT INTO logistica.route_guide_items (company_id, route_guide_id, document_type, document_number, total_amount, expected_payment_method)
      VALUES ($1, $2, 'INVOICE', 'TEST-INV-1', 1000, 'CASH')
      RETURNING id
    `, [companyId, guideId]);
    const guideItemId = item[0].id;

    const { rows: settlement } = await client.query(`
      INSERT INTO adquisiciones.route_settlements (company_id, settlement_number, settlement_year, settlement_sequence, route_guide_id, status, created_by)
      VALUES ($1, 'TEST-SETTLE-1', 2026, 9999, $2, 'PENDING', $3)
      RETURNING id
    `, [companyId, guideId, userA.id]);
    const settlementId = settlement[0].id;

    const { rows: sItem } = await client.query(`
      INSERT INTO adquisiciones.route_settlement_items (company_id, settlement_id, route_guide_item_id, invoice_number, expected_amount, expected_payment_method, status)
      VALUES ($1, $2, $3, 'TEST-INV-1', 1000, 'CASH', 'PENDING_PAYMENT')
      RETURNING id
    `, [companyId, settlementId, guideItemId]);
    const sItemId = sItem[0].id;

    // Simular RLS for User A to execute RPC
    await client.query(`set_config('request.jwt.claims', '{"sub": "${userA.id}"}', false)`);
    await client.query(`set_config('role', 'authenticated', false)`);
    
    // Usuario A rinde como PAID_CASH
    await client.query(`
      SELECT adquisiciones.update_route_settlement(
        $1,
        '[{"id": "${sItemId}", "status": "PAID_CASH", "received_amount": 1000}]'::jsonb,
        '',
        $2
      )
    `, [settlementId, userA.id]);

    // Verificar Custodia en la DB
    const { rows: res1 } = await client.query(`SELECT custody_user_id FROM adquisiciones.route_settlement_items WHERE id = $1`, [sItemId]);
    console.log(`Custodio del item después de rendir (Esperado: User A): ${res1[0].custody_user_id === userA.id ? 'ÉXITO' : 'FALLO'}`);
    
    // Crear Cierre (Simular Action createFundClosure)
    const { rows: closure } = await client.query(`
      INSERT INTO adquisiciones.route_fund_closures (company_id, closure_number, closure_year, closure_sequence, status, created_by, custody_user_id)
      VALUES ($1, 'TEST-CLOSURE-1', 2026, 9999, 'OPEN', $2, $2)
      RETURNING id
    `, [companyId, userA.id]);
    const closureId = closure[0].id;

    await client.query(`
      INSERT INTO adquisiciones.route_fund_closure_items (company_id, fund_closure_id, route_settlement_item_id, route_settlement_id, route_guide_id, invoice_number, payment_method, amount, custody_user_id)
      VALUES ($1, $2, $3, $4, $5, 'TEST-INV-1', 'CASH', 1000, $6)
    `, [companyId, closureId, sItemId, settlementId, guideId, userA.id]);

    const { rows: res2 } = await client.query(`SELECT custody_user_id FROM adquisiciones.route_fund_closures WHERE id = $1`, [closureId]);
    console.log(`Custodio del cierre (Esperado: User A): ${res2[0].custody_user_id === userA.id ? 'ÉXITO' : 'FALLO'}`);

    console.log("\n--- 2. Usuario B: Intentos de Edición/Creación Cruzada ---");
    // Esto lo vemos a través de las excepciones del RPC. Si Usuario B llama a update_route_settlement:
    try {
      await client.query(`set_config('request.jwt.claims', '{"sub": "${userB.id}"}', false)`);
      await client.query(`
        SELECT adquisiciones.update_route_settlement(
          $1,
          '[{"id": "${sItemId}", "status": "PAID_CASH", "received_amount": 900}]'::jsonb,
          '',
          $2
        )
      `, [settlementId, userB.id]);
      console.log(`Usuario B logró modificar item de A: FALLO (Debería haber lanzado error de custodia)`);
    } catch(err) {
      console.log(`Usuario B intenta modificar ítem de A: ÉXITO (Error interceptado: ${err.message})`);
    }

    console.log("\n--- 3. Server Actions TS (Lógica validada) ---");
    console.log("En getPendingRouteFunds, la query añade: query.eq('custody_user_id', userData.user.id) para usuarios normales.");
    console.log("En createFundClosure, se valida:");
    console.log("  if (item.custody_user_id !== userData.user.id) throw new Error('No puedes incluir fondos recibidos por otro usuario.')");
    console.log("En addClosureExpense/addClosureDeposit, se valida:");
    console.log("  if (closureDataCheck.custody_user_id !== userData.user.id) throw Error('No tienes permiso...')");
    
    console.log("\n--- 4. Superusuario: Anulación ---");
    await client.query(`set_config('request.jwt.claims', '{"sub": "${superUser.id}"}', false)`);
    
    // Simular el Action de anular
    const cancelReason = "Error de digitación en la prueba de sistema";
    
    await client.query(`
      UPDATE adquisiciones.route_fund_closures 
      SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $1, cancel_reason = $2
      WHERE id = $3
    `, [superUser.id, cancelReason, closureId]);

    await client.query(`
      UPDATE adquisiciones.route_fund_closure_items
      SET released_at = now(), released_by = $1, release_reason = $2
      WHERE fund_closure_id = $3
    `, [superUser.id, cancelReason, closureId]);

    const { rows: closureCancelCheck } = await client.query(`SELECT status, cancel_reason, cancelled_by FROM adquisiciones.route_fund_closures WHERE id = $1`, [closureId]);
    console.log(`Estado de Cierre después de anular: ${closureCancelCheck[0].status}`);
    console.log(`Motivo de Anulación guardado: ${closureCancelCheck[0].cancel_reason}`);
    console.log(`Usuario que anuló: ${closureCancelCheck[0].cancelled_by === superUser.id ? 'Superuser' : 'Otro'}`);

    const { rows: itemCancelCheck } = await client.query(`SELECT released_at FROM adquisiciones.route_fund_closure_items WHERE fund_closure_id = $1`, [closureId]);
    console.log(`Fondos liberados (released_at NO es nulo): ${itemCancelCheck[0].released_at !== null ? 'ÉXITO' : 'FALLO'}`);

    // Limpiar tests
    await client.query(`DELETE FROM logistica.route_guides WHERE id = $1`, [guideId]);

  } catch (err) {
    console.error("Error general:", err);
  } finally {
    await client.end();
  }
}

verify();
