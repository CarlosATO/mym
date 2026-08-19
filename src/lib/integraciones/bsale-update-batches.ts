export const UPDATE_BATCH_SIZE = 500

export interface BatchExecutionSummary {
  batchesProcessed: number
  itemsProcessed: number
}

export async function executeSequentialBatches<T>(
  items: T[],
  executeBatch: (batch: T[], batchIndex: number, totalBatches: number) => Promise<void>
): Promise<BatchExecutionSummary> {
  const totalBatches = Math.ceil(items.length / UPDATE_BATCH_SIZE)
  let batchesProcessed = 0
  let itemsProcessed = 0

  for (let offset = 0; offset < items.length; offset += UPDATE_BATCH_SIZE) {
    const batch = items.slice(offset, offset + UPDATE_BATCH_SIZE)
    await executeBatch(batch, batchesProcessed, totalBatches)
    batchesProcessed++
    itemsProcessed += batch.length
  }

  return { batchesProcessed, itemsProcessed }
}

export function shouldRunProductSupplierMappings(productsStatus: string): boolean {
  return productsStatus === 'SUCCESS'
}
