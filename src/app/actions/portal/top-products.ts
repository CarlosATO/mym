'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { requirePortalSystemAdmin } from '@/app/actions/portal/authorization'
import { todayInSantiago } from '@/lib/datetime'
import { createClient } from '@/lib/supabase/server'

const AMIMASCOTA_BSALE_CLIENT_ID = 643

export interface PortalTopProduct {
  rank: number
  sku: string | null
  name: string
  units: number
  net_sales: number
}

type SalesDocumentRow = {
  bsale_id: number | string
  client_id: number | string | null
  document_type_id: number | string | null
}

type DetailRow = {
  bsale_document_id: number | string
  variant_id: number | string | null
  variant_code: string | null
  variant_description: string | null
  quantity: number | string | null
  net_amount: number | string | null
}

type VariantRow = {
  bsale_id: number | string
  code: string | null
  description: string | null
  bsale_product_id: number | string | null
}

type ProductRow = {
  bsale_id: number | string
  name: string | null
}

export async function getPortalTopProducts(): Promise<PortalTopProduct[]> {
  await requirePortalSystemAdmin()
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('No se encontró empresa activa para el usuario.')

  const today = todayInSantiago()
  const [year, month] = today.split('-')
  const firstDay = `${year}-${month}-01`
  const supabase = await createClient()

  const documents: SalesDocumentRow[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .schema('integraciones')
      .from('bsale_documents')
      .select('bsale_id, client_id, document_type_id')
      .eq('company_id', companyId)
      .eq('state', 0)
      .in('document_type_id', [2, 5])
      .or(`client_id.is.null,client_id.neq.${AMIMASCOTA_BSALE_CLIENT_ID}`)
      .gte('emission_date', firstDay)
      .lte('emission_date', today)
      .range(offset, offset + 999)
    if (error) throw new Error(`Error cargando documentos de productos del Portal: ${error.message}`)
    documents.push(...((data ?? []) as SalesDocumentRow[]))
    if ((data ?? []).length < 1000) break
  }

  const documentIds = documents.map(document => Number(document.bsale_id)).filter(Number.isFinite)
  const details: DetailRow[] = []
  for (let offset = 0; ; offset += 1000) {
    if (documentIds.length === 0) break
    const { data, error } = await supabase
      .schema('integraciones')
      .from('bsale_document_details')
      .select('bsale_document_id, variant_id, variant_code, variant_description, quantity, net_amount')
      .eq('company_id', companyId)
      .in('bsale_document_id', documentIds)
      .range(offset, offset + 999)
    if (error) throw new Error(`Error cargando líneas de productos del Portal: ${error.message}`)
    details.push(...((data ?? []) as DetailRow[]))
    if ((data ?? []).length < 1000) break
  }

  const variantIds = [...new Set(details.map(detail => Number(detail.variant_id)).filter(Number.isFinite))]
  const variants: VariantRow[] = []
  for (let offset = 0; offset < variantIds.length; offset += 500) {
    const { data, error } = await supabase
      .schema('integraciones')
      .from('bsale_variants')
      .select('bsale_id, code, description, bsale_product_id')
      .eq('company_id', companyId)
      .in('bsale_id', variantIds.slice(offset, offset + 500))
    if (error) throw new Error(`Error cargando variantes de productos del Portal: ${error.message}`)
    variants.push(...((data ?? []) as VariantRow[]))
  }

  const productIds = [...new Set(variants.map(variant => Number(variant.bsale_product_id)).filter(Number.isFinite))]
  const products: ProductRow[] = []
  for (let offset = 0; offset < productIds.length; offset += 500) {
    const { data, error } = await supabase
      .schema('integraciones')
      .from('bsale_products')
      .select('bsale_id, name')
      .eq('company_id', companyId)
      .in('bsale_id', productIds.slice(offset, offset + 500))
    if (error) throw new Error(`Error cargando nombres de productos del Portal: ${error.message}`)
    products.push(...((data ?? []) as ProductRow[]))
  }

  const documentTypes = new Map(documents.map(document => [Number(document.bsale_id), Number(document.document_type_id)]))
  const variantMap = new Map(variants.map(variant => [Number(variant.bsale_id), variant]))
  const productMap = new Map(products.map(product => [Number(product.bsale_id), product]))
  const totals = new Map<string, { sku: string | null; name: string; units: number; netSales: number }>()

  for (const detail of details) {
    const documentType = documentTypes.get(Number(detail.bsale_document_id))
    if (documentType !== 5 && documentType !== 2) continue

    const variant = variantMap.get(Number(detail.variant_id))
    const sku = variant?.code || detail.variant_code || null
    const product = variant?.bsale_product_id ? productMap.get(Number(variant.bsale_product_id)) : null
    const name = product?.name || variant?.description || detail.variant_description || sku || 'Producto sin identificar'
    const key = sku || (variant?.bsale_id ? `variant:${variant.bsale_id}` : `name:${name}`)
    const sign = documentType === 2 ? -1 : 1
    const units = Number(detail.quantity ?? 0)
    const netSales = Number(detail.net_amount ?? 0)
    if (!Number.isFinite(units) || !Number.isFinite(netSales)) continue

    const current = totals.get(key) ?? { sku, name, units: 0, netSales: 0 }
    current.units += sign * units
    current.netSales += sign * netSales
    totals.set(key, current)
  }

  return [...totals.values()]
    .filter(product => product.netSales > 0)
    .sort((a, b) => b.netSales - a.netSales)
    .slice(0, 10)
    .map((product, index) => ({
      rank: index + 1,
      sku: product.sku,
      name: product.name,
      units: Math.round(product.units),
      net_sales: Math.round(product.netSales),
    }))
}
