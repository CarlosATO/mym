import { NextResponse } from 'next/server'
import { runCollectionPaymentWorker } from '@/lib/comercial/collection-payment-worker'

export const maxDuration = 120

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ success: false, error: 'CRON_SECRET is not configured on the server' }, { status: 500 })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const result = await runCollectionPaymentWorker()
    return NextResponse.json({ success: true, ...result }, { status: 200 })
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Collection payment worker failed' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ success: false, error: 'Method Not Allowed' }, { status: 405 })
}
