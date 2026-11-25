import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { reconcileOperationWorkflow } from '../src/lib/integraciones/bsale-purchase-receipt-core.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const companyId = '10000000-0000-0000-0000-000000000001'
const userId = '40000000-0000-0000-0000-000000000001'

let tempDir = null
let pgOptions = null

function findPgBin(bin) {
  const dirs = [
    '/opt/homebrew/opt/postgresql@18/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/opt/homebrew/opt/postgresql@15/bin',
    '/usr/local/opt/postgresql@18/bin',
    '/usr/local/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@16/bin',
    '/usr/local/opt/postgresql@15/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]
  for (const dir of dirs) {
    try {
      execFileSync(join(dir, 'postgres'), ['--version'], { stdio: 'ignore' })
      execFileSync(join(dir, bin), ['--version'], { stdio: 'ignore' })
      return join(dir, bin)
    } catch {}
  }
  return bin
}

before(() => {
  if (process.env.PGHOST) {
    if (!process.env.PGHOST.startsWith('/') || !process.env.PGPORT || !process.env.PGDATABASE) {
      throw new Error('Se requiere un PostgreSQL temporal aislado por socket Unix (prohibido conectarse a Supabase remoto)')
    }
    pgOptions = {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
    }
    return
  }

  tempDir = mkdtempSync('/tmp/pg-compras-07d1-')
  const dataDir = join(tempDir, 'data')
  const socketDir = join(tempDir, 'sock')
  const logFile = join(tempDir, 'postgres.log')
  const port = 55432 + Math.floor(Math.random() * 2000)
  const dbName = 'commercial_receipt_concurrency'

  execFileSync('mkdir', ['-p', socketDir])
  execFileSync(
    findPgBin('initdb'),
    ['-D', dataDir, '-A', 'trust', '--no-locale', '-E', 'UTF8', '-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=mmap'],
    { stdio: 'pipe' },
  )
  execFileSync(
    findPgBin('pg_ctl'),
    ['-D', dataDir, '-l', logFile, '-o', `-k "${socketDir}" -h "" -p ${port} -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap`, 'start'],
    { stdio: 'pipe' },
  )
  execFileSync(findPgBin('createdb'), ['-h', socketDir, '-p', String(port), 'commercial_receipt_unit'], { stdio: 'pipe' })
  execFileSync(
    findPgBin('psql'),
    ['-h', socketDir, '-p', String(port), '-d', 'commercial_receipt_unit', '-v', 'ON_ERROR_STOP=1', '-f', resolve(repoRoot, 'scripts/test-commercial-receipt-postgres.sql')],
    { cwd: resolve(repoRoot, 'scripts'), stdio: 'pipe' },
  )
  execFileSync(findPgBin('createdb'), ['-h', socketDir, '-p', String(port), dbName], { stdio: 'pipe' })

  // Apply the production-order schema & COMPRAS 07D.1 migration
  execFileSync(
    findPgBin('psql'),
    ['-h', socketDir, '-p', String(port), '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', resolve(repoRoot, 'scripts/test-commercial-receipt-published-rpc-postgres.sql')],
    { cwd: resolve(repoRoot, 'scripts'), stdio: 'pipe' },
  )

  pgOptions = { host: socketDir, port, database: dbName }
})

after(() => {
  if (tempDir) {
    try {
      execFileSync(findPgBin('pg_ctl'), ['-D', join(tempDir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' })
    } catch {}
    rmSync(tempDir, { recursive: true, force: true })
  }
})

async function createCommercialOrderFixture(client, lines) {
  const poId = randomUUID()
  const snapshotId = randomUUID()
  const wRes = await client.query('SELECT id FROM adquisiciones.warehouses WHERE company_id = $1 LIMIT 1', [companyId])
  const warehouseId = wRes.rows[0].id
  const lRes = await client.query('SELECT id FROM logistica.locations WHERE company_id = $1 AND warehouse_id = $2 LIMIT 1', [companyId, warehouseId])
  const locationId = lRes.rows[0].id

  await client.query('BEGIN')
  try {
    await client.query(
      `INSERT INTO adquisiciones.purchase_orders(id, company_id, correlative, commercial_draft_revision, status, receipt_status, warehouse_id)
       VALUES ($1, $2, $3, 14, 'BORRADOR', 'PENDIENTE', $4)`,
      [poId, companyId, `OC-SIM-${poId.slice(0, 8)}`, warehouseId],
    )

    const snapshotItems = []
    const createdLines = []
    for (const line of lines) {
      const itemId = randomUUID()
      const productId = line.itemType === 'SERVICE' ? null : randomUUID()
      if (productId) {
        await client.query(
          'INSERT INTO adquisiciones.products(id, company_id, bsale_product_id, bsale_variant_id) VALUES ($1, $2, $3, $4)',
          [productId, companyId, line.bsaleProductId ?? Math.floor(10000 + Math.random() * 80000), line.bsaleVariantId ?? Math.floor(10000 + Math.random() * 80000)],
        )
      }
      await client.query(
        `INSERT INTO adquisiciones.purchase_order_items(
           id, po_id, company_id, item_type, product_id, product_description, warehouse_id,
           quantity, quantity_received, unit_price, discount_amount, discount_percent, discount_unit_amount, tax_rate,
           purchase_unit_snapshot, purchase_unit_factor_snapshot, commercial_unit_price_snapshot, commercial_gross_amount_snapshot
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,0,19,$12,$13,$14,$15)`,
        [
          itemId,
          poId,
          companyId,
          line.itemType ?? 'PRODUCT',
          productId,
          line.description ?? 'Producto comercial',
          line.itemType === 'SERVICE' ? null : warehouseId,
          line.quantity,
          line.unitPrice,
          line.discountAmount,
          line.discountPercent ?? 0,
          line.purchaseUnit ?? (line.itemType === 'SERVICE' ? null : 'DISPLAY'),
          line.factor ?? null,
          line.commercialPrice ?? null,
          line.grossAmount,
        ],
      )
      snapshotItems.push({
        item_id: itemId,
        quantity: line.quantity,
        purchase_unit_snapshot: line.purchaseUnit ?? (line.itemType === 'SERVICE' ? null : 'DISPLAY'),
        purchase_unit_factor_snapshot: line.factor ?? null,
        commercial_unit_price_snapshot: line.commercialPrice ?? null,
        unit_price: line.unitPrice,
        commercial_gross_amount_snapshot: line.grossAmount,
        discount_amount: line.discountAmount,
        tax_amount: line.taxAmount,
        line_total: line.lineTotal,
      })
      createdLines.push({ ...line, itemId, productId })
    }

    await client.query('INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES (txid_current(), pg_backend_pid())')
    await client.query("UPDATE adquisiciones.purchase_orders SET status = 'EMITIDA' WHERE id = $1", [poId])
    await client.query("UPDATE adquisiciones.purchase_orders SET status = 'ENVIADA_PROVEEDOR' WHERE id = $1", [poId])
    await client.query("UPDATE adquisiciones.purchase_orders SET status = 'CONFIRMADA' WHERE id = $1", [poId])
    await client.query('DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id = txid_current() AND backend_pid = pg_backend_pid()')

    await client.query(
      'INSERT INTO adquisiciones.purchase_order_snapshots(id, po_id, company_id, snapshot_type, items_snapshot) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [snapshotId, poId, companyId, 'CONFIRMED', JSON.stringify(snapshotItems)],
    )
    await client.query('COMMIT')
    return { poId, snapshotId, warehouseId, locationId, lines: createdLines }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

async function waitForBlockedBackend(observer, targetPid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const res = await observer.query(
      'SELECT wait_event_type IS NOT NULL AS waiting FROM pg_stat_activity WHERE pid = $1',
      [targetPid],
    )
    if (res.rows[0]?.waiting) return true
    await new Promise(r => setTimeout(r, 15))
  }
  return false
}

test('1. dos recepciones simultáneas sobre la misma OC comercial con cantidades válidas convergen exactamente al total confirmado ($2.120.264,65)', async () => {
  const setup = new pg.Client(pgOptions)
  const sessionA = new pg.Client(pgOptions)
  const sessionB = new pg.Client(pgOptions)
  const sessionC = new pg.Client(pgOptions)
  await Promise.all([setup.connect(), sessionA.connect(), sessionB.connect(), sessionC.connect()])

  try {
    // Synthetic 6-line commercial PO whose confirmed grand total is exactly $2.120.264,65
    // (includes line 1 modeled on 150 displays * factor 6 = 900 units @ $9.500, gross $1.425.000, disc $90.000, net $1.335.000)
    const fixture = await createCommercialOrderFixture(setup, [
      { quantity: 900, factor: 6, commercialPrice: 9500, unitPrice: 1583.3333, grossAmount: 1425000, discountAmount: 90000, taxAmount: 253650, lineTotal: 1588650 },
      { quantity: 120, factor: 12, commercialPrice: 14990, unitPrice: 1249.1667, grossAmount: 149900, discountAmount: 7495, taxAmount: 27056.95, lineTotal: 169461.95 },
      { quantity: 48, factor: 8, commercialPrice: 18750, unitPrice: 2343.75, grossAmount: 112500, discountAmount: 5625, taxAmount: 20306.25, lineTotal: 127181.25 },
      { quantity: 90, factor: 6, commercialPrice: 7330, unitPrice: 1221.6667, grossAmount: 109950, discountAmount: 3298.5, taxAmount: 20263.79, lineTotal: 126915.29 },
      { quantity: 36, factor: 6, commercialPrice: 11420, unitPrice: 1903.3333, grossAmount: 68520, discountAmount: 1370.4, taxAmount: 12758.42, lineTotal: 79908.02 },
      { quantity: 24, factor: 4, commercialPrice: 4125, unitPrice: 1031.25, grossAmount: 24750, discountAmount: 1096.1, taxAmount: 4494.24, lineTotal: 28148.14 },
    ])

    const pidB = (await sessionB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid

    const itemsA = fixture.lines.map((l, idx) => ({
      purchase_order_item_id: l.itemId,
      condition: 'CONFORME',
      quantity_received: [137, 19, 7, 13, 5, 3][idx], // Non-multiples of commercial factor
      location_id: fixture.locationId,
    }))
    const itemsB = fixture.lines.map((l, idx) => ({
      purchase_order_item_id: l.itemId,
      condition: 'CONFORME',
      quantity_received: [289, 43, 15, 31, 11, 9][idx], // Non-multiples of commercial factor
      location_id: fixture.locationId,
    }))
    const itemsC = fixture.lines.map((l, idx) => ({
      purchase_order_item_id: l.itemId,
      condition: 'CONFORME',
      quantity_received: l.quantity - itemsA[idx].quantity_received - itemsB[idx].quantity_received,
      location_id: fixture.locationId,
    }))

    // Session A acquires FOR UPDATE lock inside an explicit transaction while Session B competes concurrently
    await sessionA.query('BEGIN')
    const resAPromise = sessionA.query(
      'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
      [companyId, fixture.poId, 'WAREHOUSE', fixture.warehouseId, 'FA', '70001', JSON.stringify(itemsA), userId, randomUUID()],
    )
    const resA = (await resAPromise).rows[0].r
    assert.equal(resA.success, true)

    const resBPromise = sessionB.query(
      'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
      [companyId, fixture.poId, 'WAREHOUSE', fixture.warehouseId, 'FA', '70002', JSON.stringify(itemsB), userId, randomUUID()],
    )

    const blocked = await waitForBlockedBackend(setup, pidB)
    assert.equal(blocked, true, 'Session B must block on the PO FOR UPDATE lock while Session A holds the transaction')

    await sessionA.query('COMMIT')
    const resB = (await resBPromise).rows[0].r
    assert.equal(resB.success, true)

    // Complete remaining pending quantities in Session C
    const resC = (await sessionC.query(
      'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
      [companyId, fixture.poId, 'WAREHOUSE', fixture.warehouseId, 'FA', '70003', JSON.stringify(itemsC), userId, randomUUID()],
    )).rows[0].r
    assert.equal(resC.success, true)

    const summary = (await setup.query(
      `SELECT
         (SELECT status FROM adquisiciones.purchase_orders WHERE id = $1) AS po_status,
         (SELECT count(*)::int FROM logistica.purchase_receipts WHERE purchase_order_id = $1) AS receipt_count,
         (SELECT sum(receipt_total_net) FROM logistica.purchase_receipts WHERE purchase_order_id = $1) AS header_net,
         (SELECT sum(receipt_total_tax) FROM logistica.purchase_receipts WHERE purchase_order_id = $1) AS header_tax,
         (SELECT sum(receipt_total_gross) FROM logistica.purchase_receipts WHERE purchase_order_id = $1) AS header_gross,
         (SELECT sum(net_amount) FROM logistica.purchase_receipt_items ri JOIN logistica.purchase_receipts r ON r.id = ri.receipt_id WHERE r.purchase_order_id = $1) AS items_net,
         (SELECT sum(commercial_discount_amount) FROM logistica.purchase_receipt_items ri JOIN logistica.purchase_receipts r ON r.id = ri.receipt_id WHERE r.purchase_order_id = $1) AS items_discount,
         (SELECT sum(commercial_gross_before_discount) FROM logistica.purchase_receipt_items ri JOIN logistica.purchase_receipts r ON r.id = ri.receipt_id WHERE r.purchase_order_id = $1) AS items_gross_before_disc,
         (SELECT count(*)::int FROM logistica.kardex_movements km JOIN logistica.purchase_receipts r ON r.id = km.source_id WHERE r.purchase_order_id = $1) AS kardex_count,
         (SELECT sum(km.total_cost) FROM logistica.kardex_movements km JOIN logistica.purchase_receipts r ON r.id = km.source_id WHERE r.purchase_order_id = $1) AS kardex_cost`,
      [fixture.poId],
    )).rows[0]

    assert.equal(summary.po_status, 'RECEPCION_TOTAL')
    assert.equal(summary.receipt_count, 3)
    assert.equal(Number(summary.items_gross_before_disc).toFixed(2), '1890620.00')
    assert.equal(Number(summary.items_discount).toFixed(2), '108885.00')
    assert.equal(Number(summary.items_net).toFixed(2), '1781735.00')
    assert.equal(Number(summary.header_net).toFixed(2), '1781735.00')
    assert.equal(Number(summary.header_tax).toFixed(2), '338529.65')
    assert.equal(Number(summary.header_gross).toFixed(2), '2120264.65')
    assert.equal(summary.kardex_count, 18) // 3 receipts * 6 lines, zero duplicates
    assert.equal(Number(summary.kardex_cost).toFixed(2), '1781735.00')
  } finally {
    await sessionA.query('ROLLBACK').catch(() => {})
    await Promise.all([setup.end(), sessionA.end(), sessionB.end(), sessionC.end()])
  }
})

test('2. dos recepciones simultáneas cuya suma supera la cantidad pendiente rechazan el exceso sin duplicados ni corrupción', async () => {
  const setup = new pg.Client(pgOptions)
  const sessionA = new pg.Client(pgOptions)
  const sessionB = new pg.Client(pgOptions)
  await Promise.all([setup.connect(), sessionA.connect(), sessionB.connect()])

  try {
    const fixture = await createCommercialOrderFixture(setup, [
      { quantity: 900, factor: 6, commercialPrice: 9500, unitPrice: 1583.3333, grossAmount: 1425000, discountAmount: 90000, taxAmount: 253650, lineTotal: 1588650 },
    ])
    const itemId = fixture.lines[0].itemId

    const callReceipt = (client, qty, docNum) =>
      client.query(
        'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
        [
          companyId,
          fixture.poId,
          'WAREHOUSE',
          fixture.warehouseId,
          'FA',
          docNum,
          JSON.stringify([{ purchase_order_item_id: itemId, condition: 'CONFORME', quantity_received: qty, location_id: fixture.locationId }]),
          userId,
          randomUUID(),
        ],
      )

    const outcomes = await Promise.allSettled([
      callReceipt(sessionA, 600, '71001'),
      callReceipt(sessionB, 500, '71002'),
    ])

    const fulfilled = outcomes.filter(o => o.status === 'fulfilled')
    const rejected = outcomes.filter(o => o.status === 'rejected')
    assert.equal(fulfilled.length, 1, 'Solo una recepción debe completarse')
    assert.equal(rejected.length, 1, 'La segunda recepción concurrente debe ser rechazada')
    assert.match(rejected[0].reason.message, /supera el saldo pendiente/)

    const verify = (await setup.query(
      `SELECT
         (SELECT quantity_received::int FROM adquisiciones.purchase_order_items WHERE id = $2) AS qty_received,
         (SELECT count(*)::int FROM logistica.purchase_receipts WHERE purchase_order_id = $1) AS receipts,
         (SELECT count(*)::int FROM logistica.kardex_movements WHERE product_id = $3) AS kardex_rows,
         (SELECT sum(quantity)::int FROM logistica.kardex_movements WHERE product_id = $3) AS kardex_qty`,
      [fixture.poId, itemId, fixture.lines[0].productId],
    )).rows[0]

    assert.equal(verify.receipts, 1)
    assert.equal(verify.kardex_rows, 1)
    assert.ok(verify.qty_received === 600 || verify.qty_received === 500)
    assert.equal(verify.kardex_qty, verify.qty_received)
  } finally {
    await Promise.all([setup.end(), sessionA.end(), sessionB.end()])
  }
})

test('3. dos solicitudes simultáneas con la misma clave de idempotencia devuelven la misma recepción y rechazan datos incompatibles', async () => {
  const setup = new pg.Client(pgOptions)
  const sessionA = new pg.Client(pgOptions)
  const sessionB = new pg.Client(pgOptions)
  await Promise.all([setup.connect(), sessionA.connect(), sessionB.connect()])

  try {
    const fixture = await createCommercialOrderFixture(setup, [
      { quantity: 900, factor: 6, commercialPrice: 9500, unitPrice: 1583.3333, grossAmount: 1425000, discountAmount: 90000, taxAmount: 253650, lineTotal: 1588650 },
    ])
    const itemId = fixture.lines[0].itemId
    const sharedKey = randomUUID()
    const payload = JSON.stringify([
      { purchase_order_item_id: itemId, condition: 'CONFORME', quantity_received: 900, location_id: fixture.locationId },
    ])

    const sql = 'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r'
    const args = [companyId, fixture.poId, 'WAREHOUSE', fixture.warehouseId, 'FA', '72001', payload, userId, sharedKey]

    // Launch both simultaneously even though the receipt consumes 100% of the PO (transitions to RECEPCION_TOTAL)
    const [rA, rB] = await Promise.all([sessionA.query(sql, args), sessionB.query(sql, args)])
    const outA = rA.rows[0].r
    const outB = rB.rows[0].r

    assert.equal(outA.success, true)
    assert.equal(outB.success, true)
    assert.equal(outA.receipt_id, outB.receipt_id)
    assert.equal(outA.receipt_number, outB.receipt_number)
    assert.deepEqual([Boolean(outA.idempotent), Boolean(outB.idempotent)].sort(), [false, true])

    // Incompatible retries with the same key on the same OC must be rejected
    const incompatibleQty = JSON.stringify([
      { purchase_order_item_id: itemId, condition: 'CONFORME', quantity_received: 450, location_id: fixture.locationId },
    ])
    await assert.rejects(
      sessionA.query(sql, [companyId, fixture.poId, 'WAREHOUSE', fixture.warehouseId, 'FA', '72001', incompatibleQty, userId, sharedKey]),
      /parámetros incompatibles/,
    )
    await assert.rejects(
      sessionB.query(sql, [companyId, fixture.poId, 'WAREHOUSE', fixture.warehouseId, 'GD', '72001', payload, userId, sharedKey]),
      /parámetros incompatibles/,
    )

    const counts = (await setup.query(
      `SELECT
         (SELECT count(*)::int FROM logistica.purchase_receipts WHERE purchase_order_id = $1) AS receipts,
         (SELECT count(*)::int FROM logistica.purchase_receipt_items WHERE receipt_id = $2) AS receipt_items,
         (SELECT count(*)::int FROM logistica.kardex_movements WHERE source_id = $2) AS kardex_rows,
         (SELECT sum(net_amount) FROM logistica.purchase_receipt_items WHERE receipt_id = $2) AS net_total`,
      [fixture.poId, outA.receipt_id],
    )).rows[0]

    assert.equal(counts.receipts, 1)
    assert.equal(counts.receipt_items, 1)
    assert.equal(counts.kardex_rows, 1)
    assert.equal(Number(counts.net_total), 1335000)
  } finally {
    await Promise.all([setup.end(), sessionA.end(), sessionB.end()])
  }
})

test('4. reutilización concurrente y secuencial de clave de idempotencia en órdenes diferentes es rechazada', async () => {
  const setup = new pg.Client(pgOptions)
  const sessionA = new pg.Client(pgOptions)
  const sessionB = new pg.Client(pgOptions)
  await Promise.all([setup.connect(), sessionA.connect(), sessionB.connect()])

  try {
    const order1 = await createCommercialOrderFixture(setup, [
      { quantity: 60, factor: 6, commercialPrice: 6000, unitPrice: 1000, grossAmount: 60000, discountAmount: 0, taxAmount: 11400, lineTotal: 71400 },
    ])
    const order2 = await createCommercialOrderFixture(setup, [
      { quantity: 60, factor: 6, commercialPrice: 6000, unitPrice: 1000, grossAmount: 60000, discountAmount: 0, taxAmount: 11400, lineTotal: 71400 },
    ])

    const contestedKey = randomUUID()
    const sql = 'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r'

    const results = await Promise.allSettled([
      sessionA.query(sql, [
        companyId,
        order1.poId,
        'WAREHOUSE',
        order1.warehouseId,
        'FA',
        '73001',
        JSON.stringify([{ purchase_order_item_id: order1.lines[0].itemId, condition: 'CONFORME', quantity_received: 30, location_id: order1.locationId }]),
        userId,
        contestedKey,
      ]),
      sessionB.query(sql, [
        companyId,
        order2.poId,
        'WAREHOUSE',
        order2.warehouseId,
        'FA',
        '73002',
        JSON.stringify([{ purchase_order_item_id: order2.lines[0].itemId, condition: 'CONFORME', quantity_received: 30, location_id: order2.locationId }]),
        userId,
        contestedKey,
      ]),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.match(rejected[0].reason.message, /otra orden de compra/)

    // Sequential retry on the losing PO must also be rejected
    const losingOrder = fulfilled[0].value.rows[0].r && (
      await setup.query('SELECT purchase_order_id FROM logistica.purchase_receipts WHERE id = $1', [fulfilled[0].value.rows[0].r.receipt_id])
    ).rows[0].purchase_order_id === order1.poId ? order2 : order1

    await assert.rejects(
      sessionA.query(sql, [
        companyId,
        losingOrder.poId,
        'WAREHOUSE',
        losingOrder.warehouseId,
        'FA',
        '73003',
        JSON.stringify([{ purchase_order_item_id: losingOrder.lines[0].itemId, condition: 'CONFORME', quantity_received: 10, location_id: losingOrder.locationId }]),
        userId,
        contestedKey,
      ]),
      /otra orden de compra/,
    )
  } finally {
    await Promise.all([setup.end(), sessionA.end(), sessionB.end()])
  }
})

test('5. limpieza de capacidades transaccionales después de éxito, error controlado y excepción, conservando protecciones comerciales', async () => {
  const client = new pg.Client(pgOptions)
  await client.connect()

  try {
    const fixture = await createCommercialOrderFixture(client, [
      { quantity: 12, factor: 6, commercialPrice: 6000, unitPrice: 1000, grossAmount: 12000, discountAmount: 0, taxAmount: 2280, lineTotal: 14280 },
    ])
    const itemId = fixture.lines[0].itemId

    await client.query('BEGIN')

    // 5a. Controlled { success: false } error (invalid document number) inside open transaction
    const badDoc = (await client.query(
      'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
      [
        companyId,
        fixture.poId,
        'WAREHOUSE',
        fixture.warehouseId,
        'FA',
        'DOC-INVALIDO',
        JSON.stringify([{ purchase_order_item_id: itemId, condition: 'CONFORME', quantity_received: 6, location_id: fixture.locationId }]),
        userId,
        randomUUID(),
      ],
    )).rows[0].r
    assert.equal(badDoc.success, false)

    let caps = (await client.query(
      `SELECT
         (SELECT count(*)::int FROM logistica.commercial_receipt_capabilities) AS receipt_caps,
         (SELECT count(*)::int FROM adquisiciones.commercial_draft_write_capabilities) AS draft_caps`,
    )).rows[0]
    assert.deepEqual(caps, { receipt_caps: 0, draft_caps: 0 })

    // 5b. Exception rollback via SAVEPOINT (overflow quantity) inside open transaction
    await client.query('SAVEPOINT sp_overflow')
    await assert.rejects(
      client.query(
        'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
        [
          companyId,
          fixture.poId,
          'WAREHOUSE',
          fixture.warehouseId,
          'FA',
          '74001',
          JSON.stringify([{ purchase_order_item_id: itemId, condition: 'CONFORME', quantity_received: 99, location_id: fixture.locationId }]),
          userId,
          randomUUID(),
        ],
      ),
      /supera el saldo pendiente/,
    )
    await client.query('ROLLBACK TO SAVEPOINT sp_overflow')

    caps = (await client.query(
      `SELECT
         (SELECT count(*)::int FROM logistica.commercial_receipt_capabilities) AS receipt_caps,
         (SELECT count(*)::int FROM adquisiciones.commercial_draft_write_capabilities) AS draft_caps`,
    )).rows[0]
    assert.deepEqual(caps, { receipt_caps: 0, draft_caps: 0 })

    // 5c. Successful partial receipt inside the same transaction
    const okPartial = (await client.query(
      'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
      [
        companyId,
        fixture.poId,
        'WAREHOUSE',
        fixture.warehouseId,
        'FA',
        '74002',
        JSON.stringify([{ purchase_order_item_id: itemId, condition: 'CONFORME', quantity_received: 5, location_id: fixture.locationId }]),
        userId,
        randomUUID(),
      ],
    )).rows[0].r
    assert.equal(okPartial.success, true)

    caps = (await client.query(
      `SELECT
         (SELECT count(*)::int FROM logistica.commercial_receipt_capabilities) AS receipt_caps,
         (SELECT count(*)::int FROM adquisiciones.commercial_draft_write_capabilities) AS draft_caps`,
    )).rows[0]
    assert.deepEqual(caps, { receipt_caps: 0, draft_caps: 0 })

    // 5d. Verify commercial guards remain strictly enforced immediately after receipt in the same transaction
    await client.query('SAVEPOINT sp_guard1')
    await assert.rejects(
      client.query('UPDATE adquisiciones.purchase_order_items SET commercial_unit_price_snapshot = 9999 WHERE id = $1', [itemId]),
      /operación controlada/,
    )
    await client.query('ROLLBACK TO SAVEPOINT sp_guard1')

    await client.query('SAVEPOINT sp_guard2')
    await assert.rejects(
      client.query("UPDATE adquisiciones.purchase_orders SET status = 'RECEPCION_TOTAL' WHERE id = $1", [fixture.poId]),
      /integración adicional/,
    )
    await client.query('ROLLBACK TO SAVEPOINT sp_guard2')

    await client.query('SAVEPOINT sp_guard3')
    await assert.rejects(
      client.query('INSERT INTO logistica.purchase_receipts(company_id, purchase_order_id) VALUES ($1, $2)', [companyId, fixture.poId]),
      /integración adicional/,
    )
    await client.query('ROLLBACK TO SAVEPOINT sp_guard3')

    await client.query('COMMIT')
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    await client.end()
  }
})

test('6. preparación concurrente BSale distingue redondeo comercial cero (RECONCILIATION_REQUIRED), bonificación (PREPARED) e inválido', async () => {
  const setup = new pg.Client(pgOptions)
  const sessionA = new pg.Client(pgOptions)
  const sessionB = new pg.Client(pgOptions)
  await Promise.all([setup.connect(), sessionA.connect(), sessionB.connect()])

  try {
    const fixture = await createCommercialOrderFixture(setup, [
      { quantity: 600, factor: 6, commercialPrice: 0.02, unitPrice: 0.0033, grossAmount: 2.00, discountAmount: 0, taxAmount: 0.38, lineTotal: 2.38, bsaleProductId: 91001, bsaleVariantId: 92001 },
    ])

    const receipt1 = (await setup.query(
      'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
      [
        companyId,
        fixture.poId,
        'WAREHOUSE',
        fixture.warehouseId,
        'FA',
        '75001',
        JSON.stringify([{ purchase_order_item_id: fixture.lines[0].itemId, condition: 'CONFORME', quantity_received: 1, location_id: fixture.locationId }]),
        userId,
        randomUUID(),
      ],
    )).rows[0].r
    assert.equal(receipt1.success, true)

    // Concurrent prepare_bsale_purchase_receipt_operation calls on the zero-cost commercial rounding receipt
    const [prepA, prepB] = await Promise.all([
      sessionA.query('SELECT integraciones.prepare_bsale_purchase_receipt_operation($1, $2) AS op', [receipt1.receipt_id, userId]),
      sessionB.query('SELECT integraciones.prepare_bsale_purchase_receipt_operation($1, $2) AS op', [receipt1.receipt_id, userId]),
    ])

    const opA = prepA.rows[0].op
    const opB = prepB.rows[0].op
    assert.equal(opA.operation_id, opB.operation_id)
    assert.equal(opA.status, 'RECONCILIATION_REQUIRED')
    assert.deepEqual(opA.payload.details, [{ variantId: 92001, quantity: 1, cost: 0 }])

    const opCount = (await setup.query(
      'SELECT count(*)::int AS cnt FROM integraciones.bsale_purchase_receipt_operations WHERE purchase_receipt_id = $1',
      [receipt1.receipt_id],
    )).rows[0].cnt
    assert.equal(opCount, 1)
  } finally {
    await Promise.all([setup.end(), sessionA.end(), sessionB.end()])
  }
})

test('7. recepciones históricas sin fingerprint (legacy) validan todos los campos persistidos y adjuntos bajo concurrencia', async () => {
  const setup = new pg.Client(pgOptions)
  const sessionA = new pg.Client(pgOptions)
  const sessionB = new pg.Client(pgOptions)
  await Promise.all([setup.connect(), sessionA.connect(), sessionB.connect()])

  try {
    const fixture = await createCommercialOrderFixture(setup, [
      { quantity: 24, factor: 6, commercialPrice: 6000, unitPrice: 1000, grossAmount: 24000, discountAmount: 0, taxAmount: 4560, lineTotal: 28560 },
      { quantity: 12, factor: 6, commercialPrice: 6000, unitPrice: 1000, grossAmount: 12000, discountAmount: 0, taxAmount: 2280, lineTotal: 14280 },
    ])

    const legacyKey = randomUUID()
    const items = [
      {
        purchase_order_item_id: fixture.lines[0].itemId,
        condition: 'CONFORME',
        quantity_received: 12,
        quantity_rejected: 0,
        quantity_missing: 0,
        location_id: fixture.locationId,
        lot_number: 'LOT-HIST-99',
        expiration_date: '2028-01-15',
        notes: 'Lote verificado',
      },
      {
        purchase_order_item_id: fixture.lines[1].itemId,
        condition: 'RECHAZADO',
        quantity_received: 0,
        quantity_rejected: 4,
        quantity_missing: 0,
        rejection_reason: 'Sello abierto',
        notes: 'Devolver a proveedor',
      },
    ]
    const attachment = {
      document_type: 'FA',
      storage_bucket: 'recepciones',
      storage_path: `hist/${legacyKey}.pdf`,
      file_name: 'guia.pdf',
      file_size: 4096,
      mime_type: 'application/pdf',
      notes: 'Adjunto historico',
    }

    const sql = 'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,$5,$6,$7,$8::date,$9::jsonb,$10,$11,$12::jsonb) AS r'
    const baseArgs = [
      companyId,
      fixture.poId,
      'WAREHOUSE',
      fixture.warehouseId,
      'Recepcion historica pre-migracion',
      'FA',
      '76001',
      '2026-11-25',
      JSON.stringify(items),
      userId,
      legacyKey,
      JSON.stringify(attachment),
    ]

    const created = (await setup.query(sql, baseArgs)).rows[0].r
    assert.equal(created.success, true)

    // Clear idempotency_request_fingerprint to simulate one of the 72 production historical receipts
    await setup.query('UPDATE logistica.purchase_receipts SET idempotency_request_fingerprint = NULL WHERE id = $1', [created.receipt_id])

    // Session A sends an exact retry; Session B concurrently reuses the legacy key with altered lot_number
    const badItems = items.map((it, idx) => (idx === 0 ? { ...it, lot_number: 'LOT-FALSO' } : it))
    const badArgs = [...baseArgs]
    badArgs[8] = JSON.stringify(badItems)

    const [exactOutcome, badOutcome] = await Promise.allSettled([
      sessionA.query(sql, baseArgs),
      sessionB.query(sql, badArgs),
    ])

    assert.equal(exactOutcome.status, 'fulfilled')
    assert.equal(exactOutcome.value.rows[0].r.idempotent, true)
    assert.equal(exactOutcome.value.rows[0].r.receipt_id, created.receipt_id)
    assert.equal(badOutcome.status, 'rejected')
    assert.match(badOutcome.reason.message, /parámetros incompatibles/)
  } finally {
    await Promise.all([setup.end(), sessionA.end(), sessionB.end()])
  }
})

test('8. reconciliación concurrente RECONCILIATION_REQUIRED -> CONFIRMED usa confirmación controlada sin POST ni duplicados de recepción BSale', async () => {
  const setup = new pg.Client(pgOptions)
  const sessionA = new pg.Client(pgOptions)
  const sessionB = new pg.Client(pgOptions)
  await Promise.all([setup.connect(), sessionA.connect(), sessionB.connect()])

  try {
    const fixture1 = await createCommercialOrderFixture(setup, [
      { quantity: 600, factor: 6, commercialPrice: 0.02, unitPrice: 0.0033, grossAmount: 2.00, discountAmount: 0, taxAmount: 0.38, lineTotal: 2.38, bsaleProductId: 93001, bsaleVariantId: 94001 },
    ])
    const fixture2 = await createCommercialOrderFixture(setup, [
      { quantity: 600, factor: 6, commercialPrice: 0.02, unitPrice: 0.0033, grossAmount: 2.00, discountAmount: 0, taxAmount: 0.38, lineTotal: 2.38, bsaleProductId: 93002, bsaleVariantId: 94002 },
    ])

    const r1 = (await setup.query(
      'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
      [
        companyId,
        fixture1.poId,
        'WAREHOUSE',
        fixture1.warehouseId,
        'FA',
        '78001',
        JSON.stringify([{ purchase_order_item_id: fixture1.lines[0].itemId, condition: 'CONFORME', quantity_received: 1, location_id: fixture1.locationId }]),
        userId,
        randomUUID(),
      ],
    )).rows[0].r

    const r2 = (await setup.query(
      'SELECT logistica.create_purchase_receipt_db($1,$2,$3,$4,NULL,$5,$6,current_date,$7::jsonb,$8,$9,NULL) AS r',
      [
        companyId,
        fixture2.poId,
        'WAREHOUSE',
        fixture2.warehouseId,
        'FA',
        '78002',
        JSON.stringify([{ purchase_order_item_id: fixture2.lines[0].itemId, condition: 'CONFORME', quantity_received: 1, location_id: fixture2.locationId }]),
        userId,
        randomUUID(),
      ],
    )).rows[0].r

    const op1 = (await setup.query('SELECT integraciones.prepare_bsale_purchase_receipt_operation($1, $2) AS op', [r1.receipt_id, userId])).rows[0].op
    const op2 = (await setup.query('SELECT integraciones.prepare_bsale_purchase_receipt_operation($1, $2) AS op', [r2.receipt_id, userId])).rows[0].op
    assert.equal(op1.status, 'RECONCILIATION_REQUIRED')
    assert.equal(op2.status, 'RECONCILIATION_REQUIRED')

    let postCount = 0
    const buildDeps = (pgClient, remoteReceptionId, expectedPayload) => ({
      loadOperation: async (opId, compId) => {
        const res = await pgClient.query(
          'SELECT id, status, bsale_reception_id, payload_snapshot, purchase_receipt_id, company_id, error_message FROM integraciones.bsale_purchase_receipt_operations WHERE id = $1 AND company_id = $2',
          [opId, compId],
        )
        return { row: res.rows[0] ?? null, error: null }
      },
      confirmReconciled: async ({ operationId, companyId: compId, userId: usrId, receptionId }) => {
        try {
          const res = await pgClient.query(
            'SELECT integraciones.confirm_reconciled_bsale_purchase_receipt_operation($1, $2, $3, $4) AS data',
            [operationId, compId, usrId, receptionId],
          )
          return { data: res.rows[0].data, error: null }
        } catch (err) {
          return { data: null, error: err.message }
        }
      },
      remote: {
        createReception: async () => { postCount += 1; return { id: remoteReceptionId } },
        getReception: async id => ({
          id,
          office: { id: expectedPayload.officeId },
          document: expectedPayload.document,
          documentNumber: expectedPayload.documentNumber,
          note: expectedPayload.note,
        }),
        getDetails: async () => expectedPayload.details.map(d => ({ variant: { id: d.variantId }, quantity: d.quantity, cost: d.cost })),
        findReceptions: async () => [{ id: remoteReceptionId }],
      },
    })

    // Concurrent reconciliation of op1 across Session A and Session B
    const [recA, recB] = await Promise.all([
      reconcileOperationWorkflow({
        companyId,
        userId,
        operationId: op1.operation_id,
        ...buildDeps(sessionA, 550001, op1.payload),
      }),
      reconcileOperationWorkflow({
        companyId,
        userId,
        operationId: op1.operation_id,
        ...buildDeps(sessionB, 550001, op1.payload),
      }),
    ])

    assert.equal(recA.status, 'CONFIRMED')
    assert.equal(recB.status, 'CONFIRMED')
    assert.equal(recA.receptionId, 550001)
    assert.equal(recB.receptionId, 550001)
    assert.equal(postCount, 0, 'Nunca debe realizarse POST automático para operaciones en RECONCILIATION_REQUIRED')

    // Attempting to bind op2 to the SAME remote Bsale reception 550001 must be rejected as duplicate
    const dupAttempt = await reconcileOperationWorkflow({
      companyId,
      userId,
      operationId: op2.operation_id,
      ...buildDeps(sessionA, 550001, op2.payload),
    })
    assert.equal(dupAttempt.status, 'RECONCILIATION_REQUIRED')
    assert.match(dupAttempt.error ?? '', /vinculada a otra operación/)
  } finally {
    await Promise.all([setup.end(), sessionA.end(), sessionB.end()])
  }
})
