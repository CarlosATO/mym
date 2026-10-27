'use client'

import { useMemo, useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { SalesOrderCard } from './sales-order-card'
import { SalesOrderDrawer } from './sales-order-drawer'
import type { SalesOrderPreparationCardInfo, SalesOrderPreparationItem, SalesOrderPreparationLine } from '@/app/actions/logistica/sales-order-preparation'
import type { PreparationCommercialAlert } from '@/app/actions/logistica/sales-order-preparation-commercial'

type PreviewStatus = 'CHANGED' | 'UNCHANGED' | 'UNAVAILABLE' | 'INCOMPLETE' | 'AMBIGUOUS'

const PREVIEW_CARD_ID = '00000000-0000-4000-8000-000000005129'

const previewCard: SalesOrderPreparationCardInfo = {
  card_id: PREVIEW_CARD_ID,
  company_id: '00000000-0000-4000-8000-000000000001',
  status: 'IN_PREPARATION',
  priority: 1,
  assigned_user_id: 'preview-user',
  assigned_user_name: 'Vista de desarrollo',
  locked_by_user_id: 'preview-lock',
  locked_by_user_name: 'Vista de desarrollo',
  locked_at: '2026-10-27T00:00:00.000Z',
  route_date: '2026-10-28',
  normalized_city: 'Santiago',
  nv_bsale_id: 92706,
  nv_folio: '5129',
  nv_emission_date: '2026-10-26',
  nv_generation_date: '2026-10-26T22:08:31.000Z',
  client_name: 'CAYLO SPA · PREVIEW LOCAL',
  city_raw: 'Santiago',
  municipality_raw: 'Santiago',
  address_raw: 'Dirección de prueba local',
  seller_bsale_id: null,
  seller_name: 'Fixture Bsale',
  total_quantity: 39,
  total_amount: 237162,
  net_amount: 199296,
  tax_amount: 37866,
  gross_amount: 237162,
  invoice_folio: null,
  is_invoiced: false,
  created_at: '2026-10-26T22:08:31.000Z',
  updated_at: '2026-10-27T00:00:00.000Z',
}

const previewLines: SalesOrderPreparationLine[] = [
  ['558025', 'BELCANDO FINEST CROC 12,5 KG', 1, 335876, 6207],
  ['557025', 'BELCANDO PUPPY GRAVY 12,5 KG', 1, 335877, 6209],
  ['754115', 'LEONARDO ADULT GF SENIOR 1,8 KG', 2, 335878, 6579],
  ['756266', 'LEONARDO LATAS QUALITY SELECTION PATO 400 GR', 12, 335879, 6257],
  ['1020', 'DIP DOG CARNE 60GR', 20, 335880, 6199],
  ['MP1', 'MATERIAL PUBLICITARIO', 1, 335881, 7139],
  ['MGMYM', 'SURTIDOS MATERIAL GRAFICO', 1, 335882, 6594],
  ['556515', 'BELCANDO FINEST GF SALMON 4 KG', 1, 335883, 6213],
].map(([sku, product_name, quantity, detail_id, variant_id], index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  company_id: previewCard.company_id,
  card_id: previewCard.card_id,
  bsale_nv_id: previewCard.nv_bsale_id,
  bsale_detail_id: Number(detail_id),
  bsale_variant_id: Number(variant_id),
  sku: String(sku),
  product_name: String(product_name),
  requested_quantity: Number(quantity),
  prepared_quantity: null,
  line_status: 'PENDING',
  excluded_from_dispatch: false,
  confirmed_by: null,
  confirmed_at: null,
  source_snapshot: null,
  created_at: previewCard.created_at,
  updated_at: previewCard.updated_at,
}))

const previewLineGrossAmounts = [61601, 61600, 43400, 41160, 0, 0, 1, 29400]

const previewItems: SalesOrderPreparationItem[] = previewLines.map((line, index) => ({
  detail_id: line.bsale_detail_id,
  company_id: line.company_id,
  nv_bsale_id: line.bsale_nv_id,
  nv_folio: Number(previewCard.nv_folio),
  variant_id: line.bsale_variant_id,
  sku: line.sku,
  product_name: line.product_name,
  quantity: line.requested_quantity,
  unit_value: null,
  total_amount: null,
  unit_net_value: null,
  line_net_amount: null,
  line_tax_amount: null,
  line_gross_amount: previewLineGrossAmounts[index],
}))

const changedAlert: PreparationCommercialAlert = {
  status: 'CHANGED',
  detail: 'Se detectaron modificaciones comerciales.',
  verifiedAt: '2026-10-27T15:00:54.809Z',
  verificationSource: 'LIVE_BSALE',
  differences: [
    {
      kind: 'REMOVED',
      previous: { variantId: 6594, sku: 'MGMYM', productName: 'SURTIDOS MATERIAL GRAFICO', quantity: 1 },
      current: null,
      quantityDelta: null,
      changedFields: [],
    },
    {
      kind: 'ADDED',
      previous: null,
      current: { variantId: 5729, sku: 'MUESTRA', productName: 'MUESTRA', quantity: 1 },
      quantityDelta: null,
      changedFields: [],
    },
    {
      kind: 'ADDED',
      previous: null,
      current: { variantId: 3184, sku: 'PW12401', productName: 'PW12401', quantity: 1 },
      quantityDelta: null,
      changedFields: [],
    },
  ],
  totalDelta: 16893,
}

function buildAlert(status: PreviewStatus): PreparationCommercialAlert {
  if (status === 'CHANGED') return changedAlert
  if (status === 'UNCHANGED') return { ...changedAlert, status, detail: 'La versión vigente es comercialmente equivalente.', differences: [], totalDelta: 0 }
  const detail = status === 'UNAVAILABLE'
    ? 'No se pudo verificar Bsale.'
    : status === 'INCOMPLETE'
      ? 'La información comercial está incompleta.'
      : 'La identidad o comparación comercial no pudo resolverse.'
  return { ...changedAlert, status, detail, differences: [], totalDelta: null, verificationSource: 'NONE', verifiedAt: null }
}

export function PreparationCommercialPreview() {
  const [status, setStatus] = useState<PreviewStatus>('CHANGED')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const alert = useMemo(() => buildAlert(status), [status])

  return (
    <main className="min-h-screen bg-[#EFE9E1] p-4 text-[#322D29] sm:p-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="rounded-xl border border-[#D1C7BD] bg-white p-5 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#72383D]">PetGroup / MYM · Preview local</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Alerta comercial Bsale</h1>
              <p className="mt-1 max-w-2xl text-sm text-[#6B625C]">Simulación visual de la NV #5129. No consulta Bsale, no escribe Supabase y no altera ninguna tarjeta operativa.</p>
            </div>
            <label className="flex items-center gap-2 text-xs font-bold">
              Estado simulado
              <select value={status} onChange={event => setStatus(event.target.value as PreviewStatus)} className="rounded-md border border-[#D1C7BD] bg-white px-2 py-1.5 font-semibold">
                {(['CHANGED', 'UNCHANGED', 'UNAVAILABLE', 'INCOMPLETE', 'AMBIGUOUS'] as PreviewStatus[]).map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>
        </header>

        <section className="rounded-xl border border-[#D1C7BD] bg-[#F8F5F1] p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wider text-[#6B625C]">Kanban · En preparación</h2>
              <p className="mt-1 text-[11px] text-[#6B625C]">La tarjeta usa el componente productivo `SalesOrderCard`.</p>
            </div>
            <span className="rounded-full border border-[#D1C7BD] bg-white px-2 py-1 text-[10px] font-bold">Solo memoria</span>
          </div>
          <DndContext>
            <div className="max-w-[320px]">
              <SalesOrderCard
                card={previewCard}
                commercialAlert={alert}
                currentUserId="preview-viewer"
                dragDisabled
                onOpen={() => setDrawerOpen(true)}
              />
            </div>
          </DndContext>
        </section>

        <p className="text-center text-[11px] text-[#6B625C]">Estado simulado: <strong>{status}</strong> · Cambia el selector para revisar todos los estados visuales.</p>
      </div>

      {drawerOpen && (
        <SalesOrderDrawer
          card={previewCard}
          items={previewItems}
          preparationLines={previewLines}
          onPreparationLinesChange={() => undefined}
          onPreparationLineChange={() => undefined}
          isLoadingPreparationLines={false}
          preparationLinesError={null}
          clientData={{ rut: '76.000.000-0', phone: '+56 9 0000 0000', email: 'preview@local.test' }}
          isLoadingItems={false}
          currentUserId="preview-viewer"
          canClaimPreparation={false}
          canTakeoverPreparation={false}
          onTakePreparation={() => undefined}
          onOwnershipConflict={() => undefined}
          onClose={() => setDrawerOpen(false)}
          onTransition={async () => ({ ok: false, error: 'Preview de solo lectura.' })}
          commercialAlert={alert}
        />
      )}
    </main>
  )
}
