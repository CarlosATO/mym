import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import crypto from 'crypto'
import fs from 'fs'
import { execFileSync } from 'child_process'

function loadEnvLocal() {
  const path = new globalThis.URL('../.env.local', import.meta.url)
  if (!fs.existsSync(path)) return
  const text = fs.readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const idx = trimmed.indexOf('=')
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnvLocal()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !ANON || !SERVICE) {
  throw new Error('Faltan variables de entorno de Supabase')
}

const QA_COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'
const OTHER_COMPANY_ID = 'd2000000-0000-0000-0000-000000000002'
const IMPORT_BUCKET = 'inventario-imports'
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const admin = createClient(SUPABASE_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

const results = []
const state = {
  createdAuthUsers: [],
  createdPortalUsers: [],
  createdAccessRows: [],
  createdProducts: [],
  createdSites: [],
  createdLocations: [],
  createdCampaigns: [],
  createdCampaignSites: [],
  createdCampaignSiteLocations: [],
  createdImports: [],
  createdStoragePaths: [],
  tempUsers: [],
}

function pushResult(id, ok, detail = '') {
  results.push({ id, ok, detail })
  const marker = ok ? 'PASS' : 'FAIL'
  console.log(`${id}. ${marker}${detail ? ` - ${detail}` : ''}`)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function dbQuery(sql) {
  const output = execFileSync('supabase', ['db', 'query', '--linked', '--output', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(output)
}

function firstValue(rows) {
  const row = rows[0] ?? {}
  const values = Object.values(row)
  return values.length > 0 ? values[0] : undefined
}

function asAuth(userId, sql) {
  return `begin; set local role authenticated; select set_config('request.jwt.claim.sub', ${sqlString(userId)}, true); select set_config('request.jwt.claim.role', 'authenticated', true); ${sql}; commit;`
}

function shortId() {
  return crypto.randomUUID().slice(0, 8)
}

function safeFileName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120)
}

function buildCampaignStoragePath(companyId, campaignId, importId, filename) {
  return `${companyId}/campaign-stock-imports/${campaignId}/${importId}/${importId}-${safeFileName(filename)}`
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex')
}

function makeWorkbook(scope, rows) {
  const headers =
    scope === 'TOTAL_CAMPAIGN'
      ? ['SKU', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO']
      : scope === 'BY_SITE'
        ? ['SKU', 'CODIGO_UNIDAD', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO']
        : ['SKU', 'CODIGO_UNIDAD', 'CODIGO_UBICACION', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO']
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Datos')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

function makeBrokenWorkbook() {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['SKU', 'CANTIDAD_TEORICA'], ['BAD-SKU', 1]]), 'Datos')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

function parseCampaignWorkbook(buffer, scope) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true })
  if (wb.SheetNames.length === 0) throw new Error('FILE_DATA_SHEET_MISSING')
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1')
  const headerRow = range.s.r
  const colMap = {}
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: headerRow, c })]
    const raw = cell && cell.v != null ? String(cell.v).trim().toUpperCase() : ''
    if (!raw) continue
    if (raw === 'SKU' || raw === 'CODIGO' || raw === 'CODIGO PRODUCTO' || raw === 'CODIGO SKU') colMap.sku = c
    if (raw === 'CODIGO_UNIDAD' || raw === 'CODIGO UNIDAD') colMap.site = c
    if (raw === 'CODIGO_UBICACION' || raw === 'CODIGO UBICACION') colMap.location = c
    if (raw === 'CANTIDAD_TEORICA' || raw === 'CANTIDAD' || raw === 'STOCK TEORICO') colMap.qty = c
    if (raw === 'COSTO_UNITARIO' || raw === 'COSTO' || raw === 'PRECIO COSTO') colMap.cost = c
  }

  const required =
    scope === 'TOTAL_CAMPAIGN'
      ? ['sku', 'qty', 'cost']
      : scope === 'BY_SITE'
        ? ['sku', 'site', 'qty', 'cost']
        : ['sku', 'site', 'location', 'qty', 'cost']
  const missing = required.filter(key => colMap[key] == null)
  if (missing.length > 0) {
    const field = missing[0]
    const canonical = field === 'sku' ? 'SKU' : field === 'site' ? 'CODIGO_UNIDAD' : field === 'location' ? 'CODIGO_UBICACION' : field === 'qty' ? 'CANTIDAD_TEORICA' : 'COSTO_UNITARIO'
    const err = new Error(`Falta la columna obligatoria "${canonical}".`)
    err.code = 'FILE_HEADER_MISSING'
    throw err
  }

  const rows = []
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const cellText = col => {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: col })]
      return cell && cell.v != null ? String(cell.v).trim() : ''
    }
    const sku = cellText(colMap.sku)
    const site = colMap.site != null ? cellText(colMap.site) : ''
    const location = colMap.location != null ? cellText(colMap.location) : ''
    const qty = cellText(colMap.qty)
    const cost = cellText(colMap.cost)
    if (!sku && !site && !location && !qty && !cost) continue
    rows.push({
      row_index: r + 1,
      sku,
      entered_site_code: site || null,
      entered_location_code: location || null,
      quantity: qty,
      cost,
    })
  }
  return { rows, file_issues: [] }
}

async function createTempUser(email, password, roleName, companyRole) {
  const roleRows = dbQuery(`select id::text as id from portal.roles where name = ${sqlString(roleName)} limit 1`)
  const role = roleRows[0]
  assert(role?.id, `No existe el rol ${roleName}`)
  const { data: authCreated, error: authErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (authErr) throw authErr
  const userId = authCreated.user.id
  state.createdAuthUsers.push(userId)
  dbQuery(`insert into portal.users (id, email, nombre, apellido, role_id, is_active, must_change_password)
    values (${sqlString(userId)}::uuid, ${sqlString(email)}, 'QA', ${sqlString(roleName)}, ${sqlString(role.id)}::uuid, true, false)`)
  state.createdPortalUsers.push(userId)
  dbQuery(`insert into core.user_company_access (user_id, company_id, role, is_default, is_active)
    values (${sqlString(userId)}::uuid, ${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(companyRole)}, true, true)`)
  state.createdAccessRows.push({ userId, companyId: QA_COMPANY_ID })
  return { userId, email, password }
}

async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  await client.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token })
  return client
}

async function ensureProduct(userId) {
  const sku = `QA-CAMP-PROD-${shortId()}`
  const existing = dbQuery(`select id::text as id, sku from adquisiciones.products where company_id = ${sqlString(QA_COMPANY_ID)}::uuid and is_active = true order by created_at asc limit 1`)
  if (existing.length > 0) return existing[0]
  const rows = dbQuery(`insert into adquisiciones.products (company_id, sku, description, status, is_active, created_by, updated_by)
    values (${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(sku)}, ${sqlString(`QA product ${sku}`)}, 'ACTIVE', true, ${sqlString(userId)}::uuid, ${sqlString(userId)}::uuid)
    returning id::text as id, sku`)
  state.createdProducts.push(rows[0].id)
  return rows[0]
}

async function ensureTempSite(userId, codeSuffix) {
  const siteCode = `QA-SITE-${codeSuffix}-${shortId()}`
  const rows = dbQuery(`insert into inventarios.inventory_sites (company_id, name, code, site_type, is_active, inventory_enabled, created_by, updated_by)
    values (${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(siteCode)}, ${sqlString(siteCode)}, 'OWN_STORE', true, true, ${sqlString(userId)}::uuid, ${sqlString(userId)}::uuid)
    returning id::text as id, code`)
  state.createdSites.push(rows[0].id)
  return rows[0]
}

async function ensureLocation(userId, siteId, code) {
  const rows = dbQuery(`insert into inventarios.inventory_site_locations (company_id, inventory_site_id, code, name, is_active, created_by, updated_by)
    values (${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(siteId)}::uuid, ${sqlString(code)}, ${sqlString(code)}, true, ${sqlString(userId)}::uuid, ${sqlString(userId)}::uuid)
    returning id::text as id, code`)
  state.createdLocations.push(rows[0].id)
  return rows[0]
}

async function ensureCampaign(userId, name, campaignType, siteScope, productScope) {
  const rows = dbQuery(`insert into inventarios.inventory_campaigns (company_id, name, campaign_type, status, planned_at, created_by, updated_by, site_scope, product_scope)
    values (${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(name)}, ${sqlString(campaignType)}, 'DRAFT', now(), ${sqlString(userId)}::uuid, ${sqlString(userId)}::uuid, ${sqlString(siteScope)}, ${sqlString(productScope)})
    returning id::text as id, name`)
  state.createdCampaigns.push(rows[0].id)
  return rows[0]
}

async function addCampaignSite(userId, campaignId, siteId, locationScope, displayOrder) {
  const rows = dbQuery(`insert into inventarios.inventory_campaign_sites (company_id, campaign_id, inventory_site_id, is_required, display_order, location_scope, created_by)
    values (${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(campaignId)}::uuid, ${sqlString(siteId)}::uuid, true, ${displayOrder}, ${sqlString(locationScope)}, ${sqlString(userId)}::uuid)
    returning id::text as id`)
  state.createdCampaignSites.push(rows[0].id)
  return rows[0].id
}

async function addCampaignSiteLocation(userId, campaignSiteId, locationId, displayOrder) {
  const rows = dbQuery(`insert into inventarios.inventory_campaign_site_locations (company_id, campaign_site_id, inventory_site_location_id, display_order, created_by)
    values (${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(campaignSiteId)}::uuid, ${sqlString(locationId)}::uuid, ${displayOrder}, ${sqlString(userId)}::uuid)
    returning id::text as id`)
  state.createdCampaignSiteLocations.push(rows[0].id)
  return rows[0].id
}

async function createCampaignImport(userInventarios, userId, campaignId, scope, filename, cutoffAt = new Date().toISOString()) {
  const rows = dbQuery(asAuth(userId, `select inventarios.create_campaign_stock_import(
    ${sqlString(QA_COMPANY_ID)}::uuid,
    ${sqlString(campaignId)}::uuid,
    ${sqlString(scope)},
    ${sqlString(cutoffAt)}::timestamptz,
    ${sqlString('CLP')},
    ${sqlString(filename)},
    ${sqlString(MIME_XLSX)},
    1024::bigint,
    ${sqlString(crypto.randomUUID())}::uuid
  ) as result`))
  const data = firstValue(rows)
  const importId = data?.entity_id ?? data?.data?.import_id ?? data?.import_id
  assert(importId, 'create_campaign_stock_import sin import_id')
  state.createdImports.push(importId)
  return { raw: data, importId }
}

async function uploadRegisterAndFinalize(userInventarios, userId, storageClient, params) {
  const { importId, campaignId, scope, filename, buffer, mimeType, idempotencyKey } = params
  const storagePath = buildCampaignStoragePath(QA_COMPANY_ID, campaignId, importId, filename)
  const { error: uploadErr } = await storageClient.from(IMPORT_BUCKET).upload(storagePath, buffer, { contentType: mimeType, upsert: false })
  if (uploadErr) throw uploadErr
  state.createdStoragePaths.push(storagePath)

  const regRows = dbQuery(asAuth(userId, `select inventarios.register_campaign_stock_import_file(
    ${sqlString(QA_COMPANY_ID)}::uuid,
    ${sqlString(importId)}::uuid,
    ${sqlString(storagePath)},
    ${sqlString(filename)},
    ${sqlString(mimeType)},
    ${buffer.length}::bigint,
    ${sqlString(crypto.randomUUID())}::uuid
  ) as result`))
  const regData = firstValue(regRows)

  const info = await storageClient.from(IMPORT_BUCKET).info(storagePath)
  if (info.error || !info.data) throw new Error('No se pudo leer el archivo subido')
  const download = await storageClient.from(IMPORT_BUCKET).download(storagePath)
  if (download.error || !download.data) throw new Error('No se pudo descargar el archivo subido')
  const arrayBuffer = await download.data.arrayBuffer()

  let parsed
  try {
    parsed = parseCampaignWorkbook(arrayBuffer, scope)
  } catch (err) {
    parsed = {
      rows: [],
      file_issues: [{ level: 'ERROR', code: err.code || 'FILE_PARSE_ERROR', message: err.message }],
    }
  }

  const fileIssues = parsed.file_issues.map(issue => ({
    level: issue.level,
    code: issue.code,
    message: issue.message,
    row_index: issue.row_index ?? null,
    metadata: issue.metadata ?? {},
  }))

  const validationRows = dbQuery(asAuth(userId, `select inventarios.validate_campaign_stock_import(
    ${sqlString(QA_COMPANY_ID)}::uuid,
    ${sqlString(importId)}::uuid,
    ${sqlString(sha256(Buffer.from(arrayBuffer)))}::char(64),
    ${sqlString(JSON.stringify(fileIssues))}::jsonb,
    ${sqlString(JSON.stringify(parsed.rows))}::jsonb,
    ${sqlString(idempotencyKey)}::uuid
  ) as result`))
  const validationData = firstValue(validationRows)

  const detailRows = dbQuery(asAuth(userId, `select inventarios.get_campaign_stock_import(${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(importId)}::uuid) as result`))
  const detail = firstValue(detailRows)

  return { regData, validationData, detail, storagePath, parsed, fileIssues, rows: parsed.rows }
}

async function legacyContractSmoke(userInventarios, storageClient, userId, siteId) {
  const filename = `legacy-${shortId()}.xlsx`
  const buffer = makeWorkbook('TOTAL_CAMPAIGN', [['LEGACY-SKU', 1, 10]])
  const legacyProduct = dbQuery(`insert into adquisiciones.products (company_id, sku, description, status, is_active, created_by, updated_by)
    values (${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(`LEGACY-${shortId()}`)}, 'Legacy smoke product', 'ACTIVE', true, ${sqlString(userId)}::uuid, ${sqlString(userId)}::uuid)
    returning id::text as id, sku`)[0]
  state.createdProducts.push(legacyProduct.id)

  const createData = firstValue(dbQuery(asAuth(userId, `select inventarios.create_stock_import(
    ${sqlString(QA_COMPANY_ID)}::uuid,
    ${sqlString(siteId)}::uuid,
    'GENERAL',
    ${sqlString(new Date().toISOString())}::timestamptz,
    ${sqlString(filename)}
  ) as result`)))
  const legacyImportId = createData?.entity_id ?? createData?.import_id ?? createData?.data?.import_id
  assert(legacyImportId, 'create_stock_import sin id')
  state.createdImports.push(legacyImportId)

  const storagePath = `${QA_COMPANY_ID}/stock-imports/${legacyImportId}/${Date.now()}-${safeFileName(filename)}`
  const { error: uploadErr } = await storageClient.from(IMPORT_BUCKET).upload(storagePath, buffer, { contentType: MIME_XLSX, upsert: false })
  if (uploadErr) throw uploadErr
  state.createdStoragePaths.push(storagePath)

  dbQuery(asAuth(userId, `select inventarios.register_stock_import_file(
    ${sqlString(QA_COMPANY_ID)}::uuid,
    ${sqlString(legacyImportId)}::uuid,
    ${sqlString(storagePath)},
    ${sqlString(filename)},
    ${sqlString(MIME_XLSX)},
    ${buffer.length}::bigint
  )`))

  const detail = firstValue(dbQuery(asAuth(userId, `select inventarios.get_stock_import(${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(legacyImportId)}::uuid) as result`)))
  return { legacyImportId, detail }
}

async function cleanup() {
  for (const p of state.createdStoragePaths) {
    try { await admin.storage.from(IMPORT_BUCKET).remove([p]) } catch {}
  }

  if (state.createdImports.length > 0) {
    dbQuery(`delete from inventarios.stock_import_row_issues where import_id in (${state.createdImports.map(sqlString).join(',')})`)
    dbQuery(`delete from inventarios.stock_import_rows where import_id in (${state.createdImports.map(sqlString).join(',')})`)
    dbQuery(`delete from inventarios.stock_imports where id in (${state.createdImports.map(sqlString).join(',')})`)
  }

  if (state.createdAuthUsers.length > 0) {
    dbQuery(`delete from inventarios.operation_idempotency where actor_id in (${state.createdAuthUsers.map(sqlString).join(',')})`)
  }

  if (state.createdCampaignSiteLocations.length > 0) dbQuery(`delete from inventarios.inventory_campaign_site_locations where id in (${state.createdCampaignSiteLocations.map(sqlString).join(',')})`)
  if (state.createdCampaignSites.length > 0) dbQuery(`delete from inventarios.inventory_campaign_sites where id in (${state.createdCampaignSites.map(sqlString).join(',')})`)
  if (state.createdCampaigns.length > 0) dbQuery(`delete from inventarios.inventory_campaigns where id in (${state.createdCampaigns.map(sqlString).join(',')})`)
  if (state.createdLocations.length > 0) dbQuery(`delete from inventarios.inventory_site_locations where id in (${state.createdLocations.map(sqlString).join(',')})`)
  if (state.createdSites.length > 0) dbQuery(`delete from inventarios.inventory_sites where id in (${state.createdSites.map(sqlString).join(',')})`)
  if (state.createdProducts.length > 0) dbQuery(`delete from adquisiciones.products where id in (${state.createdProducts.map(sqlString).join(',')})`)
  if (state.createdAccessRows.length > 0) dbQuery(`delete from core.user_company_access where user_id in (${state.createdAccessRows.map(r => sqlString(r.userId)).join(',')})`)

  for (const userId of state.createdAuthUsers.reverse()) {
    try { await admin.auth.admin.deleteUser(userId) } catch {}
  }
}

async function snapshotCarlos() {
  const ids = [
    '4d71de77-ff51-406b-9b16-89a573fcb732',
    '617902ea-4e52-484c-9c1e-50cb9ef6cda2',
    '028fb4ff-0345-440f-9d32-6f443ca96cf9',
  ]
  const snap = {}
  for (const id of ids) {
    const imp = dbQuery(`select id::text as id, status, file_sha256, row_count, error_count, warning_count, consumed_session_id::text as consumed_session_id, consumed_campaign_id::text as consumed_campaign_id from inventarios.stock_imports where id = ${sqlString(id)}::uuid limit 1`)[0]
    const rows = dbQuery(`select * from inventarios.stock_import_rows where import_id = ${sqlString(id)}::uuid order by row_index asc`)
    const issues = dbQuery(`select * from inventarios.stock_import_row_issues where import_id = ${sqlString(id)}::uuid order by created_at asc`)
    snap[id] = { imp, rows, issues }
  }
  return snap
}

async function main() {
  if (process.env.QA_ONLY === 'N') {
    await runOnlyN()
    return
  }
  if (process.env.QA_ONLY === 'OPQ') {
    await runOnlyOPQ()
    return
  }

  const qaSnapshotBefore = await snapshotCarlos()

  const goodUser = await createTempUser(`qa-good-${Date.now()}@example.com`, 'QaGood123!Aa', 'SUPER_USUARIO', 'ADMIN')
  const limitedUser = await createTempUser(`qa-limited-${Date.now()}@example.com`, 'QaLimited123!Aa', 'FINANZAS', 'FINANZAS')
  state.tempUsers.push(goodUser, limitedUser)

  const goodClient = await signIn(goodUser.email, goodUser.password)
  const goodInventarios = goodClient.schema('inventarios')
  const goodStorage = goodClient.storage

  await signIn(limitedUser.email, limitedUser.password)

  const product = await ensureProduct(goodUser.userId)
  const siteA = await ensureTempSite(goodUser.userId, 'A')
  const siteB = await ensureTempSite(goodUser.userId, 'B')
  const locA1 = await ensureLocation(goodUser.userId, siteA.id, `QA-${shortId()}-A1`)
  const locA2 = await ensureLocation(goodUser.userId, siteA.id, `QA-${shortId()}-A2`)
  const locB1 = await ensureLocation(goodUser.userId, siteB.id, `QA-${shortId()}-B1`)
  const locB2 = await ensureLocation(goodUser.userId, siteB.id, `QA-${shortId()}-B2`)

  const campaignTotal = await ensureCampaign(goodUser.userId, `QA Campaign Total ${shortId()}`, 'GENERAL', 'ALL_INTERNAL', 'ALL')
  const campaignSite = await ensureCampaign(goodUser.userId, `QA Campaign Site ${shortId()}`, 'SELECTIVE', 'SELECTED', 'ALL')
  const campaignLocation = await ensureCampaign(goodUser.userId, `QA Campaign Location ${shortId()}`, 'SELECTIVE', 'SELECTED', 'ALL')

  await addCampaignSite(goodUser.userId, campaignSite.id, siteA.id, 'ALL', 1)
  await addCampaignSite(goodUser.userId, campaignSite.id, siteB.id, 'ALL', 2)
  const locCampaignSiteA = await addCampaignSite(goodUser.userId, campaignLocation.id, siteA.id, 'SELECTED', 1)
  const locCampaignSiteB = await addCampaignSite(goodUser.userId, campaignLocation.id, siteB.id, 'SELECTED', 2)
  await addCampaignSiteLocation(goodUser.userId, locCampaignSiteA, locA1.id, 1)
  await addCampaignSiteLocation(goodUser.userId, locCampaignSiteA, locA2.id, 2)
  await addCampaignSiteLocation(goodUser.userId, locCampaignSiteB, locB1.id, 1)
  await addCampaignSiteLocation(goodUser.userId, locCampaignSiteB, locB2.id, 2)

  const imports = {}

  // A
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignTotal.id, 'TOTAL_CAMPAIGN', 'qa-total-a.xlsx')
    imports.A = created.importId
    pushResult('A', !!created.importId, 'create DRAFT TOTAL_CAMPAIGN sin unidad')
  }

  // B
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignSite.id, 'BY_SITE', 'qa-site-b.xlsx')
    imports.B = created.importId
    pushResult('B', !!created.importId, 'create DRAFT BY_SITE sin unidad en cabecera')
  }

  // C
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignLocation.id, 'BY_LOCATION', 'qa-location-c.xlsx')
    imports.C = created.importId
    pushResult('C', !!created.importId, 'create DRAFT BY_LOCATION sin unidad en cabecera')
  }

  const totalValidBuffer = makeWorkbook('TOTAL_CAMPAIGN', [[product.sku, 12, 1000]])
  const siteValidBuffer = makeWorkbook('BY_SITE', [[product.sku, siteA.code, 7, 1000], [product.sku, siteB.code, 5, 1000]])
  const locationValidBuffer = makeWorkbook('BY_LOCATION', [[product.sku, siteA.code, locA1.code, 3, 1000], [product.sku, siteA.code, locA2.code, 4, 1000], [product.sku, siteB.code, locB1.code, 5, 1000], [product.sku, siteB.code, locB2.code, 6, 1000]])

  // D
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignTotal.id, 'TOTAL_CAMPAIGN', 'qa-total-d.xlsx')
    const outcome = await uploadRegisterAndFinalize(goodInventarios, goodUser.userId, goodStorage, {
      importId: created.importId,
      campaignId: campaignTotal.id,
      scope: 'TOTAL_CAMPAIGN',
      filename: 'qa-total-d.xlsx',
      buffer: totalValidBuffer,
      mimeType: MIME_XLSX,
      idempotencyKey: crypto.randomUUID(),
    })
    const status = outcome.detail?.import?.status ?? outcome.detail?.status ?? outcome.validationData?.data?.status ?? outcome.validationData?.state
    const valid = status === 'VALIDATED'
    pushResult('D', valid, `finalize XLSX TOTAL_CAMPAIGN válido → ${status}`)
  }

  // E
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignSite.id, 'BY_SITE', 'qa-site-e.xlsx')
    const outcome = await uploadRegisterAndFinalize(goodInventarios, goodUser.userId, goodStorage, {
      importId: created.importId,
      campaignId: campaignSite.id,
      scope: 'BY_SITE',
      filename: 'qa-site-e.xlsx',
      buffer: siteValidBuffer,
      mimeType: MIME_XLSX,
      idempotencyKey: crypto.randomUUID(),
    })
    const status = outcome.detail?.import?.status ?? outcome.detail?.status ?? outcome.validationData?.data?.status ?? outcome.validationData?.state
    pushResult('E', status === 'VALIDATED', `finalize XLSX BY_SITE válido → ${status}`)
  }

  // F
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignLocation.id, 'BY_LOCATION', 'qa-location-f.xlsx')
    const outcome = await uploadRegisterAndFinalize(goodInventarios, goodUser.userId, goodStorage, {
      importId: created.importId,
      campaignId: campaignLocation.id,
      scope: 'BY_LOCATION',
      filename: 'qa-location-f.xlsx',
      buffer: locationValidBuffer,
      mimeType: MIME_XLSX,
      idempotencyKey: crypto.randomUUID(),
    })
    const status = outcome.detail?.import?.status ?? outcome.detail?.status ?? outcome.validationData?.data?.status ?? outcome.validationData?.state
    pushResult('F', status === 'VALIDATED', `finalize XLSX BY_LOCATION válido → ${status}`)
  }

  // G
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignTotal.id, 'TOTAL_CAMPAIGN', 'qa-structural-g.xlsx')
    const storagePath = buildCampaignStoragePath(QA_COMPANY_ID, campaignTotal.id, created.importId, 'qa-structural-g.xlsx')
    const buffer = makeBrokenWorkbook()
    const { error: uploadErr } = await goodStorage.from(IMPORT_BUCKET).upload(storagePath, buffer, { contentType: MIME_XLSX, upsert: false })
    if (uploadErr) throw uploadErr
    state.createdStoragePaths.push(storagePath)
    dbQuery(asAuth(goodUser.userId, `select inventarios.register_campaign_stock_import_file(
      ${sqlString(QA_COMPANY_ID)}::uuid,
      ${sqlString(created.importId)}::uuid,
      ${sqlString(storagePath)},
      'qa-structural-g.xlsx',
      ${sqlString(MIME_XLSX)},
      ${buffer.length}::bigint,
      ${sqlString(crypto.randomUUID())}::uuid
    )`))
    let parsed
    try {
      parsed = parseCampaignWorkbook(buffer, 'TOTAL_CAMPAIGN')
    } catch (err) {
      parsed = {
        rows: [],
        file_issues: [{ level: 'ERROR', code: err.code || 'FILE_PARSE_ERROR', message: err.message }],
      }
    }
    dbQuery(asAuth(goodUser.userId, `select inventarios.validate_campaign_stock_import(
      ${sqlString(QA_COMPANY_ID)}::uuid,
      ${sqlString(created.importId)}::uuid,
      ${sqlString(sha256(buffer))}::char(64),
      ${sqlString(JSON.stringify(parsed.file_issues))}::jsonb,
      ${sqlString(JSON.stringify(parsed.rows))}::jsonb,
      ${sqlString(crypto.randomUUID())}::uuid
    )`))
    const detail = firstValue(dbQuery(asAuth(goodUser.userId, `select inventarios.get_campaign_stock_import(${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(created.importId)}::uuid) as result`)))
    const ok = detail?.import?.status === 'REJECTED' && Array.isArray(detail?.import?.file_issues) && detail.import.file_issues.length > 0
    pushResult('G', ok, `archivo con error estructural → ${detail?.import?.status}`)
  }

  // H product/site/location invalid
  {
    const badProduct = await createCampaignImport(goodInventarios, goodUser.userId, campaignTotal.id, 'TOTAL_CAMPAIGN', 'qa-invalid-product-h.xlsx')
    const badProductBuffer = makeWorkbook('TOTAL_CAMPAIGN', [['NO-EXISTE', 1, 10]])
    const out = await uploadRegisterAndFinalize(goodInventarios, goodUser.userId, goodStorage, {
      importId: badProduct.importId,
      campaignId: campaignTotal.id,
      scope: 'TOTAL_CAMPAIGN',
      filename: 'qa-invalid-product-h.xlsx',
      buffer: badProductBuffer,
      mimeType: MIME_XLSX,
      idempotencyKey: crypto.randomUUID(),
    })
    const status = out.detail?.import?.status ?? out.detail?.status
    pushResult('H1', status === 'REJECTED' && (out.detail?.issues?.length || 0) > 0, `producto inválido → ${status}`)
  }
  {
    const badSite = await createCampaignImport(goodInventarios, goodUser.userId, campaignSite.id, 'BY_SITE', 'qa-invalid-site-h.xlsx')
    const badSiteBuffer = makeWorkbook('BY_SITE', [[product.sku, 'NO-SITE', 1, 10]])
    const out = await uploadRegisterAndFinalize(goodInventarios, goodUser.userId, goodStorage, {
      importId: badSite.importId,
      campaignId: campaignSite.id,
      scope: 'BY_SITE',
      filename: 'qa-invalid-site-h.xlsx',
      buffer: badSiteBuffer,
      mimeType: MIME_XLSX,
      idempotencyKey: crypto.randomUUID(),
    })
    const status = out.detail?.import?.status ?? out.detail?.status
    pushResult('H2', status === 'REJECTED' && (out.detail?.issues?.length || 0) > 0, `unidad inválida → ${status}`)
  }
  {
    const badLoc = await createCampaignImport(goodInventarios, goodUser.userId, campaignLocation.id, 'BY_LOCATION', 'qa-invalid-location-h.xlsx')
    const badLocBuffer = makeWorkbook('BY_LOCATION', [[product.sku, siteA.code, 'NO-LOC', 1, 10]])
    const out = await uploadRegisterAndFinalize(goodInventarios, goodUser.userId, goodStorage, {
      importId: badLoc.importId,
      campaignId: campaignLocation.id,
      scope: 'BY_LOCATION',
      filename: 'qa-invalid-location-h.xlsx',
      buffer: badLocBuffer,
      mimeType: MIME_XLSX,
      idempotencyKey: crypto.randomUUID(),
    })
    const status = out.detail?.import?.status ?? out.detail?.status
    pushResult('H3', status === 'REJECTED' && (out.detail?.issues?.length || 0) > 0, `ubicación inválida → ${status}`)
  }

  // I storage path manipulated
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignTotal.id, 'TOTAL_CAMPAIGN', 'qa-manipulated-i.xlsx')
    const badPath = `${QA_COMPANY_ID}/campaign-stock-imports/${campaignTotal.id}/${created.importId}/tampered.xlsx`
    const buffer = makeWorkbook('TOTAL_CAMPAIGN', [[product.sku, 1, 10]])
    const { error: uploadErr } = await goodStorage.from(IMPORT_BUCKET).upload(badPath, buffer, { contentType: MIME_XLSX, upsert: false })
    if (uploadErr) throw uploadErr
    state.createdStoragePaths.push(badPath)
    try {
      dbQuery(asAuth(goodUser.userId, `select inventarios.register_campaign_stock_import_file(
        ${sqlString(QA_COMPANY_ID)}::uuid,
        ${sqlString(created.importId)}::uuid,
        ${sqlString(badPath)},
        'qa-manipulated-i.xlsx',
        ${sqlString(MIME_XLSX)},
        ${buffer.length}::bigint,
        ${sqlString(crypto.randomUUID())}::uuid
      )`))
      pushResult('I', false, 'ruta manipulada → accepted unexpectedly')
    } catch (err) {
      pushResult('I', true, `ruta manipulada → ${err.message}`)
    }
  }

  // J another company blocked
  {
    try {
      dbQuery(asAuth(goodUser.userId, `select inventarios.create_campaign_stock_import(
        ${sqlString(OTHER_COMPANY_ID)}::uuid,
        ${sqlString(crypto.randomUUID())}::uuid,
        'TOTAL_CAMPAIGN',
        ${sqlString(new Date().toISOString())}::timestamptz,
        'CLP',
        'qa-other-company-j.xlsx',
        ${sqlString(MIME_XLSX)},
        1024::bigint,
        ${sqlString(crypto.randomUUID())}::uuid
      )`))
      pushResult('J', false, 'otra empresa → accepted unexpectedly')
    } catch (err) {
      pushResult('J', true, `otra empresa → ${err.message}`)
    }
  }

  // K user without manage blocked
  {
    try {
      dbQuery(asAuth(limitedUser.userId, `select inventarios.create_campaign_stock_import(
        ${sqlString(QA_COMPANY_ID)}::uuid,
        ${sqlString(campaignTotal.id)}::uuid,
        'TOTAL_CAMPAIGN',
        ${sqlString(new Date().toISOString())}::timestamptz,
        'CLP',
        'qa-limited-k.xlsx',
        ${sqlString(MIME_XLSX)},
        1024::bigint,
        ${sqlString(crypto.randomUUID())}::uuid
      )`))
      pushResult('K', false, 'sin manage → accepted unexpectedly')
    } catch (err) {
      pushResult('K', true, `sin manage → ${err.message}`)
    }
  }

  // L idempotency replay
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignTotal.id, 'TOTAL_CAMPAIGN', 'qa-replay-l.xlsx')
    const buffer = makeWorkbook('TOTAL_CAMPAIGN', [[product.sku, 2, 10]])
    const key = crypto.randomUUID()
    const first = await uploadRegisterAndFinalize(goodInventarios, goodUser.userId, goodStorage, {
      importId: created.importId,
      campaignId: campaignTotal.id,
      scope: 'TOTAL_CAMPAIGN',
      filename: 'qa-replay-l.xlsx',
      buffer,
      mimeType: MIME_XLSX,
      idempotencyKey: key,
    })
    const second = firstValue(dbQuery(asAuth(goodUser.userId, `select inventarios.validate_campaign_stock_import(
      ${sqlString(QA_COMPANY_ID)}::uuid,
      ${sqlString(created.importId)}::uuid,
      ${sqlString(sha256(buffer))}::char(64),
      ${sqlString(JSON.stringify(first.fileIssues))}::jsonb,
      ${sqlString(JSON.stringify(first.rows))}::jsonb,
      ${sqlString(key)}::uuid
    )`)))
    console.log('L replay response', JSON.stringify(second))
    const replayed = second?.replayed === true || second?.data?.replayed === true
    pushResult('L', replayed, 'replay sin duplicidad')
  }

  // M deterministic same file same campaign/scope/cutoff/hash
  {
    const buffer = makeWorkbook('TOTAL_CAMPAIGN', [[product.sku, 9, 10]])
    const cutoff = new Date().toISOString()
    const created1 = await createCampaignImport(goodInventarios, goodUser.userId, campaignTotal.id, 'TOTAL_CAMPAIGN', 'qa-det-m1.xlsx', cutoff)
    const first = await uploadRegisterAndFinalize(goodInventarios, goodUser.userId, goodStorage, {
      importId: created1.importId,
      campaignId: campaignTotal.id,
      scope: 'TOTAL_CAMPAIGN',
      filename: 'qa-det-m1.xlsx',
      buffer,
      mimeType: MIME_XLSX,
      idempotencyKey: crypto.randomUUID(),
    })
    const created2 = await createCampaignImport(goodInventarios, goodUser.userId, campaignTotal.id, 'TOTAL_CAMPAIGN', 'qa-det-m2.xlsx', cutoff)
    const storagePath2 = buildCampaignStoragePath(QA_COMPANY_ID, campaignTotal.id, created2.importId, 'qa-det-m2.xlsx')
    const { error: uploadErr } = await goodStorage.from(IMPORT_BUCKET).upload(storagePath2, buffer, { contentType: MIME_XLSX, upsert: false })
    if (uploadErr) throw uploadErr
    state.createdStoragePaths.push(storagePath2)
    dbQuery(asAuth(goodUser.userId, `select inventarios.register_campaign_stock_import_file(
      ${sqlString(QA_COMPANY_ID)}::uuid,
      ${sqlString(created2.importId)}::uuid,
      ${sqlString(storagePath2)},
      'qa-det-m2.xlsx',
      ${sqlString(MIME_XLSX)},
      ${buffer.length}::bigint,
      ${sqlString(crypto.randomUUID())}::uuid
    )`))
    const second = firstValue(dbQuery(asAuth(goodUser.userId, `select inventarios.validate_campaign_stock_import(
      ${sqlString(QA_COMPANY_ID)}::uuid,
      ${sqlString(created2.importId)}::uuid,
      ${sqlString(sha256(buffer))}::char(64),
      ${sqlString(JSON.stringify(first.fileIssues))}::jsonb,
      ${sqlString(JSON.stringify(first.rows))}::jsonb,
      ${sqlString(crypto.randomUUID())}::uuid
    )`)))
    console.log('M replay response', JSON.stringify(second))
    const replayed = second?.replayed === true || second?.data?.replayed === true
    pushResult('M', replayed, 'mismo archivo/campaña/alcance/cutoff/hash determinista')
  }

  // N missing object / download failure / unreadable
  {
    const created = await createCampaignImport(goodInventarios, goodUser.userId, campaignTotal.id, 'TOTAL_CAMPAIGN', 'qa-missing-n.xlsx')
    const storagePath = buildCampaignStoragePath(QA_COMPANY_ID, campaignTotal.id, created.importId, 'qa-missing-n.xlsx')
    dbQuery(asAuth(goodUser.userId, `select inventarios.register_campaign_stock_import_file(
      ${sqlString(QA_COMPANY_ID)}::uuid,
      ${sqlString(created.importId)}::uuid,
      ${sqlString(storagePath)},
      'qa-missing-n.xlsx',
      ${sqlString(MIME_XLSX)},
      1024::bigint,
      ${sqlString(crypto.randomUUID())}::uuid
    )`))
    const download = await goodStorage.from(IMPORT_BUCKET).download(storagePath)
    const ok = !!download.error || !download.data
    const detail = dbQuery(asAuth(goodUser.userId, `select inventarios.get_campaign_stock_import(${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(created.importId)}::uuid) as result`))
    const detailObj = firstValue(detail)
    const noPartial = detailObj?.summary?.total_rows === 0 && (detailObj?.rows?.length ?? 0) === 0 && (detailObj?.issues?.length ?? 0) === 0 && detailObj?.import?.status === 'DRAFT'
    pushResult('N', ok && noPartial, 'objeto inexistente / download fallido sin efectos parciales')
  }

  // O legacy contracts
  {
    const legacy = await legacyContractSmoke(goodInventarios, goodStorage, goodUser.userId, siteA.id)
    const ok = !!legacy.legacyImportId && (legacy.detail?.import?.status ?? legacy.detail?.status) === 'DRAFT'
    pushResult('O', ok, 'legacy GENERAL/POR_UBICACION continúa funcionando')
  }

  // P Carlos imports unchanged
  {
    const after = await snapshotCarlos()
    const same = JSON.stringify(after) === JSON.stringify(qaSnapshotBefore)
    pushResult('P', same, same ? 'tres importaciones intactas' : 'cambios detectados')
  }

  // Q cleanup
  await cleanup()
  const remaining = await snapshotCarlos()
  const clean = JSON.stringify(remaining) === JSON.stringify(qaSnapshotBefore)
  pushResult('Q', clean, 'limpieza de QA ejecutada')

  console.log('\nSUMMARY', results.map(r => `${r.id}:${r.ok ? 'PASS' : 'FAIL'}`).join(' '))
}

async function runOnlyN() {
  const tempUser = await createTempUser(`qa-only-n-${Date.now()}@example.com`, 'QaOnlyN123!Aa', 'SUPER_USUARIO', 'ADMIN')
  const client = await signIn(tempUser.email, tempUser.password)
  const db = client.schema('inventarios')
  const storage = client.storage

  const product = await ensureProduct(tempUser.userId)
  const site = await ensureTempSite(tempUser.userId, 'N')
  const campaign = await ensureCampaign(tempUser.userId, `QA Only N ${shortId()}`, 'GENERAL', 'ALL_INTERNAL', 'ALL')
  const created = await createCampaignImport(db, tempUser.userId, campaign.id, 'TOTAL_CAMPAIGN', 'qa-only-n.xlsx')
  const storagePath = buildCampaignStoragePath(QA_COMPANY_ID, campaign.id, created.importId, 'qa-only-n.xlsx')

  const { error: regErr } = await dbQuery(asAuth(tempUser.userId, `select inventarios.register_campaign_stock_import_file(
    ${sqlString(QA_COMPANY_ID)}::uuid,
    ${sqlString(created.importId)}::uuid,
    ${sqlString(storagePath)},
    'qa-only-n.xlsx',
    ${sqlString(MIME_XLSX)},
    1024::bigint,
    ${sqlString(crypto.randomUUID())}::uuid
  ) as result`))
  if (regErr) throw regErr

  const download = await storage.from(IMPORT_BUCKET).download(storagePath)
  const detail = firstValue(dbQuery(asAuth(tempUser.userId, `select inventarios.get_campaign_stock_import(${sqlString(QA_COMPANY_ID)}::uuid, ${sqlString(created.importId)}::uuid) as result`)))
  const ok = !!download.error && detail?.import?.status === 'DRAFT' && detail?.summary?.total_rows === 0 && (detail?.rows?.length ?? 0) === 0 && (detail?.issues?.length ?? 0) === 0
  console.log(JSON.stringify({ downloadError: !!download.error, status: detail?.import?.status, total_rows: detail?.summary?.total_rows, rows: detail?.rows?.length ?? 0, issues: detail?.issues?.length ?? 0, ok }, null, 2))

  await cleanup()
  try {
    dbQuery(`delete from inventarios.stock_import_row_issues where import_id = ${sqlString(created.importId)}::uuid`)
    dbQuery(`delete from inventarios.stock_import_rows where import_id = ${sqlString(created.importId)}::uuid`)
    dbQuery(`delete from inventarios.stock_imports where id = ${sqlString(created.importId)}::uuid`)
    dbQuery(`delete from inventarios.operation_idempotency where company_id = ${sqlString(QA_COMPANY_ID)}::uuid and operation_code in ('inventarios.create_campaign_stock_import','inventarios.register_campaign_stock_import_file')`)
    dbQuery(`delete from inventarios.inventory_campaigns where id = ${sqlString(campaign.id)}::uuid`)
    dbQuery(`delete from inventarios.inventory_sites where id = ${sqlString(site.id)}::uuid`)
    dbQuery(`delete from adquisiciones.products where id = ${sqlString(product.id)}::uuid`)
    dbQuery(`delete from core.user_company_access where user_id = ${sqlString(tempUser.userId)}::uuid`)
  } catch {}
  try { await admin.auth.admin.deleteUser(tempUser.userId) } catch {}
  process.exit(ok ? 0 : 1)
}

async function runOnlyOPQ() {
  const qaSnapshotBefore = await snapshotCarlos()
  const tempUser = await createTempUser(`qa-only-opq-${Date.now()}@example.com`, 'QaOnlyOpq123!Aa', 'SUPER_USUARIO', 'ADMIN')
  const client = await signIn(tempUser.email, tempUser.password)
  const db = client.schema('inventarios')
  const storage = client.storage

  const product = await ensureProduct(tempUser.userId)
  const siteA = await ensureTempSite(tempUser.userId, 'O')
  await ensureLocation(tempUser.userId, siteA.id, `QA-${shortId()}-O1`)
  const campaign = await ensureCampaign(tempUser.userId, `QA Only OPQ ${shortId()}`, 'GENERAL', 'ALL_INTERNAL', 'ALL')
  await addCampaignSite(tempUser.userId, campaign.id, siteA.id, 'ALL', 1)

  const legacy = await legacyContractSmoke(db, storage, tempUser.userId, siteA.id)
  const okO = !!legacy.legacyImportId && (legacy.detail?.import?.status ?? legacy.detail?.status) === 'DRAFT'
  console.log(`O: ${okO ? 'PASS' : 'FAIL'}`)

  const qaSnapshotAfter = await snapshotCarlos()
  const okP = JSON.stringify(qaSnapshotAfter) === JSON.stringify(qaSnapshotBefore)
  console.log(`P: ${okP ? 'PASS' : 'FAIL'}`)

  await cleanup()
  const qaSnapshotFinal = await snapshotCarlos()
  const okQ = JSON.stringify(qaSnapshotFinal) === JSON.stringify(qaSnapshotBefore)
  console.log(`Q: ${okQ ? 'PASS' : 'FAIL'}`)

  try {
    dbQuery(`delete from inventarios.inventory_campaign_sites where campaign_id = ${sqlString(campaign.id)}::uuid`)
    dbQuery(`delete from inventarios.inventory_campaigns where id = ${sqlString(campaign.id)}::uuid`)
    dbQuery(`delete from inventarios.inventory_site_locations where inventory_site_id = ${sqlString(siteA.id)}::uuid`)
    dbQuery(`delete from inventarios.inventory_sites where id = ${sqlString(siteA.id)}::uuid`)
    dbQuery(`delete from adquisiciones.products where id = ${sqlString(product.id)}::uuid`)
    dbQuery(`delete from core.user_company_access where user_id = ${sqlString(tempUser.userId)}::uuid`)
  } catch {}
  try { await admin.auth.admin.deleteUser(tempUser.userId) } catch {}

  process.exit(okO && okP && okQ ? 0 : 1)
}

main().catch(async err => {
  console.error('QA_ERROR', err)
  try { await cleanup() } catch {}
  process.exit(1)
})
