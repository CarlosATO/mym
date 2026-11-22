import type { InvoiceInboxSummary, ReceiptInvoiceCandidate } from './types.ts'

export interface ReceiptDueDate {
  candidate_id: string
  invoice_id: string | null
  due_date: string | null
  suggested_due_date: string | null
  due_date_source: 'SAVED' | 'MANUAL' | 'PURCHASE_ORDER' | 'SUPPLIER' | null
}

export interface InboxDueOverride {
  date: string | null
  baseKey: string
  confirmed?: boolean
  source?: ReceiptDueDate['due_date_source']
}

export function resolveInboxDueDate(
  row: ReceiptInvoiceCandidate,
  summary: InvoiceInboxSummary | undefined,
  receiptDue: ReceiptDueDate | undefined,
  override: InboxDueOverride | undefined,
) {
  const serverDate = receiptDue ? receiptDue.due_date : summary ? summary.due_date : row.due_date ?? null
  const baseKey = JSON.stringify([row.invoice_id, serverDate, receiptDue?.due_date_source ?? null])
  const hasOverride = override && (override.confirmed || override.baseKey === baseKey)
  return {
    date: hasOverride ? override.date : serverDate,
    source: hasOverride ? (override.source === undefined ? 'MANUAL' as const : override.source) : receiptDue?.due_date_source ?? (serverDate ? 'SAVED' as const : null),
    baseKey,
  }
}

// Los bloqueos son síncronos para evitar dos envíos antes del siguiente render.
export async function saveOptimisticDueDate<T>(options: {
  locks: Set<string>
  keys: string[]
  start: () => void
  request: () => Promise<T>
  success: (result: T) => void
  failure: (error: unknown) => void
  finish: () => void
}): Promise<boolean> {
  if (options.keys.some(key => options.locks.has(key))) return false
  for (const key of options.keys) options.locks.add(key)
  try {
    options.start()
    options.success(await options.request())
  } catch (error) {
    options.failure(error)
  } finally {
    for (const key of options.keys) options.locks.delete(key)
    options.finish()
  }
  return true
}
