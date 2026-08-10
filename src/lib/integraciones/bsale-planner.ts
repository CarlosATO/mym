export function planUniqueSafeProductUpdates(
  toUpdateProducts: any[],
  existingProducts: any[]
): { orderedUpdates: any[]; conflicts: any[]; cycles: any[] } {
  const orderedUpdates: any[] = [];
  const conflicts: any[] = [];
  const cycles: any[] = [];

  const existingById = new Map<string, any>();
  const currentOwnerBySku = new Map<string, string>();
  const currentOwnerByBarcode = new Map<string, string>();

  for (const ext of existingProducts) {
    existingById.set(ext.id, ext);
    if (ext.sku) currentOwnerBySku.set(String(ext.sku).trim().toUpperCase(), ext.id);
    if (ext.barcode) currentOwnerByBarcode.set(String(ext.barcode).trim(), ext.id);
  }

  const releasingSku = new Set<string>();
  const releasingBarcode = new Set<string>();
  const toUpdateMap = new Map<string, any>();

  for (const update of toUpdateProducts) {
    toUpdateMap.set(update.id, update);
    const ext = existingById.get(update.id);
    if (ext) {
      if (ext.sku && String(ext.sku).trim().toUpperCase() !== String(update.sku || '').trim().toUpperCase()) {
        releasingSku.add(update.id);
      }
      if (ext.barcode && String(ext.barcode).trim() !== String(update.barcode || '').trim()) {
        releasingBarcode.add(update.id);
      }
    }
  }

  const adj = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  for (const update of toUpdateProducts) {
    adj.set(update.id, new Set());
    inDegree.set(update.id, 0);
  }

  const validUpdates = new Set<string>();
  for (const update of toUpdateProducts) {
    let hasConflict = false;
    
    if (update.sku) {
      const newSku = String(update.sku).trim().toUpperCase();
      const currentOwnerId = currentOwnerBySku.get(newSku);
      if (currentOwnerId && currentOwnerId !== update.id) {
        if (releasingSku.has(currentOwnerId)) {
          adj.get(currentOwnerId)!.add(update.id);
          inDegree.set(update.id, inDegree.get(update.id)! + 1);
        } else {
          conflicts.push({
            type: 'UNIQUE_VALUE_CONFLICT',
            field: 'sku',
            requested_value: newSku,
            owner_product_id: currentOwnerId,
            requesting_product_id: update.id
          });
          hasConflict = true;
        }
      }
    }

    if (update.barcode) {
      const newBarcode = String(update.barcode).trim();
      const currentOwnerId = currentOwnerByBarcode.get(newBarcode);
      if (currentOwnerId && currentOwnerId !== update.id) {
        if (releasingBarcode.has(currentOwnerId)) {
          adj.get(currentOwnerId)!.add(update.id);
          inDegree.set(update.id, inDegree.get(update.id)! + 1);
        } else {
          conflicts.push({
            type: 'UNIQUE_VALUE_CONFLICT',
            field: 'barcode',
            requested_value: newBarcode,
            owner_product_id: currentOwnerId,
            requesting_product_id: update.id
          });
          hasConflict = true;
        }
      }
    }

    if (!hasConflict) {
      validUpdates.add(update.id);
    }
  }

  const queue: string[] = [];
  for (const id of Array.from(validUpdates)) {
    if (inDegree.get(id) === 0) {
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    orderedUpdates.push(toUpdateMap.get(curr));
    
    for (const neighbor of adj.get(curr)!) {
      inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
      if (inDegree.get(neighbor) === 0 && validUpdates.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  for (const id of Array.from(validUpdates)) {
    if (inDegree.get(id)! > 0) {
      cycles.push({
        type: 'UNIQUE_REASSIGNMENT_CYCLE',
        product_id: id,
        update: toUpdateMap.get(id)
      });
    }
  }

  return { orderedUpdates, conflicts, cycles };
}
