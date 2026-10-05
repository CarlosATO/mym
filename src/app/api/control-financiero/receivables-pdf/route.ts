/**
 * Proxy server-side para PDFs de Bsale.
 *
 * El token de Bsale NUNCA se expone al navegador.
 *
 * ── CAUSA DEL BLOQUEO ORIGINAL ──────────────────────────────────────────────
 * La url_pdf almacenada (app2.bsale.cl/view/56713/HASH.pdf?sfd=99) devuelve
 * HTTP 302 hacia /view/show_pdf?cpn_id=...&document_token=...
 *
 * fetch() con redirect:'follow' seguía el redirect PERO no propagaba la cookie
 * de sesión que Bsale establece en el Set-Cookie del 302.
 * Resultado: el hop final entregaba HTML (157 bytes) con Content-Type
 * incorrecto "application/pdf" → Chrome lo interpretaba como contenido inválido
 * y mostraba "Chrome bloqueó esta página".
 *
 * ── SOLUCIÓN ─────────────────────────────────────────────────────────────────
 * 1. Primer fetch con redirect:'manual' → capturar Location + Set-Cookie.
 * 2. Si 302 → fetch al destino final propagando la cookie de sesión Bsale.
 * 3. Validar magic bytes %PDF- antes de responder.
 * 4. Emitir SOLO headers necesarios (no reenviar X-Frame-Options, CSP, etc.).
 *
 * Query params:
 *   ?url=<url_pdf_encoded>&company=<company_id>&folio=<folio>&type=<doc_type>
 *   &download=1  (opcional — fuerza Content-Disposition: attachment)
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getBsaleConfigForCompany } from '@/lib/bsale/company-config'

const ALLOWED_BSALE_HOSTS = [
  'app.bsale.cl',
  'app2.bsale.cl',
  'api.bsale.cl',
  'api.bsale.io',
  'app.bsale.io',
]

const PDF_MAGIC = '%PDF'

function isAllowedBsaleUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return (
      parsed.protocol === 'https:' &&
      ALLOWED_BSALE_HOSTS.includes(parsed.hostname)
    )
  } catch {
    return false
  }
}

/**
 * Fetch con seguimiento manual de un redirect Bsale.
 *
 * Bsale /view/HASH.pdf?sfd=99 → 302 → /view/show_pdf?...
 * El Set-Cookie del 302 es necesario para que el destino final responda con PDF.
 *
 * Seguimos SOLO un nivel de redirect dentro del allow-list.
 * No seguimos redirects a dominios externos.
 */
async function fetchBsalePdf(
  url: string,
  accessToken: string,
): Promise<{ response: Response; resolvedUrl: string }> {
  const baseHeaders: Record<string, string> = {
    access_token: accessToken,
    Accept: 'application/pdf,*/*',
  }

  // Primer intento — sin seguir redirect
  const first = await fetch(url, {
    headers: baseHeaders,
    redirect: 'manual',
    cache: 'no-store',
  })

  // Si responde directamente con PDF (200)
  if (first.status === 200) {
    return { response: first, resolvedUrl: url }
  }

  // Si es un redirect (301/302/303/307/308) hacia un host permitido
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location')
    if (!location) {
      throw new Error(`Bsale respondió ${first.status} sin Location header.`)
    }
    const resolvedUrl = new URL(location, url).toString()

    if (!isAllowedBsaleUrl(resolvedUrl)) {
      throw new Error('Redirect a URL no permitida.')
    }

    // Propagar la cookie de sesión que Bsale establece en el 302
    const sessionCookie = first.headers.get('set-cookie')
    const secondHeaders: Record<string, string> = { ...baseHeaders }
    if (sessionCookie) {
      // Extraer solo el valor de la cookie (parte antes del primer ';')
      const cookieValue = sessionCookie.split(';')[0]?.trim()
      if (cookieValue) secondHeaders['Cookie'] = cookieValue
    }

    const second = await fetch(resolvedUrl, {
      headers: secondHeaders,
      redirect: 'manual', // No seguir más redirects — falla explícitamente
      cache: 'no-store',
    })

    return { response: second, resolvedUrl }
  }

  // Otros status (4xx, 5xx) → devolvemos tal cual para manejar el error
  return { response: first, resolvedUrl: url }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const rawUrl = searchParams.get('url')
  const companyId = searchParams.get('company')
  const folio = searchParams.get('folio') ?? 'documento'
  const docType = searchParams.get('type') ?? 'factura'
  const isDownload = searchParams.get('download') === '1'

  if (!rawUrl || !companyId) {
    return NextResponse.json(
      { detail: 'Parámetros requeridos: url, company.' },
      { status: 400 },
    )
  }

  if (!isAllowedBsaleUrl(rawUrl)) {
    return NextResponse.json(
      { detail: 'URL de documento no permitida.' },
      { status: 422 },
    )
  }

  let accessToken: string
  try {
    const config = getBsaleConfigForCompany(companyId)
    accessToken = config.accessToken
  } catch {
    return NextResponse.json(
      { detail: 'Empresa no configurada para acceso a documentos.' },
      { status: 403 },
    )
  }

  let upstream: Response
  try {
    const result = await fetchBsalePdf(rawUrl, accessToken)
    upstream = result.response
  } catch (err) {
    console.error(
      '[receivables-pdf] fetch error:',
      err instanceof Error ? err.message : 'unknown error',
    )
    return NextResponse.json(
      { detail: 'No se pudo obtener el documento desde Bsale.' },
      { status: 502 },
    )
  }

  if (!upstream.ok) {
    return NextResponse.json(
      { detail: `Bsale respondió ${upstream.status}.` },
      { status: upstream.status >= 500 ? 502 : upstream.status },
    )
  }

  // ── Validar que realmente es un PDF ────────────────────────────────────────
  const body = await upstream.arrayBuffer()
  const magicBytes = new TextDecoder('ascii', { fatal: false }).decode(
    new Uint8Array(body).slice(0, 4),
  )

  if (!magicBytes.startsWith(PDF_MAGIC)) {
    console.error(`[receivables-pdf] Body no es PDF. Primeros bytes: ${magicBytes}`)
    return NextResponse.json(
      { detail: 'El documento obtenido no es un PDF válido.' },
      { status: 502 },
    )
  }

  // ── Nombre de archivo para descarga ────────────────────────────────────────
  const safeFolio = String(folio).replace(/[^a-zA-Z0-9\-_]/g, '')
  const safeTypeValue = String(docType).toLowerCase()
  const safeType = (safeTypeValue.includes('factura') ? 'factura' : safeTypeValue)
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .slice(0, 32)
  const filename = `${safeType}-${safeFolio}.pdf`

  // ── Respuesta al navegador ─────────────────────────────────────────────────
  // IMPORTANTE: No reenviar X-Frame-Options, CSP, Set-Cookie ni otros headers
  // de Bsale que puedan romper el embedding. Solo headers mínimos necesarios.
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': isDownload
        ? `attachment; filename="${filename}"`
        : `inline; filename="${filename}"`,
      'Content-Length': String(body.byteLength),
      // Sin cache — documentos financieros confidenciales
      'Cache-Control': 'private, no-store',
    },
  })
}
