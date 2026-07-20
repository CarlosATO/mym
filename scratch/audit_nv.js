require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'integraciones' } });
async function run() {
  const { data: items } = await s.from('vw_bsale_sales_order_items_for_preparation').select('*').eq('nv_folio', 3496).order('product_name');
  if (items && items.length > 0) {
    console.log('Current View Items:');
    for (let i=0; i<Math.min(5, items.length); i++) {
      console.log(`SKU: ${items[i].sku}, Actual: ${items[i].product_name}`);
      
      const { data: det } = await s.from('bsale_document_details').select('variant_description').eq('bsale_id', items[i].detail_id).single();
      const { data: vr } = await s.from('bsale_variants').select('description, bsale_product_id').eq('bsale_id', items[i].variant_id).single();
      let p_name = null;
      if (vr && vr.bsale_product_id) {
         const { data: pr } = await s.from('bsale_products').select('name').eq('bsale_id', vr.bsale_product_id).single();
         p_name = pr ? pr.name : null;
      }
      console.log(`  Raw Variant Desc: ${vr ? vr.description : null}`);
      console.log(`  Raw Product Name: ${p_name}`);
      
      const v_desc = vr ? vr.description : null;
      let final_name = '';
      if (!v_desc || v_desc.trim() === '') final_name = p_name || 'Producto Desconocido';
      else if (!p_name || p_name.trim() === '') final_name = v_desc || 'Producto Desconocido';
      else if (v_desc.trim().toLowerCase() === p_name.trim().toLowerCase()) final_name = p_name.trim();
      else final_name = `${p_name.trim()} ${v_desc.trim()}`;
      
      console.log(`  Proposed Name: ${final_name}`);
      console.log('----------------');
    }
  }
}
run();
