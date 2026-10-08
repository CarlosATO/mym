import fs from 'node:fs'
import { runReceivablesSnapshot } from '../src/lib/integraciones/bsale-receivable-snapshot-runner.ts'

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
}

function valueFor(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

const startNew = process.argv.includes('--start-new')
const requestedRunId = valueFor('--run-id')
const limit = Number(valueFor('--limit') || 20)
if (startNew === Boolean(requestedRunId)) throw new Error('Usa exactamente uno de --start-new o --run-id <uuid>.')

const result = await runReceivablesSnapshot({
  runId: requestedRunId || undefined,
  batchSize: limit,
  forceNew: startNew,
})

console.log(JSON.stringify({
  company_id: 'd1000000-0000-0000-0000-000000000001',
  universe: result.universe,
  run: result.run,
  skipped: result.skipped,
  mode: startNew ? 'START_NEW' : 'RESUME',
  requested_limit: limit,
  remaining_clients: result.result?.remainingClientIds.length ?? null,
  duration_ms: result.duration_ms,
}, null, 2))
