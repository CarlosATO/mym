const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("Missing supabase credentials");
  process.exit(1);
}

const integrDb = createClient(supabaseUrl, serviceKey, {
  db: { schema: 'integraciones' },
  auth: { autoRefreshToken: false, persistSession: false },
});

const adqDb = createClient(supabaseUrl, serviceKey, {
  db: { schema: 'adquisiciones' },
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log("INICIANDO DIAGNÓSTICO B-SALE DRY RUN");
  try {
    // 1. Revisar estructura real
    let bsaleProductTypesExists = false;
    try {
        const { data: bpt, error: bptErr } = await integrDb.from('bsale_product_types').select('id').limit(1);
        if(!bptErr) bsaleProductTypesExists = true;
    } catch(e) {}
    console.log("integraciones.bsale_product_types exists:", bsaleProductTypesExists);

    // Get table structures
    console.log("\n--- A. Conteos Base ---");
    const { count: variantsTotal } = await integrDb.from('bsale_variants').select('*', { count: 'exact', head: true });
    console.log("total variantes Bsale:", variantsTotal);
    
    const { count: variantsValidSku } = await integrDb.from('bsale_variants').select('*', { count: 'exact', head: true }).neq('code', '').not('code', 'is', null);
    console.log("variantes Bsale con SKU válido:", variantsValidSku);

    const { count: productsTotal } = await adqDb.from('products').select('*', { count: 'exact', head: true });
    console.log("total productos PetGrup activos:", productsTotal);

    const { count: productsValidSku } = await adqDb.from('products').select('*', { count: 'exact', head: true }).neq('sku', '').not('sku', 'is', null);
    console.log("productos PetGrup con SKU válido:", productsValidSku);

    // Fetch all suppliers
    const { data: suppliersData } = await adqDb.from('suppliers').select('id, business_name, company_id, is_active');
    const suppliers = suppliersData || [];
    const activeSuppliers = suppliers.filter(s => s.is_active);
    console.log("total proveedores activos:", activeSuppliers.length);
    console.log("proveedores activos con company_id null:", activeSuppliers.filter(s => s.company_id === null).length);

    const { count: mappingsTotal } = await adqDb.from('product_supplier_mappings').select('*', { count: 'exact', head: true });
    console.log("mappings existentes:", mappingsTotal);

async function fetchAll(db, table, selectFields) {
    let all = [];
    let from = 0;
    const pageSize = 1000;
    while(true) {
        const { data } = await db.from(table).select(selectFields).range(from, from + pageSize - 1);
        if(!data || data.length === 0) break;
        all.push(...data);
        if(data.length < pageSize) break;
        from += pageSize;
    }
    return all;
}

    // Fetch all variants with their products
    console.log("\n--- Fetching Data for matching ---");
    const variants = await fetchAll(integrDb, 'bsale_variants', 'bsale_id, code, description, bsale_product_id');
    const productsBsale = await fetchAll(integrDb, 'bsale_products', 'bsale_id, name, raw_json');
    const petgrupProducts = await fetchAll(adqDb, 'products', 'id, description, sku');
    const costs = await fetchAll(integrDb, 'bsale_variant_costs', 'variant_id, average_cost');

    console.log("Variantes fetched:", variants.length);
    console.log("Productos Bsale fetched:", productsBsale.length);
    console.log("Productos PetGrup fetched:", petgrupProducts.length);
    
    // Check what raw_json looks like
    if (productsBsale.length > 0) {
        console.log("Sample product_type from raw_json:", productsBsale[0].raw_json?.product_type);
    }

    // Fetch product types from Bsale API directly since they are not in the DB
    const bsaleToken = process.env.BSALE_ACCESS_TOKEN;
    const bsaleUrl = process.env.BSALE_API_BASE_URL || 'https://api.bsale.io/v1';
    let bsaleProductTypesMap = new Map();
    try {
        const res = await fetch(`${bsaleUrl}/product_types.json`, {
            headers: { 'access_token': bsaleToken }
        });
        const data = await res.json();
        if(data && data.items) {
            data.items.forEach(pt => {
                bsaleProductTypesMap.set(String(pt.id), pt.name);
            });
        }
    } catch(e) {
        console.error("Error fetching product types from Bsale:", e);
    }

    const bsaleProductsMap = new Map(productsBsale.map(p => [p.bsale_id, p]));
    const petgrupProductsMap = new Map();
    petgrupProducts.forEach(p => {
        if(p.sku) {
            if(!petgrupProductsMap.has(p.sku)) petgrupProductsMap.set(p.sku, []);
            petgrupProductsMap.get(p.sku).push(p);
        }
    });

    const costMap = new Map(costs.map(c => [c.variant_id, c.average_cost]));

    let matchingSku = 0;
    let notMatchingSku = 0;
    let top30NoMatch = [];

    let matchSupplier = 0;
    let noMatchSupplier = 0;
    let top30NoSupplierMatch = [];

    let proposedMappings = [];
    
    // Normalization rule for suppliers
    const normalizeSupplierName = (name) => {
        if (!name) return null;
        let n = name;
        if (n.includes('/')) {
            n = n.split('/')[0];
        }
        return n.trim().toUpperCase().replace(/\s+/g, ' ');
    };

    const supplierMap = new Map();
    activeSuppliers.forEach(s => {
        const norm = normalizeSupplierName(s.business_name);
        if(!supplierMap.has(norm)) supplierMap.set(norm, []);
        supplierMap.get(norm).push(s);
    });

    variants.forEach(v => {
        if (!v.code) return;
        
        // SKU matching
        if (petgrupProductsMap.has(v.code)) {
            matchingSku++;
        } else {
            notMatchingSku++;
            if (top30NoMatch.length < 30) {
                const bProd = bsaleProductsMap.get(v.bsale_product_id);
                top30NoMatch.push({
                    sku: v.code,
                    bsale_product: bProd ? bProd.name : null,
                    variant_desc: v.description
                });
            }
        }

        // Supplier matching
        const bProd = bsaleProductsMap.get(v.bsale_product_id);
        const ptId = bProd?.raw_json?.product_type?.id;
        const productType = ptId ? bsaleProductTypesMap.get(String(ptId)) : null;
        const expectedSupplierName = normalizeSupplierName(productType);

        let matchedSupplier = null;
        if (expectedSupplierName && supplierMap.has(expectedSupplierName)) {
            matchedSupplier = supplierMap.get(expectedSupplierName)[0];
            matchSupplier++;
        } else {
            noMatchSupplier++;
            if (top30NoSupplierMatch.length < 30) {
                top30NoSupplierMatch.push({
                    sku: v.code,
                    bsale_product: bProd ? bProd.name : null,
                    original_product_type: productType,
                    expected_supplier_name: expectedSupplierName
                });
            }
        }

        // Build proposal
        if (matchedSupplier) {
            const petgrupProd = petgrupProductsMap.has(v.code) ? petgrupProductsMap.get(v.code)[0] : null;
            const avgCost = costMap.get(v.bsale_id) || 0;
            proposedMappings.push({
                sku: v.code,
                bsale_variant_id: v.bsale_id,
                bsale_product: bProd ? bProd.name : null,
                product_id: petgrupProd ? petgrupProd.id : null,
                petgrup_product: petgrupProd ? petgrupProd.description : null,
                supplier_id: matchedSupplier.id,
                supplier_name: matchedSupplier.business_name,
                unit_cost: avgCost,
                is_preferred: true // default props
            });
        }
    });

    console.log("\n--- B. Matching SKU ---");
    console.log("Matchean producto PetGrup:", matchingSku);
    console.log("No matchean producto PetGrup:", notMatchingSku);
    console.log("Top 30 no match:", JSON.stringify(top30NoMatch, null, 2));

    console.log("\n--- C. Matching Proveedor ---");
    console.log("Variantes asignables a proveedor (por Tipo de Producto):", matchSupplier);
    console.log("Variantes sin proveedor:", noMatchSupplier);
    console.log("Top 30 casos sin proveedor:", JSON.stringify(top30NoSupplierMatch, null, 2));

    console.log("\n--- D. Ambigüedades ---");
    const skuCounts = {};
    variants.forEach(v => {
        if(v.code) skuCounts[v.code] = (skuCounts[v.code] || 0) + 1;
    });
    const dupBsaleSkus = Object.keys(skuCounts).filter(k => skuCounts[k] > 1);
    console.log("SKUs duplicados en Bsale:", dupBsaleSkus.length);

    const dupPetgrupSkus = [...petgrupProductsMap.keys()].filter(k => petgrupProductsMap.get(k).length > 1);
    console.log("SKUs duplicados en productos PetGrup:", dupPetgrupSkus.length);

    const dupSuppliers = [...supplierMap.keys()].filter(k => supplierMap.get(k).length > 1);
    console.log("Proveedores duplicados por nombre normalizado:", dupSuppliers.length);

    const nullCosts = proposedMappings.filter(m => m.unit_cost === 0 || m.unit_cost === null).length;
    console.log("Costos promedio nulos o 0 en la propuesta:", nullCosts);

    console.log("\n--- E. Propuesta Dry-Run ---");
    console.log("Total product_supplier_mappings a crear:", proposedMappings.length);
    console.log("Con product_id:", proposedMappings.filter(m => m.product_id).length);
    console.log("Con supplier_id:", proposedMappings.filter(m => m.supplier_id).length);
    console.log("Con unit_cost > 0:", proposedMappings.filter(m => m.unit_cost > 0).length);
    console.log("Listos para generar OC (tienen todo):", proposedMappings.filter(m => m.product_id && m.supplier_id && m.unit_cost > 0).length);
    
    console.log("\nMuestra de 50 mappings:");
    console.log(JSON.stringify(proposedMappings.slice(0, 50), null, 2));

  } catch(e) {
      console.error(e);
  }
}

main();
