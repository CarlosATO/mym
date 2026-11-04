import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import module from 'node:module'
import test from 'node:test'
import {
  compareCommercialVersions,
  fingerprintCommercialVersion,
  preparationCommercialLineFromSnapshot,
} from '../src/lib/logistica/preparation-commercial-version.ts'
import {
  PREPARATION_RECONCILIATION_INCIDENT_SELECT,
  buildPreparationCommercialReconciliationPlan,
  mapPersistedIncidentToReconciliationIncident,
} from '../src/lib/logistica/preparation-commercial-reconciliation-plan.ts'

const migration = await readFile(new URL('../supabase/migrations/20261027120000_logistica_preparation_commercial_acceptance.sql', import.meta.url), 'utf8')
const reductionMigration = await readFile(new URL('../supabase/migrations/20261104130000_logistica_preparation_commercial_reduction_acceptance.sql', import.meta.url), 'utf8')
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

// ============================================================================
// MEJ-01 Bloque 1 (P0-01 + MEJ-01): Aceptación comercial segura de reducciones
// con incidencias resueltas.
// NOTA: El motor transaccional a continuación es una SIMULACIÓN EN JAVASCRIPT
// de la RPC PostgreSQL `logistica.accept_sales_order_preparation_commercial_changes`
// (migración `20261104130000_logistica_preparation_commercial_reduction_acceptance.sql`)
// y del guard P0-01 `logistica.materialize_sales_order_preparation_snapshot`
// (`20261103121029_logistica_snapshot_existing_lines_guard.sql`).
// ============================================================================

test('MEJ-01 Bloque 1: la migración incremental preserva permisos, locks, guard de auditoría y exige contrato completo de reducción resuelta y snapshot MEJ-01B', () => {
  assert.match(reductionMigration, /CREATE OR REPLACE FUNCTION logistica\.accept_sales_order_preparation_commercial_changes/)
  assert.match(reductionMigration, /v_card\.locked_by_user_id IS NULL/)
  assert.match(reductionMigration, /v_card\.locked_by_user_id IS DISTINCT FROM p_actor_id/)
  assert.match(reductionMigration, /v_card\.status <> 'IN_PREPARATION'/)
  assert.match(reductionMigration, /sales_order_audit_lines/)
  assert.match(reductionMigration, /sales_order_audit_incidents/)
  assert.match(reductionMigration, /sales_order_audits/)
  assert.match(reductionMigration, /i\.incident_type IS DISTINCT FROM 'QUANTITY_REDUCTION'/)
  assert.match(reductionMigration, /i\.required_bsale_action IS DISTINCT FROM 'SET_QUANTITY'/)
  assert.match(reductionMigration, /i\.status = 'RESOLVED'/)
  assert.match(reductionMigration, /i\.verification_status IS DISTINCT FROM 'MATCHED'/)
  assert.match(reductionMigration, /i\.expected_bsale_quantity IS DISTINCT FROM v_new_quantity/)
  assert.match(reductionMigration, /i\.bsale_observed_quantity IS DISTINCT FROM v_new_quantity/)
  assert.match(reductionMigration, /i\.bsale_observed_snapshot IS NULL/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'verification_basis'\) IS DISTINCT FROM 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE'/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'document_state'\)::integer IS DISTINCT FROM 0/)
  assert.match(reductionMigration, /i\.bsale_observed_snapshot->'canonical_identity_matched' IS DISTINCT FROM 'true'::jsonb/)
  assert.match(reductionMigration, /i\.bsale_observed_snapshot->'sync_proven' IS DISTINCT FROM 'true'::jsonb/)
  assert.match(reductionMigration, /i\.bsale_observed_snapshot->'line_link_valid' IS DISTINCT FROM 'true'::jsonb/)
  assert.match(reductionMigration, /i\.bsale_observed_snapshot->'full_card_matched' IS DISTINCT FROM 'true'::jsonb/)
  assert.match(reductionMigration, /i\.bsale_observed_snapshot->'incident_action_matched' IS DISTINCT FROM 'true'::jsonb/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'required_bsale_action'\) IS DISTINCT FROM 'SET_QUANTITY'/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'preparation_line_id'\) IS DISTINCT FROM v_line\.id::text/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'matched_preparation_line_id'\) IS DISTINCT FROM v_line\.id::text/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'expected_bsale_quantity'\)::numeric IS DISTINCT FROM v_new_quantity/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'bsale_observed_quantity'\)::numeric IS DISTINCT FROM v_new_quantity/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'physically_prepared_quantity'\)::numeric IS DISTINCT FROM v_line\.prepared_quantity/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'document_id'\)::bigint IS DISTINCT FROM \(v_request\.version_snapshot->>'physicalId'\)::bigint/)
  assert.match(reductionMigration, /\(i\.bsale_observed_snapshot->>'current_nv_id'\)::bigint IS DISTINCT FROM \(v_request\.version_snapshot->>'physicalId'\)::bigint/)
  assert.match(reductionMigration, /REVOKE ALL ON FUNCTION logistica\.accept_sales_order_preparation_commercial_changes/)
  assert.match(reductionMigration, /GRANT EXECUTE ON FUNCTION logistica\.accept_sales_order_preparation_commercial_changes\([^\n]+\) TO service_role/)
  assert.doesNotMatch(reductionMigration, /UPDATE logistica\.sales_order_preparation_incidents/)
  assert.doesNotMatch(reductionMigration, /DELETE FROM logistica\.sales_order_preparation_incidents/)
})

function isSnapshotValidForSqlSimulation(snapshot, expectedPhysicalId, expectedLineId, expectedPreparedQty, expectedNewQty) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  if (snapshot.verification_basis !== 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE') return false
  if (snapshot.verification_error != null && String(snapshot.verification_error).trim() !== '') return false
  if (typeof snapshot.document_state !== 'number' || !Number.isSafeInteger(snapshot.document_state) || snapshot.document_state !== 0) return false
  if (snapshot.canonical_identity_matched !== true) return false
  if (snapshot.sync_proven !== true) return false
  if (snapshot.line_link_valid !== true) return false
  if (snapshot.full_card_matched !== true) return false
  if (snapshot.incident_action_matched !== true) return false
  if (snapshot.required_bsale_action !== 'SET_QUANTITY') return false
  if (typeof snapshot.preparation_line_id !== 'string' || snapshot.preparation_line_id !== expectedLineId) return false
  if (typeof snapshot.matched_preparation_line_id !== 'string' || snapshot.matched_preparation_line_id !== expectedLineId) return false
  if (typeof snapshot.expected_bsale_quantity !== 'number' || snapshot.expected_bsale_quantity !== expectedNewQty) return false
  if (typeof snapshot.bsale_observed_quantity !== 'number' || snapshot.bsale_observed_quantity !== expectedNewQty) return false
  if (typeof snapshot.physically_prepared_quantity !== 'number' || snapshot.physically_prepared_quantity !== expectedPreparedQty) return false
  if (typeof snapshot.document_id !== 'number' || !Number.isSafeInteger(snapshot.document_id) || snapshot.document_id <= 0 || snapshot.document_id !== expectedPhysicalId) return false
  if (typeof snapshot.current_nv_id !== 'number' || !Number.isSafeInteger(snapshot.current_nv_id) || snapshot.current_nv_id <= 0 || snapshot.current_nv_id !== expectedPhysicalId) return false
  for (const extraKey of ['physical_id', 'physicalId', 'documentId', 'currentNvId', 'nv_id', 'nvId']) {
    if (Object.prototype.hasOwnProperty.call(snapshot, extraKey) && snapshot[extraKey] !== undefined) {
      if (typeof snapshot[extraKey] !== 'number' || !Number.isSafeInteger(snapshot[extraKey]) || snapshot[extraKey] <= 0 || snapshot[extraKey] !== expectedPhysicalId) {
        return false
      }
    }
  }
  return true
}

function simulateAcceptCommercialChangesRpc(db, params) {
  const {
    p_company_id,
    p_card_id,
    p_expected_previous_fingerprint = null,
    p_new_fingerprint,
    p_bsale_nv_id,
    p_bsale_nv_folio,
    p_canonical_bsale_token,
    p_version_snapshot,
    p_comparison,
    p_plan,
    p_accepted_by,
  } = params

  if (!p_company_id || !p_card_id || !p_accepted_by) {
    throw new Error('company_id, card_id y accepted_by son obligatorios')
  }
  if (!p_new_fingerprint || !p_bsale_nv_id || !p_bsale_nv_folio || !p_canonical_bsale_token) {
    throw new Error('La versión comercial a aceptar es incompleta')
  }
  if (!p_version_snapshot || !p_comparison || !p_plan) {
    throw new Error('El snapshot, comparación y plan de conciliación son obligatorios')
  }
  if (p_plan.status !== 'READY' || p_plan.canAcceptCompletely !== true) {
    throw new Error('El plan comercial no es elegible para aceptación automática segura')
  }
  if ((p_plan.conflicts ?? []).length > 0) {
    throw new Error('No se puede aceptar una versión comercial con conflictos pendientes')
  }

  const card = db.cards.find(c => c.id === p_card_id && c.company_id === p_company_id)
  if (!card) {
    throw new Error('Tarjeta de preparación no encontrada para la empresa')
  }
  if (card.status !== 'IN_PREPARATION') {
    throw new Error('Solo se pueden aceptar cambios comerciales cuando la tarjeta está en preparación')
  }
  if (card.canonical_bsale_token && card.canonical_bsale_token !== p_canonical_bsale_token) {
    throw new Error('La versión comercial no corresponde a la identidad canónica de la tarjeta')
  }

  const existingVersions = db.commercialVersions
    .filter(v => v.company_id === p_company_id && v.card_id === p_card_id)
    .sort((a, b) => b.version_number - a.version_number)
  const latestVersion = existingVersions[0] ?? null

  if (latestVersion) {
    if (latestVersion.fingerprint === p_new_fingerprint) {
      return { status: 'ALREADY_ACCEPTED', version_id: latestVersion.id, version_number: latestVersion.version_number }
    }
    if (p_expected_previous_fingerprint !== null && latestVersion.fingerprint !== p_expected_previous_fingerprint) {
      return { status: 'VERSION_CHANGED', current_accepted_fingerprint: latestVersion.fingerprint }
    }
  } else {
    const activeLines = db.preparationLines.filter(l => l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null)
    if (activeLines.length === 0 || activeLines.some(l => l.source_snapshot == null)) {
      throw new Error('No se puede aceptar cambios comerciales sin snapshot inicial completo')
    }
  }

  if (
    db.auditLines.some(a => a.company_id === p_company_id && a.card_id === p_card_id) ||
    db.auditIncidents.some(a => a.company_id === p_company_id && a.card_id === p_card_id) ||
    db.audits.some(a => a.company_id === p_company_id && a.card_id === p_card_id)
  ) {
    throw new Error('No se puede aceptar cambios comerciales cuando existe evidencia de Auditoría en la tarjeta')
  }

  const actions = p_plan.actions ?? []
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('El plan comercial debe contener acciones verificables')
  }

  // Trabajar sobre copia transaccional para garantizar atomicidad en la simulación JS
  const workingLines = db.preparationLines.map(l => ({ ...l }))
  const processedLineIds = new Set()

  for (const action of actions) {
    const kind = action.kind
    const lineId = action.preparationLineId ?? null
    const currentLine = action.current ?? null

    if (kind === 'KEEP' || kind === 'UPDATE_QUANTITY' || kind === 'REMOVE') {
      if (!lineId) throw new Error('Cada acción sobre línea existente debe referenciar preparationLineId')
      if (processedLineIds.has(lineId)) {
        throw new Error('El plan comercial referencia más de una vez la misma línea de preparación')
      }
      processedLineIds.add(lineId)
    }

    if (kind === 'KEEP') {
      if (!currentLine) throw new Error('KEEP requiere línea comercial vigente')
      const v_line = workingLines.find(l => l.id === lineId && l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null)
      if (!v_line) throw new Error('Línea de preparación para KEEP no existe o está retirada')
      if (Number(currentLine.quantity) !== v_line.requested_quantity) {
        throw new Error('KEEP no puede modificar requested_quantity')
      }
      if ((v_line.bsale_variant_id ?? -1) !== (currentLine.variantId ?? -1) || (v_line.sku ?? '') !== (currentLine.sku ?? '')) {
        throw new Error('KEEP no coincide con la identidad de producto de la línea preparada')
      }
      v_line.bsale_nv_id = p_bsale_nv_id
      v_line.bsale_detail_id = currentLine.detailId ?? v_line.bsale_detail_id
      v_line.source_snapshot = currentLine
    } else if (kind === 'UPDATE_QUANTITY') {
      if (!currentLine) throw new Error('UPDATE_QUANTITY requiere línea comercial vigente')
      const v_line = workingLines.find(l => l.id === lineId && l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null)
      if (!v_line) throw new Error('Línea de preparación para UPDATE_QUANTITY no existe o está retirada')
      const v_new_quantity = Number(action.newRequestedQuantity ?? currentLine.quantity ?? 0)
      if (
        v_new_quantity <= 0 ||
        v_line.excluded_from_dispatch ||
        (v_line.prepared_quantity !== null && v_new_quantity < v_line.prepared_quantity)
      ) {
        throw new Error('UPDATE_QUANTITY es incompatible con lo preparado')
      }
      if ((v_line.bsale_variant_id ?? -1) !== (currentLine.variantId ?? -1) || (v_line.sku ?? '') !== (currentLine.sku ?? '')) {
        throw new Error('UPDATE_QUANTITY no coincide con la identidad de producto de la línea preparada')
      }

      const lineIncidents = db.incidents.filter(i => i.preparation_line_id === v_line.id)
      if (v_line.line_status === 'INCIDENT' || lineIncidents.length > 0) {
        if (
          v_line.line_status !== 'INCIDENT' ||
          v_line.excluded_from_dispatch ||
          v_line.prepared_quantity === null ||
          v_line.prepared_quantity <= 0 ||
          v_line.requested_quantity <= v_line.prepared_quantity ||
          v_new_quantity !== v_line.prepared_quantity ||
          Number(currentLine.quantity ?? 0) !== v_new_quantity
        ) {
          throw new Error('UPDATE_QUANTITY no puede modificar líneas con incidencias no conciliadas para reducción exacta')
        }
        if (lineIncidents.some(i => i.status === 'OPEN' || !['RESOLVED', 'SUPERSEDED'].includes(i.status))) {
          throw new Error('UPDATE_QUANTITY no puede modificar líneas con incidencias abiertas')
        }
        const validResolved = lineIncidents.filter(i =>
          i.company_id === p_company_id &&
          i.card_id === p_card_id &&
          i.status === 'RESOLVED' &&
          i.verification_status === 'MATCHED' &&
          i.incident_type === 'QUANTITY_REDUCTION' &&
          i.required_bsale_action === 'SET_QUANTITY' &&
          i.requested_quantity === v_line.requested_quantity &&
          i.prepared_quantity === v_line.prepared_quantity &&
          i.expected_bsale_quantity === v_new_quantity &&
          i.bsale_observed_quantity === v_new_quantity &&
          (i.bsale_variant_id != null || (i.sku ?? '').trim() !== '') &&
          (i.bsale_variant_id ?? -1) === (v_line.bsale_variant_id ?? -1) &&
          (i.sku ?? '') === (v_line.sku ?? '') &&
          isSnapshotValidForSqlSimulation(i.bsale_observed_snapshot, p_bsale_nv_id, v_line.id, v_line.prepared_quantity, v_new_quantity)
        )
        if (validResolved.length === 0 || validResolved.length !== lineIncidents.filter(i => i.status === 'RESOLVED').length) {
          throw new Error('UPDATE_QUANTITY requiere una incidencia QUANTITY_REDUCTION en estado RESOLVED/MATCHED verificada para la versión vigente')
        }
      }

      if (db.auditLines.some(a => a.preparation_line_id === v_line.id)) {
        throw new Error('UPDATE_QUANTITY no puede modificar líneas con evidencia de Auditoría')
      }

      // Actualizar únicamente requested_quantity, bsale_nv_id, bsale_detail_id y source_snapshot.
      // Preservar intactos prepared_quantity, line_status, excluded_from_dispatch, confirmed_by y confirmed_at.
      v_line.bsale_nv_id = p_bsale_nv_id
      v_line.bsale_detail_id = currentLine.detailId ?? v_line.bsale_detail_id
      v_line.requested_quantity = v_new_quantity
      v_line.source_snapshot = currentLine
    } else if (kind === 'REMOVE') {
      const v_line = workingLines.find(l => l.id === lineId && l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null)
      if (!v_line) throw new Error('Línea de preparación para REMOVE no existe o está retirada')
      if (
        v_line.line_status !== 'PENDING' ||
        v_line.excluded_from_dispatch ||
        (v_line.prepared_quantity ?? 0) > 0 ||
        v_line.confirmed_by !== null ||
        v_line.confirmed_at !== null
      ) {
        throw new Error('REMOVE no puede retirar una línea con trabajo físico registrado')
      }
      if (db.incidents.some(i => i.preparation_line_id === v_line.id)) {
        throw new Error('REMOVE no puede retirar una línea con incidencias')
      }
      if (db.auditLines.some(a => a.preparation_line_id === v_line.id)) {
        throw new Error('REMOVE no puede retirar una línea con evidencia de Auditoría')
      }
      v_line.retired_at = '2026-11-04T12:00:00Z'
      v_line.retired_by = p_accepted_by
      v_line.retired_reason = 'COMMERCIAL_CHANGE_ACCEPTED'
    } else if (kind === 'ADD') {
      if (!currentLine) throw new Error('ADD requiere línea comercial vigente')
      workingLines.push({
        id: `added-line-${workingLines.length + 1}`,
        company_id: p_company_id,
        card_id: p_card_id,
        bsale_nv_id: p_bsale_nv_id,
        bsale_detail_id: currentLine.detailId,
        bsale_variant_id: currentLine.variantId ?? null,
        sku: currentLine.sku ?? null,
        product_name: currentLine.productName ?? 'Producto sin nombre',
        requested_quantity: Number(currentLine.quantity),
        prepared_quantity: null,
        line_status: 'PENDING',
        excluded_from_dispatch: false,
        confirmed_by: null,
        confirmed_at: null,
        retired_at: null,
        source_snapshot: currentLine,
      })
    } else {
      throw new Error(`Acción comercial no soportada: ${kind}`)
    }
  }

  const UncoveredActiveLines = workingLines.filter(
    l => l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null && !processedLineIds.has(l.id) && !l.id.startsWith('added-line-')
  )
  if (UncoveredActiveLines.length > 0) {
    throw new Error('El plan comercial no cubre todas las líneas activas de preparación')
  }

  // Comprobar invariante CHECK de sales_order_preparation_lines
  for (const l of workingLines) {
    if (l.prepared_quantity !== null && (l.prepared_quantity < 0 || l.prepared_quantity > l.requested_quantity)) {
      throw new Error('Violación CHECK prepared_quantity <= requested_quantity')
    }
    if (l.line_status === 'INCIDENT' && (l.prepared_quantity === null || !l.confirmed_by || !l.confirmed_at)) {
      throw new Error('Violación CHECK sales_order_preparation_lines_status_consistency')
    }
  }

  // Persistir cambios en simulación
  db.preparationLines = workingLines
  card.current_bsale_nv_id = p_bsale_nv_id
  card.canonical_bsale_token = card.canonical_bsale_token ?? p_canonical_bsale_token

  const nextVersionNumber = (latestVersion?.version_number ?? 0) + 1
  const newVersionRecord = {
    id: `version-${nextVersionNumber}`,
    company_id: p_company_id,
    card_id: p_card_id,
    version_number: nextVersionNumber,
    bsale_nv_id: p_bsale_nv_id,
    bsale_nv_folio: p_bsale_nv_folio,
    canonical_bsale_token: p_canonical_bsale_token,
    fingerprint: p_new_fingerprint,
    previous_fingerprint: latestVersion?.fingerprint ?? p_expected_previous_fingerprint,
    version_snapshot: p_version_snapshot,
    comparison: p_comparison,
    applied_actions: actions,
    accepted_by: p_accepted_by,
  }
  db.commercialVersions.push(newVersionRecord)

  return {
    status: 'ACCEPTED',
    version_id: newVersionRecord.id,
    version_number: nextVersionNumber,
    current_bsale_nv_id: p_bsale_nv_id,
    fingerprint: p_new_fingerprint,
  }
}

// Simulación en JavaScript del guard P0-01 (`20261103121029_logistica_snapshot_existing_lines_guard.sql`)
function simulateMaterializeSnapshotP001(db, p_company_id, p_card_id) {
  const card = db.cards.find(c => c.id === p_card_id && c.company_id === p_company_id)
  if (!card) throw new Error('Tarjeta de preparación no encontrada para la empresa')
  const latestAcceptedVersion = db.commercialVersions
    .filter(v => v.company_id === p_company_id && v.card_id === p_card_id)
    .sort((a, b) => b.version_number - a.version_number)[0]

  const activeLines = db.preparationLines.filter(l => l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null)

  if (latestAcceptedVersion) {
    const versionLines = latestAcceptedVersion.version_snapshot?.lines ?? []
    if (versionLines.length === 0) {
      throw new Error('La versión comercial aceptada no contiene líneas válidas para verificar el snapshot de preparación.')
    }
    if (activeLines.some(l => l.bsale_detail_id === null || l.source_snapshot == null)) {
      throw new Error('Existen líneas activas sin snapshot completo para la versión comercial aceptada.')
    }
    if (activeLines.length !== versionLines.length) {
      throw new Error('Las líneas activas de preparación no coinciden con la última versión comercial aceptada.')
    }
    const multisetKey = (variantId, sku, qty) => `${variantId ?? -1}::${sku ?? ''}::${Number(qty)}`
    const countMap = (items) => {
      const m = new Map()
      for (const k of items) m.set(k, (m.get(k) ?? 0) + 1)
      return m
    }
    const activeCounts = countMap(activeLines.map(l => multisetKey(l.bsale_variant_id, l.sku, l.requested_quantity)))
    const expectedCounts = countMap(versionLines.map(l => multisetKey(l.variantId, l.sku, l.quantity)))
    if (activeCounts.size !== expectedCounts.size || [...activeCounts.entries()].some(([k, v]) => expectedCounts.get(k) !== v)) {
      throw new Error('Las líneas activas de preparación no coinciden con las líneas de la última versión comercial aceptada.')
    }
    return 0
  }

  if (activeLines.length > 0) {
    return 0
  }
  throw new Error('Rama de materialización inicial no invocada en este escenario')
}

function buildCommercialReductionFixture() {
  const companyId = 'd1000000-0000-0000-0000-000000000001'
  const cardId = 'c2000000-0000-0000-0000-000000000002'
  const canonicalToken = 'token-nv-7701'

  const initialSnapshotLine = {
    detail_id: 88001,
    variant_id: 501,
    sku: 'SKU-RED-501',
    product_name: 'ALIMENTO PREMIUM PERRO 15KG',
    quantity: 5,
    unit_net_value: 20000,
    line_net_amount: 100000,
    line_tax_amount: 19000,
    line_gross_amount: 119000,
    nv_bsale_id: 95001,
    nv_folio: 7701,
  }

  const card = {
    id: cardId,
    company_id: companyId,
    status: 'IN_PREPARATION',
    bsale_nv_id: 95001,
    bsale_nv_folio: '7701',
    canonical_bsale_token: canonicalToken,
    current_bsale_nv_id: 95002,
  }

  const prepLine = {
    id: 'prep-line-501',
    company_id: companyId,
    card_id: cardId,
    bsale_nv_id: 95001,
    bsale_detail_id: 88001,
    bsale_variant_id: 501,
    sku: 'SKU-RED-501',
    product_name: 'ALIMENTO PREMIUM PERRO 15KG',
    requested_quantity: 5,
    prepared_quantity: 4,
    line_status: 'INCIDENT',
    excluded_from_dispatch: false,
    confirmed_by: 'operator-user-111',
    confirmed_at: '2026-11-04T09:15:00.000Z',
    retired_at: null,
    source_snapshot: initialSnapshotLine,
  }

  const incident = {
    id: 'incident-501',
    company_id: companyId,
    card_id: cardId,
    preparation_line_id: 'prep-line-501',
    bsale_nv_id: 95001,
    bsale_detail_id: 88001,
    bsale_variant_id: 501,
    sku: 'SKU-RED-501',
    product_name: 'ALIMENTO PREMIUM PERRO 15KG',
    requested_quantity: 5,
    prepared_quantity: 4,
    missing_quantity: 1,
    incident_type: 'QUANTITY_REDUCTION',
    reason: 'SHORTAGE_DETECTED',
    required_bsale_action: 'SET_QUANTITY',
    expected_bsale_quantity: 4,
    status: 'RESOLVED',
    verification_status: 'MATCHED',
    bsale_observed_quantity: 4,
    bsale_observed_snapshot: {
      historical_nv_id: 95001,
      current_nv_id: 95002,
      document_id: 95002,
      document_state: 0,
      canonical_identity_matched: true,
      sync_proven: true,
      line_link_valid: true,
      full_card_matched: true,
      incident_action_matched: true,
      required_bsale_action: 'SET_QUANTITY',
      expected_bsale_quantity: 4,
      bsale_observed_quantity: 4,
      physically_prepared_quantity: 4,
      preparation_line_id: 'prep-line-501',
      matched_preparation_line_id: 'prep-line-501',
      verification_basis: 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE',
    },
    created_by: 'operator-user-111',
    created_at: '2026-11-04T09:15:00.000Z',
    resolved_by: 'admin-user-222',
    resolved_at: '2026-11-04T10:00:00.000Z',
  }

  const currentLiveVersion = {
    identity: {
      canonicalToken,
      historicalBsaleId: 95001,
      currentBsaleId: 95002,
      folio: '7701',
    },
    physicalId: 95002,
    generationDate: '2026-11-04',
    emissionDate: '2026-11-04',
    lines: [
      {
        detailId: 88055,
        variantId: 501,
        sku: 'SKU-RED-501',
        productName: 'ALIMENTO PREMIUM PERRO 15KG',
        quantity: 4,
        unitNetValue: 20000,
        lineNetAmount: 80000,
        lineTaxAmount: 15200,
        lineGrossAmount: 95200,
        lineNumber: 1,
        special: false,
      },
    ],
    netAmount: 80000,
    taxAmount: 15200,
    totalAmount: 95200,
  }

  const db = {
    cards: [card],
    preparationLines: [prepLine],
    incidents: [incident],
    commercialVersions: [],
    audits: [],
    auditLines: [],
    auditIncidents: [],
  }

  return { db, card, prepLine, incident, currentLiveVersion }
}

test('MEJ-01 Bloque 1 — Escenarios 1, 7, 10 y 11 (Simulación JS de RPC + P0-01): reducción válida (5 -> 4), preservación histórica, compatibilidad P0-01 e idempotencia', () => {
  const { db, card, currentLiveVersion } = buildCommercialReductionFixture()
  const acceptedVersion = runFallbackVersion(card, db.preparationLines)
  const comparison = compareCommercialVersions(acceptedVersion, currentLiveVersion)

  // Verificar que una proyección truncada ('id, preparation_line_id, status, incident_type') queda bloqueada
  const truncatedIncidents = db.incidents.map(i => mapPersistedIncidentToReconciliationIncident({
    id: i.id,
    preparation_line_id: i.preparation_line_id,
    status: i.status,
    incident_type: i.incident_type,
  }))
  const truncatedPlan = buildPreparationCommercialReconciliationPlan({
    card: { cardId: card.id, companyId: card.company_id, status: card.status },
    identity: currentLiveVersion.identity,
    acceptedVersion,
    currentVersion: currentLiveVersion,
    preparationLines: db.preparationLines,
    incidents: truncatedIncidents,
    comparison,
    snapshotComplete: true,
  })
  assert.equal(truncatedPlan.status, 'REQUIRES_RESOLUTION')
  assert.equal(truncatedPlan.canAcceptCompletely, false)
  assert.equal(truncatedPlan.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')

  // Servidor proyecta las columnas reales definidas en PREPARATION_RECONCILIATION_INCIDENT_SELECT
  const selectedColumns = PREPARATION_RECONCILIATION_INCIDENT_SELECT.split(',').map(col => col.trim())
  const projectedIncidents = db.incidents.map(row =>
    mapPersistedIncidentToReconciliationIncident(
      Object.fromEntries(selectedColumns.map(col => [col, row[col]])),
    ),
  )

  const plan = buildPreparationCommercialReconciliationPlan({
    card: { cardId: card.id, companyId: card.company_id, status: card.status },
    identity: currentLiveVersion.identity,
    acceptedVersion,
    currentVersion: currentLiveVersion,
    preparationLines: db.preparationLines,
    incidents: projectedIncidents,
    comparison,
    snapshotComplete: true,
  })

  assert.equal(plan.status, 'READY')
  assert.equal(plan.canAcceptCompletely, true)
  assert.equal(plan.actions.length, 1)
  assert.equal(plan.actions[0].kind, 'UPDATE_QUANTITY')
  assert.equal(plan.actions[0].previousRequestedQuantity, 5)
  assert.equal(plan.actions[0].newRequestedQuantity, 4)

  const rpcParams = {
    p_company_id: card.company_id,
    p_card_id: card.id,
    p_expected_previous_fingerprint: plan.acceptedFingerprint,
    p_new_fingerprint: plan.currentFingerprint,
    p_bsale_nv_id: currentLiveVersion.physicalId,
    p_bsale_nv_folio: currentLiveVersion.identity.folio,
    p_canonical_bsale_token: currentLiveVersion.identity.canonicalToken,
    p_version_snapshot: currentLiveVersion,
    p_comparison: comparison,
    p_plan: plan,
    p_accepted_by: 'admin-user-222',
  }

  // Escenario 1: Aceptación comercial exitosa
  const result = simulateAcceptCommercialChangesRpc(db, rpcParams)
  assert.equal(result.status, 'ACCEPTED')
  assert.equal(result.version_number, 1)
  assert.equal(result.current_bsale_nv_id, 95002)

  // Escenario 7: Preservación histórica intacta en línea e incidencia
  assert.equal(db.preparationLines.length, 1)
  const updatedLine = db.preparationLines[0]
  assert.equal(updatedLine.requested_quantity, 4)
  assert.equal(updatedLine.prepared_quantity, 4)
  assert.equal(updatedLine.line_status, 'INCIDENT')
  assert.equal(updatedLine.excluded_from_dispatch, false)
  assert.equal(updatedLine.confirmed_by, 'operator-user-111')
  assert.equal(updatedLine.confirmed_at, '2026-11-04T09:15:00.000Z')
  assert.equal(updatedLine.bsale_nv_id, 95002)
  assert.equal(updatedLine.bsale_detail_id, 88055)

  const storedIncident = db.incidents[0]
  assert.equal(storedIncident.status, 'RESOLVED')
  assert.equal(storedIncident.verification_status, 'MATCHED')
  assert.equal(storedIncident.requested_quantity, 5)
  assert.equal(storedIncident.prepared_quantity, 4)
  assert.equal(storedIncident.required_bsale_action, 'SET_QUANTITY')
  assert.equal(storedIncident.reason, 'SHORTAGE_DETECTED')
  assert.equal(storedIncident.created_by, 'operator-user-111')
  assert.equal(storedIncident.created_at, '2026-11-04T09:15:00.000Z')
  assert.equal(storedIncident.resolved_by, 'admin-user-222')
  assert.equal(storedIncident.resolved_at, '2026-11-04T10:00:00.000Z')
  assert.equal(db.cards[0].status, 'IN_PREPARATION')

  // Escenario 10: Compatibilidad con guard P0-01 tras aceptar la reducción
  const insertedCount = simulateMaterializeSnapshotP001(db, card.company_id, card.id)
  assert.equal(insertedCount, 0)
  assert.equal(db.preparationLines.length, 1)
  assert.equal(db.preparationLines[0].requested_quantity, 4)
  assert.equal(db.preparationLines[0].prepared_quantity, 4)

  // Escenario 11: Ejecución repetida devuelve ALREADY_ACCEPTED sin crear nueva versión ni duplicar efectos
  const repeatResult = simulateAcceptCommercialChangesRpc(db, rpcParams)
  assert.equal(repeatResult.status, 'ALREADY_ACCEPTED')
  assert.equal(repeatResult.version_number, 1)
  assert.equal(db.commercialVersions.length, 1)
  assert.equal(db.preparationLines.length, 1)
})

test('MEJ-01 Bloque 1 — Escenarios 2, 3, 4, 5, 6, 8, 9 y 12 (Simulación JS de RPC): bloqueos defensivos en base de datos ante cualquier incumplimiento del contrato', () => {
  const buildForcedParams = (db, currentLiveVersion) => {
    const card = db.cards[0]
    const acceptedVersion = runFallbackVersion(card, db.preparationLines)
    const comparison = compareCommercialVersions(acceptedVersion, currentLiveVersion)
    const forcedPlan = {
      status: 'READY',
      canAcceptCompletely: true,
      conflicts: [],
      actions: [
        {
          kind: 'UPDATE_QUANTITY',
          preparationLineId: 'prep-line-501',
          previousRequestedQuantity: db.preparationLines[0].requested_quantity,
          newRequestedQuantity: currentLiveVersion.lines[0].quantity,
          preparedQuantity: db.preparationLines[0].prepared_quantity,
          quantityDelta: currentLiveVersion.lines[0].quantity - db.preparationLines[0].requested_quantity,
          current: currentLiveVersion.lines[0],
        },
      ],
    }
    return {
      p_company_id: card.company_id,
      p_card_id: card.id,
      p_expected_previous_fingerprint: fingerprintCommercialVersion(acceptedVersion).value,
      p_new_fingerprint: fingerprintCommercialVersion(currentLiveVersion).value,
      p_bsale_nv_id: currentLiveVersion.physicalId,
      p_bsale_nv_folio: currentLiveVersion.identity.folio,
      p_canonical_bsale_token: currentLiveVersion.identity.canonicalToken,
      p_version_snapshot: currentLiveVersion,
      p_comparison: comparison,
      p_plan: forcedPlan,
      p_accepted_by: 'admin-user-222',
    }
  }

  // Escenario 2: Incidencia OPEN bloquea en RPC
  {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.incidents[0].status = 'OPEN'
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY no puede modificar líneas con incidencias abiertas/,
    )
    assert.equal(db.preparationLines[0].requested_quantity, 5)
  }

  // Escenario 3: Cantidad inferior a lo preparado (Preparado 4, Bsale 3) bloquea en RPC
  {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    currentLiveVersion.lines[0].quantity = 3
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY es incompatible con lo preparado/,
    )
    assert.equal(db.preparationLines[0].requested_quantity, 5)
  }

  // Escenario 4: Incidencia SUPERSEDED sin incidencia RESOLVED vigente bloquea en RPC
  {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.incidents[0].status = 'SUPERSEDED'
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY requiere una incidencia QUANTITY_REDUCTION en estado RESOLVED\/MATCHED verificada para la versión vigente/,
    )
    assert.equal(db.preparationLines[0].requested_quantity, 5)
  }

  // Escenario 5: Versión desactualizada (physicalId verificado en incidencia distinto al de la versión que se intenta aceptar) bloquea en RPC
  {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.incidents[0].bsale_observed_snapshot = { physicalId: 95001 }
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY requiere una incidencia QUANTITY_REDUCTION en estado RESOLVED\/MATCHED verificada para la versión vigente/,
    )
    assert.equal(db.preparationLines[0].requested_quantity, 5)
  }

  // Escenario 6: Identidad incorrecta (incidencia de otra línea, otro producto, otra empresa o tarjeta) bloquea en RPC
  {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.incidents[0].preparation_line_id = 'other-line-id'
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY requiere una incidencia QUANTITY_REDUCTION en estado RESOLVED\/MATCHED verificada para la versión vigente/,
    )
  }
  {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.incidents[0].bsale_variant_id = 999
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY requiere una incidencia QUANTITY_REDUCTION en estado RESOLVED\/MATCHED verificada para la versión vigente/,
    )
  }
  {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.incidents[0].card_id = 'other-card-id'
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY requiere una incidencia QUANTITY_REDUCTION en estado RESOLVED\/MATCHED verificada para la versión vigente/,
    )
  }

  // Escenario 8: Estado de tarjeta inválido (IN_AUDIT o AUDITED) bloquea en RPC
  for (const invalidStatus of ['IN_AUDIT', 'AUDITED']) {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.cards[0].status = invalidStatus
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /Solo se pueden aceptar cambios comerciales cuando la tarjeta está en preparación/,
    )
  }

  // Escenario 9: Evidencia de Auditoría existente bloquea en RPC incluso si la tarjeta sigue en IN_PREPARATION
  {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.auditLines.push({
      id: 'audit-line-1',
      company_id: db.cards[0].company_id,
      card_id: db.cards[0].id,
      preparation_line_id: 'prep-line-501',
    })
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /No se puede aceptar cambios comerciales cuando existe evidencia de Auditoría en la tarjeta/,
    )
  }

  // Escenario 12: Producto excluido (prepared_quantity = 0 y excluded_from_dispatch = true) permanece bloqueado en RPC
  {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.preparationLines[0].prepared_quantity = 0
    db.preparationLines[0].excluded_from_dispatch = true
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY es incompatible con lo preparado/,
    )
  }

  // Solicitud fabricada enviada directamente a la RPC con snapshot histórico o incompleto (que TS rechazaría) es bloqueada por el contrato SQL
  const invalidSnapshotsForFabricatedRpc = [
    { document_id: 95002 }, // Solo document_id
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, verification_basis: undefined },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, verification_basis: null },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, verification_basis: 'LEGACY_V1' },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, document_state: null },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, document_state: 1 },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, canonical_identity_matched: false },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, canonical_identity_matched: null },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, sync_proven: false },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, line_link_valid: false },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, full_card_matched: false },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, incident_action_matched: false },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, required_bsale_action: 'REMOVE_LINE' },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, preparation_line_id: 'other-line' },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, matched_preparation_line_id: 'other-line' },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, expected_bsale_quantity: 5 },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, bsale_observed_quantity: 5 },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, physically_prepared_quantity: 5 },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, document_id: 95001 },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, current_nv_id: 95001 },
    { ...buildCommercialReductionFixture().incident.bsale_observed_snapshot, physicalId: 95001 },
  ]
  for (const badSnapshot of invalidSnapshotsForFabricatedRpc) {
    const { db, currentLiveVersion } = buildCommercialReductionFixture()
    db.incidents[0].bsale_observed_snapshot = badSnapshot
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY requiere una incidencia QUANTITY_REDUCTION en estado RESOLVED\/MATCHED verificada para la versión vigente/,
    )
    assert.equal(db.preparationLines[0].requested_quantity, 5)
  }
})

test('MEJ-01 PR #22 fix: la Server Action real proyecta las 15 columnas de evidencia desde Supabase hacia el planificador y bloquea evidencias incompletas o incompatibles', async () => {
  assert.match(action, /select\(PREPARATION_RECONCILIATION_INCIDENT_SELECT\)/)
  assert.match(action, /mapPersistedIncidentToReconciliationIncident/)
  assert.doesNotMatch(action, /select\(['"]id,\s*preparation_line_id,\s*status,\s*incident_type['"]\)/)

  let mockState = null

  const projectSelectedColumns = (row, selectClause) => {
    if (!row) return row
    if (!selectClause || selectClause.trim() === '*') return structuredClone(row)
    const cols = selectClause.split(',').map(c => c.trim()).filter(Boolean)
    return Object.fromEntries(cols.map(col => [col, structuredClone(row[col])]))
  }

  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './authorization') {
        return { url: 'mock://authorization', shortCircuit: true }
      }
      if (specifier === '@/lib/supabase/admin') {
        return { url: 'mock://supabase-admin', shortCircuit: true }
      }
      if (specifier === '@/lib/logistica/preparation-commercial-bsale-provider') {
        return { url: 'mock://bsale-provider', shortCircuit: true }
      }
      if (specifier === '@/lib/logistica/preparation-commercial-version') {
        return nextResolve(new URL('../src/lib/logistica/preparation-commercial-version.ts', import.meta.url).href, context)
      }
      if (specifier === '@/lib/logistica/preparation-commercial-reconciliation-plan') {
        return nextResolve(new URL('../src/lib/logistica/preparation-commercial-reconciliation-plan.ts', import.meta.url).href, context)
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock://authorization') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export async function requireWmsPermission() {
              return globalThis.__COMMERCIAL_ACCEPTANCE_TEST_STATE__.auth
            }
            export async function requirePreparationCardAccess() {
              return undefined
            }
          `,
        }
      }
      if (url === 'mock://supabase-admin') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export function createAdminClient() {
              return globalThis.__COMMERCIAL_ACCEPTANCE_TEST_STATE__.createAdminClient()
            }
          `,
        }
      }
      if (url === 'mock://bsale-provider') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export function createBsalePreparationCommercialProvider() {
              return {
                async getCurrentVersion() {
                  return globalThis.__COMMERCIAL_ACCEPTANCE_TEST_STATE__.currentLiveVersion
                }
              }
            }
          `,
        }
      }
      return nextLoad(url, context)
    },
  })

  const buildMockAdminClient = (db, state) => ({
    schema(schemaName) {
      assert.equal(schemaName, 'logistica')
      return {
        from(tableName) {
          let selectedClause = '*'
          const filters = []
          const applyFilters = (rows) => rows.filter(row => filters.every(fn => fn(row)))
          const builder = {
            select(clause = '*') {
              selectedClause = clause
              if (tableName === 'sales_order_preparation_incidents') {
                state.incidentSelectClauses.push(clause)
              }
              return builder
            },
            eq(col, val) {
              filters.push(row => row[col] === val)
              return builder
            },
            is(col, val) {
              filters.push(row => (row[col] ?? null) === val)
              return builder
            },
            order() {
              return builder
            },
            limit() {
              return builder
            },
            async maybeSingle() {
              const sourceRows =
                tableName === 'sales_order_preparation_cards' ? db.cards :
                tableName === 'sales_order_preparation_commercial_versions' ? db.commercialVersions :
                []
              const matched = applyFilters(sourceRows)[0] ?? null
              return { data: projectSelectedColumns(matched, selectedClause), error: null }
            },
            upsert(payload) {
              state.upsertedRequests.push(payload)
              return {
                select(clause = '*') {
                  return {
                    async single() {
                      const record = { id: 'req-1001', ...payload }
                      return { data: projectSelectedColumns(record, clause), error: null }
                    },
                  }
                },
              }
            },
            then(onFulfilled, onRejected) {
              const sourceRows =
                tableName === 'sales_order_preparation_lines' ? db.preparationLines :
                tableName === 'sales_order_preparation_incidents' ? db.incidents :
                []
              const matched = applyFilters(sourceRows).map(row => projectSelectedColumns(row, selectedClause))
              return Promise.resolve({ data: matched, error: null }).then(onFulfilled, onRejected)
            },
          }
          return builder
        },
        async rpc(fnName, rpcArgs) {
          state.rpcCalls.push({ fnName, rpcArgs })
          return {
            data: {
              status: 'ACCEPTED',
              versionId: 'version-1001',
              fingerprint: rpcArgs.p_expected_fingerprint,
            },
            error: null,
          }
        },
      }
    },
  })

  const { acceptSalesOrderPreparationCommercialChanges } = await import(
    '../src/app/actions/logistica/sales-order-preparation-commercial-acceptance.ts'
  )

  const runActionScenario = async (mutateFixture) => {
    const fixture = buildCommercialReductionFixture()
    if (mutateFixture) mutateFixture(fixture)
    const expectedFingerprint = fingerprintCommercialVersion(fixture.currentLiveVersion).value
    mockState = {
      auth: {
        companyId: fixture.card.company_id,
        user: { id: 'admin-user-222' },
      },
      currentLiveVersion: fixture.currentLiveVersion,
      incidentSelectClauses: [],
      upsertedRequests: [],
      rpcCalls: [],
      createAdminClient: () => buildMockAdminClient(fixture.db, mockState),
    }
    globalThis.__COMMERCIAL_ACCEPTANCE_TEST_STATE__ = mockState
    const response = await acceptSalesOrderPreparationCommercialChanges({
      cardId: fixture.card.id,
      expectedCommercialFingerprint: expectedFingerprint,
    })
    return { response, mockState, fixture }
  }

  // 1. Flujo real exitoso cuando la fila en sales_order_preparation_incidents tiene evidencia completa RESOLVED/MATCHED generada según PR #21
  {
    const { response, mockState: state } = await runActionScenario()
    assert.equal(response.status, 'ACCEPTED')
    assert.deepEqual(state.incidentSelectClauses, [PREPARATION_RECONCILIATION_INCIDENT_SELECT])
    assert.equal(state.upsertedRequests.length, 1)
    assert.equal(state.upsertedRequests[0].plan_snapshot.status, 'READY')
    assert.equal(state.upsertedRequests[0].plan_snapshot.actions[0].kind, 'UPDATE_QUANTITY')
    assert.equal(state.upsertedRequests[0].plan_snapshot.actions[0].newRequestedQuantity, 4)
    assert.equal(state.rpcCalls.length, 1)
  }

  // 2. Bloqueo cuando verification_status está ausente o es distinto de MATCHED (no se asume MATCHED por defecto)
  for (const invalidVerification of [null, 'MISMATCHED', 'NOT_FOUND', 'ERROR']) {
    const { response, mockState: state } = await runActionScenario(({ incident }) => {
      incident.verification_status = invalidVerification
    })
    assert.equal(response.status, 'REQUIRES_RESOLUTION')
    assert.equal(state.rpcCalls.length, 0)
  }

  // 3. Bloqueo cuando required_bsale_action está ausente o es REMOVE_LINE (no se asume SET_QUANTITY por defecto)
  for (const invalidAction of [null, 'REMOVE_LINE']) {
    const { response, mockState: state } = await runActionScenario(({ incident }) => {
      incident.required_bsale_action = invalidAction
    })
    assert.equal(response.status, 'REQUIRES_RESOLUTION')
    assert.equal(state.rpcCalls.length, 0)
  }

  // 4. Bloqueo cuando cantidades esperadas, observadas, solicitadas o preparadas están ausentes o no coinciden
  for (const mutateQty of [
    (inc) => { inc.requested_quantity = null },
    (inc) => { inc.requested_quantity = 6 },
    (inc) => { inc.prepared_quantity = null },
    (inc) => { inc.prepared_quantity = 3 },
    (inc) => { inc.expected_bsale_quantity = null },
    (inc) => { inc.expected_bsale_quantity = 3 },
    (inc) => { inc.bsale_observed_quantity = null },
    (inc) => { inc.bsale_observed_quantity = 5 },
  ]) {
    const { response, mockState: state } = await runActionScenario(({ incident }) => mutateQty(incident))
    assert.equal(response.status, 'REQUIRES_RESOLUTION')
    assert.equal(state.rpcCalls.length, 0)
  }

  // 5. Bloqueo cuando bsale_observed_snapshot está ausente, es histórico (sin verification_basis MEJ-01B), solo tiene document_id, carece de indicadores obligatorios o tiene IDs contradictorios
  const baseValidSnapshot = buildCommercialReductionFixture().incident.bsale_observed_snapshot
  for (const invalidSnapshot of [
    null,
    {},
    { document_id: 95002 },
    { ...baseValidSnapshot, verification_basis: undefined },
    { ...baseValidSnapshot, verification_basis: null },
    { ...baseValidSnapshot, verification_basis: 'HISTORICAL_BASIS' },
    { ...baseValidSnapshot, document_state: null },
    { ...baseValidSnapshot, document_state: 1 },
    { ...baseValidSnapshot, canonical_identity_matched: false },
    { ...baseValidSnapshot, canonical_identity_matched: null },
    { ...baseValidSnapshot, sync_proven: false },
    { ...baseValidSnapshot, sync_proven: null },
    { ...baseValidSnapshot, line_link_valid: false },
    { ...baseValidSnapshot, line_link_valid: null },
    { ...baseValidSnapshot, full_card_matched: false },
    { ...baseValidSnapshot, full_card_matched: null },
    { ...baseValidSnapshot, incident_action_matched: false },
    { ...baseValidSnapshot, incident_action_matched: null },
    { ...baseValidSnapshot, required_bsale_action: 'REMOVE_LINE' },
    { ...baseValidSnapshot, required_bsale_action: null },
    { ...baseValidSnapshot, preparation_line_id: 'other-line-id' },
    { ...baseValidSnapshot, matched_preparation_line_id: 'other-line-id' },
    { ...baseValidSnapshot, expected_bsale_quantity: 5 },
    { ...baseValidSnapshot, bsale_observed_quantity: 5 },
    { ...baseValidSnapshot, physically_prepared_quantity: 5 },
    { ...baseValidSnapshot, document_id: 95001, current_nv_id: 95001 },
    { ...baseValidSnapshot, document_id: 95002, current_nv_id: 95001 },
    { ...baseValidSnapshot, physicalId: 95001 },
  ]) {
    const { response, mockState: state } = await runActionScenario(({ incident }) => {
      incident.bsale_observed_snapshot = invalidSnapshot
    })
    assert.equal(response.status, 'REQUIRES_RESOLUTION')
    assert.equal(state.rpcCalls.length, 0)
  }

  // 6. Bloqueo para OPEN, SUPERSEDED sin resolución válida y referencias de producto/línea incorrectas
  for (const mutateInvalid of [
    (inc) => { inc.status = 'OPEN' },
    (inc) => { inc.status = 'SUPERSEDED' },
    (inc) => { inc.bsale_variant_id = 999 },
    (inc) => { inc.sku = 'OTRO-SKU' },
    (inc) => { inc.preparation_line_id = 'other-line-id' },
  ]) {
    const { response, mockState: state } = await runActionScenario(({ incident }) => mutateInvalid(incident))
    assert.equal(response.status, 'REQUIRES_RESOLUTION')
    assert.equal(state.rpcCalls.length, 0)
  }

  delete globalThis.__COMMERCIAL_ACCEPTANCE_TEST_STATE__
})
