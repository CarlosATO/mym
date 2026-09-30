'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { KNOWN_COMPANY_IDS } from '@/lib/bsale/company-config'
import { BsaleApiError, bsaleFetchForCompany } from '@/lib/bsale/client'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const INVALID_PRODUCT_TYPE_MESSAGE = 'El tipo de producto Bsale seleccionado no corresponde al proveedor de esta orden.'

type BsaleVariant = {
  id?: number | string
  product?: { id?: number | string }
  code?: string | number | null
  barCode?: string | number | null
}

type BsaleListResponse<T> = { count?: number; items?: T[] }

export type ProductCreationDefaults = {
  classification: 0
  stock_control: 1
  allow_decimal: 0
  unlimited_stock: 0
  allow_negative_stock: 0
  serial_number: 0
  is_lot: 0
  tax_rate: 19
  bsale_tax_id: 1
}

export type ProductCreationSupplier = {
  id: string
  business_name: string
  rut: string | null
}

export type ProductCreationBrand = {
  status: 'NONE' | 'UNIQUE' | 'MULTIPLE'
  expected_bsale_brand_id: number | null
  candidate_ids: number[]
}

export type ProductCreationType = { id: number; name: string }

export type ProductCreationContext = {
  po_id: string
  supplier: ProductCreationSupplier
  product_types: ProductCreationType[]
  brand: ProductCreationBrand
  defaults: ProductCreationDefaults
}

export type ErpDuplicate = {
  exists: boolean
  match_type: 'SKU' | 'BARCODE' | null
  product_id: string | null
  sku: string | null
  description: string | null
  bsale_product_id: number | null
  bsale_variant_id: number | null
}

export type BsaleDuplicate = {
  exists: boolean
  match_type: 'SKU' | 'BARCODE' | 'BOTH' | null
  variant_id: number | null
  product_id: number | null
  code: string | null
  barcode: string | null
}

export type ProductCreationPreflightInput = {
  sku: string
  barcode?: string | null
  bsale_product_type_id: number
}

export type ProductCreationPreflight = {
  success: boolean
  normalized: { sku: string; barcode: string | null }
  supplier: ProductCreationSupplier | null
  product_type: ProductCreationType | null
  brand: ProductCreationBrand | null
  erp_duplicate: ErpDuplicate
  bsale_duplicate: BsaleDuplicate
  conflict: boolean
  can_create: boolean
  blocking_reason: string | null
  error?: string
}

function adqAdmin() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function normalizeSku(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, ' ')
}

function normalizeBarcode(value: string | null | undefined) {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function defaultsForCompany(companyId: string): ProductCreationDefaults | null {
  if (companyId !== KNOWN_COMPANY_IDS.CAYLO) return null
  return {
    classification: 0,
    stock_control: 1,
    allow_decimal: 0,
    unlimited_stock: 0,
    allow_negative_stock: 0,
    serial_number: 0,
    is_lot: 0,
    tax_rate: 19,
    bsale_tax_id: 1,
  }
}

async function authorize() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' as string | null, companyId: null as string | null }

  const { data: canCreate, error: permissionError } = await supabase.rpc('has_permission', {
    p_permission_code: 'adquisiciones.products.create',
  })
  if (permissionError || canCreate !== true) {
    return { error: 'Permisos insuficientes para crear productos.' as string | null, companyId: null }
  }

  const { data: canViewOrders, error: orderPermissionError } = await supabase.rpc('has_permission', {
    p_permission_code: 'adquisiciones.po.view',
  })
  if (orderPermissionError || canViewOrders !== true) {
    return { error: 'Permisos insuficientes para consultar órdenes de compra.' as string | null, companyId: null }
  }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'Empresa activa requerida' as string | null, companyId: null }
  return { error: null, companyId }
}

async function getSupplierProductTypes(companyId: string, supplierId: string) {
  const db = adqAdmin()
  const { data: operativeSuppliers, error: supplierError } = await db
    .from('suppliers')
    .select('bsale_product_type_id')
    .eq('company_id', companyId)
    .eq('parent_supplier_id', supplierId)
    .eq('supplier_kind', 'BSALE_OPERATIVE')
    .eq('is_active', true)
    .eq('status', 'ACTIVE')
    .not('bsale_product_type_id', 'is', null)

  if (supplierError) throw new Error(`No se pudieron consultar los tipos del proveedor: ${supplierError.message}`)

  const typeUuids = [...new Set((operativeSuppliers ?? []).map(row => row.bsale_product_type_id).filter(Boolean))]
  if (typeUuids.length === 0) return [] as ProductCreationType[]

  const { data: types, error: typeError } = await db.schema('integraciones')
    .from('bsale_product_types')
    .select('bsale_id, name, state')
    .eq('company_id', companyId)
    .in('id', typeUuids)
    .eq('state', 0)

  if (typeError) throw new Error(`No se pudieron consultar los tipos Bsale: ${typeError.message}`)

  const byId = new Map<number, ProductCreationType>()
  for (const type of types ?? []) {
    const id = Number(type.bsale_id)
    if (!Number.isInteger(id) || !type.name) continue
    byId.set(id, { id, name: type.name })
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, 'es-CL'))
}

export async function validateSupplierBsaleProductType(
  companyId: string,
  supplierId: string,
  productTypeId: number,
): Promise<{ valid: boolean; product_type: ProductCreationType | null }> {
  const types = await getSupplierProductTypes(companyId, supplierId)
  const productType = types.find(type => type.id === productTypeId) ?? null
  return { valid: productType !== null, product_type: productType }
}

async function loadPurchaseOrderContext(companyId: string, poId: string) {
  const db = adqAdmin()
  const { data: po, error: poError } = await db
    .from('purchase_orders')
    .select('id, supplier_id, status')
    .eq('id', poId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (poError) throw new Error(`No se pudo consultar la OC: ${poError.message}`)
  if (!po) return { error: 'La orden de compra no existe.' as string | null, po: null, supplier: null }
  if (po.status !== 'ENVIADA_PROVEEDOR') {
    return { error: 'La orden de compra no está en estado ENVIADA_PROVEEDOR.' as string | null, po: null, supplier: null }
  }

  const { data: supplier, error: supplierError } = await db
    .from('suppliers')
    .select('id, business_name, rut, supplier_kind, is_active, status')
    .eq('id', po.supplier_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (supplierError) throw new Error(`No se pudo consultar el proveedor de la OC: ${supplierError.message}`)
  if (!supplier || supplier.supplier_kind !== 'REAL' || !supplier.is_active || supplier.status !== 'ACTIVE') {
    return { error: 'El proveedor de la OC no es un proveedor REAL activo.' as string | null, po: null, supplier: null }
  }

  return {
    error: null,
    po,
    supplier: {
      id: supplier.id,
      business_name: supplier.business_name,
      rut: supplier.rut,
    } satisfies ProductCreationSupplier,
  }
}

async function getSupplierBrand(companyId: string, supplierId: string): Promise<ProductCreationBrand> {
  const { data, error } = await adqAdmin().schema('integraciones')
    .from('bsale_brand_supplier_links')
    .select('bsale_brand_id')
    .eq('company_id', companyId)
    .eq('supplier_id', supplierId)

  if (error) throw new Error(`No se pudo consultar la Brand esperada: ${error.message}`)
  const candidateIds = [...new Set((data ?? []).map(row => Number(row.bsale_brand_id)).filter(Number.isInteger))]
  if (candidateIds.length === 0) return { status: 'NONE', expected_bsale_brand_id: null, candidate_ids: [] }
  if (candidateIds.length === 1) return { status: 'UNIQUE', expected_bsale_brand_id: candidateIds[0], candidate_ids: candidateIds }
  return { status: 'MULTIPLE', expected_bsale_brand_id: null, candidate_ids: candidateIds.sort((a, b) => a - b) }
}

export async function getPurchaseOrderNewProductContext(poId: string) {
  const auth = await authorize()
  if (auth.error || !auth.companyId) return { data: null, error: auth.error || 'Empresa activa requerida' }

  const defaults = defaultsForCompany(auth.companyId)
  if (!defaults) return { data: null, error: 'No existen defaults Bsale definidos para la empresa activa.' }

  try {
    const context = await loadPurchaseOrderContext(auth.companyId, poId)
    if (context.error || !context.supplier) return { data: null, error: context.error }
    const [productTypes, brand] = await Promise.all([
      getSupplierProductTypes(auth.companyId, context.supplier.id),
      getSupplierBrand(auth.companyId, context.supplier.id),
    ])
    return {
      data: {
        po_id: poId,
        supplier: context.supplier,
        product_types: productTypes,
        brand,
        defaults,
      } satisfies ProductCreationContext,
      error: null,
    }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'No se pudo cargar el contexto de creación.' }
  }
}

async function findErpDuplicate(companyId: string, sku: string, barcode: string | null): Promise<ErpDuplicate> {
  const db = adqAdmin()
  const queries = [
    db.from('products').select('id, sku, barcode, description, bsale_product_id, bsale_variant_id').eq('company_id', companyId).eq('sku', sku).maybeSingle(),
    barcode
      ? db.from('products').select('id, sku, barcode, description, bsale_product_id, bsale_variant_id').eq('company_id', companyId).eq('barcode', barcode).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ] as const
  const [skuResult, barcodeResult] = await Promise.all(queries)
  if (skuResult.error) throw new Error(`No se pudo validar el SKU en ERP: ${skuResult.error.message}`)
  if (barcodeResult.error) throw new Error(`No se pudo validar el barcode en ERP: ${barcodeResult.error.message}`)
  const product = skuResult.data ?? barcodeResult.data
  if (!product) return { exists: false, match_type: null, product_id: null, sku: null, description: null, bsale_product_id: null, bsale_variant_id: null }
  return {
    exists: true,
    match_type: skuResult.data ? 'SKU' : 'BARCODE',
    product_id: product.id,
    sku: product.sku,
    description: product.description,
    bsale_product_id: product.bsale_product_id,
    bsale_variant_id: product.bsale_variant_id,
  }
}

async function findBsaleVariant(companyId: string, key: 'code' | 'barcode', value: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await bsaleFetchForCompany<BsaleVariant>({
        companyId,
        path: '/variants.json',
        params: { [key]: value, limit: 50 },
      }) as BsaleListResponse<BsaleVariant>
      return { kind: 'OK' as const, variants: result.items ?? [] }
    } catch (error) {
      if (error instanceof BsaleApiError && error.status === 429 && attempt === 0) continue
      if (error instanceof BsaleApiError) {
        const message = error.status === 401 || error.status === 403
          ? 'BSale rechazó la autenticación o autorización.'
          : error.status >= 500
            ? 'BSale no está disponible temporalmente.'
            : `No se pudo consultar Bsale (HTTP ${error.status}).`
        return { kind: 'ERROR' as const, message }
      }
      return { kind: 'ERROR' as const, message: 'No se pudo consultar Bsale.' }
    }
  }
  return { kind: 'ERROR' as const, message: 'BSale está temporalmente limitado. Intenta nuevamente.' }
}

function firstVariant(variants: BsaleVariant[]) {
  const variant = variants[0]
  if (!variant) return null
  return {
    variant_id: Number.isInteger(Number(variant.id)) ? Number(variant.id) : null,
    product_id: Number.isInteger(Number(variant.product?.id)) ? Number(variant.product?.id) : null,
    code: variant.code == null ? null : String(variant.code),
    barcode: variant.barCode == null ? null : String(variant.barCode),
  }
}

function emptyErpDuplicate(): ErpDuplicate {
  return { exists: false, match_type: null, product_id: null, sku: null, description: null, bsale_product_id: null, bsale_variant_id: null }
}

function emptyBsaleDuplicate(): BsaleDuplicate {
  return { exists: false, match_type: null, variant_id: null, product_id: null, code: null, barcode: null }
}

export async function preflightPurchaseOrderNewProduct(
  poId: string,
  input: ProductCreationPreflightInput,
): Promise<ProductCreationPreflight> {
  const normalized = { sku: normalizeSku(input.sku), barcode: normalizeBarcode(input.barcode) }
  const base = {
    normalized,
    supplier: null,
    product_type: null,
    brand: null,
    erp_duplicate: emptyErpDuplicate(),
    bsale_duplicate: emptyBsaleDuplicate(),
    conflict: false,
    can_create: false,
    blocking_reason: null,
  }
  if (!normalized.sku) return { success: false, ...base, blocking_reason: 'El SKU es obligatorio.', error: 'El SKU es obligatorio.' }
  if (!Number.isInteger(input.bsale_product_type_id) || input.bsale_product_type_id <= 0) {
    return { success: false, ...base, blocking_reason: INVALID_PRODUCT_TYPE_MESSAGE, error: INVALID_PRODUCT_TYPE_MESSAGE }
  }

  const auth = await authorize()
  if (auth.error || !auth.companyId) return { success: false, ...base, blocking_reason: auth.error || 'Empresa activa requerida', error: auth.error || 'Empresa activa requerida' }
  const defaults = defaultsForCompany(auth.companyId)
  if (!defaults) return { success: false, ...base, blocking_reason: 'No existen defaults Bsale definidos para la empresa activa.', error: 'No existen defaults Bsale definidos para la empresa activa.' }

  try {
    const context = await loadPurchaseOrderContext(auth.companyId, poId)
    if (context.error || !context.supplier) {
      const message = context.error || 'No se pudo resolver el proveedor de la OC.'
      return { success: false, ...base, blocking_reason: message, error: message }
    }
    const typeValidation = await validateSupplierBsaleProductType(auth.companyId, context.supplier.id, input.bsale_product_type_id)
    const brand = await getSupplierBrand(auth.companyId, context.supplier.id)
    const resultBase = { ...base, supplier: context.supplier, product_type: typeValidation.product_type, brand }
    if (!typeValidation.valid) return { success: false, ...resultBase, blocking_reason: INVALID_PRODUCT_TYPE_MESSAGE, error: INVALID_PRODUCT_TYPE_MESSAGE }

    const erpDuplicate = await findErpDuplicate(auth.companyId, normalized.sku, normalized.barcode)
    const skuLookup = await findBsaleVariant(auth.companyId, 'code', normalized.sku)
    if (skuLookup.kind === 'ERROR') return { success: false, ...resultBase, erp_duplicate: erpDuplicate, blocking_reason: skuLookup.message, error: skuLookup.message }
    const barcodeLookup = normalized.barcode ? await findBsaleVariant(auth.companyId, 'barcode', normalized.barcode) : { kind: 'OK' as const, variants: [] }
    if (barcodeLookup.kind === 'ERROR') return { success: false, ...resultBase, erp_duplicate: erpDuplicate, blocking_reason: barcodeLookup.message, error: barcodeLookup.message }

    const skuMatch = firstVariant(skuLookup.variants)
    const barcodeMatch = firstVariant(barcodeLookup.variants)
    const conflict = Boolean(skuMatch && barcodeMatch && skuMatch.variant_id !== barcodeMatch.variant_id)
    const bsaleDuplicate: BsaleDuplicate = skuMatch || barcodeMatch
      ? {
          exists: true,
          match_type: skuMatch && barcodeMatch ? 'BOTH' : skuMatch ? 'SKU' : 'BARCODE',
          variant_id: (skuMatch ?? barcodeMatch)?.variant_id ?? null,
          product_id: (skuMatch ?? barcodeMatch)?.product_id ?? null,
          code: (skuMatch ?? barcodeMatch)?.code ?? null,
          barcode: (skuMatch ?? barcodeMatch)?.barcode ?? null,
        }
      : emptyBsaleDuplicate()
    const blockingReason = conflict
      ? 'El SKU y el código de barras existen en Bsale pero pertenecen a variantes diferentes.'
      : erpDuplicate.exists
        ? 'El SKU o código de barras ya existe en ERP.'
        : bsaleDuplicate.exists
          ? 'El SKU o código de barras ya existe en Bsale.'
          : null
    return {
      success: true,
      ...resultBase,
      erp_duplicate: erpDuplicate,
      bsale_duplicate: bsaleDuplicate,
      conflict,
      can_create: !erpDuplicate.exists && !bsaleDuplicate.exists && !conflict,
      blocking_reason: blockingReason,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo ejecutar el preflight.'
    return { success: false, ...base, blocking_reason: message, error: message }
  }
}
