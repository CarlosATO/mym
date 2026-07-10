const https = require('https');
const fs = require('fs');

const docs = [
  { id: 87838, url: 'https://api.bsale.cl/v1/56713/files/c253457a414e.xml' },
  { id: 87855, url: 'https://api.bsale.cl/v1/56713/files/f30b0a5ee2a6.xml' },
  { id: 87860, url: 'https://api.bsale.cl/v1/56713/files/56b2f3b0d0ea.xml' },
  { id: 87913, url: 'https://api.bsale.cl/v1/56713/files/fcfc2a6623f9.xml' }
];

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
  for (const doc of docs) {
    const xml = await fetchXml(doc.url);
    console.log(`\n--- Doc XML ${doc.id} ---`);
    console.log(xml.substring(0, 1500) + '...');
  }
}

main().catch(console.error);
