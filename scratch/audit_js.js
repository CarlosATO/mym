require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'integraciones' } });
async function run() {
  const { data: nv } = await s.from('bsale_documents').select('company_id, bsale_id, client_id').eq('number', 3496).eq('document_type_id', 23).limit(1);
  if (!nv || nv.length === 0) return console.log('NV not found');
  const company_id = nv[0].company_id;
  const bsale_document_id = nv[0].bsale_id;

  const { data: det } = await s.from('bsale_document_details').select('bsale_id, variant_id').eq('company_id', company_id).eq('bsale_document_id', bsale_document_id);
  
  const skus_to_check = ['756146', '756625', 'VK31329', 'VK31326', 'VK31331', 'ECPACK24U'];

  for (let d of det) {
    const { data: v } = await s.from('bsale_variants').select('code, description, bsale_product_id').eq('bsale_id', d.variant_id).limit(1);
    if (v && v.length > 0 && skus_to_check.includes(v[0].code)) {
       const code = v[0].code;
       const v_desc = v[0].description || '';
       const prod_id = v[0].bsale_product_id;
       let p_name = '';
       if (prod_id) {
         const { data: p } = await s.from('bsale_products').select('name').eq('bsale_id', prod_id).limit(1);
         if (p && p.length > 0) p_name = p[0].name || '';
       }

       let actual = v_desc ? v_desc : (p_name ? p_name : 'Producto Desconocido');

       let final_name = '';
       const tv = v_desc.trim();
       const tp = p_name.trim();
       if (!tv) final_name = tp || 'Producto Desconocido';
       else if (!tp) final_name = tv || 'Producto Desconocido';
       else if (tv.toLowerCase() === tp.toLowerCase()) final_name = tp;
       else final_name = `${tp} ${tv}`;

       console.log(`\nSKU: ${code}`);
       console.log(`Detail ID: ${d.bsale_id}`);
       console.log(`Actual en vista: ${actual}`);
       console.log(`Base: ${p_name}`);
       console.log(`Variante: ${v_desc}`);
       console.log(`Final: ${final_name}`);
    }
  }

  // Client Data
  const { data: client } = await s.from('bsale_clients').select('*').eq('company_id', company_id).eq('bsale_client_id', nv[0].client_id).limit(1);
  console.log('\nClient Data Check:');
  if (client && client.length > 0) {
    const c = client[0];
    console.log(`client_bsale_id: ${nv[0].client_id}`);
    console.log(`nombre cliente: ${c.business_name}`);
    console.log(`RUT/code: ${c.code}`);
    console.log(`teléfono: ${c.phone}`);
    console.log(`email: ${c.email}`);
    console.log(`dirección: ${c.address}`);
    console.log(`comuna: ${c.commune}`);
    console.log(`giro: ${c.activity}`);
    console.log(`contacto: ${c.first_name} ${c.last_name}`);
  }
}
run();
