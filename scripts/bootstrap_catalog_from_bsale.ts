import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const TARGET_COMPANY = 'd1000000-0000-0000-0000-000000000001'

async function fetchAll(table: string, schema: string, select: string = '*') {
  let allData: any[] = []
  let page = 0
  const pageSize = 1000
  let hasMore = true
  while (hasMore) {
    const { data, error } = await supabase
      .schema(schema)
      .from(table)
      .select(select)
      .eq('company_id', TARGET_COMPANY)
      .range(page * pageSize, (page + 1) * pageSize - 1)
    
    if (error) throw error
    if (!data || data.length === 0) {
      hasMore = false
    } else {
      allData.push(...data)
      if (data.length < pageSize) hasMore = false
      page++
    }
  }
  return allData
}

async function main() {
  const isApply = process.argv.includes('--apply')
  const isConfirm = process.argv.includes('--confirm-remote')
  const isApplyState = process.argv.includes('--apply-state')

  if (isApply && !isConfirm) {
    console.error('ERROR: Missing --confirm-remote with --apply')
    process.exit(1)
  }

  console.log(`[BOOTSTRAP CATALOG] Starting in ${isApply ? 'APPLY' : 'DRY-RUN'} mode.`)
  if (isApplyState) console.log(`[STATE SYNC] Operational state will be synced.`)
  console.log(`Target company: ${TARGET_COMPANY}`)

  console.log('Fetching PetGrup products...')
  const petProducts = await fetchAll('products', 'adquisiciones')
  
  console.log('Fetching Bsale variants...')
  const bsaleVariants = await fetchAll('bsale_variants', 'integraciones')
  
  console.log('Fetching Bsale products...')
  const bsaleProducts = await fetchAll('bsale_products', 'integraciones')
  
  console.log('Fetching Bsale product types...')
  const bsaleTypes = await fetchAll('bsale_product_types', 'integraciones')

  console.log('Fetching Stock Current...')
  const bsaleStock = await fetchAll('bsale_stock_current', 'integraciones')

  console.log('Fetching Mappings...')
  const mappings = await fetchAll('product_supplier_mappings', 'adquisiciones')

  console.log('Fetching sales for the last 180 days...')
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setDate(sixMonthsAgo.getDate() - 180)
  const sixMonthsAgoStr = sixMonthsAgo.toISOString().split('T')[0]
  
  const { data: recentDocs } = await supabase.schema('integraciones').from('bsale_documents')
    .select('bsale_id').gte('emission_date', sixMonthsAgoStr).eq('company_id', TARGET_COMPANY)
  
  const docIds = new Set((recentDocs || []).map(d => d.bsale_id))
  
  let salesSet = new Set<string>()
  let salesCountMap = new Map<string, number>()
  let page = 0, hasMore = true
  while (hasMore) {
    const { data: details } = await supabase.schema('integraciones').from('bsale_document_details')
      .select('bsale_document_id, variant_code, quantity')
      .eq('company_id', TARGET_COMPANY)
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (!details || details.length === 0) break
    for (const d of details) {
      if (docIds.has(d.bsale_document_id) && d.variant_code) {
        salesSet.add(d.variant_code)
        salesCountMap.set(d.variant_code, (salesCountMap.get(d.variant_code) || 0) + (d.quantity || 1))
      }
    }
    if (details.length < 1000) hasMore = false
    page++
  }

  // Build maps
  const bProdMap = new Map(bsaleProducts.map(p => [p.bsale_id, p]))
  const bTypeMap = new Map(bsaleTypes.map(t => [t.bsale_id, t]))
  const stockMap = new Map()
  for (const s of bsaleStock) {
    const code = s.variant_code || s.raw_json?.variant?.code
    if (code) stockMap.set(code, (stockMap.get(code) || 0) + (Number(s.quantity_available) || 0))
  }
  const mappingMap = new Map(mappings.map(m => [m.sku, m]))

  const exceptions = []
  const updates = []
  
  for (const p of petProducts) {
    const v = bsaleVariants.find(bv => bv.code === p.sku)
    if (!v) continue

    const bProd = bProdMap.get(v.bsale_product_id)
    const bType = bProd ? bTypeMap.get(bProd.product_type_id) : null

    const bsaleProductState = bProd ? bProd.state : null
    const bsaleVariantState = v.state
    const isInactiveBsale = (bsaleProductState === 1) || (bsaleVariantState === 1)

    const stock = stockMap.get(p.sku) || 0
    const sales = salesCountMap.get(p.sku) || 0
    const hasSales = salesSet.has(p.sku)
    const mapping = mappingMap.get(p.sku)

    let conflict = false
    let reason = null
    if (isInactiveBsale) {
      if (stock > 0 && hasSales) { conflict = true; reason = 'STOCK_Y_VENTA' }
      else if (stock > 0) { conflict = true; reason = 'STOCK_POSITIVO' }
      else if (hasSales) { conflict = true; reason = 'VENTA_RECIENTE' }
    }

    if (conflict) {
      exceptions.push({
        sku: p.sku,
        description: p.description,
        product_type: bType ? bType.name : '',
        bsale_product_state: bsaleProductState,
        bsale_variant_state: bsaleVariantState,
        stock_actual: stock,
        unidades_vendidas_180d: sales,
        documentos_ventas_180d: hasSales ? 'SI' : 'NO',
        supplier_operativo: mapping ? mapping.supplier_id : null,
        unit_cost: mapping ? mapping.unit_cost : null,
        motivo_excepcion: reason
      })
    }

    let vBarcode = String(v.bar_code || v.raw_json?.barCode || '').trim()
    if (vBarcode === '0' || vBarcode === 'null' || vBarcode === 'undefined') vBarcode = p.barcode

    const updatePayload: any = {
      bsale_product_id: v.bsale_product_id,
      bsale_variant_id: v.bsale_id,
      source: 'BSALE',
      last_bsale_sync_at: new Date().toISOString(),
      bsale_product_state: bsaleProductState,
      bsale_variant_state: bsaleVariantState,
      bsale_status_conflict: conflict,
      bsale_status_conflict_reason: reason,
      bsale_status_conflict_detected_at: conflict ? new Date().toISOString() : null
    }

    if (vBarcode) updatePayload.barcode = vBarcode
    if (bType && bType.name) {
      updatePayload.product_type = bType.name
      updatePayload.bsale_product_type_id = bType.bsale_id
      updatePayload.bsale_product_type_name = bType.name
    }
    if (v.raw_json?.isLot === 1) {
      updatePayload.requires_lot = true
    }

    if (isApplyState) {
      if (isInactiveBsale && !conflict) {
        updatePayload.is_active = false
        updatePayload.status = 'INACTIVE'
      }
    }

    updates.push({ id: p.id, payload: updatePayload })
  }

  // Write markdown exceptions report
  if (exceptions.length > 0) {
    let md = '# Reporte de Excepciones de Estado Bsale vs PetGrup\n\n'
    md += `Detectadas ${exceptions.length} excepciones donde Bsale marca el producto como inactivo pero PetGrup registra movimiento o stock local.\n\n`
    md += '| SKU | Descripción | Tipo | Estado Prod | Estado Var | Stock | Ventas 180d | Costo | Motivo |\n'
    md += '|---|---|---|---|---|---|---|---|---|\n'
    for (const e of exceptions) {
      md += `| ${e.sku} | ${e.description?.replace(/\|/g, '') || ''} | ${e.product_type} | ${e.bsale_product_state} | ${e.bsale_variant_state} | ${e.stock_actual} | ${e.unidades_vendidas_180d} | ${e.unit_cost} | **${e.motivo_excepcion}** |\n`
    }
    const docsPath = path.resolve(process.cwd(), 'docs')
    if (!fs.existsSync(docsPath)) fs.mkdirSync(docsPath, { recursive: true })
    fs.writeFileSync(path.resolve(docsPath, 'catalog-bsale-status-exceptions.md'), md)
    console.log(`Generated exceptions report at docs/catalog-bsale-status-exceptions.md`)
  }

  if (isApply) {
    console.log(`Applying updates to ${updates.length} products...`)
    // Execute updates in batches to avoid overwhelming the db
    const batchSize = 100
    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize)
      await Promise.all(batch.map(u => 
        supabase.schema('adquisiciones').from('products').update(u.payload).eq('id', u.id)
      ))
      console.log(`Updated ${i + batch.length} / ${updates.length}`)
    }
    console.log('Update complete.')
  } else {
    console.log(`DRY-RUN completed. ${updates.length} products would be updated.`)
    console.log(`${exceptions.length} exceptions found.`)
  }
}

main().catch(console.error)
