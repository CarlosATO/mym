const fs = require('fs');
require('dotenv').config({ path: '.env.local' });

async function run() {
  console.log('--- START DIAGNOSTIC VIA BSALE API ---');

  const headers = { 'access_token': process.env.BSALE_ACCESS_TOKEN, 'Content-Type': 'application/json' };

  // 1. Get Notas de Venta (id 23)
  const resNV = await fetch('https://api.bsale.io/v1/documents.json?documenttypeid=23&limit=5&expand=client,office,document_type,seller,details,references', { headers });
  const nvData = await resNV.json();
  
  console.log(`Fetched ${nvData.items?.length || 0} Notas de Venta`);
  fs.writeFileSync('bsale_api_nvs.json', JSON.stringify(nvData.items, null, 2));

  // 2. Check if Factura (id 5) has references to NV (id 23)
  const resFactura = await fetch('https://api.bsale.io/v1/documents.json?documenttypeid=5&limit=20&expand=references', { headers });
  const fData = await resFactura.json();
  
  const facturasWithRef = fData.items?.filter(f => f.references && f.references.items && f.references.items.length > 0) || [];
  console.log(`Fetched 20 Facturas. ${facturasWithRef.length} have references.`);
  fs.writeFileSync('bsale_api_facturas_refs.json', JSON.stringify(facturasWithRef, null, 2));
  
  // Try getting exact references that point to NV
  const referencesToNV = facturasWithRef.flatMap(f => f.references.items).filter(r => r.referenceDocumentTypeId === 23 || (r.document && r.document.documentTypeId === 23));
  console.log('References directly to document_type_id=23:', referencesToNV);
}

run().catch(console.error);
