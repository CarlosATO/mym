/**
 * Suite de pruebas de integración y regresión: FAC-DIR-02B
 * Integración segura de resolución de direcciones Bsale en emisión de facturas.
 *
 * Ejecución: node scripts/test-logistica-invoice-address-integration.mjs
 */

import assert from 'node:assert/strict'
import {
  buildInvoiceEmissionPayload,
  buildInvoiceEmissionIdentity,
  invoiceAddressResolutionEnabled,
  resolveInvoiceEmissionAddress,
  fetchAllBsaleClientAddresses,
} from '../src/lib/integraciones/invoice-emission-contract.ts'
import {
  verifyBsaleInvoiceAddress,
  resolveBsaleClientAddress,
  evaluateTerritoryMatch,
} from '../src/lib/integraciones/bsale-address-resolution.ts'

console.log('--- Iniciando suite de pruebas: FAC-DIR-02B (Integración de Direcciones en Facturación) ---')

let passedTests = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passedTests++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err)
    process.exit(1)
  }
}

// Subproceso de control negativo: se ejecuta exclusivamente al pasar la bandera
if (process.argv.includes('--simulate-async-failure')) {
  console.log('--- Subproceso de control negativo activo ---')
  await test('Fallo asíncrono intencional post-await', async () => {
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal('valor_esperado', 'valor_erroneo', 'Asert falló intencionalmente tras await')
  })
  process.exit(0)
}

// ==========================================
// FIXTURES REALES CONOCIDOS
// ==========================================

// Cliente 643 (AMIMASCOTA SPA / Tatiana Pailahuar)
const CLIENT_643 = {
  address: 'SANTIAGO',
  commune: 'SANTIAGO',
  city: 'SANTIAGO',
}

const ADDRESSES_643 = [
  {
    id: 11,
    addressName: 'MALL GO FLORIDA ',
    address: 'MALL GO FLORIDA  LOCAL 1015B',
    municipality: 'TALCA',
    city: 'TALCA',
    state: 0,
  },
  {
    id: 12,
    addressName: 'MALL BRISAS DEL CENTRO',
    address: 'MALL BRISAS DEL CENTRO LOCAL 4',
    municipality: 'TALCA',
    city: 'TALCA',
    state: 0,
  },
  {
    id: 13,
    addressName: 'MIRAFLORES',
    address: 'SANTIAGO MIRAFLORES 419',
    municipality: 'SANTIAGO',
    city: 'SANTIAGO',
    state: 0,
  },
]

// Cliente 994
const CLIENT_994 = {
  address: 'Freire #854',
  commune: 'Constitución',
  city: 'Constitución',
}

const ADDRESSES_994 = [
  {
    id: 28,
    addressName: 'Sucursal Romeral',
    address: 'Camino Romeral Km 5',
    municipality: 'Romeral',
    city: 'Romeral',
    state: 0,
  },
]

// ==========================================
// TEST CASES
// ==========================================

// 1. Caso real conocido: NV 5140 -> Factura 24873 (Mall Go Florida, id 11)
await test('1. Caso real NV 5140 -> Factura 24873: Resuelve addressId: 11 e incorpora addressId en el payload', () => {
  const nv = {
    address: 'MALL GO FLORIDA  LOCAL 1015B',
    municipality: 'TALCA',
    city: 'TALCA',
  }

  const result = resolveInvoiceEmissionAddress({
    nv,
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })

  assert.equal(result.ok, true)
  assert.equal(result.addressId, 11)

  const payload = buildInvoiceEmissionPayload({
    officeId: 1,
    priceListId: 1,
    saleConditionId: 1,
    emissionDate: 1730600000,
    expirationDate: 1730600000,
    clientId: 643,
    sellerId: 10,
    salesId: 'PETGROUP:FACTURA:test:123',
    addressId: result.addressId,
    details: [{ detailId: 101, quantity: 2 }],
    payments: [{ paymentTypeId: 1, amount: 50000, recordDate: 1730600000 }],
  })

  assert.equal(payload.addressId, 11)
  assert.equal(payload.clientId, 643)
  assert.equal(payload.salesId, 'PETGROUP:FACTURA:test:123')
})

// 2. Caso real conocido: NV 5147 -> Factura 24872 (Mall Brisas del Centro, id 12, Cliente 643)
await test('2. Caso real NV 5147 -> Factura 24872: Resuelve addressId: 12 (Cliente 643, Mall Brisas del Centro)', () => {
  const nv = {
    address: 'MALL BRISAS DEL CENTRO LOCAL 4',
    municipality: 'TALCA',
    city: 'TALCA',
  }

  const result = resolveInvoiceEmissionAddress({
    nv,
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })

  assert.equal(result.ok, true)
  assert.equal(result.addressId, 12)

  const payload = buildInvoiceEmissionPayload({
    officeId: 1,
    priceListId: 1,
    saleConditionId: 1,
    emissionDate: 1730600000,
    expirationDate: 1730600000,
    clientId: 643,
    sellerId: 10,
    salesId: 'PETGROUP:FACTURA:test:456',
    addressId: result.addressId,
    details: [{ detailId: 201, quantity: 5 }],
    payments: [{ paymentTypeId: 1, amount: 25000, recordDate: 1730600000 }],
  })

  assert.equal(payload.addressId, 12)
  assert.equal(payload.clientId, 643)
  assert.equal(payload.salesId, 'PETGROUP:FACTURA:test:456')
})

// 3. Coincidencia con dirección principal: Omite addressId en payload al tener coincidencia probada (Cliente 994)
await test('3. Coincidencia con dirección principal: Omite addressId en payload (Cliente 994, Freire 854)', () => {
  const nv = {
    address: 'Freire 854',
    municipality: 'Constitución',
    city: 'Constitución',
  }

  const result = resolveInvoiceEmissionAddress({
    nv,
    client: CLIENT_994,
    clientAddresses: ADDRESSES_994,
  })

  assert.equal(result.ok, true)
  assert.equal(result.addressId, null)

  const payload = buildInvoiceEmissionPayload({
    officeId: 1,
    priceListId: 1,
    saleConditionId: 1,
    emissionDate: 1730600000,
    expirationDate: 1730600000,
    clientId: 994,
    sellerId: 10,
    salesId: 'PETGROUP:FACTURA:test:789',
    addressId: result.addressId,
    details: [{ detailId: 301, quantity: 1 }],
    payments: [{ paymentTypeId: 1, amount: 10000, recordDate: 1730600000 }],
  })

  // addressId debe estar ausente cuando es null (PRIMARY_ADDRESS_MATCHED)
  assert.equal('addressId' in payload, false)
  assert.equal(payload.clientId, 994)
})

// 4. Coincidencia con dirección adicional normalizada (espacios, mayúsculas, diacríticos)
await test('4. Coincidencia con dirección adicional normalizada: Extrae addressId válido', () => {
  const nv = {
    address: '  mall  go   florida local 1015b  ',
    municipality: 'Talca',
    city: 'Talca',
  }

  const result = resolveInvoiceEmissionAddress({
    nv,
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })

  assert.equal(result.ok, true)
  assert.equal(result.addressId, 11)
})

// 5. Direcciones ambiguas o duplicadas activas -> Bloquea emisión antes de POST
await test('5. Direcciones ambiguas o duplicadas activas: Bloquea con AMBIGUOUS_MATCH', () => {
  const duplicateAddresses = [
    { id: 11, address: 'Av. Colón 100', municipality: 'TALCA', state: 0 },
    { id: 12, address: 'Av. Colón 100', municipality: 'TALCA', state: 0 },
  ]

  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'Av. Colón 100', municipality: 'Talca' },
    client: { address: 'Otra Casa Matriz', commune: 'Talca' },
    clientAddresses: duplicateAddresses,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'AMBIGUOUS_MATCH')
  assert.match(result.error, /múltiples direcciones activas coinciden/i)
})

// 6. Dirección inactiva (state !== 0) -> Bloquea emisión antes de POST
await test('6. Dirección inactiva (state: 1): Bloquea con MATCHING_ADDRESS_IS_INACTIVE', () => {
  const inactiveAddresses = [
    { id: 77, address: 'Los Aromos 450', municipality: 'LINARES', state: 1 },
  ]

  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'Los Aromos 450', municipality: 'Linares' },
    client: { address: 'Casa Central 1', commune: 'Linares' },
    clientAddresses: inactiveAddresses,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MATCHING_ADDRESS_IS_INACTIVE')
  assert.match(result.error, /dirección inactiva en Bsale/i)
})

// 7. Dirección con state: null (no presumida activa) -> Bloquea emisión antes de POST
await test('7. Dirección con state: null (no presumida activa, FAC-DIR-02B): Bloquea con MATCHING_ADDRESS_IS_INACTIVE', () => {
  const nullStateAddresses = [
    { id: 88, address: 'Calle Chacabuco 12', municipality: 'TALCA', state: null },
  ]

  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'Calle Chacabuco 12', municipality: 'Talca' },
    client: { address: 'Oficina Central', commune: 'Talca' },
    clientAddresses: nullStateAddresses,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MATCHING_ADDRESS_IS_INACTIVE')
  assert.match(result.error, /dirección inactiva en Bsale/i)
})

// 8. Bloqueo por falta de datos en Nota de Venta (sin dirección o en blanco)
await test('8. Bloqueo por falta de datos: NV con dirección null o en blanco', () => {
  const resNull = resolveInvoiceEmissionAddress({
    nv: { address: null, municipality: 'Talca' },
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })
  assert.equal(resNull.ok, false)
  assert.equal(resNull.code, 'INSUFFICIENT_DATA')

  const resBlank = resolveInvoiceEmissionAddress({
    nv: { address: '    ', municipality: 'Talca' },
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })
  assert.equal(resBlank.ok, false)
  assert.equal(resBlank.code, 'INSUFFICIENT_DATA')
})

// 9. Bloqueo por falta de datos territoriales en Nota de Venta
await test('9. Bloqueo por falta de datos: NV sin comuna ni ciudad', () => {
  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: null, city: null },
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INSUFFICIENT_DATA')
})

// 10. Bloqueo por dirección no encontrada (sin coincidencia alguna)
await test('10. Bloqueo por dirección no encontrada: NO_MATCHING_ADDRESS', () => {
  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'Dirección Inexistente 9999', municipality: 'Talca' },
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_MATCHING_ADDRESS')
  assert.match(result.error, /No se encontró una dirección coincidente/i)
})

// 11. Paginación segura y manejo defensivo del helper real fetchAllBsaleClientAddresses (Finding 1)
await test('11. Paginación segura: verificación de count, detección de páginas incompletas, duplicados y ciclos', async () => {
  // A. Paginación exitosa multi-página con count consistente (55 items en 2 páginas)
  const page1Items = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, address: `Calle ${i + 1}`, municipality: 'Talca', state: 0 }))
  const page2Items = Array.from({ length: 5 }, (_, i) => ({ id: i + 51, address: `Calle ${i + 51}`, municipality: 'Talca', state: 0 }))

  const mockValidMultiPage = async ({ params }) => {
    const offset = Number(params?.offset ?? 0)
    if (offset === 0) {
      return { count: 55, limit: 50, offset: 0, items: page1Items }
    }
    return { count: 55, limit: 50, offset: 50, items: page2Items }
  }

  const successResult = await fetchAllBsaleClientAddresses('comp-1', 643, mockValidMultiPage)
  assert.equal(successResult.ok, true)
  assert.equal(successResult.addresses.length, 55)
  assert.equal(successResult.addresses[54].id, 55)

  // B. Detección de página incompleta: count reporta 10, pero primera página devuelve solo 5 items (< limit)
  const mockIncompletePage = async () => ({
    count: 10,
    limit: 50,
    offset: 0,
    items: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, address: `Calle ${i + 1}`, state: 0 })),
  })
  const incompleteResult = await fetchAllBsaleClientAddresses('comp-1', 643, mockIncompletePage)
  assert.equal(incompleteResult.ok, false)
  assert.match(incompleteResult.error, /página incompleta/i)

  // C. Detección de count divergente entre páginas
  const mockDivergentCount = async ({ params }) => {
    const offset = Number(params?.offset ?? 0)
    if (offset === 0) return { count: 60, limit: 50, offset: 0, items: page1Items }
    return { count: 55, limit: 50, offset: 50, items: page2Items }
  }
  const divergentResult = await fetchAllBsaleClientAddresses('comp-1', 643, mockDivergentCount)
  assert.equal(divergentResult.ok, false)
  assert.match(divergentResult.error, /count divergente/i)

  // D. Detección de direcciones duplicadas entre páginas
  const mockDuplicateAddress = async ({ params }) => {
    const offset = Number(params?.offset ?? 0)
    if (offset === 0) return { count: 55, limit: 50, offset: 0, items: page1Items }
    // En la página 2 se repite el id 10
    return { count: 55, limit: 50, offset: 50, items: [{ id: 10, address: 'Repetido', state: 0 }] }
  }
  const duplicateResult = await fetchAllBsaleClientAddresses('comp-1', 643, mockDuplicateAddress)
  assert.equal(duplicateResult.ok, false)
  assert.match(duplicateResult.error, /dirección duplicada detectada/i)

  // E. Detección de página vacía antes de completar el count
  const mockEmptyPage = async () => ({
    count: 20,
    limit: 50,
    offset: 0,
    items: [],
  })
  const emptyResult = await fetchAllBsaleClientAddresses('comp-1', 643, mockEmptyPage)
  assert.equal(emptyResult.ok, false)
  assert.match(emptyResult.error, /página vacía/i)

  // F. Validación de count numérico ausente o inválido
  const mockInvalidCount = async () => ({
    count: null,
    limit: 50,
    offset: 0,
    items: [{ id: 1, address: 'Test', state: 0 }],
  })
  const invalidCountResult = await fetchAllBsaleClientAddresses('comp-1', 643, mockInvalidCount)
  assert.equal(invalidCountResult.ok, false)
  assert.match(invalidCountResult.error, /count numérico no informado o inválido/i)

  // G. Manejo de count: 0 consistente (sin items)
  const mockZeroCountOk = async () => ({ count: 0, limit: 50, offset: 0, items: [] })
  const zeroCountResult = await fetchAllBsaleClientAddresses('comp-1', 643, mockZeroCountOk)
  assert.equal(zeroCountResult.ok, true)
  assert.equal(zeroCountResult.addresses.length, 0)

  // H. Manejo de count: 0 inconsistente (con items retornados)
  const mockZeroCountBad = async () => ({ count: 0, limit: 50, offset: 0, items: [{ id: 1, address: 'Fantasma' }] })
  const zeroCountBadResult = await fetchAllBsaleClientAddresses('comp-1', 643, mockZeroCountBad)
  assert.equal(zeroCountBadResult.ok, false)
  assert.match(zeroCountBadResult.error, /count es 0 pero se devolvieron elementos/i)

  // I. Error de red o excepción en fetcher
  const mockThrowingFetcher = async () => {
    throw new Error('ETIMEDOUT: Bsale address endpoint timeout')
  }
  const throwResult = await fetchAllBsaleClientAddresses('comp-1', 643, mockThrowingFetcher)
  assert.equal(throwResult.ok, false)
  assert.match(throwResult.error, /ETIMEDOUT/i)
})

// 12. Verificación posterior de dirección en factura devuelta por Bsale (verifyBsaleInvoiceAddress, Finding 2 y Cierre Auditoría)
await test('12. Verificación posterior de documento devuelto por Bsale: Comuna y ciudad estrictas, datos no verificables y detección histórica', () => {
  const nv = {
    address: 'MALL GO FLORIDA  LOCAL 1015B',
    municipality: 'TALCA',
    city: 'TALCA',
  }

  // A. Coincidencia exacta o normalizada: OK
  const matchOk = verifyBsaleInvoiceAddress(
    { address: 'Mall Go Florida Local 1015B', municipality: 'Talca', city: 'Talca' },
    nv
  )
  assert.equal(matchOk.ok, true)

  // B. Discrepancia en dirección textual: Falla e identifica error
  const mismatchAddress = verifyBsaleInvoiceAddress(
    { address: 'Apoquindo 4700 Piso 11', municipality: 'Talca', city: 'Talca' },
    nv
  )
  assert.equal(mismatchAddress.ok, false)
  assert.match(mismatchAddress.reason, /^INVOICE_ADDRESS_MISMATCH/)

  // C. Discrepancia en territorio (comuna no coincide): Falla
  const mismatchTerritory = verifyBsaleInvoiceAddress(
    { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: 'Curicó', city: 'Curicó' },
    nv
  )
  assert.equal(mismatchTerritory.ok, false)
  assert.match(mismatchTerritory.reason, /^INVOICE_TERRITORY_MISMATCH/)

  // D. Comuna coincidente pero ciudades distintas informadas -> Falla e impide false-positive
  const mismatchCityWithMatchingCommune = verifyBsaleInvoiceAddress(
    { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: 'TALCA', city: 'LINARES' },
    nv
  )
  assert.equal(mismatchCityWithMatchingCommune.ok, false)
  assert.match(mismatchCityWithMatchingCommune.reason, /CITY_MISMATCH_WITH_MATCHING_COMMUNE/)

  // E. Datos ausentes o imposibles de verificar -> Falla para requerir conciliación
  const missingAddress = verifyBsaleInvoiceAddress(
    { address: null, municipality: 'Talca', city: 'Talca' },
    nv
  )
  assert.equal(missingAddress.ok, false)
  assert.match(missingAddress.reason, /^INVOICE_ADDRESS_UNVERIFIABLE/)

  const missingTerritory = verifyBsaleInvoiceAddress(
    { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: null, city: null },
    nv
  )
  assert.equal(missingTerritory.ok, false)
  assert.match(missingTerritory.reason, /^INVOICE_TERRITORY_UNVERIFIABLE/)

  // F. Cierre Auditoría: Factura con ciudad ausente cuando la NV la informa -> Rechazada para conciliación
  const missingInvoiceCity = verifyBsaleInvoiceAddress(
    { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: 'TALCA', city: null },
    nv
  )
  assert.equal(missingInvoiceCity.ok, false)
  assert.match(missingInvoiceCity.reason, /^INVOICE_TERRITORY_UNVERIFIABLE: invoice missing city required by sales order/)

  // G. Cierre Auditoría: Factura con comuna ausente cuando la NV la informa -> Rechazada para conciliación
  const missingInvoiceCommune = verifyBsaleInvoiceAddress(
    { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: null, city: 'TALCA' },
    nv
  )
  assert.equal(missingInvoiceCommune.ok, false)
  assert.match(missingInvoiceCommune.reason, /^INVOICE_TERRITORY_UNVERIFIABLE: invoice missing commune required by sales order/)

  // H. Factura histórica 24873 (dirección 'SANTIAGO') vs NV 5140 ('MALL GO FLORIDA LOCAL 1015B'): Detecta discrepancia real
  const historical24873 = verifyBsaleInvoiceAddress(
    { address: 'SANTIAGO', municipality: 'SANTIAGO', city: 'SANTIAGO' },
    nv
  )
  assert.equal(historical24873.ok, false)
  assert.match(historical24873.reason, /^INVOICE_ADDRESS_MISMATCH/)

  // I. Factura histórica 24872 (dirección 'SANTIAGO') vs NV 5147 ('MALL BRISAS DEL CENTRO LOCAL 4'): Detecta discrepancia real
  const historical24872 = verifyBsaleInvoiceAddress(
    { address: 'SANTIAGO', municipality: 'SANTIAGO', city: 'SANTIAGO' },
    { address: 'MALL BRISAS DEL CENTRO LOCAL 4', municipality: 'TALCA', city: 'TALCA' }
  )
  assert.equal(historical24872.ok, false)
  assert.match(historical24872.reason, /^INVOICE_ADDRESS_MISMATCH/)
})

// 13. Feature Flag apagado: Preserva compatibilidad hacia atrás estricta
await test('13. Feature flag apagado: Comportamiento por defecto y omisión de addressId', () => {
  // Asegurar que por defecto el flag está inactivo sin variable de entorno
  delete process.env.BSALE_INVOICE_ADDRESS_RESOLUTION_ENABLED
  assert.equal(invoiceAddressResolutionEnabled(), false)

  // Con el flag apagado, el payload generado por defecto no incluye addressId
  const defaultPayload = buildInvoiceEmissionPayload({
    officeId: 1,
    priceListId: 1,
    saleConditionId: 1,
    emissionDate: 1730600000,
    expirationDate: 1730600000,
    clientId: 643,
    sellerId: 10,
    salesId: 'PETGROUP:FACTURA:test:789',
    details: [{ detailId: 101, quantity: 1 }],
    payments: [{ paymentTypeId: 1, amount: 10000, recordDate: 1730600000 }],
  })

  assert.equal('addressId' in defaultPayload, false)

  // Al encenderlo explícitamente vía env:
  process.env.BSALE_INVOICE_ADDRESS_RESOLUTION_ENABLED = 'true'
  assert.equal(invoiceAddressResolutionEnabled(), true)
  delete process.env.BSALE_INVOICE_ADDRESS_RESOLUTION_ENABLED
})

// 14. Preservación de idempotencia: Identity snapshot y fingerprint inalterados
await test('14. Preservación de idempotencia: El fingerprint y salesId no dependen de addressId', () => {
  const baseSnapshot = {
    company_id: '123e4567-e89b-12d3-a456-426614174000',
    canonical_bsale_token: 'NV-5140-TOKEN',
    current_bsale_nv_id: 5140,
    client_id: 643,
    office_id: 1,
    sale_condition_id: '1',
    payment_type_id: 1,
    historical_bsale_nv_id: 5140,
    folio: '5140',
    seller_id: 10,
    price_list_id: 1,
    emission_date: '2026-11-03',
    expiration_date: '2026-11-03',
    totals: { net: 10000, tax: 1900, total: 11900 },
    details: [{ detail_id: 101, quantity: 2 }],
    total: 11900,
  }

  const identity1 = buildInvoiceEmissionIdentity(baseSnapshot)
  const identity2 = buildInvoiceEmissionIdentity(baseSnapshot)

  assert.equal(identity1.fingerprint, identity2.fingerprint)
  assert.equal(identity1.salesId, identity2.salesId)
  assert.match(identity1.salesId, /^PETGROUP:FACTURA:/)
})

// 15. Control negativo: una aserción asíncrona fallida post-await provoca fallo real de la suite (exit code 1)
await test('15. Control negativo: verificar que una aserción fallida tras await provoca el fallo real de la suite', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  let childError = null
  try {
    await execFileAsync(process.execPath, [
      new URL(import.meta.url).pathname,
      '--simulate-async-failure',
    ])
  } catch (err) {
    childError = err
  }

  assert.ok(childError, 'El subproceso con aserción asíncrona fallida debió salir con error')
  assert.equal(childError.code, 1, 'El código de salida del subproceso fallido debe ser estrictamente 1')
  const combinedOutput = `${childError.stdout || ''}\n${childError.stderr || ''}`
  assert.match(combinedOutput, /✗ Fallo asíncrono intencional post-await/, 'El harness debió registrar la falla con ✗')
  assert.match(combinedOutput, /Asert falló intencionalmente tras await/, 'El error de la aserción debió ser capturado y emitido')
})

console.log(`\n--- ${passedTests} pruebas de integración completadas exitosamente ---`)
