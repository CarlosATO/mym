import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

// Load environment variables from .env.local
dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const companyId = process.env.NEXT_PUBLIC_COMPANY_ID || 'c34a1a3f-1d37-47ab-a279-d57e0ed4f901' // default company id for dev, should query or set properly if needed

const isRemote = supabaseUrl.includes('supabase.co')

const args = process.argv.slice(2)
const isApply = args.includes('--apply')
const isConfirmRemote = args.includes('--confirm-remote')
const isDryRun = !isApply

if (isApply && isRemote && !isConfirmRemote) {
  console.error("❌ ERROR: Entorno remoto de Supabase detectado. Debes incluir '--confirm-remote' junto con '--apply' para escribir.")
  process.exit(1)
}

const cDb = createClient(supabaseUrl, serviceKey, { db: { schema: 'core' }, auth: { persistSession: false } })
const dbAdq = createClient(supabaseUrl, serviceKey, { db: { schema: 'adquisiciones' }, auth: { persistSession: false } })
const dbInt = createClient(supabaseUrl, serviceKey, { db: { schema: 'integraciones' }, auth: { persistSession: false } })

function normalizeSupplierName(name: string): string {
  if (!name) return ''
  return name
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ') // collapse multiple spaces
    .replace(/\s*\/\s*/g, '/') // remove spaces around /
}

async function run() {
  console.log(`\n🚀 INICIANDO MIGRACIÓN DE PROVEEDORES OPERATIVOS Y CATÁLOGO`);
  console.log(`Modo: ${isDryRun ? 'DRY-RUN (Sin escrituras)' : 'APPLY (Escrituras habilitadas)'}`);
  console.log(`Entorno: ${isRemote ? 'Remoto' : 'Local'} (${supabaseUrl})\n`);

  // --- OBTENER COMPANY ID SI NO EXISTE ---
  let targetCompanyId = companyId
  if (!targetCompanyId || targetCompanyId === 'c34a1a3f-1d37-47ab-a279-d57e0ed4f901') {
      const { data: cData } = await cDb.from('companies').select('id').limit(1).single()
      if (cData) targetCompanyId = cData.id
  }
  
  if (!targetCompanyId) {
    console.error("No se pudo determinar el company_id. Verifica la base de datos.")
    process.exit(1)
  }

  // --- REPORTE DE PROVEEDORES ACTUALES ---
  console.log('--- 1. Proveedores Actuales ---')
  const { data: currentSuppliers } = await dbAdq.from('suppliers').select('id, business_name, created_at, status')
  const suppliers = currentSuppliers || []
  console.log(`Proveedores encontrados en BD: ${suppliers.length}`)
  suppliers.forEach(s => {
    console.log(` - ${s.business_name} (ID: ${s.id.slice(0, 8)}..., Status: ${s.status})`)
  })
  
  // --- SYNC / PRODUCT TYPES ---
  console.log('\n--- 2. Tipos de Producto Bsale (Proveedores Operativos) ---')
  const EXCLUDED_TYPES = [
      'SIN TIPO',
      'DEMO BSALE',
      'CARGA MASIVA DE PRODUCTOS DE BSALE',
      'TIPO DE PRODUCTO O SERVICIO',
      'INSTRUCCIONES: COMPLETA EL EXCEL SEGÚN LO INDICADO EN CADA COLUMNA. COPIA DESDE'
  ]
  
  let { data: bsaleTypes } = await dbInt.from('bsale_product_types').select('*').eq('company_id', targetCompanyId)
  
  if (!bsaleTypes || bsaleTypes.length === 0) {
    if (isDryRun) {
        console.log("⚠️ No se encontraron product_types en BD. Haremos un fetch directo a Bsale API para proyectar el reporte...")
        const BSALE_API_BASE = process.env.BSALE_API_BASE_URL || 'https://api.bsale.io/v1'
        const BSALE_TOKEN = process.env.BSALE_ACCESS_TOKEN || ''
        
        let url = `${BSALE_API_BASE}/product_types.json?limit=50`
        let offset = 0
        bsaleTypes = []
        while(true) {
            const res = await fetch(`${BSALE_API_BASE}/product_types.json?limit=50&offset=${offset}`, {
                headers: { 'access_token': BSALE_TOKEN }
            })
            if (!res.ok) {
                console.error("Error Bsale API:", res.status)
                break
            }
            const data = await res.json()
            if (data.items) {
                bsaleTypes.push(...data.items.map((i:any) => ({
                    bsale_id: i.id,
                    name: i.name
                })))
            }
            if (!data.items || data.items.length < 50) break
            offset += 50
        }
    } else {
        console.warn("⚠️ No se encontraron product_types en integraciones.bsale_product_types.")
        console.warn("Por favor ejecuta la migración y la sincronización (syncBsaleCatalog) primero.")
        process.exit(1)
    }
  }
  
  console.log(`Se encontraron ${bsaleTypes.length} tipos de producto en integraciones.`)
  
  const supplierSet = new Map<string, any>()
  const excludedSet = new Map<string, any>()
  
  bsaleTypes.forEach(pt => {
    const ptNameUpper = pt.name ? pt.name.toUpperCase().trim() : ''
    const normName = normalizeSupplierName(pt.name)
    if (EXCLUDED_TYPES.includes(ptNameUpper)) {
        excludedSet.set(normName, pt)
    } else if (normName && !supplierSet.has(normName)) {
      supplierSet.set(normName, pt)
    }
  })
  
  console.log(`Proveedores operativos únicos a crear/reutilizar: ${supplierSet.size}`)
  console.log(`Product types excluidos (no comprables): ${excludedSet.size}`)
  if (excludedSet.size > 0) {
      for (const pt of excludedSet.values()) {
          console.log(` - Excluido: ${pt.name}`)
      }
  }
  
  // Comparar con existentes para avisar sobre duplicados o matches
  const newSuppliersToInsert: any[] = []
  const suppliersMapByName = new Map<string, string>() // normalized_name -> id
  suppliers.forEach(s => suppliersMapByName.set(normalizeSupplierName(s.business_name), s.id))
  
  for (const [normName, pt] of supplierSet.entries()) {
    if (suppliersMapByName.has(normName)) {
      console.log(` [Match] Proveedor operativo ya existe: ${normName}`)
    } else {
      console.log(` [Nuevo] Se creará proveedor operativo: ${normName} (desde: ${pt.name})`)
      newSuppliersToInsert.push({
        company_id: targetCompanyId,
        business_name: normName,
        status: 'ACTIVE',
        is_active: true,
      })
    }
  }

  if (!isDryRun && newSuppliersToInsert.length > 0) {
    const { data: insertedSuppliers, error: insertSupErr } = await dbAdq
        .from('suppliers')
        .insert(newSuppliersToInsert)
        .select('id, business_name')
        
    if (insertSupErr) {
        console.error("Error insertando proveedores operativos:", insertSupErr)
    } else {
        console.log(`Se insertaron ${insertedSuppliers?.length || 0} proveedores operativos.`)
        insertedSuppliers?.forEach(s => suppliersMapByName.set(normalizeSupplierName(s.business_name), s.id))
    }
  }

  // --- LIMPIEZA DE PRODUCTOS (SI NO TIENEN DEPENDENCIAS) ---
  console.log('\n--- 3. Limpieza de Productos Actuales ---')
  const { data: currentProducts } = await dbAdq.from('products').select('id, sku, description')
  const prods = currentProducts || []
  console.log(`Se encontraron ${prods.length} productos en la tabla adquisiciones.products.`)
  
  let totalDependencies = 0
  const prodsToDelete: string[] = []
  
  if (prods.length > 0) {
      // Optimización: traer todos los product_id que están siendo usados en las otras tablas de una vez
      const [{ data: poItems }, { data: psmItems }, { data: repItems }] = await Promise.all([
          dbAdq.from('purchase_order_items').select('product_id'),
          dbAdq.from('product_supplier_mappings').select('product_id'),
          dbAdq.from('purchase_replenishment_analysis_items').select('product_id')
      ])
      
      const usedProducts = new Set<string>()
      
      const addDeps = (items: any[]) => {
          items?.forEach(i => {
              if (i.product_id) usedProducts.add(i.product_id)
          })
      }
      
      addDeps(poItems || [])
      addDeps(psmItems || [])
      addDeps(repItems || [])
      
      totalDependencies = usedProducts.size
      
      for (const p of prods) {
          if (usedProducts.has(p.id)) {
              console.log(` [Skip] Producto ${p.sku} (${p.description}) tiene dependencias en uso.`)
          } else {
              prodsToDelete.push(p.id)
          }
      }
  }
  
  console.log(`Se detectaron ${prodsToDelete.length} productos sin dependencias (candidatos a eliminar).`)
  console.log(`Se detectaron ${totalDependencies} dependencias en total.`)
  
  if (totalDependencies > 0) {
      console.log("⚠️ ATENCIÓN: Existen productos con dependencias. No se eliminarán esos productos.")
      // Requisito: "si cualquier dependencia es mayor a 0, detenerse." -> "Antes de borrar productos: listar todas las dependencias... si cualquier dependencia es mayor a 0, detenerse."
      console.error("⛔ ERROR: Se encontraron dependencias hacia productos. Deteniendo proceso de eliminación por seguridad.")
      if (!isDryRun) {
          console.log("Para forzar, habría que revisar las dependencias. Abortando limpieza de productos.")
          // process.exit(1) // we might not want to kill the whole script if we still want to import, but user requested to stop before deleting. We just won't delete.
      }
  } else if (!isDryRun && prodsToDelete.length > 0) {
      const { error: delErr } = await dbAdq.from('products').delete().in('id', prodsToDelete)
      if (delErr) {
          console.error("Error eliminando productos:", delErr)
      } else {
          console.log(`Se eliminaron ${prodsToDelete.length} productos.`)
      }
  } else if (isDryRun && prodsToDelete.length > 0) {
      console.log(` [Dry-Run] Se eliminarían ${prodsToDelete.length} productos sin dependencias.`)
  }

  // --- IMPORTACIÓN DE PRODUCTOS Y MAPPINGS ---
  console.log('\n--- 4. Importación de Productos y Mappings ---')
  const fetchAll = async (table: string, columns: string, eqCol: string, eqVal: string, extraFilters?: (q: any) => any) => {
      let allData: any[] = []
      let offset = 0
      const limit = 1000
      while (true) {
          let query = dbInt.from(table).select(columns).eq(eqCol, eqVal).range(offset, offset + limit - 1)
          if (extraFilters) query = extraFilters(query)
          const { data } = await query
          if (!data || data.length === 0) break
          allData.push(...data)
          if (data.length < limit) break
          offset += limit
      }
      return allData
  }
  
  const bsaleVariants = await fetchAll('bsale_variants', 'bsale_id, code, description, bsale_product_id', 'company_id', targetCompanyId, q => q.not('code', 'is', null).not('code', 'eq', ''))
  const bsaleProducts = await fetchAll('bsale_products', 'bsale_id, name, product_type_id', 'company_id', targetCompanyId)
  const bsaleCosts = await fetchAll('bsale_variant_costs', 'variant_id, average_cost', 'company_id', targetCompanyId)
  
  const bsaleProductsMap = new Map((bsaleProducts || []).map(p => [p.bsale_id, p]))
  const productTypeMap = new Map((bsaleTypes || []).map(t => [t.bsale_id, t]))
  const bsaleCostsMap = new Map((bsaleCosts || []).map(c => [c.variant_id, c.average_cost]))
  
  const variants = bsaleVariants || []
  console.log(`Variantes de Bsale válidas (con SKU): ${variants.length}`)
  
  const uniqueSkus = new Map<string, any>()
  
  let noProductTypeCount = 0
  let noCostCount = 0
  let withCostCount = 0
  
  for (const v of variants) {
      const sku = v.code
      if (!sku) continue
      
      const p = bsaleProductsMap.get(v.bsale_product_id)
      if (!p) continue
      
      const ptId = p.product_type_id
      const pt = ptId ? productTypeMap.get(ptId) : null
      
      if (!pt) {
          noProductTypeCount++
      }
      
      const ptNameUpper = pt && pt.name ? pt.name.toUpperCase().trim() : ''
      const isExcluded = pt ? EXCLUDED_TYPES.includes(ptNameUpper) : false
      const supplierName = pt && !isExcluded ? normalizeSupplierName(pt.name) : 'SIN PROVEEDOR'
      const avgCost = bsaleCostsMap.get(v.bsale_id) || 0
      
      if (avgCost > 0) withCostCount++
      else noCostCount++
      
      const description = v.description ? `${p.name} - ${v.description}` : p.name
      
      if (!uniqueSkus.has(sku)) {
          uniqueSkus.set(sku, {
              sku,
              description,
              supplierName,
              unit_cost: avgCost,
              bsale_variant_id: v.bsale_id
          })
      }
  }
  
  console.log(`SKUs únicos a importar: ${uniqueSkus.size}`)
  console.log(` - Variantes sin product_type o con tipo excluido: ${noProductTypeCount}`)
  
  if (isDryRun) {
      console.log(` [Dry-Run] Se crearían ${uniqueSkus.size} productos PetGrup.`)
      console.log(` [Dry-Run] Se crearían ${uniqueSkus.size} product_supplier_mappings.`)
  } else {
      // Inserción masiva de productos (idealmente en lotes)
      const productsToInsert = Array.from(uniqueSkus.values()).map(u => ({
          company_id: targetCompanyId,
          sku: u.sku,
          description: u.description,
          status: 'ACTIVE'
      }))
      
      const { data: insertedProds, error: prodErr } = await dbAdq
          .from('products')
          .upsert(productsToInsert, { onConflict: 'company_id, sku', ignoreDuplicates: false })
          .select('id, sku')
          
      if (prodErr) {
          console.error("Error insertando productos:", prodErr)
      } else {
          console.log(`Se insertaron/actualizaron ${insertedProds?.length || 0} productos PetGrup.`)
          
          // Construir Mappings
          const prodIdMap = new Map((insertedProds || []).map(p => [p.sku, p.id]))
          
          const mappingsToInsert = Array.from(uniqueSkus.values()).map(u => {
              // Ensure we have a valid supplier_id, if not, skip or use a default
              // For now we map strictly if we have the supplier
              const supplierId = suppliersMapByName.get(u.supplierName)
              if (!supplierId) return null
              
              return {
                  company_id: targetCompanyId,
                  product_id: prodIdMap.get(u.sku),
                  supplier_id: supplierId,
                  bsale_variant_id: u.bsale_variant_id,
                  sku: u.sku,
                  product_name: u.description,
                  unit_cost: u.unit_cost,
                  is_preferred: true,
                  is_active: true
              }
          }).filter((m): m is NonNullable<typeof m> => Boolean(m))
          
          const { data: insertedMappings, error: mapErr } = await dbAdq
              .from('product_supplier_mappings')
              .upsert(mappingsToInsert, { onConflict: 'company_id, supplier_id, sku', ignoreDuplicates: false })
              .select('id')
              
          if (mapErr) {
              console.error("Error insertando mappings:", mapErr)
          } else {
              console.log(`Se crearon/actualizaron ${insertedMappings?.length || 0} product_supplier_mappings.`)
          }
      }
  }
  
  console.log('\n--- 5. Resumen de Mappings ---')
  console.log(`Mappings proyectados: ${uniqueSkus.size}`)
  console.log(` - Con costo válido: ${withCostCount}`)
  console.log(` - Sin costo: ${noCostCount}`)
  
  const productsWithoutSupplier = Array.from(uniqueSkus.values()).filter(u => u.supplierName === 'SIN PROVEEDOR')
  console.log(`\n--- 6. Productos sin Proveedor Operativo ---`)
  console.log(`Productos que quedarían sin proveedor asignado: ${productsWithoutSupplier.length}`)
  
  console.log(`\n✅ Proceso ${isDryRun ? 'DRY-RUN' : 'APPLY'} finalizado.\n`)
}

run().catch(console.error)
