'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { KNOWN_COMPANY_IDS } from '@/lib/bsale/company-config'
import { BsaleApiError, bsaleFetchForCompany } from '@/lib/bsale/client'
import { bsaleWriteForCompany } from '@/lib/bsale/write-client'
import {
  createBsaleProductAndVariant,
  type BsaleProductCreationDependencies,
  type BsaleProductCreationResult,
  type LocalCreatedProduct,
} from '@/lib/integraciones/bsale-product-creation-core'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const INVALID_PRODUCT_TYPE_MESSAGE = 'El tipo de producto Bsale seleccionado no corresponde al proveedor de esta orden.'

type BsaleVariant = {
  id?: number | string
  product?: { id?: number | string }
  code?: string | number | null
  barCode?: string | number | null
}

type BsaleListResponse<T> = { count?: number; items?: T[] }
type BsaleProductTax = { tax?: { id?: number | string } | null; id?: number | string }

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
  erp_conflict: boolean
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
  if (!user) return { error: 'No autorizado' as string | null, companyId: null as string | null, userId: null as string | null }

  const { data: canCreate, error: permissionError } = await supabase.rpc('has_permission', {
    p_permission_code: 'adquisiciones.products.create',
  })
  if (permissionError || canCreate !== true) {
    return { error: 'Permisos insuficientes para crear productos.' as string | null, companyId: null, userId: null }
  }

  const { data: canViewOrders, error: orderPermissionError } = await supabase.rpc('has_permission', {
    p_permission_code: 'adquisiciones.po.view',
  })
  if (orderPermissionError || canViewOrders !== true) {
    return { error: 'Permisos insuficientes para consultar órdenes de compra.' as string | null, companyId: null, userId: null }
  }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'Empresa activa requerida' as string | null, companyId: null, userId: null }
  return { error: null, companyId, userId: user.id }
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

async function findErpDuplicate(companyId: string, sku: string, barcode: string | null): Promise<{ duplicate: ErpDuplicate; conflict: boolean }> {
  const db = adqAdmin()
  const select = 'id, sku, barcode, description, bsale_product_id, bsale_variant_id'
  const lookup = async (field: 'sku' | 'barcode', value: string) => {
    const { data, error } = await db.from('products')
      .select(select)
      .or(`company_id.is.null,company_id.eq.${companyId}`)
      .eq(field, value)
      .limit(1)
    if (error) throw new Error(`No se pudo validar el ${field} en ERP: ${error.message}`)
    return data?.[0] ?? null
  }
  const [skuProduct, barcodeProduct] = await Promise.all([
    lookup('sku', sku),
    barcode ? lookup('barcode', barcode) : Promise.resolve(null),
  ])
  const product = skuProduct ?? barcodeProduct
  if (!product) return { duplicate: emptyErpDuplicate(), conflict: false }
  return {
    duplicate: {
      exists: true,
      match_type: skuProduct ? 'SKU' : 'BARCODE',
      product_id: product.id,
      sku: product.sku,
      description: product.description,
      bsale_product_id: product.bsale_product_id,
      bsale_variant_id: product.bsale_variant_id,
    },
    conflict: Boolean(skuProduct && barcodeProduct && skuProduct.id !== barcodeProduct.id),
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
    erp_conflict: false,
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

    const erpLookup = await findErpDuplicate(auth.companyId, normalized.sku, normalized.barcode)
    const erpDuplicate = erpLookup.duplicate
    const erpConflict = erpLookup.conflict
    const skuLookup = await findBsaleVariant(auth.companyId, 'code', normalized.sku)
    if (skuLookup.kind === 'ERROR') return { success: false, ...resultBase, erp_duplicate: erpDuplicate, erp_conflict: erpConflict, blocking_reason: skuLookup.message, error: skuLookup.message }
    const barcodeLookup = normalized.barcode ? await findBsaleVariant(auth.companyId, 'barcode', normalized.barcode) : { kind: 'OK' as const, variants: [] }
    if (barcodeLookup.kind === 'ERROR') return { success: false, ...resultBase, erp_duplicate: erpDuplicate, erp_conflict: erpConflict, blocking_reason: barcodeLookup.message, error: barcodeLookup.message }

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
      : erpConflict
        ? 'El SKU y el código de barras ya existen en ERP pero pertenecen a productos diferentes.'
      : erpDuplicate.exists
        ? 'El SKU o código de barras ya existe en ERP.'
        : bsaleDuplicate.exists
          ? 'El SKU o código de barras ya existe en Bsale.'
          : null
    return {
      success: true,
      ...resultBase,
      erp_duplicate: erpDuplicate,
      erp_conflict: erpConflict,
      bsale_duplicate: bsaleDuplicate,
      conflict,
      can_create: !erpDuplicate.exists && !erpConflict && !bsaleDuplicate.exists && !conflict,
      blocking_reason: blockingReason,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo ejecutar el preflight.'
    return { success: false, ...base, blocking_reason: message, error: message }
  }
}

async function findExistingVariantForCreation(companyId: string, sku: string, barcode: string | null) {
  const skuLookup = await findBsaleVariant(companyId, 'code', sku)
  if (skuLookup.kind === 'ERROR') throw new Error(`RECONCILIATION_REQUIRED: ${skuLookup.message}`)
  const barcodeLookup = barcode ? await findBsaleVariant(companyId, 'barcode', barcode) : { kind: 'OK' as const, variants: [] }
  if (barcodeLookup.kind === 'ERROR') throw new Error(`RECONCILIATION_REQUIRED: ${barcodeLookup.message}`)
  const variant = firstVariant(skuLookup.variants) ?? firstVariant(barcodeLookup.variants)
  if (!variant || variant.variant_id == null) return null
  return { variantId: variant.variant_id, productId: variant.product_id, code: variant.code, barcode: variant.barcode }
}

async function getProductTaxesForCreation(companyId: string, productId: number) {
  const result = await bsaleFetchForCompany<BsaleProductTax>({
    companyId,
    path: `/products/${productId}/product_taxes.json`,
    params: { limit: 50 },
  }) as BsaleListResponse<BsaleProductTax>
  return [...new Set((result.items ?? [])
    .map(item => Number(item.tax?.id ?? item.id))
    .filter(id => Number.isInteger(id) && id > 0))]
}

async function persistCreatedProduct(input: {
  companyId: string
  userId: string
  sku: string
  barcode: string | null
  description: string
  productType: ProductCreationType
  bsaleProductId: number
  bsaleVariantId: number
  bsaleProductState: number | null
  bsaleVariantState: number | null
}): Promise<LocalCreatedProduct> {
  const db = adqAdmin()
  const duplicate = await findErpDuplicate(input.companyId, input.sku, input.barcode)
  if (duplicate.duplicate.exists || duplicate.conflict) {
    throw new Error('ERP_PERSIST_FAILED: el SKU o barcode ya existe en el catálogo efectivo.')
  }

  const now = new Date().toISOString()
  const description = input.description.trim().replace(/\s+/g, ' ')
  const { data, error } = await db.from('products').insert({
    company_id: input.companyId,
    sku: input.sku,
    barcode: input.barcode,
    description,
    short_description: null,
    brand: null,
    product_type: input.productType.name,
    tax_rate: 19,
    min_stock: 0,
    max_stock: 0,
    reorder_point: 0,
    is_perishable: false,
    requires_lot: false,
    requires_expiration: false,
    status: 'ACTIVE',
    is_active: true,
    source: 'BSALE',
    bsale_product_id: input.bsaleProductId,
    bsale_variant_id: input.bsaleVariantId,
    bsale_product_type_id: input.productType.id,
    bsale_product_type_name: input.productType.name,
    bsale_product_state: input.bsaleProductState,
    bsale_variant_state: input.bsaleVariantState,
    last_bsale_sync_at: now,
    created_by: input.userId,
    updated_by: input.userId,
  }).select('id, sku, barcode, description, tax_rate, bsale_product_id, bsale_variant_id, bsale_product_type_id, bsale_product_type_name').maybeSingle()

  if (error || !data) throw new Error(`ERP_PERSIST_FAILED: ${error?.message || 'No se insertó el producto.'}`)
  return data as LocalCreatedProduct
}

async function ensureRealSupplierMapping(input: {
  companyId: string
  userId: string
  product: LocalCreatedProduct
  supplierId: string
}) {
  const db = adqAdmin()
  const { data: preferredMappings, error: preferredError } = await db.from('product_supplier_mappings')
    .select('id, supplier_id')
    .eq('company_id', input.companyId)
    .eq('sku', input.product.sku)
    .eq('is_active', true)
    .eq('is_preferred', true)
  if (preferredError) throw new Error(`MAPPING_FAILED: ${preferredError.message}`)
  if ((preferredMappings ?? []).some(mapping => mapping.supplier_id !== input.supplierId)) {
    throw new Error('MAPPING_FAILED: el SKU ya tiene otro proveedor preferido activo.')
  }

  const { data: existing, error: existingError } = await db.from('product_supplier_mappings')
    .select('id')
    .eq('company_id', input.companyId)
    .eq('supplier_id', input.supplierId)
    .eq('sku', input.product.sku)
    .maybeSingle()
  if (existingError) throw new Error(`MAPPING_FAILED: ${existingError.message}`)

  const mapping = {
    product_id: input.product.id,
    supplier_id: input.supplierId,
    bsale_variant_id: input.product.bsale_variant_id,
    sku: input.product.sku,
    product_name: input.product.description,
    is_preferred: true,
    is_active: true,
    updated_by: input.userId,
  }
  const result = existing
    ? await db.from('product_supplier_mappings').update(mapping).eq('id', existing.id)
    : await db.from('product_supplier_mappings').insert({ ...mapping, company_id: input.companyId, created_by: input.userId })
  if (result.error) throw new Error(`MAPPING_FAILED: ${result.error.message}`)
}

export async function createPurchaseOrderBsaleProduct(
  poId: string,
  input: ProductCreationPreflightInput & { description: string; bsale_product_id?: number | null },
): Promise<BsaleProductCreationResult | { success: false; status: 'PREFLIGHT_BLOCKED'; error: string }> {
  const auth = await authorize()
  if (auth.error || !auth.companyId || !auth.userId) return { success: false, status: 'PREFLIGHT_BLOCKED', error: auth.error || 'Empresa activa requerida.' }
  if (!input.description.trim()) return { success: false, status: 'PREFLIGHT_BLOCKED', error: 'La descripción es obligatoria.' }

  const preflight = await preflightPurchaseOrderNewProduct(poId, input)
  if (!preflight.success || !preflight.can_create || !preflight.supplier || !preflight.product_type) {
    return { success: false, status: 'PREFLIGHT_BLOCKED', error: preflight.blocking_reason || preflight.error || 'El preflight bloqueó la creación.' }
  }

  const dependencies: BsaleProductCreationDependencies = {
    findExistingVariant: (sku, barcode) => findExistingVariantForCreation(auth.companyId!, sku, barcode),
    getProductTaxes: productId => getProductTaxesForCreation(auth.companyId!, productId),
    createProduct: async payload => {
      const response = await bsaleWriteForCompany<{ id?: number | string; state?: number | string }>({ companyId: auth.companyId!, path: '/products.json', body: payload })
      return { id: Number(response.id), state: response.state == null ? null : Number(response.state) }
    },
    createVariant: async payload => {
      const response = await bsaleWriteForCompany<{ id?: number | string; state?: number | string; product?: { id?: number | string }; productId?: number | string }>({ companyId: auth.companyId!, path: '/variants.json', body: payload })
      return {
        id: Number(response.id),
        productId: Number(response.product?.id ?? response.productId ?? payload.productId),
        state: response.state == null ? null : Number(response.state),
      }
    },
    persistProduct: persistCreatedProduct,
    ensureSupplierMapping: ensureRealSupplierMapping,
  }

  try {
    return await createBsaleProductAndVariant({
      companyId: auth.companyId,
      userId: auth.userId,
      supplier: preflight.supplier,
      sku: preflight.normalized.sku,
      barcode: preflight.normalized.barcode,
      description: input.description,
      productType: preflight.product_type,
      expectedBrandId: preflight.brand?.expected_bsale_brand_id ?? null,
      existingProductId: input.bsale_product_id ?? null,
    }, dependencies)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Se requiere reconciliación Bsale.'
    return { success: false, status: 'RECONCILIATION_REQUIRED', error: message.replace(/^RECONCILIATION_REQUIRED:\s*/, '') }
  }
}
