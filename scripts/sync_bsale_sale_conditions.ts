import 'dotenv/config'
import path from 'path'
import fs from 'fs'

const envLocalPath = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envLocalPath)) {
  const envContent = fs.readFileSync(envLocalPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}
import { syncBsaleSaleConditions } from '../src/lib/integraciones/bsale-sale-conditions-sync'

const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const isApply = args.includes('--apply')
const limitIndex = args.findIndex(a => a.startsWith('--limit='))
const limitOverride = limitIndex !== -1 ? parseInt(args[limitIndex].split('=')[1], 10) || null : null
const companyIdIndex = args.findIndex(a => a.startsWith('--company-id='))
const companyId = companyIdIndex !== -1 ? args[companyIdIndex].split('=')[1] : 'd1000000-0000-0000-0000-000000000001'

async function main() {
  console.log(`[SALE CONDITIONS SYNC] Starting in ${isApply ? 'APPLY' : 'DRY-RUN'} mode.`)
  console.log(`Target company: ${companyId}`)

  const result = await syncBsaleSaleConditions({
    companyId,
    triggerType: 'CLI',
    isDryRun: !isApply,
    recordDryRun: true,
    limitOverride,
  })

  console.log(`\nResult: ${result.status}`)
  if (result.message) console.log(`Message: ${result.message}`)
  if (result.stats) console.log('Stats:', JSON.stringify(result.stats, null, 2))

  process.exit(result.status === 'SUCCESS' ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
