import dotenv from 'dotenv'
import path from 'path'
import { syncBsaleProducts } from '../src/lib/integraciones/bsale-products-sync'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const isDryRun = process.argv.includes('--dry-run') || !process.argv.includes('--apply')
const recordRun = process.argv.includes('--record-run')
const limitArgIndex = process.argv.indexOf('--limit')
const limitOverride = limitArgIndex > -1 ? parseInt(process.argv[limitArgIndex + 1]) : null
const companyIdArgIndex = process.argv.indexOf('--company-id')
const targetCompanyId = companyIdArgIndex > -1 ? process.argv[companyIdArgIndex + 1] : 'd1000000-0000-0000-0000-000000000001'

async function run() {
  console.log(`Iniciando sincronización (CLI). Modo: ${isDryRun ? 'DRY-RUN' : 'APPLY'}`)
  
  const result = await syncBsaleProducts({
    companyId: targetCompanyId,
    triggerType: 'CLI',
    isDryRun,
    recordDryRun: recordRun,
    limitOverride
  })

  console.log('\n--- RESULTADO FINAL ---')
  console.log('Status:', result.status)
  if (result.message) console.log('Message:', result.message)
  console.log('Stats:', JSON.stringify(result.stats, null, 2))
}

run()
