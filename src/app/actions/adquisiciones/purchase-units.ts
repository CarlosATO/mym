'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'
import { fetchAllPages, resolveRealSupplier } from '@/modules/adquisiciones/unidades-compra/catalog-data'
import { loadBsaleBrandSuppliers } from '@/modules/adquisiciones/lib/bsale-brand-suppliers'
import { resolvePurchaseCommercial } from '@/modules/adquisiciones/lib/purchase-commercial-resolver'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const PURCHASE_UNITS = ['UNIDAD', 'BOLSA', 'DISPLAY', 'CAJA', 'PACK', 'SACHET'] as const

export async function getPurchaseCommercialForManualOrder(productId: string, supplierId: string) {
  const authorization = await authorize('adquisiciones.products.view')
  if ('error' in authorization) return { success: false as const, message: authorization.error }
  try {
    return await resolvePurchaseCommercial(db(), authorization.companyId, productId, supplierId)
  } catch {
    return { success: false as const, message: 'No se pudo consultar la configuración comercial.' }
  }
}

function db() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'adquisiciones' }, auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function authorize(permissionCode: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No hay una empresa activa o una sesión válida.' as const }
  const [companyId, { data: allowed, error }] = await Promise.all([
    getActiveCompanyId(user), supabase.rpc('has_permission', { p_permission_code: permissionCode }),
  ])
  if (!companyId) return { error: 'No hay una empresa activa o una sesión válida.' as const }
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
  supplier_status: 'RESOLVED' | 'NO_MAPPING' | 'UNRESOLVED'
  last_purchase_unit_cost: number | null
  purchase_unit: string | null
  purchase_unit_factor: number
  sales_unit: string | null
  sales_unit_factor: number
  can_edit: boolean
}

export async function getPurchaseUnitsCatalog(): Promise<{ data: PurchaseUnitRow[]; error?: string }> {
  const authorization = await authorize('adquisiciones.products.view')
  if ('error' in authorization) return { data: [], error: authorization.error }
  const admin = db()

  let catalog
  try {
    catalog = await Promise.all([
    fetchAllPages((from, to) => admin.from('products')
      .select('id, sku, description, sales_unit, sales_unit_factor, bsale_variant_id, source, bsale_brand_id', { count: 'exact' })
      .eq('company_id', authorization.companyId)
      .eq('is_active', true)
      .order('description')
      .order('sku').order('id').range(from, to)),
    fetchAllPages((from, to) => admin.from('product_supplier_mappings')
      .select('id, product_id, supplier_id, purchase_unit, purchase_unit_factor', { count: 'exact' })
      .eq('company_id', authorization.companyId)
      .eq('is_active', true).order('id').range(from, to)),
    fetchAllPages((from, to) => admin.from('suppliers')
      .select('id, business_name, supplier_kind, parent_supplier_id', { count: 'exact' })
      .or(`company_id.eq.${authorization.companyId},company_id.is.null`)
      .eq('is_active', true).order('id').range(from, to)),
  ])
  } catch (error) {
    const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : ''
    if (message.includes('sales_unit_factor')) return { data: [], error: 'Falta la migración de unidades por venta en la base de datos configurada.' }
    return { data: [], error: 'No se pudo cargar la configuración de unidades de compra.' }
  }

  const [products, mappings, supplierRows] = catalog
  const suppliers = new Map(supplierRows.map(supplier => [supplier.id, supplier]))
  const brandIds = Array.from(new Set(products.filter(product => product.source === 'BSALE' && product.bsale_brand_id != null).map(product => Number(product.bsale_brand_id))))
  const brandPromise = loadBsaleBrandSuppliers(admin, authorization.companyId, brandIds)
    .then(data => ({ data })).catch(() => ({ data: null }))
  const variantIds = Array.from(new Set(products.map(product => product.bsale_variant_id).filter((id): id is number => id !== null)))
  const costs = new Map<number, number>()
  const costBatches = Array.from({ length: Math.ceil(variantIds.length / 500) }, (_, index) => variantIds.slice(index * 500, (index + 1) * 500))
  const costResults = await Promise.all(costBatches.map(ids => admin.schema('integraciones')
      .from('vw_bsale_variant_last_purchase_cost')
      .select('bsale_variant_id, last_purchase_cost')
      .eq('company_id', authorization.companyId)
      .in('bsale_variant_id', ids)))
  const { data: brandSuppliers } = await brandPromise
  if (!brandSuppliers) return { data: [], error: 'No se pudieron resolver los proveedores por marca Bsale.' }
  for (const { data, error } of costResults) {
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
      const realSupplier = product.source === 'BSALE'
        ? product.bsale_brand_id == null ? null : brandSuppliers.get(Number(product.bsale_brand_id)) ?? null
        : resolveRealSupplier(supplier ?? undefined, suppliers)
      rows.push({
        row_id: mapping?.id ?? `product:${product.id}`,
        mapping_id: mapping?.id ?? null,
        product_id: product.id,
        sku: product.sku,
        description: product.description,
        real_supplier_id: realSupplier?.id ?? null,
        real_supplier_name: realSupplier?.business_name ?? (mapping ? 'Proveedor no resoluble' : null),
        supplier_status: !mapping ? 'NO_MAPPING' : realSupplier ? 'RESOLVED' : 'UNRESOLVED',
        last_purchase_unit_cost: product.bsale_variant_id === null ? null : costs.get(product.bsale_variant_id) ?? null,
        purchase_unit: mapping?.purchase_unit ?? null,
        purchase_unit_factor: Number(mapping?.purchase_unit_factor ?? 1),
        sales_unit: product.sales_unit,
        sales_unit_factor: product.sales_unit_factor,
        can_edit: Boolean(mapping),
      })
    }
  }
  return { data: rows }
}

export async function saveUnitConfiguration(input: {
  productIds: string[]; mappingId?: string; purchaseUnit?: string; purchaseFactor?: number; salesFactor?: number
}) {
  const authorization = await authorize('adquisiciones.products.update')
  if ('error' in authorization) return { error: authorization.error }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 500 || input.productIds.some(id => typeof id !== 'string' || !uuid.test(id))) return { error: 'Seleccione entre 1 y 500 productos válidos.' }
  const ids = Array.from(new Set(input.productIds))
  if (input.mappingId && !uuid.test(input.mappingId)) return { error: 'Mapeo inválido.' }
  if (input.purchaseUnit !== undefined && !normalizeUnit(input.purchaseUnit)) return { error: 'Seleccione una presentación de compra válida.' }
  if (input.purchaseFactor !== undefined && normalizeFactor(input.purchaseFactor) === null) return { error: 'Unidades por compra debe ser un entero mayor o igual a 1.' }
  if (input.salesFactor !== undefined && normalizeFactor(input.salesFactor) === null) return { error: 'Unidades por venta debe ser un entero mayor o igual a 1.' }
  if (input.purchaseUnit === undefined && input.purchaseFactor === undefined && input.salesFactor === undefined) return { error: 'No hay cambios para guardar.' }
  const { error } = await db().rpc('save_purchase_unit_configuration', {
    p_company_id: authorization.companyId, p_user_id: authorization.user.id, p_product_ids: ids,
    p_mapping_id: input.mappingId ?? null, p_purchase_unit: input.purchaseUnit === undefined ? null : normalizeUnit(input.purchaseUnit),
    p_purchase_factor: input.purchaseFactor ?? null, p_sales_factor: input.salesFactor ?? null,
  })
  return error ? { error: 'No se pudo guardar la configuración. Verifique los datos y la migración requerida.' } : { success: true, updated: ids.length, purchaseUnit: input.purchaseUnit === undefined ? undefined : normalizeUnit(input.purchaseUnit)!, purchaseFactor: input.purchaseFactor, salesFactor: input.salesFactor }
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
  if (!Array.isArray(input.mappingIds) || input.mappingIds.length === 0 || input.mappingIds.length > 500) return { error: 'Seleccione entre 1 y 500 mapeos.' }
  if (input.mappingIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) return { error: 'Uno o más mapeos son inválidos.' }
  const mappingIds = Array.from(new Set(input.mappingIds.map(id => id.toLowerCase())))
  if (mappingIds.length !== input.mappingIds.length) return { error: 'La selección contiene mapeos duplicados.' }
  if (!purchaseUnit) return { error: 'Seleccione una unidad de compra válida.' }
  if (purchaseUnitFactor === null) return { error: 'El factor debe ser un número entero mayor o igual a 1.' }
  const { data, error } = await db().rpc('update_purchase_units_bulk', {
    p_company_id: authorization.companyId, p_user_id: authorization.user.id,
    p_mapping_ids: mappingIds, p_purchase_unit: purchaseUnit, p_purchase_factor: purchaseUnitFactor,
  })
  if (error || data !== mappingIds.length) return { error: 'No se pudieron guardar todas las presentaciones de compra.' }
  return { success: true, updated: data as number, purchaseUnit, purchaseUnitFactor }
}

export async function updateSalesUnits(input: { productIds: string[]; salesUnit: string }) {
  const authorization = await authorize('adquisiciones.products.update')
  if ('error' in authorization) return { error: authorization.error }
  if (!Array.isArray(input.productIds) || input.productIds.length === 0 || input.productIds.length > 500 ||
      input.productIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    return { error: 'Seleccione entre 1 y 500 productos válidos.' }
  }
  const productIds = Array.from(new Set(input.productIds))
  const normalized = typeof input.salesUnit === 'string' ? input.salesUnit.trim().toUpperCase().replace(/\s+/g, ' ') : ''
  if (!normalized) return { error: 'Seleccione una unidad de venta.' }

  const admin = db()
  const { data: classifiers, error: classifierError } = await admin.from('product_classifiers')
    .select('name').eq('classifier_type', 'SALES_UNIT').eq('normalized_name', normalized)
    .eq('is_active', true).or(`company_id.is.null,company_id.eq.${authorization.companyId}`).limit(1)
  if (classifierError || !classifiers?.length) return { error: 'Seleccione una unidad de venta activa del catálogo.' }
  const salesUnit = classifiers[0].name as string

  const { data: products, error: lookupError } = await admin.from('products')
    .select('id').eq('company_id', authorization.companyId).eq('is_active', true).in('id', productIds)
  if (lookupError || products?.length !== productIds.length) return { error: 'Uno o más productos no pertenecen a la empresa activa o están inactivos.' }
  const { data: updated, error } = await admin.from('products')
    .update({ sales_unit: salesUnit, updated_by: authorization.user.id, updated_at: new Date().toISOString() })
    .eq('company_id', authorization.companyId).eq('is_active', true).in('id', productIds).select('id')
  if (error || updated?.length !== productIds.length) return { error: 'No se pudo confirmar la actualización de todos los productos. Recargue el catálogo.' }
  return { success: true, updated: updated.length, salesUnit }
}
