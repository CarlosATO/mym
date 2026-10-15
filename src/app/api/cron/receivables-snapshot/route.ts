import { NextResponse } from 'next/server'
import { runReceivablesSnapshot } from '@/lib/integraciones/bsale-receivable-snapshot-runner'

export const maxDuration = 600

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ success: false, error: 'CRON_SECRET is not configured on the server' }, { status: 500 })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await runReceivablesSnapshot({
      consumeManualDispatchClaim: request.headers.get('x-cxc-snapshot-only') === 'true',
      manualDispatchClaimId: request.headers.get('x-cxc-manual-claim-id'),
    })
    if (result.skipped === 'SYNC_ACTIVE') return NextResponse.json({ success: false, ...result }, { status: 409 })
    if (result.skipped === 'SNAPSHOT_LOCKED') return NextResponse.json({ success: false, ...result }, { status: 409 })
    if (result.rateLimited || result.run?.status === 'RUNNING') {
      return NextResponse.json({ success: false, ...result }, { status: 202 })
    }
    return NextResponse.json({ success: result.run?.status === 'COMPLETED', ...result }, { status: result.run?.status === 'COMPLETED' ? 200 : 500 })
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Receivables snapshot failed' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ success: false, error: 'Method Not Allowed' }, { status: 405 })
}
