const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, { db: { schema: 'integraciones' } });

async function run() {
  console.log('--- START DIAGNOSTIC ---');

  // 1. Get Document Types
  const { data: docTypes, error: dtErr } = await supabase
    .from('bsale_document_types')
    .select('*')
    .ilike('name', '%nota%venta%');
    
  if (dtErr) console.error('Error fetching doc types:', dtErr);
  console.log('Document Types matching "nota venta":', docTypes);

  // Fallback if not found locally, fetch all just in case
  const { data: allDocTypes } = await supabase.from('bsale_document_types').select('*');
  const notaVentaType = allDocTypes?.find(t => t.name.toLowerCase().includes('nota') && t.name.toLowerCase().includes('venta'));
  
  if (!notaVentaType) {
    console.log('Could not find Nota de Venta type. All types:', allDocTypes?.map(t => ({id: t.bsale_id, name: t.name})));
    return;
  }
  
  const nvTypeId = notaVentaType.bsale_id;
  console.log(`Nota de Venta is document_type_id: ${nvTypeId} (${notaVentaType.name})`);

  // 2. Conteo de Notas de Venta
  const { count, error: countErr } = await supabase
    .from('bsale_documents')
    .select('*', { count: 'exact', head: true })
    .eq('document_type_id', nvTypeId);
    
  const { data: dateLimits } = await supabase
    .from('bsale_documents')
    .select('generation_date')
    .eq('document_type_id', nvTypeId)
    .order('generation_date', { ascending: true })
    .limit(1);
    
  const { data: dateLimitsDesc } = await supabase
    .from('bsale_documents')
    .select('generation_date')
    .eq('document_type_id', nvTypeId)
    .order('generation_date', { ascending: false })
    .limit(1);

  console.log(`Total Notas de Venta: ${count}`);
  console.log(`Date range: ${dateLimits?.[0]?.generation_date} to ${dateLimitsDesc?.[0]?.generation_date}`);

  // 3. Obtener 5 ejemplos recientes con detalles
  const { data: nvExamples, error: nvErr } = await supabase
    .from('bsale_documents')
    .select(`
      *,
      bsale_document_details (
        *
      )
    `)
    .eq('document_type_id', nvTypeId)
    .order('generation_date', { ascending: false })
    .limit(5);

  if (nvErr) console.error('Error fetching NVs:', nvErr);
  
  console.log('\n--- 5 EXAMPLES ---');
  fs.writeFileSync('nv_examples.json', JSON.stringify(nvExamples, null, 2));
  console.log('Saved 5 examples to nv_examples.json');

  // 4. Analizar relación con Facturas
  // Let's see if we have references xml
  const nvIds = nvExamples.map(e => e.bsale_id);
  const { data: refs } = await supabase
    .from('bsale_document_references_xml')
    .select('*')
    .in('document_id', nvIds);
    
  console.log('\n--- REFERENCES FOR THESE EXAMPLES ---');
  console.log(refs);

  // Let's see if there are ANY references in the table
  const { data: sampleRefs } = await supabase
    .from('bsale_document_references_xml')
    .select('*')
    .limit(10);
  fs.writeFileSync('nv_refs_sample.json', JSON.stringify(sampleRefs, null, 2));

  // 5. Check if Facturas have references to NV
  // Factura is usually type_id = 5 (Factura Electrónica) or 1 (Factura)
  const facturaType = allDocTypes?.find(t => t.name.toLowerCase().includes('factura') && t.name.toLowerCase().includes('electr'));
  const facturaTypeId = facturaType ? facturaType.bsale_id : 5;
  console.log(`Factura Electrónica is type_id: ${facturaTypeId}`);
  
  const { data: facturas } = await supabase
    .from('bsale_documents')
    .select('*')
    .eq('document_type_id', facturaTypeId)
    .order('generation_date', { ascending: false })
    .limit(50);
    
  const facturaIds = facturas?.map(f => f.bsale_id) || [];
  if (facturaIds.length > 0) {
    const { data: facturaRefs } = await supabase
      .from('bsale_document_references_xml')
      .select('*')
      .in('document_id', facturaIds);
    fs.writeFileSync('factura_refs_sample.json', JSON.stringify(facturaRefs, null, 2));
    
    // Test if any facturas reference NVs via Bsale's reference system
    console.log(`Found ${facturaRefs?.length || 0} references in 50 recent facturas`);
  }

  // 6. Check unique cities in recent NV
  const { data: citiesData } = await supabase
    .from('bsale_documents')
    .select('city, municipality, address')
    .eq('document_type_id', nvTypeId)
    .order('generation_date', { ascending: false })
    .limit(100);
    
  fs.writeFileSync('nv_cities.json', JSON.stringify(citiesData, null, 2));
  console.log('Saved 100 cities to nv_cities.json');

}
run().catch(console.error);
