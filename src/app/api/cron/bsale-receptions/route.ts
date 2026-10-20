import { NextResponse } from 'next/server'
import { syncBsaleReceptions } from '@/lib/integraciones/bsale-receptions-sync'

const CRON_SECRET = process.env.CRON_SECRET
const COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'

export async function POST(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await syncBsaleReceptions({
      companyId: COMPANY_ID,
      trigger: 'SCHEDULED',
    })

    if (result.status === 'FAILED') {
      return NextResponse.json(result, { status: 500 })
    }
    if (result.status === 'NO_WATERMARK') {
      return NextResponse.json(result, { status: 500 })
    }
    if (result.status === 'SKIPPED_LOCKED') {
      return NextResponse.json(result, { status: 409 })
    }

    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 })
  }
}
