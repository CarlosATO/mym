import { syncBsaleProducts } from './bsale-products-sync'
import { syncBsaleProductTypes } from './bsale-product-types-sync'
import { syncProductSupplierMappings, AutoMappingResult } from './bsale-auto-mapping'
import { shouldRunProductSupplierMappings } from './bsale-update-batches'
import { syncOperativeSupplierParents, OperativeParentSyncResult } from './bsale-operative-parent-sync'

interface CatalogStepResult {
  status: string
  message?: string
  error?: unknown
  stats?: unknown
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getStat(stats: unknown, key: 'newProducts' | 'updatedProducts'): number {
  if (!stats || typeof stats !== 'object') return 0
  const value = (stats as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : 0
}

export interface CatalogAutoSyncResult {
  productTypesResult: CatalogStepResult
  productsResult: CatalogStepResult
  operativeParentResult: OperativeParentSyncResult
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

  let productTypesResult: CatalogStepResult = { status: '', stats: {} }
  let productsResult: CatalogStepResult = { status: '', stats: {} }
  let operativeParentResult: OperativeParentSyncResult = {
    scanned: 0, alreadyCorrect: 0, assigned: 0, updated: 0,
    noActiveProducts: 0, withoutBrand: 0, multipleBrands: 0,
    brandWithoutLink: 0, invalidRealSupplier: 0, errors: [], pending: [],
  }
  let mappingResult: AutoMappingResult = {
    productsScanned: 0, mappingsScanned: 0, productsWithProductType: 0,
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
    productTypesResult = ptRes
    if (ptRes.status === 'FAILED') {
      finalStatus = 'PARTIAL'
      errorMessage += (errorMessage ? ' | ' : '') + 'ProductTypes: ' + (ptRes.message || '')
    } else if (ptRes.status === 'SKIPPED') {
      console.log(`${logTag} syncBsaleProductTypes skipped (lock)`)
    }
    console.log(`${logTag} ProductTypes: status=${ptRes.status}`)
  } catch (ptErr: unknown) {
    console.error(`${logTag} Error en productTypes:`, ptErr)
    finalStatus = 'PARTIAL'
    errorMessage += (errorMessage ? ' | ' : '') + 'Error en productTypes: ' + getErrorMessage(ptErr)
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
    productsResult = prodRes
    if (prodRes.status !== 'SUCCESS') {
      finalStatus = 'PARTIAL'
      const productError = prodRes.message || getErrorMessage(prodRes.error)
      errorMessage += (errorMessage ? ' | ' : '') + 'Products: ' + productError
      if (prodRes.status === 'SKIPPED') {
        console.log(`${logTag} syncBsaleProducts skipped (lock)`)
      }
    }
    console.log(`${logTag} Products: status=${prodRes.status} new=${getStat(prodRes.stats, 'newProducts')} upd=${getStat(prodRes.stats, 'updatedProducts')}`)
  } catch (prodErr: unknown) {
    console.error(`${logTag} Error en products:`, prodErr)
    finalStatus = 'PARTIAL'
    errorMessage += (errorMessage ? ' | ' : '') + 'Error en products: ' + getErrorMessage(prodErr)
  }

  if (!shouldRunProductSupplierMappings(productsResult.status)) {
    console.log(`${logTag} Mappings omitidos porque products terminó con status=${productsResult.status}`)
    return { productTypesResult, productsResult, operativeParentResult, mappingResult, finalStatus, errorMessage }
  }

  // Step 0c: Resolve operative supplier → approved REAL parent by active Bsale brand
  console.log(`${logTag} Iniciando syncOperativeSupplierParents...`)
  try {
    operativeParentResult = await syncOperativeSupplierParents(companyId, { dryRun: false })
    if (operativeParentResult.errors.length > 0) {
      finalStatus = 'PARTIAL'
      errorMessage += (errorMessage ? ' | ' : '') + 'Operative parents: ' + operativeParentResult.errors.join('; ')
    }
    console.log(`${logTag} Operative parents: scanned=${operativeParentResult.scanned} assigned=${operativeParentResult.assigned} updated=${operativeParentResult.updated} pending=${operativeParentResult.pending.length}`)
  } catch (parentErr: unknown) {
    console.error(`${logTag} Error en operative parents:`, parentErr)
    finalStatus = 'PARTIAL'
    errorMessage += (errorMessage ? ' | ' : '') + 'Error en operative parents: ' + getErrorMessage(parentErr)
  }

  // Step 0d: Auto-mapping producto → pseudoproveedor
  console.log(`${logTag} Iniciando syncProductSupplierMappings...`)
  try {
    mappingResult = await syncProductSupplierMappings(companyId, { dryRun: false })
    if (mappingResult.errors.length > 0) {
      finalStatus = 'PARTIAL'
      errorMessage += (errorMessage ? ' | ' : '') + 'Mappings: ' + mappingResult.errors.join('; ')
    }
    console.log(`${logTag} Mappings: created=${mappingResult.mappingsCreated} skippedExist=${mappingResult.mappingsSkippedExisting} manualConflict=${mappingResult.mappingsSkippedManualConflict} newOps=${mappingResult.operativeSuppliersCreated} opsNoParent=${mappingResult.operativeSuppliersWithoutParent}`)
  } catch (mapErr: unknown) {
    console.error(`${logTag} Error en auto-mapping:`, mapErr)
    finalStatus = 'PARTIAL'
    errorMessage += (errorMessage ? ' | ' : '') + 'Error en auto-mapping: ' + getErrorMessage(mapErr)
  }

  return { productTypesResult, productsResult, operativeParentResult, mappingResult, finalStatus, errorMessage }
}
