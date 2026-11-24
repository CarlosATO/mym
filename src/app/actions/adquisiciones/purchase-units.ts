'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const PURCHASE_UNITS = ['UNIDAD', 'BOLSA', 'DISPLAY', 'CAJA', 'PACK', 'SACHET'] as const

function db() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'adquisiciones' }, auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function authorize(permissionCode: string) {
  const supabase = await createClient()
  const [{ data: { user } }, companyId] = await Promise.all([supabase.auth.getUser(), getActiveCompanyId()])
  if (!user || !companyId) return { error: 'No hay una empresa activa o una sesión válida.' as const }
  const { data: allowed, error } = await supabase.rpc('has_permission', { p_permission_code: permissionCode })
  if (error || allowed !== true) return { error: 'Permisos insuficientes para administrar unidades de compra.' as const }
  return { user, companyId }
}

function normalizeUnit(value: unknown): string | null {
  const unit = String(value ?? '').trim().toUpperCase()
  return PURCHASE_UNITS.includes(unit as typeof PURCHASE_UNITS[number]) ? unit : null
}

function normalizeFactor(value: unknown): number | null {
  const factor = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isInteger(factor) && factor >= 1 ? factor : null
}

export type PurchaseUnitRow = {
  row_id: string
  mapping_id: string | null
  product_id: string
  sku: string
  description: string
  real_supplier_id: string | null
  real_supplier_name: string | null
  last_purchase_unit_cost: number | null
  purchase_unit: string | null
  purchase_unit_factor: number
  sales_unit: string | null
  can_edit: boolean
}

export async function getPurchaseUnitsCatalog(): Promise<{ data: PurchaseUnitRow[]; error?: string }> {
  const authorization = await authorize('adquisiciones.products.view')
  if ('error' in authorization) return { data: [], error: authorization.error }
  const admin = db()

  const [productsResult, mappingsResult, suppliersResult] = await Promise.all([
    admin.from('products')
      .select('id, sku, description, sales_unit, bsale_variant_id')
      .eq('company_id', authorization.companyId)
      .eq('is_active', true)
      .order('description')
      .order('sku'),
    admin.from('product_supplier_mappings')
      .select('id, product_id, supplier_id, purchase_unit, purchase_unit_factor, is_active')
      .eq('company_id', authorization.companyId)
      .eq('is_active', true),
    admin.from('suppliers')
      .select('id, business_name, supplier_kind, parent_supplier_id')
      .or(`company_id.eq.${authorization.companyId},company_id.is.null`)
      .eq('is_active', true),
  ])
  if (productsResult.error || mappingsResult.error || suppliersResult.error) {
    return { data: [], error: 'No se pudo cargar la configuración de unidades de compra.' }
  }

  const products = productsResult.data ?? []
  const mappings = mappingsResult.data ?? []
  const suppliers = new Map((suppliersResult.data ?? []).map(supplier => [supplier.id, supplier]))
  const variantIds = Array.from(new Set(products.map(product => product.bsale_variant_id).filter((id): id is number => id !== null)))
  const costs = new Map<number, number>()
  for (let offset = 0; offset < variantIds.length; offset += 500) {
    const { data, error } = await admin.schema('integraciones')
      .from('vw_bsale_variant_last_purchase_cost')
      .select('bsale_variant_id, last_purchase_cost')
      .eq('company_id', authorization.companyId)
      .in('bsale_variant_id', variantIds.slice(offset, offset + 500))
    if (error) return { data: [], error: 'No se pudo cargar el costo canónico de compras.' }
    for (const row of data ?? []) {
      const variantId = Number(row.bsale_variant_id)
      const cost = Number(row.last_purchase_cost)
      if (Number.isFinite(variantId) && Number.isFinite(cost)) costs.set(variantId, cost)
    }
  }

  const mappingsByProduct = new Map<string, typeof mappings>()
  for (const mapping of mappings) {
    if (!mapping.product_id) continue
    const current = mappingsByProduct.get(mapping.product_id) ?? []
    current.push(mapping)
    mappingsByProduct.set(mapping.product_id, current)
  }
  const rows: PurchaseUnitRow[] = []
  for (const product of products) {
    const productMappings = mappingsByProduct.get(product.id) ?? []
    const sourceMappings = productMappings.length > 0 ? productMappings : [null]
    for (const mapping of sourceMappings) {
      const supplier = mapping ? suppliers.get(mapping.supplier_id) : null
      const realSupplier = supplier?.supplier_kind === 'REAL'
        ? supplier
        : supplier?.parent_supplier_id ? suppliers.get(supplier.parent_supplier_id) : null
      rows.push({
        row_id: mapping?.id ?? `product:${product.id}`,
        mapping_id: mapping?.id ?? null,
        product_id: product.id,
        sku: product.sku,
        description: product.description,
        real_supplier_id: realSupplier?.id ?? null,
        real_supplier_name: realSupplier?.business_name ?? null,
        last_purchase_unit_cost: product.bsale_variant_id === null ? null : costs.get(product.bsale_variant_id) ?? null,
        purchase_unit: mapping?.purchase_unit ?? null,
        purchase_unit_factor: Number(mapping?.purchase_unit_factor ?? 1),
        sales_unit: product.sales_unit,
        can_edit: Boolean(mapping),
      })
    }
  }
  return { data: rows }
}

export async function updatePurchaseUnit(input: { mappingId: string; purchaseUnit: string; purchaseUnitFactor: number }) {
  const authorization = await authorize('adquisiciones.products.update')
  if ('error' in authorization) return { error: authorization.error }
  const purchaseUnit = normalizeUnit(input.purchaseUnit)
  const purchaseUnitFactor = normalizeFactor(input.purchaseUnitFactor)
  if (!purchaseUnit) return { error: 'Seleccione una unidad de compra válida.' }
  if (purchaseUnitFactor === null) return { error: 'El factor debe ser un número entero mayor o igual a 1.' }
  const admin = db()
  const { data: mapping } = await admin.from('product_supplier_mappings')
    .select('id, product_id')
    .eq('id', input.mappingId)
    .eq('company_id', authorization.companyId)
    .eq('is_active', true)
    .maybeSingle()
  if (!mapping) return { error: 'Mapeo de producto-proveedor no encontrado.' }
  const { error } = await admin.from('product_supplier_mappings')
    .update({ purchase_unit: purchaseUnit, purchase_unit_factor: purchaseUnitFactor, updated_at: new Date().toISOString(), updated_by: authorization.user.id })
    .eq('id', mapping.id)
    .eq('company_id', authorization.companyId)
  return error ? { error: 'No se pudo guardar la unidad de compra.' } : { success: true }
}

export async function updatePurchaseUnitsBulk(input: { mappingIds: string[]; purchaseUnit: string; purchaseUnitFactor: number }) {
  const authorization = await authorize('adquisiciones.products.update')
  if ('error' in authorization) return { error: authorization.error }
  const purchaseUnit = normalizeUnit(input.purchaseUnit)
  const purchaseUnitFactor = normalizeFactor(input.purchaseUnitFactor)
  const mappingIds = Array.from(new Set(input.mappingIds.filter(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))).slice(0, 500)
  if (!purchaseUnit) return { error: 'Seleccione una unidad de compra válida.' }
  if (purchaseUnitFactor === null) return { error: 'El factor debe ser un número entero mayor o igual a 1.' }
  if (mappingIds.length === 0) return { error: 'Seleccione al menos un producto con proveedor asociado.' }
  const admin = db()
  const { data: mappings, error: lookupError } = await admin.from('product_supplier_mappings')
    .select('id')
    .eq('company_id', authorization.companyId)
    .eq('is_active', true)
    .in('id', mappingIds)
  if (lookupError || (mappings ?? []).length !== mappingIds.length) return { error: 'Uno o más mapeos no pertenecen a la empresa activa.' }
  const { error } = await admin.from('product_supplier_mappings')
    .update({ purchase_unit: purchaseUnit, purchase_unit_factor: purchaseUnitFactor, updated_at: new Date().toISOString(), updated_by: authorization.user.id })
    .eq('company_id', authorization.companyId)
    .in('id', mappingIds)
  return error ? { error: 'No se pudieron guardar las unidades de compra.' } : { success: true, updated: mappingIds.length }
}
