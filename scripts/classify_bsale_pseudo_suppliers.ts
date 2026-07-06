import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const TARGET_COMPANY = 'd1000000-0000-0000-0000-000000000001'

const isApply = process.argv.includes('--apply')
const isConfirm = process.argv.includes('--confirm-remote')

async function run() {
  console.log(`[SUPPLIER CLASSIFICATION] Mode: ${isApply ? 'APPLY' : 'DRY-RUN'}`)
  
  if (isApply && !isConfirm) {
    console.error('Error: --apply requires --confirm-remote')
    process.exit(1)
  }

  // Fetch data
  console.log('Fetching suppliers...')
  const { data: suppliers, error: supErr } = await supabase.schema('adquisiciones')
    .from('suppliers')
    .select('*')
    .eq('company_id', TARGET_COMPANY)
  if (supErr) throw supErr

  console.log('Fetching bsale product types...')
  const { data: bsaleTypes, error: bsaleErr } = await supabase.schema('integraciones')
    .from('bsale_product_types')
    .select('id, name')
  if (bsaleErr) throw bsaleErr

  console.log('Fetching product supplier mappings...')
  const { data: mappings, error: mapErr } = await supabase.schema('adquisiciones')
    .from('product_supplier_mappings')
    .select('supplier_id, product_id, is_active, unit_cost')
    .eq('company_id', TARGET_COMPANY)
  if (mapErr) throw mapErr

  console.log('Fetching products...')
  const { data: products, error: prodErr } = await supabase.schema('adquisiciones')
    .from('products')
    .select('id, is_active')
    .eq('company_id', TARGET_COMPANY)
  if (prodErr) throw prodErr

  const productMap = new Map(products.map(p => [p.id, p]))

  let totalSuppliers = suppliers.length
  let activeSuppliers = suppliers.filter(s => s.is_active).length
  let inactiveSuppliers = suppliers.filter(s => !s.is_active).length
  
  const bsaleTypeNames = new Set(bsaleTypes.map(t => (t.name || '').toUpperCase().trim()))
  
  const pseudoSuppliers = []
  const realSuppliers = []
  
  for (const s of suppliers) {
    const bName = (s.business_name || '').toUpperCase().trim()
    const matchesBsaleType = bsaleTypeNames.has(bName)
    const hasSlash = bName.includes('/')
    
    const isPseudo = matchesBsaleType || hasSlash
    
    if (isPseudo) {
      const typeRecord = bsaleTypes.find(t => (t.name || '').toUpperCase().trim() === bName)
      
      const sMappings = mappings.filter(m => m.supplier_id === s.id)
      let productsActive = 0
      let productsInactive = 0
      let withCost = 0
      let withoutCost = 0
      
      for (const m of sMappings) {
        if (m.unit_cost !== null && Number(m.unit_cost) > 0) withCost++
        else withoutCost++
        
        if (m.product_id) {
          const p = productMap.get(m.product_id)
          if (p) {
            if (p.is_active) productsActive++
            else productsInactive++
          }
        }
      }
      
      pseudoSuppliers.push({
        supplier: s,
        bsaleTypeId: typeRecord ? typeRecord.id : null,
        bsaleTypeName: typeRecord ? typeRecord.name : (matchesBsaleType ? bName : null),
        suggestedRoot: bName.split('/')[0].trim(),
        totalProducts: sMappings.length,
        productsActive,
        productsInactive,
        withCost,
        withoutCost,
      })
    } else {
      realSuppliers.push(s)
    }
  }

  let countWithMappings = pseudoSuppliers.filter(ps => ps.totalProducts > 0).length
  let countWithoutMappings = pseudoSuppliers.filter(ps => ps.totalProducts === 0).length
  let countWithActiveProducts = pseudoSuppliers.filter(ps => ps.productsActive > 0).length
  let countWithOnlyInactiveProducts = pseudoSuppliers.filter(ps => ps.productsActive === 0 && ps.productsInactive > 0).length
  let countGarbage = pseudoSuppliers.filter(ps => !ps.supplier.is_active && ps.totalProducts === 0).length

  console.log('\n--- REPORTE DE CLASIFICACIÓN ---')
  console.log(`Total suppliers: ${totalSuppliers}`)
  console.log(`Activos: ${activeSuppliers} | Inactivos: ${inactiveSuppliers}`)
  console.log(`Candidatos a pseudoproveedor: ${pseudoSuppliers.length}`)
  console.log(`Proveedores reales probables: ${realSuppliers.length}`)
  console.log(`Pseudoproveedores con mappings: ${countWithMappings}`)
  console.log(`Pseudoproveedores sin mappings: ${countWithoutMappings}`)
  console.log(`Pseudoproveedores asociados a productos activos: ${countWithActiveProducts}`)
  console.log(`Pseudoproveedores asociados SOLO a inactivos: ${countWithOnlyInactiveProducts}`)
  console.log(`Pseudoproveedores basura inactivos (sin prods): ${countGarbage}`)

  // Agrupar por raíz
  const rootGroups = new Map()
  for (const ps of pseudoSuppliers) {
    const root = ps.suggestedRoot
    if (!rootGroups.has(root)) {
      rootGroups.set(root, { count: 0, products: 0, pActive: 0, pInactive: 0, withCost: 0, withoutCost: 0 })
    }
    const g = rootGroups.get(root)
    g.count++
    g.products += ps.totalProducts
    g.pActive += ps.productsActive
    g.pInactive += ps.productsInactive
    g.withCost += ps.withCost
    g.withoutCost += ps.withoutCost
  }

  console.log('\n--- AGRUPACIÓN POR RAÍZ (Top 15) ---')
  console.log('Raíz sugerida | Pseudos | Productos | Prod Activos | Prod Inactivos | Con Costo | Sin Costo')
  const sortedRoots = Array.from(rootGroups.entries()).sort((a, b) => b[1].products - a[1].products).slice(0, 15)
  for (const [root, g] of sortedRoots) {
    console.log(`${root.padEnd(14)}| ${String(g.count).padEnd(8)}| ${String(g.products).padEnd(10)}| ${String(g.pActive).padEnd(13)}| ${String(g.pInactive).padEnd(15)}| ${String(g.withCost).padEnd(10)}| ${g.withoutCost}`)
  }

  // Generate a small sample
  let sampleMd = '# Muestra de Candidatos a Pseudoproveedores (Top 50)\n\n'
  sampleMd += '| Nombre Actual | Raíz Sugerida | Total Mappings | Prod Activos | Match Tipo Bsale |\n'
  sampleMd += '|---|---|---|---|---|\n'
  for (const ps of pseudoSuppliers.slice(0, 50)) {
    sampleMd += `| ${ps.supplier.business_name} | ${ps.suggestedRoot} | ${ps.totalProducts} | ${ps.productsActive} | ${ps.bsaleTypeId ? 'SI' : 'NO'} |\n`
  }
  fs.writeFileSync(path.resolve(process.cwd(), 'docs', 'pseudo-suppliers-sample.md'), sampleMd)
  console.log('\nGenerada muestra en docs/pseudo-suppliers-sample.md')

  if (isApply) {
    console.log('\nAplicando cambios...')
    let updatedCount = 0
    let errorCount = 0

    for (const ps of pseudoSuppliers) {
      const payload = {
        supplier_kind: 'BSALE_OPERATIVE',
        bsale_product_type_id: ps.bsaleTypeId,
        bsale_product_type_name: ps.bsaleTypeName,
        source: 'BSALE'
      }

      const { error } = await supabase.schema('adquisiciones')
        .from('suppliers')
        .update(payload)
        .eq('id', ps.supplier.id)

      if (error) {
        console.error(`Error actualizando proveedor ${ps.supplier.id}:`, error.message)
        errorCount++
      } else {
        updatedCount++
      }
    }

    console.log(`\nCambios aplicados: ${updatedCount} actualizados, ${errorCount} errores.`)
  }
}

run().catch(console.error)
