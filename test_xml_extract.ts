const { extractBsaleDocumentReferencesFromXml } = require('./src/app/actions/integraciones/bsale-sync');
const fs = require('fs');

const xml = `
          <Referencia>
            <NroLinRef>1</NroLinRef>
            <TpoDocRef>33</TpoDocRef>
            <FolioRef>22980</FolioRef>
            <FchRef>2026-06-26</FchRef>
            <CodRef>3</CodRef>
            <RazonRef>SNACKS DE OBSEQUIO</RazonRef>
          </Referencia>
`;

console.log(extractBsaleDocumentReferencesFromXml(xml));
