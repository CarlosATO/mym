import { NextResponse } from 'next/server'
import { runReceivablesSnapshot } from '@/lib/integraciones/bsale-receivable-snapshot-runner'

export const maxDuration = 600

function describeSnapshotError(error: unknown) {
  const detail = error && typeof error === 'object'
    ? error as { name?: unknown; code?: unknown; message?: unknown }
    : null
  return {
    name: typeof detail?.name === 'string' ? detail.name : typeof error,
    code: typeof detail?.code === 'string' ? detail.code : null,
    message: typeof detail?.message === 'string' ? detail.message.slice(0, 500) : String(error).slice(0, 500),
  }
}

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
    // Diagnose non-Error objects returned by downstream clients without logging tokens or request headers.
    console.error('[receivables-snapshot] Execution failed', describeSnapshotError(error))
    return NextResponse.json({ success: false, error: 'Receivables snapshot failed' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ success: false, error: 'Method Not Allowed' }, { status: 405 })
}
