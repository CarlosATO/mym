const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) {
  process.env[k] = envConfig[k];
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const iDb = createClient(supabaseUrl, serviceKey, {
  db: { schema: 'integraciones' },
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const sku = '1020';
  const startDate = '2026-06-11';
  const endDate = '2026-07-10';

  console.log("=== AUDIT START ===");

  // 1. Get all docs in period
  const { data: allDocs, error: docError } = await iDb.from('bsale_documents')
    .select('bsale_id, document_type_id, number, emission_date, generation_date, synced_at, office_id')
    .gte('emission_date', '2026-06-11')
    .lte('emission_date', '2026-07-09');

  if (docError) {
    console.error("Error fetching docs:", docError);
    return;
  }

  const docIds = allDocs.map(d => d.bsale_id);
  const docMap = new Map();
  allDocs.forEach(d => docMap.set(d.bsale_id, d));

  console.log(`Found ${allDocs.length} docs in period`);

  // Fetch details by pages or just query by variant_code
  let skuDetails = [];
  const { data: detData, error: detError } = await iDb.from('bsale_document_details')
    .select('bsale_document_id, variant_code, quantity, variant_id')
    .eq('variant_code', sku);
    
  if (detError) {
    console.error("Error fetching details:", detError);
    return;
  }
  
  skuDetails = detData.filter(d => docMap.has(d.bsale_document_id));
  console.log(`Found ${detData.length} details total for sku ${sku}, ${skuDetails.length} in period.`);

  // Find document types by mapping or guessing
  const docTypeMap = {
    1: 'FACTURA ELECTRÓNICA / BOLETA',
    2: 'NOTA DE CRÉDITO ELECTRÓNICA',
    5: 'BOLETA ELECTRÓNICA T / FACTURA',
    23: 'NOTA VENTA'
  };

  // Buckets
  const buckets = [
    { label: '12/06 al 18/06', start: new Date('2026-06-12T00:00:00'), end: new Date('2026-06-19T00:00:00'), expected: 155, petgrup: 53 },
    { label: '19/06 al 25/06', start: new Date('2026-06-19T00:00:00'), end: new Date('2026-06-26T00:00:00'), expected: 3, petgrup: 15 },
    { label: '26/06 al 02/07', start: new Date('2026-06-26T00:00:00'), end: new Date('2026-07-03T00:00:00'), expected: 120, petgrup: 88 },
    { label: '03/07 al 09/07', start: new Date('2026-07-03T00:00:00'), end: new Date('2026-07-10T00:00:00'), expected: 63, petgrup: 0 },
  ];

  // Process data for buckets
  buckets.forEach(b => {
    b.bruto = 0;
    b.nc = 0;
    b.neto = 0;
    b.docs = 0;
    b.details = 0;
  });

  const typeStats = {};
  const officeStats = {};

  skuDetails.forEach(det => {
    const doc = docMap.get(det.bsale_document_id);
    const date = new Date(doc.emission_date + 'T00:00:00');
    const qty = Number(det.quantity) || 0;
    const dt = doc.document_type_id;

    const isNC = (dt === 2 || dt === 36 || dt === 37);
    const sign = isNC ? -1 : 1;
    const netQty = qty * sign;

    // Type Stats
    if (!typeStats[dt]) typeStats[dt] = { docs: new Set(), bruto: 0, neto: 0 };
    typeStats[dt].docs.add(doc.bsale_id);
    typeStats[dt].bruto += qty;
    typeStats[dt].neto += netQty;

    // Office Stats
    const off = doc.office_id || 'null';
    if (!officeStats[off]) officeStats[off] = { docs: new Set(), bruto: 0, neto: 0 };
    officeStats[off].docs.add(doc.bsale_id);
    officeStats[off].bruto += qty;
    officeStats[off].neto += netQty;

    // Bucket Stats
    buckets.forEach(b => {
      if (date >= b.start && date < b.end) {
        if (!isNC) b.bruto += qty;
        else b.nc += qty;
        b.neto += netQty;
        b.details++;
        b.docs++; // rough count
      }
    });
  });

  console.log("\n--- BUCKETS ---");
  buckets.forEach(b => {
    console.log(`${b.label} | Bsale esperado: ${b.expected} | PetGrup actual: ${b.petgrup} | Supabase bruto (FE+Bol): ${b.bruto} | Supabase NC: ${b.nc} | Supabase neto: ${b.neto} | Diff neto vs Bsale: ${b.neto - b.expected} | Details: ${b.details}`);
  });

  console.log("\n--- TYPE STATS ---");
  for (const dt in typeStats) {
    const isNC = (parseInt(dt) === 2 || parseInt(dt) === 36 || parseInt(dt) === 37);
    console.log(`Type: ${dt} (${docTypeMap[dt] || 'UNKNOWN'}) | docs: ${typeStats[dt].docs.size} | bruto: ${typeStats[dt].bruto} | neto: ${typeStats[dt].neto} | Sign: ${isNC ? '-' : '+'}`);
  }

  console.log("\n--- OFFICE STATS ---");
  for (const off in officeStats) {
    console.log(`Office: ${off} | docs: ${officeStats[off].docs.size} | bruto: ${officeStats[off].bruto} | neto: ${officeStats[off].neto}`);
  }

  // Synced at details
  const maxDocEmis = allDocs.reduce((m, d) => (!m || d.emission_date > m) ? d.emission_date : m, null);
  const maxDocGen = allDocs.reduce((m, d) => (!m || d.generation_date > m) ? d.generation_date : m, null);
  const maxDocSync = allDocs.reduce((m, d) => (!m || d.synced_at > m) ? d.synced_at : m, null);
  
  console.log("\n--- SYNC STATS ---");
  console.log(`Max emission_date: ${maxDocEmis}`);
  console.log(`Max generation_date: ${maxDocGen}`);
  console.log(`Max synced_at: ${maxDocSync}`);

  // Count docs in 03/07 to 09/07
  const lastBlockDocs = allDocs.filter(d => d.emission_date >= '2026-07-03' && d.emission_date <= '2026-07-09');
  console.log(`Total docs in 03/07 - 09/07: ${lastBlockDocs.length}`);
  const lastBlockDetails = skuDetails.filter(d => {
    const doc = docMap.get(d.bsale_document_id);
    return doc.emission_date >= '2026-07-03' && doc.emission_date <= '2026-07-09';
  });
  console.log(`Total SKU1020 details in 03/07 - 09/07: ${lastBlockDetails.length}`);

  console.log("\n=== AUDIT END ===");
}

main().catch(console.error);
