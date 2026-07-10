const https = require('https');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const token = process.env.BSALE_ACCESS_TOKEN;
const docs = [87838, 87855, 87860, 87913];

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
  for (const id of docs) {
    const doc = await fetch(`https://api.bsale.io/v1/documents/${id}.json`);
    console.log(`\n--- Doc ${id} ---`);
    console.log(doc.ted);
  }
}

main().catch(console.error);
