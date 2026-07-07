import { NextRequest, NextResponse } from 'next/server'
import { syncBsaleClients } from '@/lib/integraciones/bsale-clients-sync'

export async function POST(req: NextRequest) {
  return handleSync(req)
}

export async function GET(req: NextRequest) {
  // Allow GET to support simple cron callers like cron-job.org if they only do GET
  return handleSync(req)
}

async function handleSync(req: NextRequest) {
  // Protect with CRON_SECRET
  const authHeader = req.headers.get('authorization')
  if (
    authHeader !== `Bearer ${process.env.CRON_SECRET}` && 
    req.headers.get('x-cron-secret') !== process.env.CRON_SECRET
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Base company ID since we only have one company context for now.
  // In a multi-tenant setup, this job could loop over all enabled configurations in sync_job_configs
  const companyId = 'd1000000-0000-0000-0000-000000000001'

  try {
    const result = await syncBsaleClients({
      companyId,
      triggerType: 'SCHEDULED',
      isDryRun: false,
      recordDryRun: true
    })

    return NextResponse.json({
      status: result.status,
      message: result.message || 'Sync execution completed',
      stats: result.stats
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
