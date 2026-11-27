import { NextResponse } from 'next/server'
import { getBsaleSyncRolloutConfig } from '@/lib/integraciones/bsale-sync-coordinator'
import { ensureBsaleSyncQueueRuntimeRegistered } from '@/lib/integraciones/bsale-sync-queue-runtime'

export const maxDuration = 120

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET is not configured on the server' }, { status: 500 })
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const rollout = getBsaleSyncRolloutConfig()
  if (!rollout.queueEnabled) {
    return NextResponse.json({ success: true, skipped: 'QUEUE_DISABLED_BY_ROLLOUT_FLAG' }, { status: 200 })
  }
  if (!rollout.supervisorEnabled) {
    return NextResponse.json({ success: true, skipped: 'SUPERVISOR_DISABLED_BY_ROLLOUT_FLAG' }, { status: 200 })
  }

  try {
    const manager = ensureBsaleSyncQueueRuntimeRegistered()
    const summary = await manager.drain()
    return NextResponse.json({ success: true, ...summary }, { status: 200 })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Bsale sync queue worker failed' },
      { status: 500 },
    )
  }
}

export async function GET() {
  return NextResponse.json({ success: false, error: 'Method Not Allowed' }, { status: 405 })
}
