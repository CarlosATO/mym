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
  const { data: allDocs } = await iDb.from('bsale_documents')
    .select('bsale_id, document_type_id, number, emission_date, generation_date, synced_at, office_id')
    .in('document_type_id', [1, 5, 23]);

  const docMap = new Map();
  allDocs.forEach(d => docMap.set(d.bsale_id, d));

  const { data: detData } = await iDb.from('bsale_document_details')
    .select('bsale_document_id, variant_code, quantity')
    .eq('variant_code', '1020');

  const skuDetails = detData.filter(d => docMap.has(d.bsale_document_id));

  const buckets = [
    { label: '12/06 al 18/06', start: new Date('2026-06-12T00:00:00'), end: new Date('2026-06-19T00:00:00') },
    { label: '19/06 al 25/06', start: new Date('2026-06-19T00:00:00'), end: new Date('2026-06-26T00:00:00') },
    { label: '26/06 al 02/07', start: new Date('2026-06-26T00:00:00'), end: new Date('2026-07-03T00:00:00') },
    { label: '03/07 al 09/07', start: new Date('2026-07-03T00:00:00'), end: new Date('2026-07-10T00:00:00') },
  ];

  buckets.forEach(b => b.petgrup = 0);

  skuDetails.forEach(det => {
    const doc = docMap.get(det.bsale_document_id);
    const date = new Date(doc.emission_date + 'T00:00:00');
    const qty = Number(det.quantity) || 0;

    buckets.forEach(b => {
      if (date >= b.start && date < b.end) {
        b.petgrup += qty;
      }
    });
  });

  console.log("PetGrup Mock Calculation (Types 1, 5, 23):");
  buckets.forEach(b => console.log(`${b.label}: ${b.petgrup}`));
  console.log("Total:", buckets.reduce((a, b) => a + b.petgrup, 0));
}

main().catch(console.error);
