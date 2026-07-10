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
  const sku = '1020';

  const { data: allDocs } = await iDb.from('bsale_documents')
    .select('bsale_id, document_type_id, number, emission_date, generation_date, synced_at, office_id')
    .gte('emission_date', '2026-06-11')
    .lte('emission_date', '2026-07-09');

  const docMap = new Map();
  allDocs.forEach(d => docMap.set(d.bsale_id, d));

  const { data: detData } = await iDb.from('bsale_document_details')
    .select('bsale_document_id, variant_code, quantity')
    .eq('variant_code', sku);

  const skuDetails = detData.filter(d => docMap.has(d.bsale_document_id));

  // Buckets
  const buckets = [
    { label: '12/06 al 18/06', start: new Date('2026-06-12T00:00:00'), end: new Date('2026-06-19T00:00:00'), expected: 155, petgrup: 53 },
    { label: '19/06 al 25/06', start: new Date('2026-06-19T00:00:00'), end: new Date('2026-06-26T00:00:00'), expected: 3, petgrup: 15 },
    { label: '26/06 al 02/07', start: new Date('2026-06-26T00:00:00'), end: new Date('2026-07-03T00:00:00'), expected: 120, petgrup: 88 },
    { label: '03/07 al 09/07', start: new Date('2026-07-03T00:00:00'), end: new Date('2026-07-10T00:00:00'), expected: 63, petgrup: 0 },
  ];

  buckets.forEach(b => { b.bruto = 0; b.nc = 0; b.neto = 0; b.details = 0; });

  const typeStats = {};
  const officeStats = {};

  skuDetails.forEach(det => {
    const doc = docMap.get(det.bsale_document_id);
    const date = new Date(doc.emission_date + 'T00:00:00');
    const qty = Number(det.quantity) || 0;
    const dt = doc.document_type_id;

    // Factura = 5, Boleta = 1, NC = 2
    if (![1, 2, 5].includes(dt)) return; // Only process these for the logic requested by user

    const isNC = (dt === 2);
    const sign = isNC ? -1 : 1;
    const netQty = qty * sign;

    if (!typeStats[dt]) typeStats[dt] = { docs: new Set(), bruto: 0, neto: 0 };
    typeStats[dt].docs.add(doc.bsale_id);
    typeStats[dt].bruto += qty;
    typeStats[dt].neto += netQty;

    const off = doc.office_id || 'null';
    if (!officeStats[off]) officeStats[off] = { docs: new Set(), bruto: 0, neto: 0 };
    officeStats[off].docs.add(doc.bsale_id);
    officeStats[off].bruto += qty;
    officeStats[off].neto += netQty;

    buckets.forEach(b => {
      if (date >= b.start && date < b.end) {
        if (!isNC) b.bruto += qty;
        else b.nc += qty;
        b.neto += netQty;
        b.details++;
      }
    });
  });

  console.log("\n--- BUCKETS ---");
  buckets.forEach(b => {
    console.log(`${b.label} | Bsale esperado: ${b.expected} | PetGrup actual: ${b.petgrup} | Supabase bruto: ${b.bruto} | Supabase NC: ${b.nc} | Supabase neto: ${b.neto} | Diff neto vs Bsale: ${b.neto - b.expected} | Details: ${b.details}`);
  });

  console.log("\n--- TYPE STATS ---");
  const dtNames = { 1: 'BOLETA ELECTRÓNICA T', 2: 'NOTA DE CRÉDITO ELECTRÓNICA', 5: 'FACTURA ELECTRÓNICA' };
  for (const dt in typeStats) {
    const isNC = (parseInt(dt) === 2);
    console.log(`Type: ${dt} (${dtNames[dt]}) | docs: ${typeStats[dt].docs.size} | bruto: ${typeStats[dt].bruto} | neto: ${typeStats[dt].neto} | Sign: ${isNC ? '-' : '+'}`);
  }

  console.log("\n--- OFFICE STATS ---");
  for (const off in officeStats) {
    console.log(`Office: ${off} | docs: ${officeStats[off].docs.size} | bruto: ${officeStats[off].bruto} | neto: ${officeStats[off].neto}`);
  }

  const maxDocEmis = allDocs.reduce((m, d) => (!m || d.emission_date > m) ? d.emission_date : m, null);
  const maxDocGen = allDocs.reduce((m, d) => (!m || d.generation_date > m) ? d.generation_date : m, null);
  const maxDocSync = allDocs.reduce((m, d) => (!m || d.synced_at > m) ? d.synced_at : m, null);
  
  console.log("\n--- SYNC STATS ---");
  console.log(`Max emission_date: ${maxDocEmis}`);
  console.log(`Max generation_date: ${maxDocGen}`);
  console.log(`Max synced_at: ${maxDocSync}`);

  const lastBlockDocs = allDocs.filter(d => d.emission_date >= '2026-07-03' && d.emission_date <= '2026-07-09');
  console.log(`Total docs in 03/07 - 09/07: ${lastBlockDocs.length}`);
  const lastBlockDetails = skuDetails.filter(d => {
    const doc = docMap.get(d.bsale_document_id);
    return doc.emission_date >= '2026-07-03' && doc.emission_date <= '2026-07-09';
  });
  console.log(`Total SKU1020 details in 03/07 - 09/07: ${lastBlockDetails.length}`);

}

main().catch(console.error);
