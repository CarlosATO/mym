const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  console.log("--- Auditoría Específica de Notas de Crédito SKU 1020 ---");
  
  const { data: ncDetails, error } = await iDb.from('vw_bsale_document_details_normalized')
    .select('document_number, bsale_document_id, detail_bsale_id, emission_date, generation_date, document_type_id, document_type_name, variant_code, raw_quantity, sign_for_sales, net_quantity, office_id, office_name')
    .eq('variant_code', '1020')
    .eq('document_type_id', 2) // Nota de crédito
    .gte('emission_date', '2026-06-12')
    .lte('emission_date', '2026-06-18');
    
  if (error) {
    console.error("Error fetching NC details:", error);
    return;
  }
  
  console.log(`Se encontraron ${ncDetails.length} líneas de NC en Supabase.\n`);
  
  console.log("| folio | bsale_document_id | detail_bsale_id | emission_date | variant_code | raw_quantity | net_quantity |");
  console.log("|---|---|---|---|---|---|---|");
  ncDetails.forEach(d => {
    console.log(`| ${d.document_number} | ${d.bsale_document_id} | ${d.detail_bsale_id} | ${d.emission_date} | ${d.variant_code} | ${d.raw_quantity} | ${d.net_quantity} |`);
  });
  
  // Extraer el raw_json de estos documents y details para mayor profundidad
  for (const d of ncDetails) {
    console.log(`\n--- Detalle Folio ${d.document_number} ---`);
    
    // Obtener raw document
    const { data: docData } = await iDb.from('bsale_documents').select('raw_json').eq('bsale_id', d.bsale_document_id).single();
    if (docData) {
      const j = docData.raw_json;
      console.log(`Doc raw_json (resumen): office.id=${j.office?.id}, client=${j.client?.id}, document_type=${j.document_type?.id}, state=${j.state}, rcvState=${j.rcvState}`);
    }
    
    // Obtener raw detail
    const { data: detData } = await iDb.from('bsale_document_details').select('raw_json').eq('bsale_id', d.detail_bsale_id).single();
    if (detData) {
      const j = detData.raw_json;
      console.log(`Detail raw_json: quantity=${j.quantity}, netAmount=${j.netAmount}, totalAmount=${j.totalAmount}, variant=${j.variant?.id}`);
    }
  }

}

main().catch(console.error);
