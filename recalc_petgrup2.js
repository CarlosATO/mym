const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const iDb = createClient(supabaseUrl, serviceKey, {
  db: { schema: 'integraciones' },
  auth: { autoRefreshToken: false, persistSession: false },
});

async function fetchAll(
  schema,
  table,
  select,
  filters = {},
  options = {}
) {
  const maxRows = options.maxRows ?? 50000;
  const orderCol = options.orderCol;
  const c = createClient(supabaseUrl, serviceKey, {
    db: { schema }, auth: { autoRefreshToken: false, persistSession: false },
  });
  const result = [];
  const pageSize = 1000;
  for (let off = 0; off < maxRows; off += pageSize) {
    let q = c.from(table).select(select).range(off, off + pageSize - 1);
    if (orderCol) q = q.order(orderCol);
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined && v !== null) {
          if (Array.isArray(v)) q = q.in(k, v);
          else q = q.eq(k, v);
        }
      }
    }
    const { data, error } = await q;
    if (error) throw new Error(`[fetchAll] Error fetching ${schema}.${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    result.push(...data);
    if (data.length < pageSize) break;
    
    if (off + pageSize >= maxRows) {
      throw new Error(`[fetchAll] Límite de seguridad de ${maxRows} filas excedido para tabla ${table}`);
    }
  }
  return result;
}

async function main() {
  const t0 = Date.now();
  console.log("Iniciando carga de dataset recalculada...");
  
  // 1. Obtener documentos (Simulando lo que hace bsale-dataset.ts para docs de 180 días)
  const dateFromStr = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0];
  const docs = await fetchAll('integraciones', 'bsale_documents',
    'bsale_id, emission_date, document_type_id, office_id',
    { document_type_id: [1, 5, 23] }
  );

  const docIdSet = new Set(docs.map(d => d.bsale_id));
  const docMap = new Map();
  docs.forEach(d => docMap.set(d.bsale_id, d));
  console.log(`Docs cargados: ${docs.length}`);

  // 2. Obtener detalles chunking (la nueva lógica)
  const allDetails = [];
  const docIdsArray = [...docIdSet];
  const chunkSize = 200;
  
  for (let i = 0; i < docIdsArray.length; i += chunkSize) {
    const chunk = docIdsArray.slice(i, i + chunkSize);
    const chunkDetails = await fetchAll('integraciones', 'bsale_document_details',
      'bsale_document_id, variant_id, variant_code, variant_description, quantity, net_unit_value, total_amount',
      { bsale_document_id: chunk },
      { maxRows: 100000, orderCol: 'id' }
    );
    allDetails.push(...chunkDetails);
  }

  const t1 = Date.now();
  console.log(`Detalles totales cargados realmente: ${allDetails.length}`);
  console.log(`Carga completada en ${t1 - t0}ms`);
  
  // 3. Filtrar para SKU 1020
  const skuDetails = allDetails.filter(d => String(d.variant_code) === '1020');
  console.log(`Detalles para SKU 1020 cargados: ${skuDetails.length}`);
  
  // Buckets
  const buckets = [
    { label: '12/06 al 18/06', start: new Date('2026-06-12T00:00:00'), end: new Date('2026-06-19T00:00:00') },
    { label: '19/06 al 25/06', start: new Date('2026-06-19T00:00:00'), end: new Date('2026-06-26T00:00:00') },
    { label: '26/06 al 02/07', start: new Date('2026-06-26T00:00:00'), end: new Date('2026-07-03T00:00:00') },
    { label: '03/07 al 09/07', start: new Date('2026-07-03T00:00:00'), end: new Date('2026-07-10T00:00:00') },
  ];

  buckets.forEach(b => b.units = 0);
  const typeStats = { 1: 0, 5: 0, 23: 0 };

  skuDetails.forEach(det => {
    const doc = docMap.get(det.bsale_document_id);
    // analytics.ts parses this as date:
    const date = new Date(doc.emission_date + 'T00:00:00');
    const qty = Number(det.quantity) || 0;
    
    if (typeStats[doc.document_type_id] !== undefined) {
      typeStats[doc.document_type_id] += qty;
    }

    buckets.forEach(b => {
      if (date >= b.start && date < b.end) {
        b.units += qty;
      }
    });
  });

  console.log("\n--- RESULTADO PETGRUP RECALCULADO ---");
  console.log(`Ventas 6m (Total PetGrup para el bloque evaluado): ${buckets.reduce((a, b) => a + b.units, 0)}`);

  console.log("\n--- TOTAL POR BLOQUE ---");
  buckets.forEach(b => console.log(`${b.label}: ${b.units}`));

  console.log("\n--- TOTAL POR TIPO DE DOCUMENTO (solo [1, 5, 23]) ---");
  for (const t in typeStats) {
    console.log(`Type ${t}: ${typeStats[t]}`);
  }

}

main().catch(console.error);
