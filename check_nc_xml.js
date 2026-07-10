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

function fetchXml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function main() {
  const data = await fetch(`https://api.bsale.io/v1/documents.json?limit=10&documenttypeid=2&number=4202`);
  const doc = data.items.find(x => x.number === 4202);
  console.log("Doc 4202 XML URL:", doc.urlXml);
  if (doc.urlXml) {
    const xml = await fetchXml(doc.urlXml);
    console.log("XML:", xml);
  }
}

main().catch(console.error);
