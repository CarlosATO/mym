const https = require('https');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const token = process.env.BSALE_ACCESS_TOKEN;

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'access_token': token } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  const data = await fetch(`https://api.bsale.io/v1/documents.json?limit=1&documenttypeid=2`);
  console.log(JSON.stringify(data.items[0], null, 2));
}

main().catch(console.error);
