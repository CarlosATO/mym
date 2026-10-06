import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function adqDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function fetchAllRows<T>(buildQuery: () => any): Promise<T[]> {
  const pageSize = 1000
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...((data || []) as T[]))
    if (!data || data.length < pageSize) return rows
  }
}

export function isSkuInScope(sku: string, targetSkus?: string[]) {
  return !targetSkus || targetSkus.length === 0 || targetSkus.includes(sku)
}

export interface AutoMappingResult {
  productsScanned: number
  mappingsScanned: number
  productsWithProductType: number
  operativeSuppliersFound: number
  operativeSuppliersCreated: number
  mappingsCreated: number
  mappingsUpdated: number
  mappingsSkippedExisting: number
  mappingsSkippedManualConflict: number
  productsWithoutProductType: number
  productsWithoutResolvedSupplier: number
  operativeSuppliersWithoutParent: number
  errors: string[]
}

export function isProductSupplierMappingCoherent(
  mapping: { company_id: string; sku: string; product_id: string | null; bsale_variant_id: number | null },
  product: { company_id: string | null; sku: string; id: string; bsale_variant_id: number | null },
) {
  return mapping.company_id === product.company_id
    && mapping.sku === product.sku
    && mapping.product_id === product.id
    && mapping.bsale_variant_id === product.bsale_variant_id
}

export async function syncProductSupplierMappings(
  companyId: string,
  options?: { dryRun?: boolean; skus?: string[] }
): Promise<AutoMappingResult> {
    const dryRun = options?.dryRun ?? false
    const targetSkus = options?.skus
    const targeted = Boolean(targetSkus && targetSkus.length > 0)
  const db = adqDb()

  const result: AutoMappingResult = {
    productsScanned: 0,
    mappingsScanned: 0,
    productsWithProductType: 0,
    operativeSuppliersFound: 0,
    operativeSuppliersCreated: 0,
    mappingsCreated: 0,
    mappingsUpdated: 0,
    mappingsSkippedExisting: 0,
    mappingsSkippedManualConflict: 0,
    productsWithoutProductType: 0,
    productsWithoutResolvedSupplier: 0,
    operativeSuppliersWithoutParent: 0,
    errors: [],
  }

  try {
    // 1. Leer productos (todos o solo los SKUs objetivo)
    const allProducts = await fetchAllRows<{
      id: string
      company_id: string | null
      sku: string
      bsale_product_type_name: string | null
      bsale_variant_id: number | null
      is_active: boolean
    }>(() => {
      let query = db
        .from('products')
        .select('id, company_id, sku, bsale_product_type_name, bsale_variant_id, is_active')
        .eq('company_id', companyId)
      if (targetSkus && targetSkus.length > 0) query = query.in('sku', targetSkus)
      return query.order('id')
    })
    result.productsScanned = allProducts.length

    const withProductType = allProducts.filter(p => p.bsale_product_type_name)
    result.productsWithProductType = withProductType.length
    result.productsWithoutProductType = allProducts.length - withProductType.length

    // 2. Leer todos los suppliers BSALE_OPERATIVE (globales + empresa)
    const orFilter = `company_id.is.null,company_id.eq.${companyId}`
    const allSuppliers = await fetchAllRows<{
      id: string
      business_name: string
      company_id: string | null
      parent_supplier_id: string | null
      supplier_kind: string
    }>(() => db
      .from('suppliers')
      .select('id, business_name, company_id, parent_supplier_id, supplier_kind')
      .eq('supplier_kind', 'BSALE_OPERATIVE')
      .or(orFilter)
      .order('id'))
    result.operativeSuppliersFound = allSuppliers.length
    result.operativeSuppliersWithoutParent = allSuppliers.filter(s => !s.parent_supplier_id).length

    // 3. Leer todos los suppliers REAL (para detectar conflictos manuales)
    const realSuppliers = await fetchAllRows<{ id: string }>(() => db
      .from('suppliers')
      .select('id')
      .eq('supplier_kind', 'REAL')
      .or(orFilter)
      .order('id'))

    const realSupplierIds = new Set(realSuppliers.map(s => s.id))

    // 4. Leer mappings activos existentes
    type ExistingMapping = {
      id: string
      company_id: string
      sku: string
      product_id: string | null
      supplier_id: string
      bsale_variant_id: number | null
      is_preferred: boolean
    }
    const existingMappings = await fetchAllRows<ExistingMapping>(() => {
      let query = db
        .from('product_supplier_mappings')
        .select('id, company_id, sku, product_id, supplier_id, bsale_variant_id, is_active, is_preferred')
        .eq('company_id', companyId)
        .eq('is_active', true)
      if (targeted) query = query.in('sku', targetSkus!)
      return query.order('id')
    })
    result.mappingsScanned = existingMappings.length

    const productById = new Map(allProducts.map(product => [product.id, product]))
    const productsBySku = new Map<string, typeof allProducts>()
    const productsByVariant = new Map<number, typeof allProducts>()
    for (const product of allProducts) {
      const skuKey = `${product.company_id}|${product.sku}`
      productsBySku.set(skuKey, [...(productsBySku.get(skuKey) || []), product])
      if (product.bsale_variant_id !== null && product.bsale_variant_id !== undefined) {
        productsByVariant.set(product.bsale_variant_id, [...(productsByVariant.get(product.bsale_variant_id) || []), product])
      }
    }

    const mappingPlans = (existingMappings || []).map(rawMapping => {
      const mapping = { ...rawMapping }
      const skuProducts = productsBySku.get(`${companyId}|${mapping.sku}`) || []
      const productBySku = skuProducts.length === 1 ? skuProducts[0] : null
      const productByMappingId = mapping.product_id ? productById.get(mapping.product_id) : null
      const productByMappingVariant = mapping.bsale_variant_id === null
        ? null
        : (productsByVariant.get(mapping.bsale_variant_id) || []).find(product => product.company_id === companyId) || null
      const targetProduct = productBySku
        || (productByMappingId?.company_id === companyId ? productByMappingId : null)
        || productByMappingVariant
      return { mapping, targetProduct }
    })

    const plansByTarget = new Map<string, typeof mappingPlans>()
    for (const plan of mappingPlans) {
      if (!plan.targetProduct) continue
      const targetKey = `${plan.mapping.company_id}|${plan.mapping.supplier_id}|${plan.targetProduct.sku}`
      plansByTarget.set(targetKey, [...(plansByTarget.get(targetKey) || []), plan])
    }

    const existingBySku = new Map<string, ExistingMapping[]>()
    for (const plans of plansByTarget.values()) {
      const orderedPlans = [...plans].sort((a, b) => Number(b.mapping.is_preferred) - Number(a.mapping.is_preferred) || a.mapping.id.localeCompare(b.mapping.id))
      const keeper = orderedPlans[0]

      for (const duplicate of orderedPlans.slice(1)) {
        if (!duplicate.targetProduct) continue
        if (!isSkuInScope(duplicate.mapping.sku, targetSkus) || !isSkuInScope(duplicate.targetProduct.sku, targetSkus)) continue
        if (!dryRun) {
          const { error: deactivateErr } = await db.from('product_supplier_mappings').update({ is_active: false }).eq('id', duplicate.mapping.id)
          if (deactivateErr) result.errors.push(`Error desactivando mapping duplicado ${duplicate.mapping.id}: ${deactivateErr.message}`)
        }
      }

      const { mapping, targetProduct } = keeper

      if (!targetProduct) {
        continue
      }

      if (!isSkuInScope(mapping.sku, targetSkus) || !isSkuInScope(targetProduct.sku, targetSkus)) {
        result.errors.push(`Mapping fuera de scope dirigido omitido: ${mapping.id}`)
        continue
      }

      if (!isProductSupplierMappingCoherent(mapping, targetProduct)) {
        const repair = {
          product_id: targetProduct.id,
          sku: targetProduct.sku,
          bsale_variant_id: targetProduct.bsale_variant_id,
        }
        if (!dryRun) {
          const { error: repairErr } = await db.from('product_supplier_mappings').update(repair).eq('id', mapping.id)
          if (repairErr) {
            result.errors.push(`Error reparando mapping ${mapping.id}: ${repairErr.message}`)
            continue
          }
        }
        Object.assign(mapping, repair)
        result.mappingsUpdated++
      }

      const arr = existingBySku.get(mapping.sku) || []
      arr.push(mapping)
      existingBySku.set(mapping.sku, arr)
    }

    for (const plan of mappingPlans.filter(plan => !plan.targetProduct)) {
      if (!isSkuInScope(plan.mapping.sku, targetSkus)) continue
      if (!dryRun) {
        const { error: deactivateErr } = await db.from('product_supplier_mappings').update({ is_active: false }).eq('id', plan.mapping.id)
        if (deactivateErr) result.errors.push(`Error desactivando mapping sin producto ${plan.mapping.id}: ${deactivateErr.message}`)
      }
    }

    // 5. Construir índice de suppliers por business_name
    const supplierByName = new Map<string, typeof allSuppliers[0]>()
    for (const s of allSuppliers) {
      const key = s.business_name?.trim().toLowerCase()
      if (key) supplierByName.set(key, s)
    }

    // 6. Procesar cada producto
    for (const product of withProductType) {
      if (!product.sku) continue

      const typeName = product.bsale_product_type_name?.trim()
      if (!typeName) continue

      const typeKey = typeName.toLowerCase()
      const supplier = supplierByName.get(typeKey)

      if (!supplier) {
        // No hay supplier BSALE_OPERATIVE para este product_type
        if (!dryRun) {
          try {
            const { error: createErr } = await db.from('suppliers').insert({
              company_id: companyId,
              business_name: typeName,
              bsale_product_type_name: typeName,
              supplier_kind: 'BSALE_OPERATIVE',
              is_active: true,
              source: 'BSALE',
            })
            if (createErr) throw createErr
            result.operativeSuppliersCreated++

            // Re-construir indice con el nuevo supplier
            const { data: newSup } = await db
              .from('suppliers')
              .select('id, business_name, company_id, parent_supplier_id, supplier_kind')
              .eq('business_name', typeName)
              .or(`company_id.is.null,company_id.eq.${companyId}`)
              .single()
            if (newSup) {
              supplierByName.set(typeKey, newSup)
              result.operativeSuppliersFound++
              // Continuar con el nuevo supplier
              const sk = newSup
              // Intentar crear mapping
              await processMapping(db, companyId, product, sk, existingBySku, realSupplierIds, result, dryRun, targetSkus)
            }
          } catch (err: any) {
            result.errors.push(`Error creando supplier ${typeName}: ${err.message}`)
          }
        } else {
          result.productsWithoutResolvedSupplier++
        }
        continue
      }

      await processMapping(db, companyId, product, supplier, existingBySku, realSupplierIds, result, dryRun, targetSkus)
    }
  } catch (err: any) {
    result.errors.push(`Error general en auto-mapping: ${err.message}`)
  }

  return result
}

export interface PendingAlert {
  type: string
  sku?: string
  product_name?: string
  product_type?: string
  supplier_name?: string
  detail: string
}

export async function getMappingPendingAlerts(companyId: string): Promise<{
  alerts: PendingAlert[]
  counts: {
    sinProductType: number
    sinBsaleOperative: number
    sinParentSupplier: number
    sinMapping: number
    multiMapping: number
    conflictManual: number
  }
}> {
  const db = adqDb()

  const counts = {
    sinProductType: 0,
    sinBsaleOperative: 0,
    sinParentSupplier: 0,
    sinMapping: 0,
    multiMapping: 0,
    conflictManual: 0,
  }

  const alerts: PendingAlert[] = []

  try {
    const { data: products } = await db
      .from('products')
      .select('id, sku, description, bsale_product_type_name, is_active')
      .eq('company_id', companyId)
    const allProds = products || []

    // Productos activos sin product_type
    const noType = allProds.filter(p => p.is_active && !p.bsale_product_type_name)
    counts.sinProductType = noType.length
    noType.slice(0, 20).forEach(p => alerts.push({
      type: 'SIN_PRODUCT_TYPE', sku: p.sku, product_name: p.description,
      detail: `Producto activo sin bsale_product_type_name`,
    }))

    const orFilter = `company_id.is.null,company_id.eq.${companyId}`
    const { data: suppliers } = await db
      .from('suppliers')
      .select('id, business_name, parent_supplier_id, supplier_kind')
      .eq('supplier_kind', 'BSALE_OPERATIVE')
      .or(orFilter)
    const allSuppliers = suppliers || []
    const supByName = new Map(allSuppliers.map(s => [s.business_name?.trim().toLowerCase(), s]))
    const supNoParent = allSuppliers.filter(s => !s.parent_supplier_id)
    counts.sinParentSupplier = supNoParent.length
    supNoParent.slice(0, 20).forEach(s => alerts.push({
      type: 'BSALE_OPERATIVE_SIN_PARENT', supplier_name: s.business_name,
      detail: `BSALE_OPERATIVE sin proveedor real asociado`,
    }))

    // Productos con product_type pero sin BSALE_OPERATIVE
    const noOper = allProds.filter(p => p.bsale_product_type_name && !supByName.has(p.bsale_product_type_name.trim().toLowerCase()))
    counts.sinBsaleOperative = noOper.length
    noOper.slice(0, 20).forEach(p => alerts.push({
      type: 'PRODUCT_TYPE_SIN_BSALE_OPERATIVE', sku: p.sku, product_name: p.description, product_type: p.bsale_product_type_name!,
      detail: `Product type ${p.bsale_product_type_name} no existe como BSALE_OPERATIVE`,
    }))

    // Productos activos sin mapping
    const { data: mappings } = await db
      .from('product_supplier_mappings')
      .select('sku')
      .eq('company_id', companyId)
      .eq('is_active', true)
    const mappedSkus = new Set((mappings || []).map(m => m.sku))
    const noMap = allProds.filter(p => p.is_active && !mappedSkus.has(p.sku))
    counts.sinMapping = noMap.length
    noMap.slice(0, 20).forEach(p => alerts.push({
      type: 'PRODUCTO_SIN_MAPPING', sku: p.sku, product_name: p.description, product_type: p.bsale_product_type_name || undefined,
      detail: `Producto activo sin mapping a proveedor`,
    }))

    // Multi-mappings activos
    const multiMap = new Map<string, number>()
    for (const m of (mappings || [])) {
      multiMap.set(m.sku, (multiMap.get(m.sku) || 0) + 1)
    }
    const multiSkus = [...multiMap.entries()].filter(([_, c]) => c > 1)
    counts.multiMapping = multiSkus.length
    multiSkus.slice(0, 20).forEach(([sku]) => alerts.push({
      type: 'MULTIPLE_MAPPINGS', sku,
      detail: `SKU con múltiples mappings activos`,
    }))
  } catch (err: any) {
    alerts.push({ type: 'ERROR', detail: `Error obteniendo alertas: ${err.message}` })
  }

  return { alerts, counts }
}

async function processMapping(
  db: ReturnType<typeof adqDb>,
  companyId: string,
  product: { id: string; sku: string; bsale_product_type_name?: string | null; bsale_variant_id?: number | null },
  supplier: { id: string; business_name: string; parent_supplier_id?: string | null },
  existingBySku: Map<string, { id: string; company_id: string; sku: string; product_id: string | null; supplier_id: string; bsale_variant_id: number | null; is_preferred: boolean }[]>,
  realSupplierIds: Set<string>,
  result: AutoMappingResult,
  dryRun: boolean,
  targetSkus?: string[],
) {
  const sku = product.sku
  if (!sku || !isSkuInScope(sku, targetSkus)) return

  const existingForSku = existingBySku.get(sku)

  if (existingForSku && existingForSku.length > 0) {
    // Ya existe mapping activo para este SKU
    const mappedToThisSupplier = existingForSku.find(m => m.supplier_id === supplier.id && m.product_id === product.id && m.bsale_variant_id === product.bsale_variant_id)
    if (mappedToThisSupplier) {
      result.mappingsSkippedExisting++
      return
    }

    // Hay mapping a otro supplier
    const hasManualMapping = existingForSku.some(m => realSupplierIds.has(m.supplier_id))
    if (hasManualMapping) {
      result.mappingsSkippedManualConflict++
      return
    }

    // Mapping a otro BSALE_OPERATIVE → posible cambio de product_type
      // Desactivar el mapping anterior y crear el nuevo
      if (!dryRun) {
        for (const old of existingForSku) {
          if (!isSkuInScope(old.sku, targetSkus)) continue
          await db.from('product_supplier_mappings').update({ is_active: false }).eq('id', old.id)
      }
      existingBySku.delete(sku)
    }
  }

  if (!dryRun) {
    try {
      const { error: insErr } = await db.from('product_supplier_mappings').insert({
        company_id: companyId,
        product_id: product.id,
        supplier_id: supplier.id,
        bsale_variant_id: product.bsale_variant_id || null,
        sku: sku,
        product_name: null,
        unit_cost: null,
        is_preferred: false,
        is_active: true,
      })
      if (insErr) throw insErr
      result.mappingsCreated++
    } catch (err: any) {
      if (err.code === '23505') {
        result.mappingsSkippedExisting++
      } else {
        result.errors.push(`Error creando mapping para SKU ${sku}: ${err.message}`)
      }
    }
  } else {
    result.mappingsCreated++
  }
}
