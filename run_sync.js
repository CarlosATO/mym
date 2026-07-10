const { syncBsaleSales } = require('./src/app/actions/integraciones/bsale-sync');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

async function main() {
  console.log("Iniciando sync de ventas...");
  const res = await syncBsaleSales('d1000000-0000-0000-0000-000000000001', {
    dateFrom: '2026-07-03',
    dateTo: '2026-07-09'
  });
  console.log("Resultado del Sync:");
  console.log(JSON.stringify(res, null, 2));
}

main().catch(console.error);
