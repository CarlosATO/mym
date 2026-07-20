require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'integraciones' } });
async function run() {
  // Check the real FK from bsale_variants to bsale_products
  const { data: fk_check } = await s.rpc('execute_sql', { query: `
    SELECT 
        v.bsale_id AS variant_id, 
        v.code, 
        v.description AS variant_desc, 
        v.bsale_product_id,
        p.bsale_id AS product_id,
        p.name AS product_name
    FROM integraciones.bsale_variants v
    LEFT JOIN integraciones.bsale_products p ON v.bsale_product_id = p.bsale_id
    WHERE v.code = '756146'
  ` });
  console.log('FK Check for 756146:');
  console.log(fk_check);

  // Check the items query using the proposed logic
  const { data: audit } = await s.rpc('execute_sql', { query: `
    SELECT 
        nv.number AS nv_folio,
        v.code AS sku,
        det.bsale_id AS detail_id,
        -- product_name_actual_en_vista
        COALESCE(NULLIF(v.description, ''), p.name, 'Producto Desconocido') AS product_name_actual,
        p.name AS product_name_base,
        v.description AS variant_description,
        -- product_name_final_propuesto
        CASE 
            WHEN NULLIF(TRIM(v.description), '') IS NULL THEN COALESCE(NULLIF(TRIM(p.name), ''), 'Producto Desconocido')
            WHEN NULLIF(TRIM(p.name), '') IS NULL THEN COALESCE(NULLIF(TRIM(v.description), ''), 'Producto Desconocido')
            WHEN TRIM(LOWER(v.description)) = TRIM(LOWER(p.name)) THEN TRIM(p.name)
            ELSE TRIM(CONCAT(p.name, ' ', v.description))
        END AS product_name_final
    FROM integraciones.bsale_documents nv
    JOIN integraciones.bsale_document_details det ON nv.company_id = det.company_id AND nv.bsale_id = det.bsale_document_id
    LEFT JOIN integraciones.bsale_variants v ON det.company_id = v.company_id AND det.variant_id = v.bsale_id
    LEFT JOIN integraciones.bsale_products p ON v.company_id = p.company_id AND v.bsale_product_id = p.bsale_id
    WHERE nv.number = 3496 AND nv.document_type_id = 23
  ` });
  
  if (audit) {
    const skus_to_check = ['756146', '756625', 'VK31329', 'VK31326', 'VK31331', 'ECPACK24U'];
    for (let row of audit) {
      if (skus_to_check.includes(row.sku)) {
        console.log(`\nSKU: ${row.sku}`);
        console.log(`Detail ID: ${row.detail_id}`);
        console.log(`Actual en vista: ${row.product_name_actual}`);
        console.log(`Base: ${row.product_name_base}`);
        console.log(`Variante: ${row.variant_description}`);
        console.log(`Final: ${row.product_name_final}`);
      }
    }
  }

  // Audit Client Data
  const { data: clientData } = await s.rpc('execute_sql', { query: `
    SELECT 
        nv.client_id AS client_bsale_id,
        c.business_name AS nombre_cliente,
        c.code AS rut,
        c.phone AS telefono,
        c.email AS email,
        c.address AS direccion,
        c.commune AS comuna,
        c.city AS ciudad,
        c.activity AS giro,
        c.first_name || ' ' || c.last_name AS contacto
    FROM integraciones.bsale_documents nv
    LEFT JOIN integraciones.bsale_clients c ON nv.company_id = c.company_id AND nv.client_id = c.bsale_client_id
    WHERE nv.number = 3496 AND nv.document_type_id = 23
  `});
  console.log('\nClient Data Check:');
  console.log(clientData);

}
run();
