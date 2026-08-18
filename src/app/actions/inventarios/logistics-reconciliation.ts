'use server'

import crypto from 'crypto'
import { getActiveCompanyId } from '@/app/actions/companies'
import { createInventariosClient } from '@/lib/supabase/inventarios'

export type ReconciliationStatus = 'READY' | 'MISMATCH' | 'BLOCKED' | 'STALE' | 'APPLIED'
export type LogisticsApplicabilityStatus = 'READY' | 'BLOCKED'
export type LogisticsApplicationStatus = 'NOT_APPLIED' | 'APPLIED'

export interface LogisticsReconciliationProduct {
  id: string
  reconciliation_id: string
  bsale_variant_id: number
  bsale_office_id: number
  sku: string
  product_name: string
  physical_quantity: number
  bsale_quantity: number | null
  difference_quantity: number | null
  reconciliation_status: ReconciliationStatus
  logistics_applicability_status: LogisticsApplicabilityStatus
  logistics_application_status: LogisticsApplicationStatus
  logistics_block_reasons: string[]
  source_count: number
  line_count: number
  latest_bsale_sync_run_id: string | null
  bsale_synced_at: string | null
}

export interface LogisticsReconciliationSummary {
  campaign_id: string
  reconciliation_id: string | null
  item_count: number
  ready_count: number
  mismatch_count: number
  blocked_count: number
  stale_count: number
  applied_count: number
  logistics_ready_count: number
  logistics_blocked_count: number
}

export interface LogisticsReconciliationData {
  campaignId: string
  summary: LogisticsReconciliationSummary
  products: LogisticsReconciliationProduct[]
}

export interface LogisticsCampaignDetailLine {
  id: string
  session_id: string
  session_name: string | null
  warehouse_id: string | null
  warehouse_name: string | null
  logistics_location_id: string | null
  logistics_location_code: string | null
  logistics_location_name: string | null
  target_quantity: number
  previous_balance: number | null
  delta: number | null
  application_result: 'APPLIED' | 'NO_OP' | 'FAILED' | null
  adjustment_id: string | null
  adjustment_item_id: string | null
  kardex_movement_id: string | null
  applied_at: string | null
}

export interface LogisticsCampaignDetail {
  item: Record<string, unknown>
  sources: Array<Record<string, unknown>>
  lines: LogisticsCampaignDetailLine[]
}

function numberValue(value: unknown): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value)
}

function mapSummary(campaignId: string, value: unknown): LogisticsReconciliationSummary {
  const data = (value ?? {}) as Record<string, unknown>
  return {
    campaign_id: String(data.campaign_id ?? campaignId),
    reconciliation_id: nullableString(data.reconciliation_id),
    item_count: numberValue(data.item_count),
    ready_count: numberValue(data.ready_count),
    mismatch_count: numberValue(data.mismatch_count),
    blocked_count: numberValue(data.blocked_count),
    stale_count: numberValue(data.stale_count),
    applied_count: numberValue(data.applied_count),
    logistics_ready_count: numberValue(data.logistics_ready_count),
    logistics_blocked_count: numberValue(data.logistics_blocked_count),
  }
}

function mapProduct(row: Record<string, unknown>): LogisticsReconciliationProduct {
  return {
    id: String(row.id),
    reconciliation_id: String(row.reconciliation_id),
    bsale_variant_id: numberValue(row.bsale_variant_id),
    bsale_office_id: numberValue(row.bsale_office_id),
    sku: String(row.sku ?? 'Sin SKU'),
    product_name: String(row.product_name ?? 'Producto sin nombre'),
    physical_quantity: numberValue(row.physical_quantity),
    bsale_quantity: row.bsale_quantity == null ? null : numberValue(row.bsale_quantity),
    difference_quantity: row.difference_quantity == null ? null : numberValue(row.difference_quantity),
    reconciliation_status: String(row.reconciliation_status ?? 'BLOCKED') as ReconciliationStatus,
    logistics_applicability_status: String(row.logistics_applicability_status ?? 'BLOCKED') as LogisticsApplicabilityStatus,
    logistics_application_status: String(row.logistics_application_status ?? 'NOT_APPLIED') as LogisticsApplicationStatus,
    logistics_block_reasons: Array.isArray(row.logistics_block_reasons) ? row.logistics_block_reasons.map(String) : [],
    source_count: numberValue(row.source_count),
    line_count: numberValue(row.line_count),
    latest_bsale_sync_run_id: nullableString(row.latest_bsale_sync_run_id),
    bsale_synced_at: nullableString(row.bsale_synced_at),
  }
}

async function campaignRead(campaignId: string): Promise<{ companyId: string | null; data: LogisticsReconciliationData | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { companyId: null, data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await createInventariosClient()
    const [summaryResult, itemsResult] = await Promise.all([
      db.rpc('get_inventory_campaign_stock_reconciliation_summary', { p_company_id: companyId, p_campaign_id: campaignId }),
      db.rpc('list_inventory_campaign_stock_reconciliation_items', { p_company_id: companyId, p_campaign_id: campaignId }),
    ])
    if (summaryResult.error || itemsResult.error) {
      console.error('campaign reconciliation read error:', summaryResult.error?.message ?? itemsResult.error?.message)
      return { companyId, data: null, error: 'No se pudo cargar la conciliación logística.' }
    }
    return {
      companyId,
      error: null,
      data: {
        campaignId,
        summary: mapSummary(campaignId, summaryResult.data),
        products: ((itemsResult.data ?? []) as Array<Record<string, unknown>>).map(mapProduct),
      },
    }
  } catch (error) {
    console.error('campaign reconciliation read exception:', error)
    return { companyId, data: null, error: 'No se pudo cargar la conciliación logística.' }
  }
}

export async function getActiveCompanyCampaignLogisticsReconciliation(campaignId: string) {
  return campaignRead(campaignId)
}

export async function refreshActiveCompanyCampaignLogisticsReconciliation(campaignId: string) {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { success: false, error: 'No tienes una empresa activa seleccionada.' }
  const db = await createInventariosClient()
  const { error } = await db.rpc('refresh_inventory_campaign_stock_reconciliation', {
    p_company_id: companyId,
    p_campaign_id: campaignId,
  })
  if (error) {
    console.error('refresh campaign reconciliation error:', error.message)
    return { success: false, error: 'No se pudo actualizar la conciliación.' }
  }
  return { success: true }
}

export async function applyActiveCompanyCampaignLogistics(campaignId: string, reconciliationItemIds: string[]) {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { success: false, error: 'No tienes una empresa activa seleccionada.' }
  if (reconciliationItemIds.length === 0) return { success: false, error: 'Selecciona al menos un item READY aplicable.' }
  const db = await createInventariosClient()
  const { data, error } = await db.rpc('apply_inventory_campaign_logistics', {
    p_company_id: companyId,
    p_campaign_id: campaignId,
    p_reconciliation_item_ids: reconciliationItemIds,
    p_idempotency_key: crypto.randomUUID(),
  })
  if (error) {
    console.error('apply campaign logistics error:', error.message)
    return { success: false, error: 'No se pudo ejecutar la aplicación logística.' }
  }
  return { success: true, result: data }
}

export async function getActiveCompanyCampaignLogisticsItemDetail(campaignId: string, itemId: string): Promise<{ data: LogisticsCampaignDetail | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  const db = await createInventariosClient()
  const { data, error } = await db.rpc('get_inventory_campaign_stock_reconciliation_item_detail', {
    p_company_id: companyId,
    p_campaign_id: campaignId,
    p_item_id: itemId,
  })
  if (error) {
    console.error('campaign reconciliation detail error:', error.message)
    return { data: null, error: 'No se pudo cargar el detalle del item.' }
  }
  const payload = (data ?? {}) as Record<string, unknown>
  const lines = (Array.isArray(payload.lines) ? payload.lines : []) as Array<Record<string, unknown>>
  return {
    error: null,
    data: {
      item: (payload.item ?? {}) as Record<string, unknown>,
      sources: (Array.isArray(payload.sources) ? payload.sources : []) as Array<Record<string, unknown>>,
      lines: lines.map(line => ({
        id: String(line.id),
        session_id: String(line.session_id),
        session_name: nullableString(line.session_name),
        warehouse_id: nullableString(line.warehouse_id),
        warehouse_name: nullableString(line.warehouse_name),
        logistics_location_id: nullableString(line.logistics_location_id),
        logistics_location_code: nullableString(line.logistics_location_code),
        logistics_location_name: nullableString(line.logistics_location_name),
        target_quantity: numberValue(line.target_quantity ?? line.physical_quantity),
        previous_balance: line.previous_balance == null ? null : numberValue(line.previous_balance),
        delta: line.delta == null ? null : numberValue(line.delta),
        application_result: line.application_result === 'APPLIED' || line.application_result === 'NO_OP' || line.application_result === 'FAILED' ? line.application_result : null,
        adjustment_id: nullableString(line.adjustment_id),
        adjustment_item_id: nullableString(line.adjustment_item_id),
        kardex_movement_id: nullableString(line.kardex_movement_id),
        applied_at: nullableString(line.applied_at),
      })),
    },
  }
}
