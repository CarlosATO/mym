import type { SalesOrderAuditIncident, SalesOrderAuditLine } from '@/app/actions/logistica/sales-order-audit'

export function pendingBulkAuditLines(
  lines: SalesOrderAuditLine[],
  incidents: SalesOrderAuditIncident[],
  drafts: Record<string, string>,
  focusedLineId: string | null,
): SalesOrderAuditLine[] {
  const open = new Set(incidents.filter(item => item.status === 'OPEN').map(item => item.audit_line_id))
  return lines.filter(line => line.line_status === 'PENDING'
    && line.audit_quantity == null
    && !Object.hasOwn(drafts, line.id)
    && line.id !== focusedLineId
    && !open.has(line.id))
}

// The confirmation RPC locks a line before its audit; commercial acceptance
// locks the audit before its lines. Avoid increasing that deadlock window.
export async function runAuditBulk<T>(
  lines: T[],
  process: (line: T) => Promise<boolean>,
  progress: (done: number, total: number) => void,
  shouldContinue: () => boolean,
): Promise<void> {
  progress(0, lines.length)
  for (let index = 0; index < lines.length && shouldContinue(); index++) {
    const keepGoing = await process(lines[index])
    progress(index + 1, lines.length)
    if (!keepGoing) break
  }
}
