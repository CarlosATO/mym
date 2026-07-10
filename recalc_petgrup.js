const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const t0 = Date.now();
  console.log("Iniciando carga de dataset...");
  
  // 1. Obtener documentos
  const { data: allDocs, error: docError } = await iDb.from('bsale_documents')
    .select('bsale_id, document_type_id, number, emission_date, generation_date, synced_at, office_id')
    .in('document_type_id', [1, 5, 23])
    .gte('emission_date', '2026-01-01'); // approx limit
    
  if (docError) {
    console.error(docError);
    return;
  }

  const docIdSet = new Set(allDocs.map(d => d.bsale_id));
  const docMap = new Map();
  allDocs.forEach(d => docMap.set(d.bsale_id, d));
  
  console.log(`Docs cargados: ${allDocs.length}`);
  
  // 2. Obtener detalles chunking (la nueva lógica)
  const allDetails = [];
  const docIdsArray = [...docIdSet];
  const chunkSize = 200;
  
  for (let i = 0; i < docIdsArray.length; i += chunkSize) {
    const chunk = docIdsArray.slice(i, i + chunkSize);
    
    // fetchAll loop logic for the chunk
    let off = 0;
    const pageSize = 1000;
    const maxRows = 100000;
    while (off < maxRows) {
      const { data: chunkData, error: chunkErr } = await iDb.from('bsale_document_details')
        .select('bsale_document_id, variant_code, quantity, variant_id')
        .in('bsale_document_id', chunk)
        .order('id')
        .range(off, off + pageSize - 1);
        
      if (chunkErr) {
        console.error(chunkErr);
        break;
      }
      
      if (!chunkData || chunkData.length === 0) break;
      allDetails.push(...chunkData);
      
      if (chunkData.length < pageSize) break;
      off += pageSize;
      if (off >= maxRows) console.warn("Límite excedido");
    }
  }

  const t1 = Date.now();
  console.log(`Detalles totales cargados realmente: ${allDetails.length}`);
  console.log(`Carga completada en ${t1 - t0}ms`);
  
  // 3. Filtrar para SKU 1020
  const skuDetails = allDetails.filter(d => String(d.variant_code) === '1020');
  
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
  console.log(`Ventas 6m (Total PetGrup, periodo evaluado): ${buckets.reduce((a, b) => a + b.units, 0)}`);

  console.log("\n--- TOTAL POR BLOQUE ---");
  buckets.forEach(b => console.log(`${b.label}: ${b.units}`));

  console.log("\n--- TOTAL POR TIPO DE DOCUMENTO (solo [1, 5, 23]) ---");
  for (const t in typeStats) {
    console.log(`Type ${t}: ${typeStats[t]}`);
  }

}

main().catch(console.error);
