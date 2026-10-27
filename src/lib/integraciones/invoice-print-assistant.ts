export type InvoicePrintWindow = Window | null

export function setInvoicePrintWindowStatus(target: InvoicePrintWindow, title: string, detail?: string) {
  if (!target || target.closed) return
  try {
    const document = target.document
    if (!document.body || !document.getElementById('invoice-print-status')) {
      document.open()
      document.write('<!doctype html><html><head><title>Impresión de factura</title><style>html,body{margin:0;padding:0;background:#f8f5f1;color:#322d29;font-family:system-ui,sans-serif}.status{padding:32px;max-width:720px;margin:auto}.detail{white-space:pre-wrap;color:#6b625c;font-size:14px}@media print{html,body{margin:0!important;padding:0!important;background:#fff!important}#invoice-print-status-panel{display:none!important}}</style></head><body><section id="invoice-print-status-panel" class="status"><h1 id="invoice-print-status"></h1><p id="invoice-print-detail" class="detail"></p></section><div id="invoice-print-pages"></div></body></html>')
      document.close()
    }
    const status = document.getElementById('invoice-print-status')
    const message = document.getElementById('invoice-print-detail')
    if (status) status.textContent = title
    if (message) message.textContent = detail ?? ''
  } catch {
    // La ventana puede haber sido cerrada entre la comprobación y la escritura.
  }
}

const BSALE_HOSTS = new Set(['bsale.cl', 'www.bsale.cl', 'app.bsale.cl', 'app2.bsale.cl'])

export function getSafeHttpsHostname(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !BSALE_HOSTS.has(url.hostname.toLowerCase())) return null
    return url.hostname.toLowerCase()
  } catch {
    return null
  }
}

export function validateBsaleRedirectUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !BSALE_HOSTS.has(url.hostname.toLowerCase())) return null
    const isOfficialPdf = /^\/view\/[^/]+\/[^/]+\.pdf$/i.test(url.pathname)
    const isAuthorizedPdfRelay = url.hostname.toLowerCase() === 'app2.bsale.cl' && url.pathname === '/view/show_pdf'
    if (!isOfficialPdf && !isAuthorizedPdfRelay) return null
    return url.href
  } catch {
    return null
  }
}

export function validateBsalePdfResponseUrl(initialPdfUrl: unknown, responseUrl: unknown): string | null {
  if (!validateBsalePdfUrl(initialPdfUrl)) return null
  if (validateBsalePdfUrl(responseUrl)) return String(responseUrl)
  try {
    const url = new URL(String(responseUrl))
    if (url.protocol === 'https:' && url.hostname.toLowerCase() === 'app2.bsale.cl' && url.pathname === '/view/show_pdf') return url.href
  } catch {
    return null
  }
  return null
}

export function validateBsalePdfUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (!getSafeHttpsHostname(url.href)) return null
    if (!/^\/view\/[^/]+\/[^/]+\.pdf$/i.test(url.pathname)) return null
    return url.href
  } catch {
    return null
  }
}

export function prepareInvoicePrintWindow(open: (url?: string, target?: string, features?: string) => Window | null): InvoicePrintWindow {
  try {
    return open('', '_blank')
  } catch {
    return null
  }
}

export function openConfirmedInvoicePdf(
  target: InvoicePrintWindow,
  pdfUrl: unknown,
  print: (target: Window) => void = windowTarget => windowTarget.print(),
  onPrintError?: (message: string) => void,
): { opened: boolean; printable: boolean; reason?: 'INVALID_URL' | 'POPUP_BLOCKED' | 'CLOSED' } {
  const url = validateBsalePdfUrl(pdfUrl)
  if (!url) return { opened: false, printable: false, reason: 'INVALID_URL' }
  if (!target || target.closed) return { opened: false, printable: false, reason: 'POPUP_BLOCKED' }

  try {
    target.location.href = url
    globalThis.setTimeout(() => {
      try {
        if (!target.closed) {
          target.focus()
          print(target)
        }
      } catch (error) {
        onPrintError?.(error instanceof Error ? error.message : 'Chrome rechazó la solicitud de impresión.')
      }
    }, 800)
    return { opened: true, printable: true }
  } catch {
    return { opened: false, printable: false, reason: 'CLOSED' }
  }
}
