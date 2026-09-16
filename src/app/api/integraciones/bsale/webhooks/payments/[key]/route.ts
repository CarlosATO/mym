import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  // 1. Validar el secret / receiver key con comparación en tiempo constante
  const { key } = await params
  const expectedKey = process.env.BSALE_WEBHOOK_RECEIVER_KEY
  if (!expectedKey) {
    return new NextResponse('Not found', { status: 404 })
  }
  
  const expectedBuffer = Buffer.from(expectedKey)
  const providedBuffer = Buffer.from(key)
  
  if (
    expectedBuffer.length !== providedBuffer.length || 
    !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    // Retornamos 404 para ofuscar que aquí existe un endpoint de webhook si la clave es incorrecta
    return new NextResponse('Not found', { status: 404 })
  }

  // 2. Validar Content-Type y Content-Length
  if (!req.headers.get('content-type')?.includes('application/json')) {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 400 })
  }

  const contentLengthStr = req.headers.get('content-length')
  if (contentLengthStr) {
    const contentLength = parseInt(contentLengthStr, 10)
    if (!Number.isNaN(contentLength) && contentLength > 16384) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    }
  }

  // 3. Leer payload con límite de tamaño (16 KB) mediante streams (Next.js Request body)
  let payload: unknown
  let textBody = ''
  let totalBytes = 0
  try {
    if (req.body) {
      const reader = req.body.getReader()
      const decoder = new TextDecoder('utf-8')
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          totalBytes += value.length
          if (totalBytes > 16384) {
            return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
          }
          textBody += decoder.decode(value, { stream: true })
        }
      }
      textBody += decoder.decode() // flush
    }
    
    if (!textBody) {
      return NextResponse.json({ error: 'Empty body' }, { status: 400 })
    }
    
    payload = JSON.parse(textBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { cpnId, resource, resourceId, topic, action, send } = payload as Record<string, unknown>

  // 4. Validación estructural estricta
  if (typeof cpnId !== 'string' && typeof cpnId !== 'number') {
    return NextResponse.json({ error: 'cpnId missing or invalid' }, { status: 400 })
  }
  if (typeof resource !== 'string' || !resource) {
    return NextResponse.json({ error: 'resource missing or invalid' }, { status: 400 })
  }
  if (typeof resourceId !== 'number' || resourceId <= 0 || !Number.isInteger(resourceId)) {
    return NextResponse.json({ error: 'resourceId must be a positive integer' }, { status: 400 })
  }
  if (topic !== 'payment') {
    return NextResponse.json({ error: 'topic must be payment' }, { status: 400 })
  }
  if (action !== 'POST' && action !== 'PUT') {
    return NextResponse.json({ error: 'action must be POST or PUT' }, { status: 400 })
  }
  if (typeof send !== 'number' || send <= 0 || !Number.isInteger(send)) {
    return NextResponse.json({ error: 'send must be a valid unix timestamp' }, { status: 400 })
  }

  // 5. Generar Fingerprint determinista
  const cpnIdStr = String(cpnId)
  const fingerprintString = `${cpnIdStr}|${topic}|${resourceId}|${action}|${send}`
  const eventFingerprint = crypto.createHash('sha256').update(fingerprintString).digest('hex')

  // 6. Preparar datos para persistencia
  // send epoch es usualmente segundos desde unix epoch
  // si send está en milisegundos, lo ajustamos, pero asumimos segundos según docs estándar
  const isMillis = send > 1e11
  const sentAt = new Date(isMillis ? send : send * 1000).toISOString()

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  
  if (!supabaseUrl || !serviceKey) {
    console.error('[Bsale Webhook] Error interno: credenciales de base de datos no configuradas')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const db = createClient(supabaseUrl, serviceKey, {
    db: { schema: 'integraciones' },
    auth: { persistSession: false, autoRefreshToken: false }
  })

  // 7. Persistencia append-only
  // company_id = null y status = 'UNMAPPED' (Mapping se hará asíncronamente en GC-01C2)
  const { error } = await db.from('bsale_webhook_events').insert({
    company_id: null,
    provider: 'BSALE',
    cpn_id: cpnIdStr,
    topic,
    action,
    resource,
    resource_id: resourceId,
    send_epoch: send,
    sent_at: sentAt,
    event_fingerprint: eventFingerprint,
    payload,
    status: 'UNMAPPED',
    attempts: 0
  })

  if (error) {
    // Si el error es de unicidad (ya recibimos este evento exacto), devolvemos 200 (Idempotencia)
    // Código de Postgres para unique_violation es '23505'
    if (error.code === '23505') {
      return NextResponse.json({ success: true, message: 'Duplicate event acknowledged' })
    }
    
    console.error('[Bsale Webhook] Error guardando evento:', error.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // 8. Responder HTTP 200 de inmediato
  return NextResponse.json({ success: true })
}

// Rechazar explícitamente otros métodos HTTP
export async function GET() {
  return new NextResponse('Method Not Allowed', { status: 405 })
}
export async function PUT() {
  return new NextResponse('Method Not Allowed', { status: 405 })
}
export async function DELETE() {
  return new NextResponse('Method Not Allowed', { status: 405 })
}
