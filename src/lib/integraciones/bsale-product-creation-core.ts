export type BsaleCreationStatus =
  | 'CREATED'
  | 'PREFLIGHT_BLOCKED'
  | 'BSALE_PRODUCT_FAILED'
  | 'BSALE_PRODUCT_CREATED_VARIANT_FAILED'
  | 'BSALE_VARIANT_EXISTS'
  | 'ERP_PERSIST_FAILED'
  | 'MAPPING_FAILED'
  | 'RECONCILIATION_REQUIRED'

export type BsaleProductPayload = {
  name: string
  description: string
  classification: 0
  allowDecimal: 0
  stockControl: 1
  productTypeId: number
  serialNumber: 0
  isLot: 0
  taxId: 1
}

export type BsaleVariantPayload = {
  productId: number
  description: string
  unlimitedStock: 0
  allowNegativeStock: 0
  code: string
  barCode?: string
}

export type BsaleVariantIdentity = {
  variantId: number
  productId: number | null
  code: string | null
  barcode: string | null
}

export type LocalCreatedProduct = {
  id: string
  sku: string
  barcode: string | null
  description: string
  tax_rate: number
  bsale_product_id: number
  bsale_variant_id: number
  bsale_product_type_id: number
  bsale_product_type_name: string
}

export type BsaleProductCreationInput = {
  companyId: string
  supplier: { id: string; business_name: string; rut: string | null }
  sku: string
  barcode: string | null
  description: string
  productType: { id: number; name: string }
  expectedBrandId: number | null
  userId: string
}

export type BsaleProductCreationDependencies = {
  findExistingVariant: (sku: string, barcode: string | null) => Promise<BsaleVariantIdentity | null>
  createProduct: (payload: BsaleProductPayload) => Promise<{ id: number; state: number | null }>
  createVariant: (payload: BsaleVariantPayload) => Promise<{ id: number; productId: number; state: number | null }>
  persistProduct: (input: {
    companyId: string
    userId: string
    sku: string
    barcode: string | null
    description: string
    productType: { id: number; name: string }
    bsaleProductId: number
    bsaleVariantId: number
    bsaleProductState: number | null
    bsaleVariantState: number | null
  }) => Promise<LocalCreatedProduct>
  ensureSupplierMapping: (input: {
    companyId: string
    userId: string
    product: LocalCreatedProduct
    supplierId: string
  }) => Promise<void>
}

export type BsaleProductCreationResult =
  | {
      success: true
      status: 'CREATED'
      product: LocalCreatedProduct
      supplier: BsaleProductCreationInput['supplier']
      brand: { expected_bsale_brand_id: number | null; assignment_status: 'PENDING_MANUAL' }
    }
  | {
      success: false
      status: Exclude<BsaleCreationStatus, 'CREATED'>
      error: string
      bsale_product_id?: number
      bsale_variant_id?: number
      product?: LocalCreatedProduct
    }

function normalizeDescription(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function responseId(value: unknown, label: string) {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new Error(`BSale no devolvió un ${label} válido.`)
  return id
}

function toProductPayload(input: BsaleProductCreationInput): BsaleProductPayload {
  const description = normalizeDescription(input.description)
  return {
    name: description,
    description,
    classification: 0,
    allowDecimal: 0,
    stockControl: 1,
    productTypeId: input.productType.id,
    serialNumber: 0,
    isLot: 0,
    taxId: 1,
  }
}

function toVariantPayload(input: BsaleProductCreationInput, productId: number): BsaleVariantPayload {
  const payload: BsaleVariantPayload = {
    productId,
    description: normalizeDescription(input.description),
    unlimitedStock: 0,
    allowNegativeStock: 0,
    code: input.sku,
  }
  if (input.barcode) payload.barCode = input.barcode
  return payload
}

async function persistRecoveredVariant(
  input: BsaleProductCreationInput,
  deps: BsaleProductCreationDependencies,
  variant: BsaleVariantIdentity,
  productState: number | null,
  status: 'CREATED' | 'BSALE_VARIANT_EXISTS' = 'CREATED',
): Promise<BsaleProductCreationResult> {
  if (!variant.productId) {
    return { success: false, status: 'RECONCILIATION_REQUIRED', error: 'La variante Bsale existe pero no expone su Product asociado.', bsale_variant_id: variant.variantId }
  }
  let persistedProduct: LocalCreatedProduct | undefined
  try {
    const product = await deps.persistProduct({
      companyId: input.companyId,
      userId: input.userId,
      sku: input.sku,
      barcode: input.barcode,
      description: normalizeDescription(input.description),
      productType: input.productType,
      bsaleProductId: variant.productId,
      bsaleVariantId: variant.variantId,
      bsaleProductState: productState,
      bsaleVariantState: null,
    })
    persistedProduct = product
    await deps.ensureSupplierMapping({ companyId: input.companyId, userId: input.userId, product, supplierId: input.supplier.id })
    if (status === 'BSALE_VARIANT_EXISTS') {
      return {
        success: false,
        status,
        error: 'La variante ya existía en Bsale y fue reconciliada localmente.',
        bsale_product_id: variant.productId,
        bsale_variant_id: variant.variantId,
        product,
      }
    }
    return {
      success: true,
      status: 'CREATED',
      product,
      supplier: input.supplier,
      brand: { expected_bsale_brand_id: input.expectedBrandId, assignment_status: 'PENDING_MANUAL' },
    }
  } catch (error) {
    return {
      success: false,
      status: error instanceof Error && error.message.startsWith('MAPPING_FAILED:') ? 'MAPPING_FAILED' : 'ERP_PERSIST_FAILED',
      error: error instanceof Error ? error.message : 'No se pudo persistir el producto recuperado en ERP.',
      bsale_product_id: variant.productId,
      bsale_variant_id: variant.variantId,
      product: persistedProduct,
    }
  }
}

export async function createBsaleProductAndVariant(
  input: BsaleProductCreationInput,
  deps: BsaleProductCreationDependencies,
): Promise<BsaleProductCreationResult> {
  const existingBeforeProduct = await deps.findExistingVariant(input.sku, input.barcode)
  if (existingBeforeProduct) {
    return {
      success: false,
      status: 'BSALE_VARIANT_EXISTS',
      error: 'La variante ya existe en Bsale; se requiere reconciliación local.',
      bsale_product_id: existingBeforeProduct.productId ?? undefined,
      bsale_variant_id: existingBeforeProduct.variantId,
    }
  }

  let bsaleProduct: { id: number; state: number | null }
  try {
    bsaleProduct = await deps.createProduct(toProductPayload(input))
  } catch (error) {
    const recovered = await deps.findExistingVariant(input.sku, input.barcode)
    if (recovered) return persistRecoveredVariant(input, deps, recovered, null, 'BSALE_VARIANT_EXISTS')
    const uncertain = error instanceof Error && (error.name === 'AbortError' || error.name === 'TypeError')
    return { success: false, status: uncertain ? 'RECONCILIATION_REQUIRED' : 'BSALE_PRODUCT_FAILED', error: error instanceof Error ? error.message : 'No se pudo crear el Product en Bsale.' }
  }

  let productId: number
  try {
    productId = responseId(bsaleProduct.id, 'Product ID')
  } catch (error) {
    return { success: false, status: 'RECONCILIATION_REQUIRED', error: error instanceof Error ? error.message : 'Product Bsale sin ID.', bsale_product_id: Number(bsaleProduct.id) || undefined }
  }

  const existingBeforeVariant = await deps.findExistingVariant(input.sku, input.barcode)
  if (existingBeforeVariant) return persistRecoveredVariant(input, deps, { ...existingBeforeVariant, productId: existingBeforeVariant.productId ?? productId }, bsaleProduct.state, 'BSALE_VARIANT_EXISTS')

  let bsaleVariant: { id: number; productId: number; state: number | null }
  try {
    bsaleVariant = await deps.createVariant(toVariantPayload(input, productId))
  } catch (error) {
    const recovered = await deps.findExistingVariant(input.sku, input.barcode)
    if (recovered) return persistRecoveredVariant(input, deps, { ...recovered, productId: recovered.productId ?? productId }, bsaleProduct.state)
    return {
      success: false,
      status: 'BSALE_PRODUCT_CREATED_VARIANT_FAILED',
      error: error instanceof Error ? error.message : 'Product creado en Bsale, pero falló la creación de la variante.',
      bsale_product_id: productId,
    }
  }

  let variantId: number
  try {
    variantId = responseId(bsaleVariant.id, 'Variant ID')
  } catch (error) {
    return {
      success: false,
      status: 'BSALE_PRODUCT_CREATED_VARIANT_FAILED',
      error: error instanceof Error ? error.message : 'Variant Bsale sin ID.',
      bsale_product_id: productId,
    }
  }
  let persistedProduct: LocalCreatedProduct | undefined
  try {
    const product = await deps.persistProduct({
      companyId: input.companyId,
      userId: input.userId,
      sku: input.sku,
      barcode: input.barcode,
      description: normalizeDescription(input.description),
      productType: input.productType,
      bsaleProductId: productId,
      bsaleVariantId: variantId,
      bsaleProductState: bsaleProduct.state,
      bsaleVariantState: bsaleVariant.state,
    })
    persistedProduct = product
    await deps.ensureSupplierMapping({ companyId: input.companyId, userId: input.userId, product, supplierId: input.supplier.id })
    return {
      success: true,
      status: 'CREATED',
      product,
      supplier: input.supplier,
      brand: { expected_bsale_brand_id: input.expectedBrandId, assignment_status: 'PENDING_MANUAL' },
    }
  } catch (error) {
    return {
      success: false,
      status: error instanceof Error && error.message.startsWith('MAPPING_FAILED:') ? 'MAPPING_FAILED' : 'ERP_PERSIST_FAILED',
      error: error instanceof Error ? error.message.replace(/^MAPPING_FAILED:\s*/, '') : 'No se pudo persistir el producto creado en ERP.',
      bsale_product_id: productId,
      bsale_variant_id: variantId,
      product: persistedProduct,
    }
  }
}

export { normalizeDescription, toProductPayload, toVariantPayload }
