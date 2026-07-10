import { NextResponse } from 'next/server'
import { runReplenishmentBsaleSync } from '@/app/actions/integraciones/bsale-sync'

const CRON_SECRET = process.env.CRON_SECRET

export async function POST(request: Request) {
  // Fail closed if no secret is configured
  if (!CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET is not configured on the server' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Fixed company_id for MYM (whitelist approach, not accepting arbitrary IDs from body)
  const companyId = 'd1000000-0000-0000-0000-000000000001'

  try {
    const result = await runReplenishmentBsaleSync(companyId)
    
    // Check if skipped due to lock
    if (result.status === 'SKIPPED_LOCKED') {
      return NextResponse.json(result, { status: 409 }) // Conflict
    }

    if (!result.success && result.status === 'FAILED') {
      return NextResponse.json(result, { status: 500 })
    }

    return NextResponse.json(result, { status: 200 })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
