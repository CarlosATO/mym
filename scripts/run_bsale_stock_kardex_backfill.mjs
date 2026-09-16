import { syncBsaleStockKardex } from '../src/lib/integraciones/bsale-stock-kardex.ts'

const to = new Date('2026-09-16T00:00:00Z')
const from = new Date(to)
from.setUTCDate(from.getUTCDate() - 59)
const day = value => value.toISOString().slice(0, 10)
const companyId = 'd1000000-0000-0000-0000-000000000001'

const result = await syncBsaleStockKardex({
  companyId,
  officeId: 1,
  dateFrom: day(from),
  dateTo: day(to),
})
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (!result.success) process.exitCode = 1
