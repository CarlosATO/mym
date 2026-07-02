import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { RouteGuide } from '@/modules/logistica/guias-ruta/types'
import { formatRouteGuideLineAmount, formatPaymentMethodLabel } from '@/modules/logistica/guias-ruta/utils/route-guide-formatters'
import { isEmptyRouteGuideRow } from '@/modules/logistica/guias-ruta/utils/route-guide-validation'

const DARK_HEADER: [number, number, number] = [30, 58, 95]
const EMERALD: [number, number, number] = [16, 185, 129]
const DARK_TEXT: [number, number, number] = [30, 41, 59]
const LIGHT_GRAY: [number, number, number] = [248, 250, 252]
const WHITE: [number, number, number] = [255, 255, 255]
const MID_GRAY: [number, number, number] = [100, 116, 139]
const LIGHT_BORDER: [number, number, number] = [226, 232, 240]

function formatCurrency(amount: number): string {
  return `$ ${Math.round(amount).toLocaleString('es-CL')}`
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  const day = String(d.getDate() + 1).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  return `${day}/${month}/${year}`
}

function drawPageFooter(doc: jsPDF, pageNum: number, totalPages: number): void {
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 15

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6)
  doc.setTextColor(...MID_GRAY)
  doc.setDrawColor(...LIGHT_BORDER)
  doc.setLineWidth(0.3)
  doc.line(margin, 282, pageWidth - margin, 282)

  doc.text(
    `Documento generado el ${formatDate(new Date().toISOString())} | Página ${pageNum} de ${totalPages}`,
    pageWidth / 2,
    288.5,
    { align: 'center' },
  )
}

function getImageSizeFromBase64(base64: string): { width: number; height: number } | null {
  try {
    const base64Data = base64.split(',')[1] || base64
    const binaryString = typeof window !== 'undefined' 
      ? window.atob(base64Data) 
      : Buffer.from(base64Data, 'base64').toString('binary')
    const buffer = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      buffer[i] = binaryString.charCodeAt(i)
    }

    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      const width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19]
      const height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23]
      return { width, height }
    }

    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let i = 2
      while (i < buffer.length) {
        if (i + 4 > buffer.length) break
        const marker = (buffer[i] << 8) | buffer[i + 1]
        if ((marker & 0xFF00) !== 0xFF00) { i++; continue }
        i += 2
        if (marker === 0xFFD9) break
        const length = (buffer[i] << 8) | buffer[i + 1]
        if (marker >= 0xFFC0 && marker <= 0xFFC3) {
          const height = (buffer[i + 3] << 8) | buffer[i + 4]
          const width = (buffer[i + 5] << 8) | buffer[i + 6]
          return { width, height }
        }
        i += length
      }
    }
  } catch (err) {
    console.error('Error parsing image size from base64:', err)
  }
  return null
}

export async function generateRouteGuidePdfBlob(guide: RouteGuide, logoBase64?: string, secondLogoBase64?: string): Promise<Blob> {
  const doc = new jsPDF('p', 'mm', 'a4')
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 15
  const usableWidth = pageWidth - 2 * margin
  let cursorY = margin
  let totalPages = 1

  // HEADER BAR
  const headerHeight = 32
  doc.setFillColor(...DARK_HEADER)
  doc.rect(0, 0, pageWidth, headerHeight, 'F')

  let fetchedLogo1 = logoBase64
  let fetchedLogo2 = secondLogoBase64

  if (!fetchedLogo1 || !fetchedLogo2) {
    try {
      const fetchBase64 = async (url: string) => {
        const res = await fetch(url)
        if (!res.ok) return null
        const b = await res.blob()
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(b)
        })
      }
      if (!fetchedLogo1) fetchedLogo1 = await fetchBase64('/logo.png') || undefined
      if (!fetchedLogo2) fetchedLogo2 = await fetchBase64('/Logo_AmiMascota.jpeg') || undefined
    } catch (err) {
      console.error('Error fetching logos:', err)
    }
  }

  if (fetchedLogo1 || fetchedLogo2) {
    try {
      const renderLogo = (base64: string, xPos: number) => {
        let format = 'PNG'
        if (base64.startsWith('data:image/')) {
          const parts = base64.split(';')[0].split(':')
          const mime = parts.length > 1 ? parts[1].split(';')[0] : ''
          if (mime === 'image/jpeg' || mime === 'image/jpg') format = 'JPEG'
          else if (mime === 'image/webp') format = 'WEBP'
          else format = mime.split('/')[1]?.toUpperCase() || 'PNG'
        }

        let logoW = 20
        let logoH = 17
        const imgSize = getImageSizeFromBase64(base64)
        if (imgSize) {
          const aspectRatio = imgSize.width / imgSize.height
          const maxW = 30
          const maxH = 15
          if (aspectRatio > maxW / maxH) {
            logoW = maxW
            logoH = maxW / aspectRatio
          } else {
            logoH = maxH
            logoW = maxH * aspectRatio
          }
        }
        doc.addImage(base64, format, xPos, 5 + (15 - logoH) / 2, logoW, logoH)
        return logoW
      }
      
      let currentX = margin + 2
      if (fetchedLogo1) {
        currentX += renderLogo(fetchedLogo1, currentX) + 5
      }
      if (fetchedLogo2) {
        renderLogo(fetchedLogo2, currentX)
      }
    } catch (err) {
      console.error('Error adding logo:', err)
    }
  }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(...WHITE)
  doc.text("DISTRIBUIDORA MYM", pageWidth - margin, 12, { align: 'right' })

  // TITLE
  cursorY = headerHeight + 8
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.setTextColor(...DARK_HEADER)
  const title = guide.status === 'DISPATCHED' ? 'GUÍA DESPACHADA' : 'GUÍA DE RUTA'
  doc.text(title, margin, cursorY)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MID_GRAY)
  
  if (guide.status === 'DRAFT' && !guide.id) {
    doc.text(`BORRADOR NO GUARDADO`, margin, cursorY + 5.5)
  } else {
    doc.text(`N° ${guide.guide_number || '---'}  |  Fecha: ${formatDate(guide.guide_date)}`, margin, cursorY + 5.5)
  }

  cursorY += 12

  // EMERALD DIVIDER
  doc.setDrawColor(...EMERALD)
  doc.setLineWidth(1.2)
  doc.line(margin, cursorY, pageWidth - margin, cursorY)
  cursorY += 6

  // TWO-COLUMN INFO
  const leftColX = margin
  const rightColX = margin + usableWidth / 2 + 3

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...EMERALD)
  doc.text('INFORMACIÓN DE RUTA', leftColX, cursorY)
  doc.text('PERSONAL ASIGNADO', rightColX, cursorY)

  const leftRows: [string, string][] = [
    ['Ruta:', guide.route_name_snapshot || '-'],
    ['Vehículo:', guide.vehicle_name_snapshot || '-']
  ]
  const rightRows: [string, string][] = [
    ['Vendedor:', guide.seller_name_snapshot || '-'],
    ['Conductor:', guide.driver_name_snapshot || '-'],
    ['Despachador:', guide.dispatcher_name_snapshot || '-']
  ]

  doc.setFontSize(8)
  doc.setTextColor(...DARK_TEXT)
  let leftY = cursorY + 5
  for (const [label, value] of leftRows) {
    doc.setFont('helvetica', 'bold')
    doc.text(label, leftColX, leftY)
    doc.setFont('helvetica', 'normal')
    doc.text(value, leftColX + 15, leftY)
    leftY += 5
  }

  let rightY = cursorY + 5
  for (const [label, value] of rightRows) {
    doc.setFont('helvetica', 'bold')
    doc.text(label, rightColX, rightY)
    doc.setFont('helvetica', 'normal')
    doc.text(value, rightColX + 20, rightY)
    rightY += 5
  }

  cursorY = Math.max(leftY, rightY) + 6

  // TABLE
  const validItems = guide.items?.filter(i => !isEmptyRouteGuideRow(i)) || []
  
  const tableHeaders = ['#', 'Factura', 'Cliente', 'Comuna', 'Monto', 'Forma Pago', 'Obs.']
  const tableBody = validItems.map(item => [
    item.line_number.toString(),
    item.invoice_number,
    item.customer_address && item.customer_address.trim() !== '' ? `${item.customer_name}\nDir: ${item.customer_address.trim()}` : item.customer_name,
    item.commune,
    formatRouteGuideLineAmount(item.amount),
    formatPaymentMethodLabel(item.payment_method_normalized, item.payment_method_original),
    item.notes
  ])

  const blockHeight = 55;
  const blockStartY = 297 - margin - blockHeight; // 197 -> 227

  const autoTableOptions = {
    head: [tableHeaders],
    startY: cursorY,
    margin: { left: margin, right: margin, bottom: 15 },
    styles: { font: 'helvetica', fontSize: 7, textColor: [30, 41, 59], lineColor: [226, 232, 240], lineWidth: 0.3 },
    headStyles: { fillColor: [30, 58, 95], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7, halign: 'center' },
    columnStyles: {
      0: { halign: 'center', cellWidth: 8 },
      1: { halign: 'center', cellWidth: 15 },
      2: { cellWidth: 50 },
      3: { cellWidth: 30 },
      4: { halign: 'right', cellWidth: 20 },
      5: { halign: 'center', cellWidth: 20 },
      6: { cellWidth: 30 }
    },
    alternateRowStyles: { fillColor: [248, 250, 252] }
  } as any;

  // PASS 1: Simular renderizado para calcular paginación
  const doc1 = new jsPDF('p', 'mm', 'a4')
  autoTable(doc1, { ...autoTableOptions, body: tableBody });
  const pages1 = doc1.getNumberOfPages();
  const finalY1 = (doc1 as any).lastAutoTable.finalY;

  let splitIndex = -1;
  // Si la tabla termina invadiendo el área reservada para el bloque final (blockStartY)
  if (finalY1 > blockStartY) {
    const allRows = (doc1 as any).lastAutoTable.body;
    
    // Calcular en qué página cayó cada fila analizando los saltos de su coordenada Y
    let currentPage = 1;
    let lastY = 0;
    for (const r of allRows) {
      if (r.y < lastY - 10) {
        currentPage++; // La coordenada Y bajó abruptamente, hubo salto de página
      }
      r.pageNumber = currentPage;
      lastY = r.y;
    }
    
    const finalPageRows = allRows.filter((r: any) => r.pageNumber === pages1);
    
    for (const r of finalPageRows) {
      if (r.y + r.height > blockStartY) {
        splitIndex = r.index;
        break;
      }
    }
    
    // Si no encontramos un índice claro, dividimos antes de la última fila de esa página
    if (splitIndex === -1 && finalPageRows.length > 0) {
      splitIndex = finalPageRows[finalPageRows.length - 1].index;
    }
    
    // Evitar cortes nulos
    if (splitIndex <= 0 && tableBody.length > 1) {
      splitIndex = 1;
    }
  }

  // PASS 2: Renderizado real con división de tabla si es necesario
  if (splitIndex > -1 && splitIndex < tableBody.length) {
    const tableBody1 = tableBody.slice(0, splitIndex);
    const tableBody2 = tableBody.slice(splitIndex);

    autoTable(doc, { ...autoTableOptions, body: tableBody1 });
    doc.addPage();
    autoTable(doc, { ...autoTableOptions, body: tableBody2, startY: margin });
  } else {
    autoTable(doc, { ...autoTableOptions, body: tableBody });
  }

  // TOTALS (New layout)
  doc.setPage(doc.getNumberOfPages()); // Nos aseguramos de estar en la última página
  
  const summaryStartY = blockStartY;
  
  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...DARK_TEXT);
  doc.text(`Resumen de guía: ${guide.total_invoices || 0} Facturas`, margin, summaryStartY);
  
  const summaryTableBody = [
    ['Efectivo esperado', formatCurrency(guide.total_cash_expected || 0), ''],
    ['Cheques esperados', formatCurrency(guide.total_check_expected || 0), ''],
    ['Crédito', formatCurrency(guide.total_credit || 0), ''],
    ['Transferencia', formatCurrency(guide.total_transfer || 0), ''],
  ];
  
  const totalUnknown = guide.items?.filter(i => i.payment_method_normalized === 'UNKNOWN').reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0) || 0;
  const hasUnknown = totalUnknown > 0;

  if (hasUnknown) {
    summaryTableBody.push(['No reconocido', formatCurrency(totalUnknown), '']);
  }
  
  summaryTableBody.push(['Gastos', '', '']);
  
  autoTable(doc, {
    head: [['Concepto', 'Emitido', 'Recibido / Rendido']],
    body: summaryTableBody,
    startY: summaryStartY + 3,
    margin: { left: margin },
    tableWidth: 100,
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 1.5, textColor: [30, 41, 59], lineColor: [226, 232, 240], lineWidth: 0.3 },
    headStyles: { fillColor: [30, 58, 95], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7, halign: 'center' },
    columnStyles: {
      0: { cellWidth: 35, fontStyle: 'bold' },
      1: { cellWidth: 25, halign: 'right' },
      2: { cellWidth: 40 }
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  const totalsX = margin + 100 + 10;
  let ty = summaryStartY + 10;
  
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...DARK_TEXT);
  doc.text('Monto total ruta:', totalsX, ty);
  doc.text(formatCurrency(guide.total_amount || 0), pageWidth - margin, ty, { align: 'right' });
  
  ty += 8;
  
  doc.setDrawColor(...EMERALD);
  doc.setLineWidth(0.5);
  doc.line(totalsX, ty - 4, pageWidth - margin, ty - 4);
  
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...EMERALD);
  doc.text('Total a rendir:', totalsX, ty + 1);
  doc.setFontSize(10);
  doc.text(formatCurrency((guide.total_cash_expected || 0) + (guide.total_check_expected || 0)), pageWidth - margin, ty + 1, { align: 'right' });

  // SIGNATURES
  let sigY = blockStartY + 45; 
  
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...DARK_TEXT)
  doc.setDrawColor(...DARK_TEXT)
  doc.setLineWidth(0.3)
  
  const third = usableWidth / 3
  doc.line(margin + 10, sigY, margin + third - 10, sigY)
  doc.text('Firma Despachador', margin + third / 2, sigY + 4, { align: 'center' })

  doc.line(margin + third + 10, sigY, margin + third * 2 - 10, sigY)
  doc.text('Firma Conductor', margin + third + third / 2, sigY + 4, { align: 'center' })

  doc.line(margin + third * 2 + 10, sigY, margin + usableWidth - 10, sigY)
  doc.text('Firma Rendición / Caja', margin + third * 2 + third / 2, sigY + 4, { align: 'center' })

  totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    drawPageFooter(doc, i, totalPages)
  }

  doc.setProperties({
    title: `Guia de Ruta N° ${guide.guide_number || 'BORRADOR'}`,
  })

  return doc.output('blob')
}

export async function downloadRouteGuidePdf(guide: RouteGuide, filename: string): Promise<void> {
  const blob = await generateRouteGuidePdfBlob(guide)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
