import { NextRequest, NextResponse } from 'next/server'
import { syncBsaleSaleConditions } from '@/lib/integraciones/bsale-sale-conditions-sync'

export async function POST(req: NextRequest) {
  return handleSync(req)
}

export async function GET(req: NextRequest) {
  return handleSync(req)
}

async function handleSync(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (
    authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
    req.headers.get('x-cron-secret') !== process.env.CRON_SECRET
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = 'd1000000-0000-0000-0000-000000000001'

  try {
    const result = await syncBsaleSaleConditions({
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
