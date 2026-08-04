import * as XLSX from 'xlsx'

export interface TemplateLocation {
  code: string
  name: string | null
  is_active: boolean
}

export interface TemplateContext {
  modality: 'GENERAL' | 'POR_UBICACION'
  siteName: string
  siteCode: string
  cutoffAt: string
  locations: TemplateLocation[]
}

function aoaToSheet(rows: (string | number | boolean)[][]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows)
}

function setColWidths(ws: XLSX.WorkSheet, widths: number[]) {
  ws['!cols'] = widths.map(w => ({ wch: w }))
}

export function buildImportTemplate(ctx: TemplateContext): Buffer {
  const isGeneral = ctx.modality === 'GENERAL'
  const workbook = XLSX.utils.book_new()

  const instructions: (string | number | boolean)[][] = [
    ['Instrucciones para la plantilla de importación de stock'],
    [''],
    ['Unidad inventariable:', ctx.siteName],
    ['Código de unidad:', ctx.siteCode],
    ['Modalidad:', isGeneral ? 'GENERAL' : 'POR_UBICACION'],
    ['Fecha y hora de corte:', ctx.cutoffAt],
    ['Moneda:', 'CLP'],
    ['Formato admitido:', 'XLSX, XLS o CSV UTF-8 (sin macros).'],
    [''],
    ['1. La hoja "Datos" debe contener las columnas oficiales. No agregues UUID ni IDs internos.'],
    ['2. Cantidad teórica: valor numérico mayor o igual a cero, máximo 3 decimales.'],
    ['3. Costo unitario: valor numérico en CLP, mayor o igual a cero, máximo 2 decimales.'],
    ['4. Productos desconocidos: se marcarán como error; no se crean productos automáticamente.'],
    ['5. Costo faltante o cero: no bloquea la importación, pero deja la valorización incompleta.'],
    isGeneral
      ? ['6. Ubicaciones: no se usan en modalidad GENERAL. Una columna de ubicación informada genera una advertencia.']
      : ['6. Ubicaciones: deben existir y estar activas en la hoja "Ubicaciones".'],
    ['7. No se permiten fórmulas operativas en las celdas de SKU, cantidad, costo o ubicación.'],
    ['8. No incluyas filas de ejemplo dentro de la hoja "Datos".'],
  ]

  const instrSheet = aoaToSheet(instructions)
  setColWidths(instrSheet, [50, 90])
  XLSX.utils.book_append_sheet(workbook, instrSheet, 'Instrucciones')

  const datosHeader = isGeneral
    ? ['SKU', 'Cantidad teórica', 'Costo unitario', 'Código de barras', 'Nombre producto']
    : ['SKU', 'Código ubicación', 'Cantidad teórica', 'Costo unitario', 'Código de barras', 'Nombre producto']

  const datosSheet = aoaToSheet([datosHeader])
  setColWidths(datosSheet, [20, 22, 16, 20, 40])
  XLSX.utils.book_append_sheet(workbook, datosSheet, 'Datos')

  if (!isGeneral) {
    const ubicacionesRows: (string | number | boolean)[][] = [['Código', 'Nombre', 'Estado']]
    for (const loc of ctx.locations) {
      ubicacionesRows.push([loc.code, loc.name ?? '', loc.is_active ? 'ACTIVA' : 'INACTIVA'])
    }
    const locSheet = aoaToSheet(ubicacionesRows)
    setColWidths(locSheet, [20, 40, 12])
    XLSX.utils.book_append_sheet(workbook, locSheet, 'Ubicaciones')
  }

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
