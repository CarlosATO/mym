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
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 500 })
  const authHeader = req.headers.get('authorization')
  if (
    authHeader !== `Bearer ${secret}` &&
    req.headers.get('x-cron-secret') !== secret
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
    }, { status: result.status === 'SUCCESS' ? 200 : result.status === 'SKIPPED' ? 409 : 500 })
  } catch (error: unknown) {
    return NextResponse.json({ status: 'FAILED', error: error instanceof Error ? error.message : 'Error desconocido' }, { status: 500 })
  }
}
