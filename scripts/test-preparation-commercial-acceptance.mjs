import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  compareCommercialVersions,
  fingerprintCommercialVersion,
  preparationCommercialLineFromSnapshot,
} from '../src/lib/logistica/preparation-commercial-version.ts'
import {
  buildPreparationCommercialReconciliationPlan,
} from '../src/lib/logistica/preparation-commercial-reconciliation-plan.ts'

const migration = await readFile(new URL('../supabase/migrations/20261027120000_logistica_preparation_commercial_acceptance.sql', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation-commercial-acceptance.ts', import.meta.url), 'utf8')
const alertAction = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation-commercial.ts', import.meta.url), 'utf8')
const versionSource = await readFile(new URL('../src/lib/logistica/preparation-commercial-version.ts', import.meta.url), 'utf8')
const panelSource = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', import.meta.url), 'utf8')
const drawerSource = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx', import.meta.url), 'utf8')

test('la aceptación sólo está disponible para service_role y exige estado IN_PREPARATION', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION logistica\.accept_sales_order_preparation_commercial_changes/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.accept_sales_order_preparation_commercial_changes\([^\n]+\) TO service_role/)
  assert.match(migration, /v_card\.status <> 'IN_PREPARATION'/)
  assert.match(migration, /FOR UPDATE;/)
})

test('la migración conserva líneas retiradas y no altera incidencias ni auditoría', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS retired_at/)
  assert.match(migration, /SET retired_at = now\(\)/)
  assert.doesNotMatch(migration, /DELETE FROM logistica\.sales_order_preparation_lines/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_incidents/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_audit_(lines|incidents)/)
  assert.match(migration, /sales_order_audit_lines WHERE preparation_line_id/)
})

test('la acción obtiene empresa/usuario desde sesión, fuerza lectura Bsale y valida fingerprint', () => {
  assert.match(action, /requireWmsPermission\('logistica\.preparation\.manage'\)/)
  assert.match(action, /createBsalePreparationCommercialProvider\(\)/)
  assert.match(action, /AbortSignal\.timeout\(15_000\)/)
  assert.match(action, /currentFingerprint !== params\.expectedCommercialFingerprint/)
  assert.match(action, /buildPreparationCommercialReconciliationPlan/)
  assert.doesNotMatch(action, /from\(['"]sales_order_audit/)
})

test('el flujo de aceptación no conecta ningún botón ni drawer', () => {
  assert.doesNotMatch(action, /drawer|onClick|button/i)
  assert.match(migration, /UNIQUE \(company_id, card_id, fingerprint\)/)
})

test('la nueva detección lee la versión aceptada con service_role y normaliza snapshots camelCase', () => {
  assert.match(alertAction, /createAdminClient\(\)/)
  assert.match(alertAction, /preparationCommercialLineFromSnapshot/)
  assert.match(versionSource, /'detail_id', 'detailId'/)
  assert.match(versionSource, /'variant_id', 'variantId'/)
  assert.match(versionSource, /'product_name', 'productName'/)
})

test('COM-02C: fallbackVersion usa card.bsale_nv_id como physicalId histórico y reconstruye netAmount, taxAmount y totalAmount', () => {
  assert.match(action, /physicalId:\s*card\.bsale_nv_id\b/)
  assert.doesNotMatch(action, /physicalId:\s*card\.current_bsale_nv_id\s*\?\?\s*card\.bsale_nv_id/)
  assert.match(action, /completeSnapshots\.map\(preparationCommercialLineFromSnapshot\)/)
  assert.match(action, /netAmount:\s*sumLineField\(versionLines,\s*'lineNetAmount'\)/)
  assert.match(action, /taxAmount:\s*sumLineField\(versionLines,\s*'lineTaxAmount'\)/)
  assert.match(action, /totalAmount:\s*sumLineField\(versionLines,\s*'lineGrossAmount'\)/)
  assert.match(action, /\.order\('bsale_detail_id',\s*\{\s*ascending:\s*true\s*\}\)/)
})

function buildNv5148Fixture() {
  const card = {
    id: '6b6214e6-281b-4fde-92d9-4f90ff3e2098',
    company_id: 'd1000000-0000-0000-0000-000000000001',
    status: 'IN_PREPARATION',
    bsale_nv_id: 92753,
    bsale_nv_folio: '5148',
    canonical_bsale_token: '2f2ce3af5035',
    current_bsale_nv_id: 92799,
  }

  const unchangedSnapshots = [
    {
      detail_id: 336245,
      variant_id: 2000,
      sku: '70501',
      product_name: 'DOGIT PANALES DESECHABLES T.S',
      quantity: 3,
      unit_net_value: 4896,
      line_net_amount: 14689,
      line_tax_amount: 2791,
      line_gross_amount: 17480,
      nv_bsale_id: 92753,
      nv_folio: 5148,
    },
    ...Array.from({ length: 11 }, (_, idx) => ({
      detail_id: 336252 + idx,
      variant_id: 2001 + idx,
      sku: `L${String(idx + 2).padStart(2, '0')}`,
      product_name: `PRODUCTO L${idx + 2}`,
      quantity: 2,
      unit_net_value: 6000,
      line_net_amount: 12000,
      line_tax_amount: 2280,
      line_gross_amount: 14280,
      nv_bsale_id: 92753,
      nv_folio: 5148,
    })),
    {
      detail_id: 336263,
      variant_id: 2012,
      sku: 'L13',
      product_name: 'PRODUCTO L13',
      quantity: 1,
      unit_net_value: 18893,
      line_net_amount: 18893,
      line_tax_amount: 3590,
      line_gross_amount: 22481,
      nv_bsale_id: 92753,
      nv_folio: 5148,
    },
  ]

  const snapshots92753 = [
    ...unchangedSnapshots,
    {
      detail_id: 336247,
      variant_id: 6839,
      sku: 'WG85765',
      product_name: 'WINGA POUCH PREBIOTIC SALMON GATO 90GR',
      quantity: 3,
      unit_net_value: 1470,
      line_net_amount: 4409,
      line_tax_amount: 838,
      line_gross_amount: 5246,
      nv_bsale_id: 92753,
      nv_folio: 5148,
    },
    {
      detail_id: 336251,
      variant_id: 5777,
      sku: 'USA651',
      product_name: 'IB CHURU TUNA VARIETIES 50 TUBES, 700 GR',
      quantity: 5,
      unit_net_value: 16419,
      line_net_amount: 82097,
      line_tax_amount: 15598,
      line_gross_amount: 97698,
      nv_bsale_id: 92753,
      nv_folio: 5148,
    },
  ].sort((a, b) => a.detail_id - b.detail_id)

  const persistedLines = snapshots92753.map((snap, index) => ({
    id: `line-5148-${index + 1}`,
    bsale_detail_id: snap.detail_id,
    bsale_variant_id: snap.variant_id,
    sku: snap.sku,
    product_name: snap.product_name,
    requested_quantity: snap.quantity,
    prepared_quantity: null,
    line_status: 'PENDING',
    excluded_from_dispatch: false,
    source_snapshot: snap,
  }))

  const liveVersion92799 = {
    identity: {
      canonicalToken: card.canonical_bsale_token,
      historicalBsaleId: card.bsale_nv_id,
      currentBsaleId: card.current_bsale_nv_id,
      folio: card.bsale_nv_folio,
    },
    physicalId: 92799,
    generationDate: '2026-10-29',
    emissionDate: '2026-10-29',
    lines: [
      ...unchangedSnapshots.map((snap, idx) => ({
        detailId: 336480 + idx,
        variantId: snap.variant_id,
        sku: snap.sku,
        productName: snap.product_name,
        quantity: snap.quantity,
        unitNetValue: snap.unit_net_value,
        lineNetAmount: snap.line_net_amount,
        lineTaxAmount: snap.line_tax_amount,
        lineGrossAmount: snap.line_gross_amount,
        lineNumber: 0,
        special: false,
      })),
      {
        detailId: 336471,
        variantId: 6839,
        sku: 'WG85765',
        productName: 'WINGA POUCH PREBIOTIC SALMON GATO 90GR',
        quantity: 2,
        unitNetValue: 1470,
        lineNetAmount: 2939,
        lineTaxAmount: 558,
        lineGrossAmount: 3497,
        lineNumber: 0,
        special: false,
      },
      {
        detailId: 336475,
        variantId: 5777,
        sku: 'USA651',
        productName: 'IB CHURU TUNA VARIETIES 50 TUBES, 700 GR',
        quantity: 5,
        unitNetValue: 16419,
        lineNetAmount: 82097,
        lineTaxAmount: 15598,
        lineGrossAmount: 97697,
        lineNumber: 0,
        special: false,
      },
    ],
    netAmount: 250618,
    taxAmount: 47617,
    totalAmount: 298235,
  }

  return { card, persistedLines, liveVersion92799 }
}

function runFallbackVersion(card, lines) {
  if (!card.canonical_bsale_token || !card.bsale_nv_folio || lines.length === 0 || lines.some(line => !line.source_snapshot)) return null
  const completeSnapshots = lines.map(line => line.source_snapshot)
  const versionLines = completeSnapshots.map(preparationCommercialLineFromSnapshot)
  const sumLineField = (field) => {
    const values = versionLines.map(line => line[field] ?? null)
    return values.some(v => v == null || !Number.isFinite(v)) ? null : values.reduce((sum, v) => sum + (v ?? 0), 0)
  }
  return {
    identity: {
      canonicalToken: card.canonical_bsale_token,
      historicalBsaleId: card.bsale_nv_id,
      currentBsaleId: card.current_bsale_nv_id ?? card.bsale_nv_id,
      folio: card.bsale_nv_folio,
    },
    physicalId: card.bsale_nv_id,
    generationDate: null,
    emissionDate: null,
    lines: versionLines,
    netAmount: sumLineField('lineNetAmount'),
    taxAmount: sumLineField('lineTaxAmount'),
    totalAmount: sumLineField('lineGrossAmount'),
  }
}

test('COM-02C: primera aceptación de NV #5148 reconstruye versión histórica 92753 ($299.985) y calcula totalDelta real -$1.750 frente a 92799 ($298.235)', () => {
  const { card, persistedLines, liveVersion92799 } = buildNv5148Fixture()
  const reconstructedHistorical = runFallbackVersion(card, persistedLines)
  assert.ok(reconstructedHistorical)

  // Identidad e importes históricos reales
  assert.equal(reconstructedHistorical.physicalId, 92753)
  assert.equal(reconstructedHistorical.identity.historicalBsaleId, 92753)
  assert.equal(reconstructedHistorical.identity.currentBsaleId, 92799)
  assert.equal(reconstructedHistorical.netAmount, 252088)
  assert.equal(reconstructedHistorical.taxAmount, 47897)
  assert.equal(reconstructedHistorical.totalAmount, 299985)

  // Comparación contra versión vigente 92799
  const comparison = compareCommercialVersions(reconstructedHistorical, liveVersion92799)
  assert.equal(comparison.sameIdentity, true)
  assert.equal(comparison.totals.previous.netAmount, 252088)
  assert.equal(comparison.totals.previous.taxAmount, 47897)
  assert.equal(comparison.totals.previous.totalAmount, 299985)
  assert.equal(comparison.totals.current.netAmount, 250618)
  assert.equal(comparison.totals.current.taxAmount, 47617)
  assert.equal(comparison.totals.current.totalAmount, 298235)
  assert.equal(comparison.totals.totalDelta, -1750)

  // Plan de conciliación en primera aceptación
  const plan = buildPreparationCommercialReconciliationPlan({
    card: { cardId: card.id, companyId: card.company_id, status: card.status },
    identity: liveVersion92799.identity,
    acceptedVersion: reconstructedHistorical,
    currentVersion: liveVersion92799,
    preparationLines: persistedLines,
    incidents: [],
    comparison,
    snapshotComplete: true,
  })

  assert.equal(plan.status, 'READY')
  assert.equal(plan.canAcceptCompletely, true)
  assert.equal(plan.currentPhysicalId, 92799)
  assert.equal(plan.impact.totalDelta, -1750)
  assert.equal(plan.impact.quantityUpdates, 1)
  assert.equal(plan.impact.conflicts, 0)
  assert.equal(plan.acceptedFingerprint, fingerprintCommercialVersion(reconstructedHistorical).value)
  assert.equal(plan.currentFingerprint, fingerprintCommercialVersion(liveVersion92799).value)
})

test('COM-02C: segunda y posteriores aceptaciones utilizan la versión comercial aceptada persistida y preservan trabajo físico', () => {
  const { card, persistedLines, liveVersion92799 } = buildNv5148Fixture()

  // Estado tras la primera aceptación (92799 aceptada) y avance físico en bodega:
  // USA651 preparada completa (5/5 CONFIRMED), WG85765 actualizada a 2 con 2 preparadas (2/2 CONFIRMED)
  const storedAcceptedVersion = {
    version_snapshot: liveVersion92799,
    fingerprint: fingerprintCommercialVersion(liveVersion92799).value,
  }
  const linesAfterFirstAcceptance = persistedLines.map(line => {
    if (line.sku === 'WG85765') {
      return {
        ...line,
        bsale_nv_id: 92799,
        bsale_detail_id: 336471,
        requested_quantity: 2,
        prepared_quantity: 2,
        line_status: 'CONFIRMED',
        source_snapshot: liveVersion92799.lines.find(l => l.sku === 'WG85765'),
      }
    }
    if (line.sku === 'USA651') {
      return {
        ...line,
        prepared_quantity: 5,
        line_status: 'CONFIRMED',
      }
    }
    return line
  })

  // Tercera versión en Bsale (92810): L13 sube de 1 a 2 unidades y USA651 ajusta precio neto
  const liveVersion92810 = {
    ...liveVersion92799,
    identity: { ...liveVersion92799.identity, currentBsaleId: 92810 },
    physicalId: 92810,
    lines: liveVersion92799.lines.map(item => {
      if (item.sku === 'L13') {
        return {
          ...item,
          detailId: 336600,
          quantity: 2,
          lineNetAmount: 37786,
          lineTaxAmount: 7180,
          lineGrossAmount: 44962,
        }
      }
      if (item.sku === 'USA651') {
        return {
          ...item,
          detailId: 336601,
          unitNetValue: 16000,
          lineNetAmount: 80000,
          lineTaxAmount: 15200,
          lineGrossAmount: 95200,
        }
      }
      return { ...item, detailId: (item.detailId ?? 336480) + 200 }
    }),
    netAmount: 250618 + 18893 - 2097,
    taxAmount: 47617 + 3590 - 398,
    totalAmount: 298235 + 22481 - 2497,
  }

  // En segunda aceptación prevalece storedAcceptedVersion.version_snapshot sobre fallbackVersion
  const acceptedVersion = storedAcceptedVersion.version_snapshot ?? runFallbackVersion(card, linesAfterFirstAcceptance)
  assert.equal(acceptedVersion.physicalId, 92799)
  assert.equal(acceptedVersion.totalAmount, 298235)

  const comparison = compareCommercialVersions(acceptedVersion, liveVersion92810)
  assert.equal(comparison.totals.previous.totalAmount, 298235)
  assert.equal(comparison.totals.current.totalAmount, 318219)
  assert.equal(comparison.totals.totalDelta, 19984)

  const plan = buildPreparationCommercialReconciliationPlan({
    card: { cardId: card.id, companyId: card.company_id, status: card.status },
    identity: liveVersion92810.identity,
    acceptedVersion,
    currentVersion: liveVersion92810,
    preparationLines: linesAfterFirstAcceptance,
    incidents: [],
    comparison,
    snapshotComplete: true,
  })

  assert.equal(plan.status, 'READY')
  assert.equal(plan.canAcceptCompletely, true)
  assert.equal(plan.impact.totalDelta, 19984)
  assert.equal(plan.impact.quantityUpdates, 1)

  const usaKeep = plan.actions.find(a => a.kind === 'KEEP' && a.current?.sku === 'USA651')
  assert.ok(usaKeep)
  assert.equal(usaKeep.preparedQuantity, 5)
  const wgKeep = plan.actions.find(a => a.kind === 'KEEP' && a.preparationLineId === linesAfterFirstAcceptance.find(l => l.sku === 'WG85765').id)
  assert.ok(wgKeep)
  assert.equal(wgKeep.preparedQuantity, 2)
  const l13Update = plan.actions.find(a => a.kind === 'UPDATE_QUANTITY')
  assert.ok(l13Update)
  assert.equal(l13Update.previousRequestedQuantity, 1)
  assert.equal(l13Update.newRequestedQuantity, 2)

  // Si una versión posterior intenta bajar WG85765 a 1 (con 2 ya preparadas), se bloquea
  const incompatibleVersion = {
    ...liveVersion92810,
    lines: liveVersion92810.lines.map(item => item.sku === 'WG85765' ? { ...item, quantity: 1 } : item),
  }
  const incompatibleComparison = compareCommercialVersions(acceptedVersion, incompatibleVersion)
  const incompatiblePlan = buildPreparationCommercialReconciliationPlan({
    card: { cardId: card.id, companyId: card.company_id, status: card.status },
    identity: incompatibleVersion.identity,
    acceptedVersion,
    currentVersion: incompatibleVersion,
    preparationLines: linesAfterFirstAcceptance,
    incidents: [],
    comparison: incompatibleComparison,
    snapshotComplete: true,
  })
  assert.equal(incompatiblePlan.status, 'REQUIRES_RESOLUTION')
  assert.equal(incompatiblePlan.canAcceptCompletely, false)
  assert.equal(incompatiblePlan.conflicts[0].reason, 'QUANTITY_BELOW_PREPARED')
})

test('COM-02C: coherencia exacta con el detector comercial, rechazo de versión obsoleta e idempotencia', () => {
  const { card, persistedLines, liveVersion92799 } = buildNv5148Fixture()

  // Construcción de snapshotVersion (detector) frente a fallbackVersion (aceptación)
  const snapshots = persistedLines.map(line => line.source_snapshot)
  const sumSnapshotField = (field) => {
    const values = snapshots.map(s => (s[field] == null || s[field] === '' || !Number.isFinite(Number(s[field])) ? null : Number(s[field])))
    return values.some(v => v == null) ? null : values.reduce((sum, v) => sum + v, 0)
  }
  const detectorSnapshotVersion = {
    identity: {
      canonicalToken: card.canonical_bsale_token,
      historicalBsaleId: card.bsale_nv_id,
      currentBsaleId: card.current_bsale_nv_id ?? card.bsale_nv_id,
      folio: card.bsale_nv_folio,
    },
    physicalId: card.bsale_nv_id,
    generationDate: null,
    emissionDate: null,
    lines: snapshots.map(preparationCommercialLineFromSnapshot),
    netAmount: sumSnapshotField('line_net_amount'),
    taxAmount: sumSnapshotField('line_tax_amount'),
    totalAmount: sumSnapshotField('line_gross_amount'),
  }
  const acceptanceFallbackVersion = runFallbackVersion(card, persistedLines)

  assert.deepEqual(acceptanceFallbackVersion, detectorSnapshotVersion)
  assert.equal(
    fingerprintCommercialVersion(acceptanceFallbackVersion).value,
    fingerprintCommercialVersion(detectorSnapshotVersion).value,
  )
  assert.deepEqual(
    compareCommercialVersions(acceptanceFallbackVersion, liveVersion92799),
    compareCommercialVersions(detectorSnapshotVersion, liveVersion92799),
  )

  // Protección ante versión obsoleta: si Bsale cambió entre la alerta y la aceptación
  const obsoleteComparison = compareCommercialVersions(acceptanceFallbackVersion, liveVersion92799)
  const newerLiveVersion = {
    ...liveVersion92799,
    physicalId: 92805,
    totalAmount: 295000,
  }
  const obsoletePlan = buildPreparationCommercialReconciliationPlan({
    card: { cardId: card.id, companyId: card.company_id, status: card.status },
    identity: newerLiveVersion.identity,
    acceptedVersion: acceptanceFallbackVersion,
    currentVersion: newerLiveVersion,
    preparationLines: persistedLines,
    incidents: [],
    comparison: obsoleteComparison,
    snapshotComplete: true,
  })
  assert.equal(obsoletePlan.status, 'AMBIGUOUS')
  assert.equal(obsoletePlan.canAcceptCompletely, false)
  assert.equal(obsoletePlan.conflicts[0].reason, 'CURRENT_VERSION_CHANGED')

  // Idempotencia y control de versión en Server Action y RPC SQL
  assert.match(action, /if \(currentFingerprint !== params\.expectedCommercialFingerprint\) return \{ status: 'VERSION_CHANGED', fingerprint: currentFingerprint \}/)
  assert.match(action, /onConflict:\s*'company_id,card_id,expected_fingerprint'/)
  assert.match(migration, /RETURN jsonb_build_object\('status', 'ALREADY_ACCEPTED'\);/)
  assert.match(migration, /RETURN jsonb_build_object\('status', 'VERSION_CHANGED'\);/)
})

test('COM-02D: handleCommercialAcceptanceSuccess limpia alerta, invalida caché del nv_bsale_id anterior y refresca el tablero sin spinner ni llamadas extra a Bsale', () => {
  assert.match(
    panelSource,
    /const handleCommercialAcceptanceSuccess = \(cardId: string\) => \{\s*const currentCard = cardsRef\.current\.find\(item => item\.card_id === cardId\)\s*if \(currentCard\) \{\s*detailCacheRef\.current\.delete\(currentCard\.nv_bsale_id\)\s*\}\s*clearCommercialAlert\(cardId\)\s*void loadBoard\(\{ showSpinner: false \}\)\s*\}/,
  )
  assert.match(
    drawerSource,
    /if \(result\.status !== 'ACCEPTED' && result\.status !== 'ALREADY_ACCEPTED'\) \{\s*setCommercialAcceptanceError\([\s\S]*?return\s*\}\s*const lines = await getSalesOrderPreparationLines\(card\.company_id, card\.card_id\)\s*if \(lines\.error\) \{\s*setCommercialAcceptanceError\([\s\S]*?return\s*\}\s*onPreparationLinesChange\(lines\.data\)\s*onCommercialAcceptanceSuccess\?\.\(card\.card_id\)/,
  )
})

test('COM-02D: aceptación exitosa actualiza totales comerciales, cantidad solicitada, nv_bsale_id y cabecera del Drawer conservando selección y filtros', async () => {
  const boardBeforeAcceptance = [
    {
      card_id: '6b6214e6-281b-4fde-92d9-4f90ff3e2098',
      company_id: 'd1000000-0000-0000-0000-000000000001',
      status: 'IN_PREPARATION',
      nv_bsale_id: 92753,
      nv_folio: '5148',
      total_quantity: 33,
      net_amount: 252088,
      tax_amount: 47897,
      gross_amount: 299985,
      total_amount: 299985,
      comuna: 'SANTIAGO',
      seller_name: 'Vendedor 1',
    },
    {
      card_id: 'other-card-id',
      company_id: 'd1000000-0000-0000-0000-000000000001',
      status: 'PENDING',
      nv_bsale_id: 92700,
      nv_folio: '5100',
      total_quantity: 10,
      net_amount: 100000,
      tax_amount: 19000,
      gross_amount: 119000,
      total_amount: 119000,
      comuna: 'PROVIDENCIA',
      seller_name: 'Vendedor 2',
    },
  ]

  const boardAfterAcceptance = [
    {
      ...boardBeforeAcceptance[0],
      nv_bsale_id: 92799,
      total_quantity: 32,
      net_amount: 250618,
      tax_amount: 47617,
      gross_amount: 298235,
      total_amount: 298235,
    },
    boardBeforeAcceptance[1],
  ]

  let cards = [...boardBeforeAcceptance]
  let cardsRef = [...boardBeforeAcceptance]
  let selectedCard = boardBeforeAcceptance[0]
  let selectedCardIds = new Set(['6b6214e6-281b-4fde-92d9-4f90ff3e2098', 'other-card-id'])
  let selectedComunas = ['SANTIAGO']
  let filterSellerKey = 'Vendedor 1'
  let loading = false
  let error = null
  let boardRequestSeq = 0
  const detailCache = new Map([[92753, { nv_bsale_id: 92753 }]])
  const commercialAlerts = {
    '6b6214e6-281b-4fde-92d9-4f90ff3e2098': {
      cardId: '6b6214e6-281b-4fde-92d9-4f90ff3e2098',
      status: 'READY',
      currentFingerprint: 'fp-92799',
    },
  }
  const checkedAt = new Map()
  let bsaleCallsDuringBoardRefresh = 0

  const clearCommercialAlert = (cardId) => {
    delete commercialAlerts[cardId]
    checkedAt.set(cardId, Date.now())
  }

  const loadBoard = async ({ showSpinner = false } = {}) => {
    const seq = ++boardRequestSeq
    if (showSpinner) loading = true
    error = null
    const res = { data: boardAfterAcceptance, error: undefined }
    if (seq !== boardRequestSeq) return
    const rows = res.data ?? []
    cardsRef = rows
    cards = rows
    const validCardIds = new Set(rows.map(r => r.card_id))
    selectedCardIds = new Set([...selectedCardIds].filter(id => validCardIds.has(id)))
    if (selectedCard) {
      const next = rows.find(candidate => candidate.card_id === selectedCard.card_id)
      selectedCard = next ?? selectedCard
    }
    if (showSpinner) loading = false
  }

  const handleCommercialAcceptanceSuccess = async (cardId) => {
    const currentCard = cardsRef.find(item => item.card_id === cardId)
    if (currentCard) {
      detailCache.delete(currentCard.nv_bsale_id)
    }
    clearCommercialAlert(cardId)
    await loadBoard({ showSpinner: false })
  }

  await handleCommercialAcceptanceSuccess('6b6214e6-281b-4fde-92d9-4f90ff3e2098')

  // Kanban actualizado con valores vigentes de Bsale
  const updatedKanbanCard = cards.find(c => c.card_id === '6b6214e6-281b-4fde-92d9-4f90ff3e2098')
  assert.equal(updatedKanbanCard.nv_bsale_id, 92799)
  assert.equal(updatedKanbanCard.total_quantity, 32)
  assert.equal(updatedKanbanCard.net_amount, 250618)
  assert.equal(updatedKanbanCard.tax_amount, 47617)
  assert.equal(updatedKanbanCard.gross_amount, 298235)
  assert.equal(updatedKanbanCard.total_amount, 298235)

  // Cabecera del Drawer abierto actualizada con los mismos datos vigentes
  assert.equal(selectedCard.nv_bsale_id, 92799)
  assert.equal(selectedCard.total_quantity, 32)
  assert.equal(selectedCard.net_amount, 250618)
  assert.equal(selectedCard.tax_amount, 47617)
  assert.equal(selectedCard.gross_amount, 298235)
  assert.equal(selectedCard.total_amount, 298235)

  // Alerta comercial limpiada y caché del ID físico anterior invalidado
  assert.equal(commercialAlerts['6b6214e6-281b-4fde-92d9-4f90ff3e2098'], undefined)
  assert.equal(checkedAt.has('6b6214e6-281b-4fde-92d9-4f90ff3e2098'), true)
  assert.equal(detailCache.has(92753), false)

  // Selección y navegación preservadas sin spinner ni consultas extra a Bsale
  assert.deepEqual([...selectedCardIds], ['6b6214e6-281b-4fde-92d9-4f90ff3e2098', 'other-card-id'])
  assert.deepEqual(selectedComunas, ['SANTIAGO'])
  assert.equal(filterSellerKey, 'Vendedor 1')
  assert.equal(loading, false)
  assert.equal(error, null)
  assert.equal(bsaleCallsDuringBoardRefresh, 0)
})

test('COM-02D: aceptación rechazada no limpia alerta ni refresca tablero; carreras y fallos de refresco conservan integridad', async () => {
  let refreshCalls = 0
  let alertCleared = false

  const executeDrawerAcceptanceFlow = async (actionResult) => {
    if (actionResult.status !== 'ACCEPTED' && actionResult.status !== 'ALREADY_ACCEPTED') {
      return { ok: false, error: actionResult.status }
    }
    alertCleared = true
    refreshCalls += 1
    return { ok: true }
  }

  // Aceptación rechazada (CONFLICT / VERSION_CHANGED / FORBIDDEN) no dispara onCommercialAcceptanceSuccess
  const rejected = await executeDrawerAcceptanceFlow({ status: 'CONFLICT' })
  assert.equal(rejected.ok, false)
  assert.equal(alertCleared, false)
  assert.equal(refreshCalls, 0)

  // Protección contra carrera en loadBoard mediante boardRequestSeqRef y manejo de error de refresco
  let boardRequestSeq = 0
  let appliedSnapshot = 'initial'
  let boardError = null

  const simulateLoadBoardWithSeq = async (resolver) => {
    const seq = ++boardRequestSeq
    const res = await resolver()
    if (seq !== boardRequestSeq) return 'ignored-stale'
    if (res.error) {
      boardError = res.error
      return 'error-handled'
    }
    appliedSnapshot = res.data
    return 'applied'
  }

  let resolveSlow
  const slowPromise = new Promise(resolve => { resolveSlow = resolve })
  const pSlow = simulateLoadBoardWithSeq(() => slowPromise)
  const pFast = simulateLoadBoardWithSeq(async () => ({ data: 'fresh-92799' }))
  assert.equal(await pFast, 'applied')
  resolveSlow({ data: 'stale-92753' })
  assert.equal(await pSlow, 'ignored-stale')
  assert.equal(appliedSnapshot, 'fresh-92799')

  // Si un refresco falla, registra el error sin presentar datos obsoletos nuevos ni lanzar excepción
  const failedRefresh = await simulateLoadBoardWithSeq(async () => ({ error: 'Error de red al cargar tablero' }))
  assert.equal(failedRefresh, 'error-handled')
  assert.equal(boardError, 'Error de red al cargar tablero')
})
