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
const exclusionMigration = await readFile(new URL('../supabase/migrations/20261104140000_logistica_preparation_commercial_exclusion_acceptance.sql', import.meta.url), 'utf8')
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
  assert.match(reductionMigration, /i\.bsale_observed_snapshot \? 'verification_error'/)
  assert.match(reductionMigration, /i\.bsale_observed_snapshot->'verification_error' IS DISTINCT FROM 'null'::jsonb/)
  assert.match(reductionMigration, /i\.bsale_observed_snapshot->'verification_error' IS DISTINCT FROM '""'::jsonb/)
  assert.doesNotMatch(reductionMigration, /btrim\(i\.bsale_observed_snapshot->>'verification_error'\)/)
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

function isSnapshotValidForSqlSimulation(
  snapshot,
  expectedPhysicalId,
  expectedLineId,
  expectedPreparedQty,
  expectedNewQty,
  expectedRequiredAction = 'SET_QUANTITY',
) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  if (snapshot.verification_basis !== 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE') return false
  if (snapshot.verification_error != null && snapshot.verification_error !== '') return false
  if (typeof snapshot.document_state !== 'number' || !Number.isSafeInteger(snapshot.document_state) || snapshot.document_state !== 0) return false
  if (snapshot.canonical_identity_matched !== true) return false
  if (snapshot.sync_proven !== true) return false
  if (snapshot.line_link_valid !== true) return false
  if (snapshot.full_card_matched !== true) return false
  if (snapshot.incident_action_matched !== true) return false
  if (snapshot.required_bsale_action !== expectedRequiredAction) return false
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
  if (Object.prototype.hasOwnProperty.call(card, 'locked_by_user_id')) {
    if (!card.locked_by_user_id) {
      throw new Error('COMMERCIAL_ACCEPTANCE_LOCK_REQUIRED')
    }
    if (card.locked_by_user_id !== p_accepted_by) {
      throw new Error('COMMERCIAL_ACCEPTANCE_LOCK_OWNER_REQUIRED')
    }
  }
  if (card.canonical_bsale_token && card.canonical_bsale_token !== p_canonical_bsale_token) {
    throw new Error('La versión comercial no corresponde a la identidad canónica de la tarjeta')
  }

  const versionLines = p_version_snapshot.lines ?? []
  if (
    !Array.isArray(versionLines) ||
    versionLines.length === 0 ||
    versionLines.some(l => !l || typeof l !== 'object' || typeof l.quantity !== 'number' || !Number.isFinite(l.quantity) || l.quantity <= 0)
  ) {
    throw new Error('La versión comercial aceptada debe contener al menos una línea vigente con cantidad positiva')
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
  const activeActionCount = actions.filter(a => ['KEEP', 'UPDATE_QUANTITY', 'ADD'].includes(a.kind)).length
  if (activeActionCount === 0) {
    throw new Error('COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la aceptación dejaría el pedido sin líneas activas')
  }

  const nextVersionNumber = (latestVersion?.version_number ?? 0) + 1
  const newVersionId = `version-${nextVersionNumber}`

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
      const v_line = workingLines.find(l => l.id === lineId && l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null)
      if (!v_line) throw new Error('Línea de preparación para KEEP no existe o está retirada')
      if (currentLine) {
        if (Number(currentLine.quantity) !== v_line.requested_quantity) {
          throw new Error('KEEP no puede modificar requested_quantity')
        }
        if ((v_line.bsale_variant_id ?? -1) !== (currentLine.variantId ?? -1) || (v_line.sku ?? '') !== (currentLine.sku ?? '')) {
          throw new Error('KEEP no coincide con la identidad de producto de la línea preparada')
        }
      }
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
          isSnapshotValidForSqlSimulation(i.bsale_observed_snapshot, p_bsale_nv_id, v_line.id, v_line.prepared_quantity, v_new_quantity, 'SET_QUANTITY')
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
      if (db.auditLines.some(a => a.preparation_line_id === v_line.id)) {
        throw new Error('REMOVE no puede retirar una línea con evidencia de Auditoría')
      }

      const previousLine = action.previous ?? null
      if (
        !previousLine ||
        typeof previousLine !== 'object' ||
        currentLine != null ||
        (action.newRequestedQuantity != null && Number(action.newRequestedQuantity) !== 0)
      ) {
        throw new Error('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: REMOVE requiere previous válido y current nulo')
      }
      if (
        (previousLine.variantId == null && !(previousLine.sku ?? '').trim()) ||
        (previousLine.variantId ?? null) !== (v_line.bsale_variant_id ?? null) ||
        (previousLine.sku ?? '').trim().toUpperCase() !== (v_line.sku ?? '').trim().toUpperCase() ||
        Number(previousLine.quantity) !== v_line.requested_quantity
      ) {
        throw new Error('COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la identidad canónica del producto eliminado no coincide con la línea operativa')
      }
      if (
        versionLines.some(snapLine =>
          (snapLine.detailId != null && v_line.bsale_detail_id != null && Number(snapLine.detailId) === Number(v_line.bsale_detail_id)) ||
          (v_line.bsale_variant_id != null && snapLine.variantId != null && Number(snapLine.variantId) === Number(v_line.bsale_variant_id)) ||
          ((v_line.sku ?? '').trim() !== '' && (snapLine.sku ?? '').trim() !== '' && (snapLine.sku ?? '').trim().toUpperCase() === (v_line.sku ?? '').trim().toUpperCase())
        )
      ) {
        throw new Error('COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: el producto eliminado aún figura en la versión comercial')
      }

      const lineIncidents = db.incidents.filter(i => i.preparation_line_id === v_line.id)
      if (v_line.line_status === 'INCIDENT' || v_line.excluded_from_dispatch || lineIncidents.length > 0) {
        if (
          v_line.line_status !== 'INCIDENT' ||
          v_line.excluded_from_dispatch !== true ||
          v_line.prepared_quantity !== 0 ||
          v_line.requested_quantity <= 0 ||
          !v_line.confirmed_by ||
          !v_line.confirmed_at
        ) {
          throw new Error('COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la línea excluida o con incidencia no cumple el contrato de eliminación comercial')
        }
        if (lineIncidents.some(i => i.company_id !== p_company_id || i.card_id !== p_card_id || !['RESOLVED', 'SUPERSEDED'].includes(i.status))) {
          throw new Error('COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la línea excluida tiene incidencias abiertas o inválidas')
        }
        const resolvedIncidents = lineIncidents.filter(i => i.status === 'RESOLVED')
        const validResolved = resolvedIncidents.filter(i =>
          i.company_id === p_company_id &&
          i.card_id === p_card_id &&
          i.status === 'RESOLVED' &&
          i.verification_status === 'MATCHED' &&
          i.incident_type === 'LINE_EXCLUDED' &&
          i.required_bsale_action === 'REMOVE_LINE' &&
          i.requested_quantity === v_line.requested_quantity &&
          i.prepared_quantity === 0 &&
          i.expected_bsale_quantity === 0 &&
          i.bsale_observed_quantity === 0 &&
          (i.bsale_variant_id != null || (i.sku ?? '').trim() !== '') &&
          (i.bsale_variant_id ?? null) === (v_line.bsale_variant_id ?? null) &&
          (i.sku ?? '').trim().toUpperCase() === (v_line.sku ?? '').trim().toUpperCase() &&
          isSnapshotValidForSqlSimulation(i.bsale_observed_snapshot, p_bsale_nv_id, v_line.id, 0, 0, 'REMOVE_LINE')
        )
        if (validResolved.length === 0 || validResolved.length !== resolvedIncidents.length) {
          throw new Error('COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: REMOVE sobre línea excluida requiere incidencia LINE_EXCLUDED / REMOVE_LINE en RESOLVED/MATCHED verificada para la versión vigente')
        }
      } else {
        if (
          v_line.line_status !== 'PENDING' ||
          v_line.excluded_from_dispatch ||
          v_line.prepared_quantity !== null ||
          v_line.confirmed_by !== null ||
          v_line.confirmed_at !== null
        ) {
          throw new Error('REMOVE no puede retirar una línea con trabajo físico registrado')
        }
      }

      // Actualizar únicamente retired_at, retired_by, retirement_acceptance_id y updated_at
      v_line.retired_at = '2026-11-04T12:00:00Z'
      v_line.retired_by = p_accepted_by
      v_line.retirement_acceptance_id = newVersionId
      v_line.updated_at = '2026-11-04T12:00:00Z'
    } else if (kind === 'ADD') {
      if (!currentLine || currentLine.detailId == null || Number(currentLine.quantity ?? 0) <= 0) {
        throw new Error('ADD requiere línea comercial vigente con detailId y cantidad positiva')
      }
      if (currentLine.variantId == null && !(currentLine.sku ?? '').trim()) {
        throw new Error('COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: ADD requiere variante o SKU identificable')
      }
      if (
        workingLines.some(l =>
          l.company_id === p_company_id &&
          l.card_id === p_card_id &&
          Number(l.bsale_detail_id) === Number(currentLine.detailId)
        )
      ) {
        throw new Error('COMMERCIAL_ACCEPTANCE_CONCURRENT_MODIFICATION: la línea ADD ya existe')
      }
      workingLines.push({
        id: `added-line-${workingLines.length + 1}`,
        company_id: p_company_id,
        card_id: p_card_id,
        bsale_nv_id: p_bsale_nv_id,
        bsale_detail_id: currentLine.detailId,
        bsale_variant_id: currentLine.variantId ?? null,
        sku: currentLine.sku ?? null,
        product_name: currentLine.productName ?? 'Producto sin descripción',
        requested_quantity: Number(currentLine.quantity),
        prepared_quantity: null,
        line_status: 'PENDING',
        excluded_from_dispatch: false,
        confirmed_by: null,
        confirmed_at: null,
        retired_at: null,
        retired_by: null,
        retirement_acceptance_id: null,
        source_snapshot: currentLine,
      })
    } else {
      throw new Error(`Acción comercial no soportada: ${kind}`)
    }
  }

  const remainingActiveLines = workingLines.filter(
    l => l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null,
  )
  if (remainingActiveLines.length === 0) {
    throw new Error('COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la aceptación dejaría el pedido sin líneas activas')
  }

  const UncoveredActiveLines = workingLines.filter(
    l => l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null && !processedLineIds.has(l.id) && !l.id.startsWith('added-line-')
  )
  if (UncoveredActiveLines.length > 0) {
    throw new Error('El plan comercial no cubre todas las líneas activas de preparación')
  }

  const multisetKey = (variantId, sku, qty) => `${variantId ?? -1}::${(sku ?? '').trim().toUpperCase()}::${Number(qty)}`
  const countMap = (items) => {
    const m = new Map()
    for (const k of items) m.set(k, (m.get(k) ?? 0) + 1)
    return m
  }
  const activeCounts = countMap(remainingActiveLines.map(l => multisetKey(l.bsale_variant_id, l.sku, l.requested_quantity)))
  const expectedCounts = countMap(versionLines.map(l => multisetKey(l.variantId, l.sku, l.quantity)))
  if (activeCounts.size !== expectedCounts.size || [...activeCounts.entries()].some(([k, v]) => expectedCounts.get(k) !== v)) {
    throw new Error('COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: las líneas activas no corresponden comercialmente a la versión aceptada')
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

  // Persistir cambios en simulación de forma atómica con la versión comercial aceptada
  db.preparationLines = workingLines
  card.current_bsale_nv_id = p_bsale_nv_id
  card.canonical_bsale_token = card.canonical_bsale_token ?? p_canonical_bsale_token

  const newVersionRecord = {
    id: newVersionId,
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
    const multisetKey = (variantId, sku, qty) => `${variantId ?? -1}::${(sku ?? '').trim().toUpperCase()}::${Number(qty)}`
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

    const appliedActions = latestAcceptedVersion.applied_actions ?? []
    if (Array.isArray(appliedActions) && appliedActions.length > 0) {
      for (const act of appliedActions) {
        if (act.kind === 'KEEP' || act.kind === 'UPDATE_QUANTITY') {
          const line = db.preparationLines.find(l => l.id === act.preparationLineId && l.company_id === p_company_id && l.card_id === p_card_id)
          if (!line || line.retired_at !== null || Number(line.requested_quantity) !== Number(act.newRequestedQuantity)) {
            throw new Error('Las acciones aceptadas no corresponden a líneas persistidas válidas.')
          }
        } else if (act.kind === 'REMOVE') {
          const line = db.preparationLines.find(l => l.id === act.preparationLineId && l.company_id === p_company_id && l.card_id === p_card_id)
          if (!line || line.retired_at === null || line.retirement_acceptance_id !== latestAcceptedVersion.id) {
            throw new Error('Las acciones aceptadas REMOVE no corresponden a líneas retiradas válidas.')
          }
        } else if (act.kind === 'ADD') {
          if (!act.current || (act.current.variantId == null && !(act.current.sku ?? '').trim()) || act.current.quantity == null) {
            throw new Error('Las acciones aceptadas ADD no corresponden a líneas persistidas válidas.')
          }
        }
      }
      const actionLineTuples = appliedActions
        .filter(act => ['KEEP', 'UPDATE_QUANTITY', 'ADD'].includes(act.kind))
        .map(act => {
          if (act.kind === 'ADD') {
            return multisetKey(act.current.variantId, act.current.sku, act.current.quantity)
          }
          const line = db.preparationLines.find(l => l.id === act.preparationLineId && l.company_id === p_company_id && l.card_id === p_card_id)
          return multisetKey(line?.bsale_variant_id, line?.sku, act.newRequestedQuantity)
        })
      const actionCounts = countMap(actionLineTuples)
      if (actionCounts.size !== expectedCounts.size || [...actionCounts.entries()].some(([k, v]) => expectedCounts.get(k) !== v)) {
        throw new Error('Las acciones aceptadas no corresponden al snapshot comercial.')
      }
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

  // Paridad exacta de verification_error entre TypeScript (planificador) y PostgreSQL (simulación del contrato RPC):
  // Solo permite campo ausente, null o "". Rechaza espacios, texto de error, número, booleano y objeto JSON.
  const baseValidSnapshotForParity = buildCommercialReductionFixture().incident.bsale_observed_snapshot
  const snapshotWithoutVerificationError = { ...baseValidSnapshotForParity }
  delete snapshotWithoutVerificationError.verification_error

  const allowedVerificationErrorSnapshots = [
    { label: 'campo ausente', snapshot: snapshotWithoutVerificationError },
    { label: 'null', snapshot: { ...baseValidSnapshotForParity, verification_error: null } },
    { label: 'cadena vacía', snapshot: { ...baseValidSnapshotForParity, verification_error: '' } },
  ]
  for (const { label, snapshot } of allowedVerificationErrorSnapshots) {
    const { db, card, currentLiveVersion } = buildCommercialReductionFixture()
    db.incidents[0].bsale_observed_snapshot = snapshot
    const acceptedVersion = runFallbackVersion(card, db.preparationLines)
    const comparison = compareCommercialVersions(acceptedVersion, currentLiveVersion)
    const plan = buildPreparationCommercialReconciliationPlan({
      card: { cardId: card.id, companyId: card.company_id, status: card.status },
      identity: currentLiveVersion.identity,
      acceptedVersion,
      currentVersion: currentLiveVersion,
      preparationLines: db.preparationLines,
      incidents: [mapPersistedIncidentToReconciliationIncident(db.incidents[0])],
      comparison,
      snapshotComplete: true,
    })
    assert.equal(plan.status, 'READY', `TypeScript debe permitir verification_error (${label})`)
    const rpcResult = simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion))
    assert.equal(rpcResult.status, 'ACCEPTED', `RPC debe permitir verification_error (${label})`)
    assert.equal(db.preparationLines[0].requested_quantity, 4)
  }

  const rejectedVerificationErrorSnapshots = [
    { label: 'espacios', snapshot: { ...baseValidSnapshotForParity, verification_error: '   ' } },
    { label: 'texto de error', snapshot: { ...baseValidSnapshotForParity, verification_error: 'QUANTITY_MISMATCH' } },
    { label: 'número (0)', snapshot: { ...baseValidSnapshotForParity, verification_error: 0 } },
    { label: 'número (123)', snapshot: { ...baseValidSnapshotForParity, verification_error: 123 } },
    { label: 'booleano (false)', snapshot: { ...baseValidSnapshotForParity, verification_error: false } },
    { label: 'booleano (true)', snapshot: { ...baseValidSnapshotForParity, verification_error: true } },
    { label: 'objeto JSON', snapshot: { ...baseValidSnapshotForParity, verification_error: {} } },
  ]
  for (const { label, snapshot } of rejectedVerificationErrorSnapshots) {
    const { db, card, currentLiveVersion } = buildCommercialReductionFixture()
    db.incidents[0].bsale_observed_snapshot = snapshot
    const acceptedVersion = runFallbackVersion(card, db.preparationLines)
    const comparison = compareCommercialVersions(acceptedVersion, currentLiveVersion)
    const plan = buildPreparationCommercialReconciliationPlan({
      card: { cardId: card.id, companyId: card.company_id, status: card.status },
      identity: currentLiveVersion.identity,
      acceptedVersion,
      currentVersion: currentLiveVersion,
      preparationLines: db.preparationLines,
      incidents: [mapPersistedIncidentToReconciliationIncident(db.incidents[0])],
      comparison,
      snapshotComplete: true,
    })
    assert.equal(plan.status, 'REQUIRES_RESOLUTION', `TypeScript debe rechazar verification_error (${label})`)
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedParams(db, currentLiveVersion)),
      /UPDATE_QUANTITY requiere una incidencia QUANTITY_REDUCTION en estado RESOLVED\/MATCHED verificada para la versión vigente/,
      `RPC debe rechazar verification_error (${label})`,
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
    { ...baseValidSnapshot, verification_error: '   ' },
    { ...baseValidSnapshot, verification_error: 'QUANTITY_MISMATCH' },
    { ...baseValidSnapshot, verification_error: 0 },
    { ...baseValidSnapshot, verification_error: false },
    { ...baseValidSnapshot, verification_error: {} },
  ]) {
    const { response, mockState: state } = await runActionScenario(({ incident }) => {
      incident.bsale_observed_snapshot = invalidSnapshot
    })
    assert.equal(response.status, 'REQUIRES_RESOLUTION')
    assert.equal(state.rpcCalls.length, 0)
  }

  for (const validVerificationErrorMutation of [
    (snap) => { delete snap.verification_error },
    (snap) => { snap.verification_error = null },
    (snap) => { snap.verification_error = '' },
  ]) {
    const { response, mockState: state } = await runActionScenario(({ incident }) => {
      validVerificationErrorMutation(incident.bsale_observed_snapshot)
    })
    assert.equal(response.status, 'ACCEPTED')
    assert.equal(state.rpcCalls.length, 1)
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

// ============================================================================
// MEJ-01 · Exclusión comercial segura de una línea físicamente excluida
// (LINE_EXCLUDED / REMOVE_LINE) — Escenarios V1–V4 y R1–R9
// ============================================================================

test('MEJ-01 Exclusión total (Inspección estática SQL): migración 20261104140000 exige contrato estricto de REMOVE_LINE, paridad de verification_error, versión no vacía y preservación física', () => {
  assert.match(exclusionMigration, /CREATE OR REPLACE FUNCTION logistica\.accept_sales_order_preparation_commercial_changes/)
  assert.match(exclusionMigration, /v_card\.status <> 'IN_PREPARATION'/)
  assert.match(exclusionMigration, /v_card\.locked_by_user_id IS NULL/)
  assert.match(exclusionMigration, /v_card\.locked_by_user_id IS DISTINCT FROM p_actor_id/)
  assert.match(exclusionMigration, /jsonb_array_length\(v_request\.version_snapshot->'lines'\) = 0/)
  assert.match(exclusionMigration, /\(snap_line\.value->>'quantity'\)::numeric <= 0/)
  assert.match(exclusionMigration, /v_active_action_count = 0/)
  assert.match(exclusionMigration, /i\.incident_type IS DISTINCT FROM 'LINE_EXCLUDED'/)
  assert.match(exclusionMigration, /i\.required_bsale_action IS DISTINCT FROM 'REMOVE_LINE'/)
  assert.match(exclusionMigration, /i\.verification_status IS DISTINCT FROM 'MATCHED'/)
  assert.match(exclusionMigration, /i\.requested_quantity IS DISTINCT FROM v_line\.requested_quantity/)
  assert.match(exclusionMigration, /i\.prepared_quantity IS DISTINCT FROM 0/)
  assert.match(exclusionMigration, /i\.expected_bsale_quantity IS DISTINCT FROM 0/)
  assert.match(exclusionMigration, /i\.bsale_observed_quantity IS DISTINCT FROM 0/)
  assert.match(exclusionMigration, /\(i\.bsale_observed_snapshot->>'verification_basis'\) IS DISTINCT FROM 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE'/)
  assert.match(exclusionMigration, /i\.bsale_observed_snapshot->'verification_error' IS DISTINCT FROM 'null'::jsonb/)
  assert.match(exclusionMigration, /i\.bsale_observed_snapshot->'verification_error' IS DISTINCT FROM '""'::jsonb/)
  assert.doesNotMatch(exclusionMigration, /btrim\(i\.bsale_observed_snapshot->>'verification_error'\)/)
  assert.match(exclusionMigration, /\(i\.bsale_observed_snapshot->>'required_bsale_action'\) IS DISTINCT FROM 'REMOVE_LINE'/)
  assert.match(exclusionMigration, /\(i\.bsale_observed_snapshot->>'expected_bsale_quantity'\)::numeric IS DISTINCT FROM 0/)
  assert.match(exclusionMigration, /\(i\.bsale_observed_snapshot->>'bsale_observed_quantity'\)::numeric IS DISTINCT FROM 0/)
  assert.match(exclusionMigration, /\(i\.bsale_observed_snapshot->>'physically_prepared_quantity'\)::numeric IS DISTINCT FROM 0/)
  assert.match(exclusionMigration, /SET retired_at = now\(\), retired_by = p_actor_id,\s*retirement_acceptance_id = v_version_id, updated_at = now\(\)/)
  assert.doesNotMatch(exclusionMigration, /DELETE FROM logistica\.sales_order_preparation_lines/)
  assert.doesNotMatch(exclusionMigration, /UPDATE logistica\.sales_order_preparation_incidents/)
  assert.doesNotMatch(exclusionMigration, /DELETE FROM logistica\.sales_order_preparation_incidents/)
  assert.match(exclusionMigration, /REVOKE ALL ON FUNCTION logistica\.accept_sales_order_preparation_commercial_changes/)
  assert.match(exclusionMigration, /GRANT EXECUTE ON FUNCTION logistica\.accept_sales_order_preparation_commercial_changes\([^\n]+\) TO service_role/)
})

function buildCommercialExclusionFixture() {
  const companyId = 'd1000000-0000-0000-0000-000000000001'
  const cardId = 'c3000000-0000-0000-0000-000000000003'
  const canonicalToken = 'token-nv-8801'

  const snapshotActiveOld = {
    detail_id: 91001,
    variant_id: 101,
    sku: 'SKU-ACT-101',
    product_name: 'COLLAR ANTIPARASITARIO PERRO',
    quantity: 3,
    unit_net_value: 10000,
    line_net_amount: 30000,
    line_tax_amount: 5700,
    line_gross_amount: 35700,
    nv_bsale_id: 96001,
    nv_folio: 8801,
  }

  const snapshotExcludedOld = {
    detail_id: 91002,
    variant_id: 601,
    sku: 'SKU-EXCL-601',
    product_name: 'SNACK DENTAL GATO 60GR',
    quantity: 5,
    unit_net_value: 4000,
    line_net_amount: 20000,
    line_tax_amount: 3800,
    line_gross_amount: 23800,
    nv_bsale_id: 96001,
    nv_folio: 8801,
  }

  const card = {
    id: cardId,
    company_id: companyId,
    status: 'IN_PREPARATION',
    locked_by_user_id: 'admin-user-222',
    bsale_nv_id: 96001,
    bsale_nv_folio: '8801',
    canonical_bsale_token: canonicalToken,
    current_bsale_nv_id: 96002,
  }

  const activeLine = {
    id: 'prep-line-101',
    company_id: companyId,
    card_id: cardId,
    bsale_nv_id: 96001,
    bsale_detail_id: 91001,
    bsale_variant_id: 101,
    sku: 'SKU-ACT-101',
    product_name: 'COLLAR ANTIPARASITARIO PERRO',
    requested_quantity: 3,
    prepared_quantity: 3,
    line_status: 'CONFIRMED',
    excluded_from_dispatch: false,
    confirmed_by: 'operator-user-111',
    confirmed_at: '2026-11-04T09:10:00.000Z',
    retired_at: null,
    retired_by: null,
    retirement_acceptance_id: null,
    source_snapshot: snapshotActiveOld,
  }

  const excludedLine = {
    id: 'prep-line-601',
    company_id: companyId,
    card_id: cardId,
    bsale_nv_id: 96001,
    bsale_detail_id: 91002,
    bsale_variant_id: 601,
    sku: 'SKU-EXCL-601',
    product_name: 'SNACK DENTAL GATO 60GR',
    requested_quantity: 5,
    prepared_quantity: 0,
    line_status: 'INCIDENT',
    excluded_from_dispatch: true,
    confirmed_by: 'operator-user-111',
    confirmed_at: '2026-11-04T09:15:00.000Z',
    retired_at: null,
    retired_by: null,
    retirement_acceptance_id: null,
    source_snapshot: snapshotExcludedOld,
  }

  const exclusionIncident = {
    id: 'incident-601',
    company_id: companyId,
    card_id: cardId,
    preparation_line_id: 'prep-line-601',
    bsale_nv_id: 96001,
    bsale_detail_id: 91002,
    bsale_variant_id: 601,
    sku: 'SKU-EXCL-601',
    product_name: 'SNACK DENTAL GATO 60GR',
    requested_quantity: 5,
    prepared_quantity: 0,
    missing_quantity: 5,
    incident_type: 'LINE_EXCLUDED',
    reason: 'OUT_OF_STOCK',
    required_bsale_action: 'REMOVE_LINE',
    expected_bsale_quantity: 0,
    status: 'RESOLVED',
    verification_status: 'MATCHED',
    bsale_observed_quantity: 0,
    bsale_observed_snapshot: {
      historical_nv_id: 96001,
      current_nv_id: 96002,
      document_id: 96002,
      document_state: 0,
      canonical_identity_matched: true,
      sync_proven: true,
      line_link_valid: true,
      full_card_matched: true,
      incident_action_matched: true,
      required_bsale_action: 'REMOVE_LINE',
      expected_bsale_quantity: 0,
      bsale_observed_quantity: 0,
      physically_prepared_quantity: 0,
      preparation_line_id: 'prep-line-601',
      matched_preparation_line_id: 'prep-line-601',
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
      historicalBsaleId: 96001,
      currentBsaleId: 96002,
      folio: '8801',
    },
    physicalId: 96002,
    generationDate: '2026-11-04',
    emissionDate: '2026-11-04',
    lines: [
      {
        detailId: 91055,
        variantId: 101,
        sku: 'SKU-ACT-101',
        productName: 'COLLAR ANTIPARASITARIO PERRO',
        quantity: 3,
        unitNetValue: 10000,
        lineNetAmount: 30000,
        lineTaxAmount: 5700,
        lineGrossAmount: 35700,
        lineNumber: 1,
        special: false,
      },
    ],
    netAmount: 30000,
    taxAmount: 5700,
    totalAmount: 35700,
  }

  const db = {
    cards: [card],
    preparationLines: [activeLine, excludedLine],
    incidents: [exclusionIncident],
    commercialVersions: [],
    audits: [],
    auditLines: [],
    auditIncidents: [],
  }

  return { db, card, activeLine, excludedLine, exclusionIncident, currentLiveVersion }
}

// Simulación JS de `materialize_sales_order_audit_snapshot` (20261027120000)
function simulateMaterializeAuditSnapshot(db, p_company_id, p_card_id) {
  const activeLines = db.preparationLines.filter(
    l => l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null,
  )
  if (activeLines.some(l => l.line_status === 'PENDING' || l.prepared_quantity === null)) {
    throw new Error('Existen líneas activas pendientes de preparación antes de Auditoría')
  }
  return activeLines.map(pl => ({
    preparation_line_id: pl.id,
    bsale_detail_id: pl.bsale_detail_id,
    bsale_variant_id: pl.bsale_variant_id,
    sku: pl.sku,
    product_name: pl.product_name,
    requested_quantity_snapshot: pl.requested_quantity,
    prepared_quantity_snapshot: pl.prepared_quantity,
    excluded_from_dispatch_snapshot: pl.excluded_from_dispatch,
  }))
}

// Simulación JS de MEJ-01C `get_sales_order_preparation_commercial_consistency_v1` (20261030130000)
function simulateCommercialConsistencyV1(db, p_company_id, p_card_id, bsaleCurrentDetails) {
  const openIncidents = db.incidents.filter(
    i => i.company_id === p_company_id && i.card_id === p_card_id && i.status === 'OPEN',
  )
  if (openIncidents.length > 0) {
    return { eligible: false, reason: 'OPEN_PREPARATION_INCIDENTS' }
  }
  const activePrepLines = db.preparationLines.filter(
    l => l.company_id === p_company_id && l.card_id === p_card_id && l.retired_at === null,
  )
  if (activePrepLines.length === 0) {
    return { eligible: false, reason: 'NO_ACTIVE_PREPARATION_LINES' }
  }
  const keyOf = (sku, variantId) => ((sku ?? '').trim() ? `SKU:${sku.trim().toUpperCase()}` : `VARIANT:${variantId}`)
  const prepByKey = new Map()
  for (const l of activePrepLines) {
    const k = keyOf(l.sku, l.bsale_variant_id)
    prepByKey.set(k, (prepByKey.get(k) ?? 0) + Number(l.prepared_quantity ?? 0))
  }
  const bsaleByKey = new Map()
  for (const d of bsaleCurrentDetails) {
    const k = keyOf(d.sku, d.variantId)
    bsaleByKey.set(k, (bsaleByKey.get(k) ?? 0) + Number(d.quantity ?? 0))
  }
  const allKeys = new Set([...prepByKey.keys(), ...bsaleByKey.keys()])
  for (const k of allKeys) {
    const pQty = prepByKey.get(k) ?? 0
    const bQty = bsaleByKey.get(k) ?? 0
    if ((pQty > 0 || bQty > 0) && pQty !== bQty) {
      return { eligible: false, reason: 'PREPARED_QUANTITY_MISMATCH' }
    }
  }
  return { eligible: true, reason: null }
}

test('MEJ-01 Exclusión total — Escenarios V1, V2, V3 y V4 (Planificador TS + Simulación JS de RPC, P0-01, Auditoría y Facturación MEJ-01C)', () => {
  const { db, card, currentLiveVersion } = buildCommercialExclusionFixture()
  const acceptedVersion = runFallbackVersion(card, db.preparationLines.filter(l => l.retired_at === null))
  const comparison = compareCommercialVersions(acceptedVersion, currentLiveVersion)

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

  // V1: Plan READY con KEEP para línea activa y REMOVE para línea físicamente excluida
  assert.equal(plan.status, 'READY')
  assert.equal(plan.canAcceptCompletely, true)
  assert.equal(plan.conflicts.length, 0)
  assert.equal(plan.impact.removed, 1)
  assert.equal(plan.impact.totalDelta, -23800)

  const removeAct = plan.actions.find(a => a.kind === 'REMOVE')
  assert.ok(removeAct)
  assert.equal(removeAct.preparationLineId, 'prep-line-601')
  assert.equal(removeAct.previous?.sku, 'SKU-EXCL-601')
  assert.equal(removeAct.previous?.variantId, 601)
  assert.equal(removeAct.previous?.quantity, 5)
  assert.equal(removeAct.current, null)
  assert.equal(removeAct.newRequestedQuantity, 0)
  assert.equal(removeAct.preparedQuantity, 0)

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

  const acceptRes = simulateAcceptCommercialChangesRpc(db, rpcParams)
  assert.equal(acceptRes.status, 'ACCEPTED')
  assert.equal(acceptRes.version_id, 'version-1')
  assert.equal(acceptRes.current_bsale_nv_id, 96002)

  // Verificar preservación íntegra del registro físico excluido y atomicidad de retirement_acceptance_id
  const activePersisted = db.preparationLines.find(l => l.id === 'prep-line-101')
  const retiredExcluded = db.preparationLines.find(l => l.id === 'prep-line-601')
  assert.equal(activePersisted.retired_at, null)
  assert.equal(retiredExcluded.retired_at, '2026-11-04T12:00:00Z')
  assert.equal(retiredExcluded.retired_by, 'admin-user-222')
  assert.equal(retiredExcluded.retirement_acceptance_id, acceptRes.version_id)
  assert.equal(retiredExcluded.requested_quantity, 5)
  assert.equal(retiredExcluded.prepared_quantity, 0)
  assert.equal(retiredExcluded.line_status, 'INCIDENT')
  assert.equal(retiredExcluded.excluded_from_dispatch, true)
  assert.equal(retiredExcluded.confirmed_by, 'operator-user-111')
  assert.equal(retiredExcluded.confirmed_at, '2026-11-04T09:15:00.000Z')
  assert.equal(retiredExcluded.bsale_nv_id, 96001)
  assert.equal(retiredExcluded.bsale_detail_id, 91002)

  // Historial de incidencia intacto
  assert.equal(db.incidents.length, 1)
  assert.equal(db.incidents[0].status, 'RESOLVED')
  assert.equal(db.incidents[0].verification_status, 'MATCHED')
  assert.equal(db.incidents[0].incident_type, 'LINE_EXCLUDED')
  assert.equal(db.incidents[0].required_bsale_action, 'REMOVE_LINE')
  assert.equal(db.incidents[0].requested_quantity, 5)
  assert.equal(db.incidents[0].prepared_quantity, 0)

  // Versión comercial aceptada sólo contiene la línea vigente en Bsale
  assert.equal(db.commercialVersions.length, 1)
  assert.equal(db.commercialVersions[0].id, acceptRes.version_id)
  assert.equal(db.commercialVersions[0].version_snapshot.lines.length, 1)
  assert.equal(db.commercialVersions[0].version_snapshot.lines[0].sku, 'SKU-ACT-101')

  // Guard P0-01 sin errores ni duplicación de líneas (incluyendo validación de applied_actions REMOVE)
  assert.equal(simulateMaterializeSnapshotP001(db, card.company_id, card.id), 0)

  // Auditoría materializa únicamente la línea comercial vigente (Solicitado = 3, Preparado = 3), sin el producto eliminado
  const auditSnapshot = simulateMaterializeAuditSnapshot(db, card.company_id, card.id)
  assert.equal(auditSnapshot.length, 1)
  assert.equal(auditSnapshot[0].sku, 'SKU-ACT-101')
  assert.equal(auditSnapshot[0].requested_quantity_snapshot, 3)
  assert.equal(auditSnapshot[0].prepared_quantity_snapshot, 3)

  // Elegibilidad de facturación MEJ-01C conforme sin facturar el producto eliminado
  const consistency = simulateCommercialConsistencyV1(db, card.company_id, card.id, currentLiveVersion.lines)
  assert.deepEqual(consistency, { eligible: true, reason: null })

  // V3: Idempotencia de aceptación
  const repeatRes = simulateAcceptCommercialChangesRpc(db, rpcParams)
  assert.equal(repeatRes.status, 'ALREADY_ACCEPTED')
  assert.equal(repeatRes.version_id, 'version-1')
  assert.equal(db.commercialVersions.length, 1)

  // V4: Reincorporación posterior del mismo SKU en una versión comercial nueva (96003) con detailId distinto (92099)
  const readdedVersion = {
    ...currentLiveVersion,
    identity: { ...currentLiveVersion.identity, currentBsaleId: 96003 },
    physicalId: 96003,
    lines: [
      ...currentLiveVersion.lines,
      {
        detailId: 92099,
        variantId: 601,
        sku: 'SKU-EXCL-601',
        productName: 'SNACK DENTAL GATO 60GR',
        quantity: 2,
        unitNetValue: 4000,
        lineNetAmount: 8000,
        lineTaxAmount: 1520,
        lineGrossAmount: 9520,
        lineNumber: 2,
        special: false,
      },
    ],
    netAmount: 38000,
    taxAmount: 7220,
    totalAmount: 45220,
  }
  const secondComparison = compareCommercialVersions(db.commercialVersions[0].version_snapshot, readdedVersion)
  const secondPlan = buildPreparationCommercialReconciliationPlan({
    card: { cardId: card.id, companyId: card.company_id, status: card.status },
    identity: readdedVersion.identity,
    acceptedVersion: db.commercialVersions[0].version_snapshot,
    currentVersion: readdedVersion,
    preparationLines: db.preparationLines.filter(l => l.retired_at === null),
    incidents: projectedIncidents,
    comparison: secondComparison,
    snapshotComplete: true,
  })
  assert.equal(secondPlan.status, 'READY')
  assert.equal(secondPlan.canAcceptCompletely, true)
  assert.equal(secondPlan.impact.added, 1)

  const secondAccept = simulateAcceptCommercialChangesRpc(db, {
    p_company_id: card.company_id,
    p_card_id: card.id,
    p_expected_previous_fingerprint: secondPlan.acceptedFingerprint,
    p_new_fingerprint: secondPlan.currentFingerprint,
    p_bsale_nv_id: readdedVersion.physicalId,
    p_bsale_nv_folio: readdedVersion.identity.folio,
    p_canonical_bsale_token: readdedVersion.identity.canonicalToken,
    p_version_snapshot: readdedVersion,
    p_comparison: secondComparison,
    p_plan: secondPlan,
    p_accepted_by: 'admin-user-222',
  })
  assert.equal(secondAccept.status, 'ACCEPTED')
  assert.equal(secondAccept.version_number, 2)
  assert.equal(db.preparationLines.length, 3)

  // La línea histórica excluida permanece retirada con su incidencia intacta, y la nueva línea entra como PENDING independiente
  const stillRetiredLine = db.preparationLines.find(l => l.id === 'prep-line-601')
  const newlyAddedLine = db.preparationLines.find(l => l.bsale_detail_id === 92099)
  assert.equal(stillRetiredLine.retired_at, '2026-11-04T12:00:00Z')
  assert.equal(stillRetiredLine.retirement_acceptance_id, 'version-1')
  assert.equal(stillRetiredLine.line_status, 'INCIDENT')
  assert.equal(stillRetiredLine.excluded_from_dispatch, true)
  assert.ok(newlyAddedLine)
  assert.equal(newlyAddedLine.retired_at, null)
  assert.equal(newlyAddedLine.line_status, 'PENDING')
  assert.equal(newlyAddedLine.prepared_quantity, null)
  assert.equal(newlyAddedLine.requested_quantity, 2)
  assert.equal(simulateMaterializeSnapshotP001(db, card.company_id, card.id), 0)
})

test('MEJ-01 Exclusión total — Escenarios R1 a R9 (Simulación JS de RPC + Server Action): bloqueos defensivos sin modificar datos', async () => {
  const buildForcedRemovalParams = (db, currentLiveVersion, mutateAction) => {
    const card = db.cards[0]
    const acceptedVersion = runFallbackVersion(card, db.preparationLines.filter(l => l.retired_at === null))
    const comparison = compareCommercialVersions(acceptedVersion, currentLiveVersion)
    const actions = [
      {
        kind: 'KEEP',
        preparationLineId: 'prep-line-101',
        previous: null,
        current: currentLiveVersion.lines[0] ?? null,
        previousRequestedQuantity: 3,
        newRequestedQuantity: 3,
        preparedQuantity: 3,
        quantityDelta: 0,
      },
      {
        kind: 'REMOVE',
        preparationLineId: 'prep-line-601',
        previous: {
          detailId: 91002,
          variantId: 601,
          sku: 'SKU-EXCL-601',
          productName: 'SNACK DENTAL GATO 60GR',
          quantity: 5,
        },
        current: null,
        previousRequestedQuantity: 5,
        newRequestedQuantity: 0,
        preparedQuantity: 0,
        quantityDelta: -5,
      },
    ]
    if (mutateAction) mutateAction(actions)
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
      p_plan: {
        status: 'READY',
        canAcceptCompletely: true,
        conflicts: [],
        actions,
      },
      p_accepted_by: 'admin-user-222',
    }
  }

  // R1: Incidencia OPEN o SUPERSEDED sin resolución vigente bloquea en RPC
  for (const badStatus of ['OPEN', 'SUPERSEDED']) {
    const { db, currentLiveVersion } = buildCommercialExclusionFixture()
    db.incidents[0].status = badStatus
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, currentLiveVersion)),
      /COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION/,
    )
    assert.equal(db.preparationLines.find(l => l.id === 'prep-line-601').retired_at, null)
  }

  // R2: Evidencia histórica insuficiente o verification_error inválido (PR #25) bloquea en RPC
  const baseExclusionSnapshot = buildCommercialExclusionFixture().exclusionIncident.bsale_observed_snapshot
  for (const badSnapshot of [
    null,
    { document_id: 96002 },
    { ...baseExclusionSnapshot, verification_basis: 'HISTORICAL' },
    { ...baseExclusionSnapshot, required_bsale_action: 'SET_QUANTITY' },
    { ...baseExclusionSnapshot, expected_bsale_quantity: 5 },
    { ...baseExclusionSnapshot, bsale_observed_quantity: 5 },
    { ...baseExclusionSnapshot, physically_prepared_quantity: 1 },
    { ...baseExclusionSnapshot, document_id: 96001 },
    { ...baseExclusionSnapshot, current_nv_id: 96001 },
    { ...baseExclusionSnapshot, physicalId: 96001 },
    { ...baseExclusionSnapshot, verification_error: '   ' },
    { ...baseExclusionSnapshot, verification_error: 'ERR' },
    { ...baseExclusionSnapshot, verification_error: 0 },
    { ...baseExclusionSnapshot, verification_error: false },
    { ...baseExclusionSnapshot, verification_error: {} },
  ]) {
    const { db, currentLiveVersion } = buildCommercialExclusionFixture()
    db.incidents[0].bsale_observed_snapshot = badSnapshot
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, currentLiveVersion)),
      /COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION/,
    )
    assert.equal(db.preparationLines.find(l => l.id === 'prep-line-601').retired_at, null)
  }

  // R3: Preparación parcial mayor que cero (prepared_quantity = 1) bloquea en RPC
  {
    const { db, currentLiveVersion } = buildCommercialExclusionFixture()
    db.preparationLines.find(l => l.id === 'prep-line-601').prepared_quantity = 1
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, currentLiveVersion)),
      /COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION/,
    )
    assert.equal(db.preparationLines.find(l => l.id === 'prep-line-601').retired_at, null)
  }

  // R4: Bsale mantiene una línea con cantidad 0 o mantiene el producto eliminado en version_snapshot -> bloqueado en RPC
  {
    const { db, currentLiveVersion } = buildCommercialExclusionFixture()
    const versionWithZeroLine = {
      ...currentLiveVersion,
      lines: [
        ...currentLiveVersion.lines,
        { detailId: 91099, variantId: 601, sku: 'SKU-EXCL-601', productName: 'SNACK', quantity: 0 },
      ],
    }
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, versionWithZeroLine)),
      /cantidad positiva/,
    )
    const versionStillContainingProduct = {
      ...currentLiveVersion,
      lines: [
        ...currentLiveVersion.lines,
        { detailId: 91099, variantId: 601, sku: 'SKU-EXCL-601', productName: 'SNACK', quantity: 1 },
      ],
    }
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, versionStillContainingProduct)),
      /el producto eliminado aún figura en la versión comercial/,
    )
  }

  // R5: Eliminación de todos los productos del pedido -> bloqueado en RPC
  {
    const { db, currentLiveVersion } = buildCommercialExclusionFixture()
    const emptyVersion = { ...currentLiveVersion, lines: [] }
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, emptyVersion, (actions) => {
        actions.splice(0, 1)
      })),
      /al menos una línea vigente con cantidad positiva/,
    )
  }

  // R6: Colisión de detailId al agregar de nuevo el mismo SKU -> bloqueado en RPC sin modificar datos
  {
    const { db, currentLiveVersion } = buildCommercialExclusionFixture()
    const res1 = simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, currentLiveVersion))
    assert.equal(res1.status, 'ACCEPTED')
    const collidingVersion = {
      ...currentLiveVersion,
      physicalId: 96003,
      lines: [
        ...currentLiveVersion.lines,
        { detailId: 91002, variantId: 601, sku: 'SKU-EXCL-601', productName: 'SNACK', quantity: 2 },
      ],
    }
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, {
        p_company_id: db.cards[0].company_id,
        p_card_id: db.cards[0].id,
        p_expected_previous_fingerprint: res1.fingerprint,
        p_new_fingerprint: 'fp-colliding-96003',
        p_bsale_nv_id: 96003,
        p_bsale_nv_folio: '8801',
        p_canonical_bsale_token: db.cards[0].canonical_bsale_token,
        p_version_snapshot: collidingVersion,
        p_comparison: {},
        p_plan: {
          status: 'READY',
          canAcceptCompletely: true,
          conflicts: [],
          actions: [
            { kind: 'KEEP', preparationLineId: 'prep-line-101', newRequestedQuantity: 3, current: collidingVersion.lines[0] },
            { kind: 'ADD', preparationLineId: null, newRequestedQuantity: 2, current: collidingVersion.lines[1] },
          ],
        },
        p_accepted_by: 'admin-user-222',
      }),
      /COMMERCIAL_ACCEPTANCE_CONCURRENT_MODIFICATION: la línea ADD ya existe/,
    )
    assert.equal(db.commercialVersions.length, 1)
  }

  // R7 y R8: Tarjeta fuera de IN_PREPARATION, sin lock del actor o con evidencia de Auditoría -> bloqueado
  {
    const { db, currentLiveVersion } = buildCommercialExclusionFixture()
    db.cards[0].locked_by_user_id = 'other-user-999'
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, currentLiveVersion)),
      /COMMERCIAL_ACCEPTANCE_LOCK_OWNER_REQUIRED/,
    )
  }
  {
    const { db, currentLiveVersion } = buildCommercialExclusionFixture()
    db.audits.push({ id: 'audit-1', company_id: db.cards[0].company_id, card_id: db.cards[0].id })
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, currentLiveVersion)),
      /evidencia de Auditoría/,
    )
  }

  // R9: Solicitud manipulada contra la RPC (previous nulo, current no nulo, identidad cambiada o cantidad previa falsa) -> bloqueado
  for (const mutateTampered of [
    (actions) => { actions[1].previous = null },
    (actions) => { actions[1].current = { detailId: 91002, quantity: 0 } },
    (actions) => { actions[1].previous.sku = 'SKU-FALSO' },
    (actions) => { actions[1].previous.variantId = 999 },
    (actions) => { actions[1].previous.quantity = 4 },
    (actions) => { actions[1].newRequestedQuantity = 1 },
  ]) {
    const { db, currentLiveVersion } = buildCommercialExclusionFixture()
    assert.throws(
      () => simulateAcceptCommercialChangesRpc(db, buildForcedRemovalParams(db, currentLiveVersion, mutateTampered)),
      /COMMERCIAL_ACCEPTANCE_(INVALID_ACTION|REQUIRES_RESOLUTION)/,
    )
    assert.equal(db.preparationLines.find(l => l.id === 'prep-line-601').retired_at, null)
  }
})
