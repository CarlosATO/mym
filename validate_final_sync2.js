const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  const { data: details } = await iDb.from('vw_bsale_sales_logistic_valid')
    .select('*')
    .eq('variant_code', '1020')
    .gte('emission_date', '2026-06-12')
    .lte('emission_date', '2026-07-09');

  const blocks = [
    { label: '12/06 al 18/06', expected: 155, start: new Date('2026-06-12T00:00:00'), end: new Date('2026-06-19T00:00:00') },
    { label: '19/06 al 25/06', expected: 3, start: new Date('2026-06-19T00:00:00'), end: new Date('2026-06-26T00:00:00') },
    { label: '26/06 al 02/07', expected: 120, start: new Date('2026-06-26T00:00:00'), end: new Date('2026-07-03T00:00:00') },
    { label: '03/07 al 09/07', expected: 63, start: new Date('2026-07-03T00:00:00'), end: new Date('2026-07-10T00:00:00') },
  ];

  blocks.forEach(b => b.logistic = 0);

  details.forEach(d => {
    const emission = new Date(d.emission_date + 'T00:00:00');
    const b = blocks.find(x => emission >= x.start && emission < x.end);
    if (b) {
      b.logistic += Number(d.logistic_net_quantity);
    }
  });

  console.log("\n--- VALIDACION SKU 1020 POR BLOQUE ---");
  console.log("| Bloque | Bsale esperado Carlos | logistic_net_quantity Supabase | Diferencia |");
  console.log("|---|---|---|---|");
  blocks.forEach(b => {
    console.log(`| ${b.label} | ${b.expected} | ${b.logistic} | ${b.logistic - b.expected} |`);
  });

  console.log("\n--- VALIDACION DETALLE 03/07 al 09/07 ---");
  const expectedFolios = ['23032', '23039', '23071', '23072', '23096'];
  const blockDetails = details.filter(d => {
    const emission = new Date(d.emission_date + 'T00:00:00');
    return emission >= new Date('2026-07-03T00:00:00') && emission < new Date('2026-07-10T00:00:00');
  });

  console.log("| folio | header_exists | detail_exists | raw_qty | logistic_qty | type | date | office | coincide |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  expectedFolios.forEach(folio => {
    // FIX: loose inequality or String conversion
    const d = blockDetails.find(x => String(x.document_number) === folio);
    if (d) {
      const coincide = d.logistic_net_quantity == d.raw_quantity ? 'SÍ' : 'NO';
      console.log(`| ${folio} | SÍ | SÍ | ${d.raw_quantity} | ${d.logistic_net_quantity} | ${d.document_type_id} | ${d.emission_date} | ${d.office_name||'-'} | ${coincide} |`);
    } else {
      console.log(`| ${folio} | ? | NO | - | - | - | - | - | - |`);
    }
  });
}

main().catch(console.error);
