import { syncBsaleProducts } from './bsale-products-sync'
import { syncBsaleProductTypes } from './bsale-product-types-sync'
import { syncProductSupplierMappings, AutoMappingResult } from './bsale-auto-mapping'
import { shouldRunProductSupplierMappings } from './bsale-update-batches'

export interface CatalogAutoSyncResult {
  productTypesResult: any
  productsResult: any
  mappingResult: AutoMappingResult
  finalStatus: 'COMPLETED' | 'PARTIAL'
  errorMessage: string
}

export async function runCatalogAutoSyncStep(
  companyId: string,
  trigger: string = 'SCHEDULED',
  context: string = 'SCHEDULED'
): Promise<CatalogAutoSyncResult> {
  let finalStatus: 'COMPLETED' | 'PARTIAL' = 'COMPLETED'
  let errorMessage = ''
  const triggerType = trigger === 'SCHEDULED' ? 'SCHEDULED' : (trigger === 'MANUAL' ? 'MANUAL' : 'SCHEDULED')

  let productTypesResult: any = { status: '', stats: {} }
  let productsResult: any = { status: '', stats: {} }
  let mappingResult: AutoMappingResult = {
    productsScanned: 0, productsWithProductType: 0,
    operativeSuppliersFound: 0, operativeSuppliersCreated: 0,
    mappingsCreated: 0, mappingsUpdated: 0,
    mappingsSkippedExisting: 0, mappingsSkippedManualConflict: 0,
    productsWithoutProductType: 0, productsWithoutResolvedSupplier: 0,
    operativeSuppliersWithoutParent: 0, errors: [],
  }

  // Step 0a: Sync Product Types → creates BSALE_OPERATIVE suppliers
  const logTag = context === 'CATALOG' ? '[bsale-catalog-sync]' : '[runReplenishmentBsaleSync]'
  console.log(`${logTag} Iniciando syncBsaleProductTypes...`)
  try {
    const ptRes = await syncBsaleProductTypes({
      companyId,
      triggerType,
      isDryRun: false,
      recordDryRun: true,
    })
    productTypesResult = ptRes as any
    if (ptRes.status === 'FAILED') {
      finalStatus = 'PARTIAL'
      errorMessage += (errorMessage ? ' | ' : '') + 'ProductTypes: ' + (ptRes.message || '')
    } else if (ptRes.status === 'SKIPPED') {
      console.log(`${logTag} syncBsaleProductTypes skipped (lock)`)
    }
    console.log(`${logTag} ProductTypes: status=${ptRes.status}`)
  } catch (ptErr: any) {
    console.error(`${logTag} Error en productTypes:`, ptErr)
    finalStatus = 'PARTIAL'
    errorMessage += (errorMessage ? ' | ' : '') + 'Error en productTypes: ' + ptErr.message
  }

  // Step 0b: Sync Products + Variants → updates adquisiciones.products
  console.log(`${logTag} Iniciando syncBsaleProducts...`)
  try {
    const prodRes = await syncBsaleProducts({
      companyId,
      triggerType,
      isDryRun: false,
      recordDryRun: true,
    })
    productsResult = prodRes as any
    if (prodRes.status !== 'SUCCESS') {
      finalStatus = 'PARTIAL'
      const productError = prodRes.message || prodRes.error?.message || String(prodRes.error || '')
      errorMessage += (errorMessage ? ' | ' : '') + 'Products: ' + productError
      if (prodRes.status === 'SKIPPED') {
        console.log(`${logTag} syncBsaleProducts skipped (lock)`)
      }
    }
    console.log(`${logTag} Products: status=${prodRes.status} new=${(prodRes.stats as any)?.newProducts || 0} upd=${(prodRes.stats as any)?.updatedProducts || 0}`)
  } catch (prodErr: any) {
    console.error(`${logTag} Error en products:`, prodErr)
    finalStatus = 'PARTIAL'
    errorMessage += (errorMessage ? ' | ' : '') + 'Error en products: ' + prodErr.message
  }

  if (!shouldRunProductSupplierMappings(productsResult.status)) {
    console.log(`${logTag} Mappings omitidos porque products terminó con status=${productsResult.status}`)
    return { productTypesResult, productsResult, mappingResult, finalStatus, errorMessage }
  }

  // Step 0c: Auto-mapping producto → pseudoproveedor
  console.log(`${logTag} Iniciando syncProductSupplierMappings...`)
  try {
    mappingResult = await syncProductSupplierMappings(companyId, { dryRun: false })
    if (mappingResult.errors.length > 0) {
      finalStatus = 'PARTIAL'
      errorMessage += (errorMessage ? ' | ' : '') + 'Mappings: ' + mappingResult.errors.join('; ')
    }
    console.log(`${logTag} Mappings: created=${mappingResult.mappingsCreated} skippedExist=${mappingResult.mappingsSkippedExisting} manualConflict=${mappingResult.mappingsSkippedManualConflict} newOps=${mappingResult.operativeSuppliersCreated} opsNoParent=${mappingResult.operativeSuppliersWithoutParent}`)
  } catch (mapErr: any) {
    console.error(`${logTag} Error en auto-mapping:`, mapErr)
    finalStatus = 'PARTIAL'
    errorMessage += (errorMessage ? ' | ' : '') + 'Error en auto-mapping: ' + mapErr.message
  }

  return { productTypesResult, productsResult, mappingResult, finalStatus, errorMessage }
}
