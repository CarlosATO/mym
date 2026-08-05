import * as XLSX from 'xlsx'
import type { CampaignImportScope } from './campaign-excel'

export interface CampaignImportTemplateContext {
  scope: CampaignImportScope
}

const SCOPE_COLUMNS: Record<CampaignImportScope, string[]> = {
  TOTAL_CAMPAIGN: ['SKU', 'DESCRIPCION', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
  BY_SITE: ['SKU', 'DESCRIPCION', 'CODIGO_UNIDAD', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
  BY_LOCATION: ['SKU', 'DESCRIPCION', 'CODIGO_UNIDAD', 'CODIGO_UBICACION', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
}

const SCOPE_RULES: Record<CampaignImportScope, string[]> = {
  TOTAL_CAMPAIGN: [
    'Una fila por producto: SKU, descripcion opcional, cantidad teorica global y costo unitario.',
    'No se indica unidad ni ubicacion: la cantidad corresponde al total de todas las unidades incluidas en la campana.',
  ],
  BY_SITE: [
    'Una fila por producto y unidad: SKU, descripcion opcional, codigo de unidad, cantidad teorica y costo unitario.',
    'El codigo de unidad debe coincidir con el codigo de una unidad inventariable de la campana.',
  ],
  BY_LOCATION: [
    'Una fila por producto, unidad y ubicacion: SKU, descripcion opcional, codigo de unidad, codigo de ubicacion, cantidad teorica y costo unitario.',
    'El codigo de unidad es obligatorio: dos unidades pueden tener ubicaciones con el mismo codigo.',
  ],
}

function aoaToSheet(rows: (string | number | boolean)[][]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows)
}

function setColWidths(ws: XLSX.WorkSheet, widths: number[]) {
  ws['!cols'] = widths.map(w => ({ wch: w }))
}

export function buildCampaignImportTemplate(ctx: CampaignImportTemplateContext): Buffer {
  const { scope } = ctx
  const workbook = XLSX.utils.book_new()

  const instructions: (string | number | boolean)[][] = [
    ['Instrucciones para la plantilla de importacion unica por campana'],
    [''],
    ['Alcance:', scope],
    ['Formato admitido:', 'XLSX, XLS o CSV UTF-8 (sin macros).'],
    ['Moneda:', 'CLP'],
    [''],
  ]
  for (const rule of SCOPE_RULES[scope]) {
    instructions.push([rule])
  }
  instructions.push(
    [''],
    ['Descripcion: sirve como referencia humana y no identifica ni crea productos.'],
    ['PetGroup utilizara la descripcion oficial del catalogo despues de validar.'],
    ['El SKU sigue siendo obligatorio.'],
    [''],
    ['Cantidad teorica: valor numerico mayor o igual a cero, maximo 3 decimales.'],
    ['Costo unitario: valor numerico en CLP, mayor o igual a cero, maximo 2 decimales.'],
    ['Costo vacio o cero: no bloquea la importacion, pero deja la valorizacion incompleta.'],
    ['No se permiten formulas en las celdas de SKU, unidad, ubicacion, cantidad o costo.'],
    ['No incluyas filas de ejemplo dentro de la hoja "Datos".'],
  )

  const instrSheet = aoaToSheet(instructions)
  setColWidths(instrSheet, [45, 95])
  XLSX.utils.book_append_sheet(workbook, instrSheet, 'Instrucciones')

  const datosSheet = aoaToSheet([SCOPE_COLUMNS[scope]])
  setColWidths(datosSheet, SCOPE_COLUMNS[scope].map(() => 22))
  XLSX.utils.book_append_sheet(workbook, datosSheet, 'Datos')

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
