CREATE TABLE portal.regions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code varchar(10) NOT NULL,
    name varchar(100) NOT NULL,
    normalized_name varchar(100) NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_code ON portal.regions (code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_name ON portal.regions (name);

CREATE TABLE portal.communes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id uuid NOT NULL REFERENCES portal.regions(id),
    code varchar(20) NOT NULL,
    name varchar(100) NOT NULL,
    normalized_name varchar(100) NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_communes_code ON portal.communes (code);
CREATE INDEX IF NOT EXISTS idx_communes_region ON portal.communes (region_id);
CREATE INDEX IF NOT EXISTS idx_communes_name ON portal.communes (name);

ALTER TABLE portal.regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal.communes ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_regions_select ON portal.regions FOR SELECT TO authenticated USING (true);
CREATE POLICY rls_communes_select ON portal.communes FOR SELECT TO authenticated USING (true);

GRANT USAGE ON SCHEMA portal TO authenticated, service_role;
GRANT ALL ON portal.regions TO authenticated, service_role;
GRANT ALL ON portal.communes TO authenticated, service_role;

INSERT INTO portal.regions (code, name, normalized_name) VALUES
('AP', 'ARICA Y PARINACOTA', 'ARICA Y PARINACOTA'),
('TA', 'TARAPACA', 'TARAPACA'),
('AN', 'ANTOFAGASTA', 'ANTOFAGASTA'),
('AT', 'ATACAMA', 'ATACAMA'),
('CO', 'COQUIMBO', 'COQUIMBO'),
('VS', 'VALPARAISO', 'VALPARAISO'),
('RM', 'REGION METROPOLITANA', 'REGION METROPOLITANA'),
('LI', 'LIBERTADOR GENERAL BERNARDO O''HIGGINS', 'LIBERTADOR GENERAL BERNARDO O''HIGGINS'),
('ML', 'MAULE', 'MAULE'),
('NB', 'NUBLE', 'NUBLE'),
('BI', 'BIOBIO', 'BIOBIO'),
('AR', 'LA ARAUCANIA', 'LA ARAUCANIA'),
('LR', 'LOS RIOS', 'LOS RIOS'),
('LL', 'LOS LAGOS', 'LOS LAGOS'),
('AI', 'AYSEN DEL GENERAL CARLOS IBAÑEZ DEL CAMPO', 'AYSEN DEL GENERAL CARLOS IBAÑEZ DEL CAMPO'),
('MG', 'MAGALLANES Y DE LA ANTARTICA CHILENA', 'MAGALLANES Y DE LA ANTARTICA CHILENA');

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'ARICA'), (reg.code || '-02', 'CAMARONES'), (reg.code || '-03', 'PUTRE'), (reg.code || '-04', 'GENERAL LAGOS')
) AS codes(code, name) WHERE reg.code = 'AP';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'IQUIQUE'), (reg.code || '-02', 'ALTO HOSPICIO'), (reg.code || '-03', 'POZO ALMONTE'), (reg.code || '-04', 'CAMIÑA'), (reg.code || '-05', 'COLCHANE'), (reg.code || '-06', 'HUARA'), (reg.code || '-07', 'PICA')
) AS codes(code, name) WHERE reg.code = 'TA';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'ANTOFAGASTA'), (reg.code || '-02', 'MEJILLONES'), (reg.code || '-03', 'SIERRA GORDA'), (reg.code || '-04', 'TALTAL'), (reg.code || '-05', 'CALAMA'), (reg.code || '-06', 'OLLAGUE'), (reg.code || '-07', 'SAN PEDRO DE ATACAMA'), (reg.code || '-08', 'TOCOPILLA'), (reg.code || '-09', 'MARIA ELENA')
) AS codes(code, name) WHERE reg.code = 'AN';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'COPIAPO'), (reg.code || '-02', 'CALDERA'), (reg.code || '-03', 'TIERRA AMARILLA'), (reg.code || '-04', 'VALLENAR'), (reg.code || '-05', 'FREIRINA'), (reg.code || '-06', 'HUASCO'), (reg.code || '-07', 'ALTO DEL CARMEN'), (reg.code || '-08', 'CHANARAL'), (reg.code || '-09', 'DIEGO DE ALMAGRO')
) AS codes(code, name) WHERE reg.code = 'AT';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'LA SERENA'), (reg.code || '-02', 'COQUIMBO'), (reg.code || '-03', 'ANDACOLLO'), (reg.code || '-04', 'LA HIGUERA'), (reg.code || '-05', 'PAIHUANO'), (reg.code || '-06', 'VICUÑA'), (reg.code || '-07', 'ILLAPEL'), (reg.code || '-08', 'CANELA'), (reg.code || '-09', 'LOS VILOS'), (reg.code || '-10', 'SALAMANCA'), (reg.code || '-11', 'OVALLE'), (reg.code || '-12', 'COMBARBALA'), (reg.code || '-13', 'MONTE PATRIA'), (reg.code || '-14', 'PUNITAQUI'), (reg.code || '-15', 'RIO HURTADO')
) AS codes(code, name) WHERE reg.code = 'CO';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'VALPARAISO'), (reg.code || '-02', 'CASABLANCA'), (reg.code || '-03', 'CONCON'), (reg.code || '-04', 'JUAN FERNANDEZ'), (reg.code || '-05', 'PUCHUNCAVI'), (reg.code || '-06', 'QUILPUE'), (reg.code || '-07', 'QUINTERO'), (reg.code || '-08', 'VIÑA DEL MAR'), (reg.code || '-09', 'ISLA DE PASCUA'), (reg.code || '-10', 'LOS ANDES'), (reg.code || '-11', 'CALLE LARGA'), (reg.code || '-12', 'RINCONADA'), (reg.code || '-13', 'SAN ESTEBAN'), (reg.code || '-14', 'LA LIGUA'), (reg.code || '-15', 'CABILDO'), (reg.code || '-16', 'PAPUDO'), (reg.code || '-17', 'PETORCA'), (reg.code || '-18', 'ZAPALLAR'), (reg.code || '-19', 'QUILLOTA'), (reg.code || '-20', 'CALERA'), (reg.code || '-21', 'HIJUELAS'), (reg.code || '-22', 'LA CRUZ'), (reg.code || '-23', 'NOGALES'), (reg.code || '-24', 'SAN ANTONIO'), (reg.code || '-25', 'ALGARROBO'), (reg.code || '-26', 'CARTAGENA'), (reg.code || '-27', 'EL QUISCO'), (reg.code || '-28', 'EL TABO'), (reg.code || '-29', 'SANTO DOMINGO'), (reg.code || '-30', 'SAN FELIPE'), (reg.code || '-31', 'CATEMU'), (reg.code || '-32', 'LLAY LLAY'), (reg.code || '-33', 'PANQUEHUE'), (reg.code || '-34', 'PUTAENDO'), (reg.code || '-35', 'SANTA MARIA'), (reg.code || '-36', 'VILLA ALEMANA'), (reg.code || '-37', 'LIMACHE'), (reg.code || '-38', 'OLMUE')
) AS codes(code, name) WHERE reg.code = 'VS';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'SANTIAGO'), (reg.code || '-02', 'CERRILLOS'), (reg.code || '-03', 'CERRO NAVIA'), (reg.code || '-04', 'CONCHALI'), (reg.code || '-05', 'EL BOSQUE'), (reg.code || '-06', 'ESTACION CENTRAL'), (reg.code || '-07', 'HUECHURABA'), (reg.code || '-08', 'INDEPENDENCIA'), (reg.code || '-09', 'LA CISTERNA'), (reg.code || '-10', 'LA FLORIDA'), (reg.code || '-11', 'LA GRANJA'), (reg.code || '-12', 'LA PINTANA'), (reg.code || '-13', 'LA REINA'), (reg.code || '-14', 'LAS CONDES'), (reg.code || '-15', 'LO BARNECHEA'), (reg.code || '-16', 'LO ESPEJO'), (reg.code || '-17', 'LO PRADO'), (reg.code || '-18', 'MACUL'), (reg.code || '-19', 'MAIPU'), (reg.code || '-20', 'ÑUÑOA'), (reg.code || '-21', 'PADRE HURTADO'), (reg.code || '-22', 'PEDRO AGUIRRE CERDA'), (reg.code || '-23', 'PEÑALOLEN'), (reg.code || '-24', 'PROVIDENCIA'), (reg.code || '-25', 'PUDAHUEL'), (reg.code || '-26', 'QUILICURA'), (reg.code || '-27', 'QUINTA NORMAL'), (reg.code || '-28', 'RECOLETA'), (reg.code || '-29', 'RENCA'), (reg.code || '-30', 'SAN MIGUEL'), (reg.code || '-31', 'SAN JOAQUIN'), (reg.code || '-32', 'SAN RAMON'), (reg.code || '-33', 'VITACURA'), (reg.code || '-34', 'COLINA'), (reg.code || '-35', 'LAMPA'), (reg.code || '-36', 'TILTIL'), (reg.code || '-37', 'PUENTE ALTO'), (reg.code || '-38', 'SAN JOSE DE MAIPO'), (reg.code || '-39', 'PIRQUE'), (reg.code || '-40', 'SAN BERNARDO'), (reg.code || '-41', 'BUIN'), (reg.code || '-42', 'CALERA DE TANGO'), (reg.code || '-43', 'PAINE'), (reg.code || '-44', 'MELIPILLA'), (reg.code || '-45', 'ALHUE'), (reg.code || '-46', 'CURACAVI'), (reg.code || '-47', 'MARIA PINTO'), (reg.code || '-48', 'SAN PEDRO'), (reg.code || '-49', 'TALAGANTE'), (reg.code || '-50', 'EL MONTE'), (reg.code || '-51', 'ISLA DE MAIPO'), (reg.code || '-52', 'PADRE HURTADO')
) AS codes(code, name) WHERE reg.code = 'RM';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'RANCAGUA'), (reg.code || '-02', 'CODEGUA'), (reg.code || '-03', 'COINCO'), (reg.code || '-04', 'COLTAUCO'), (reg.code || '-05', 'DOÑIHUE'), (reg.code || '-06', 'GRANEROS'), (reg.code || '-07', 'LAS CABRAS'), (reg.code || '-08', 'MACHALI'), (reg.code || '-09', 'MALLOA'), (reg.code || '-10', 'MOSTAZAL'), (reg.code || '-11', 'OLIVAR'), (reg.code || '-12', 'PEUMO'), (reg.code || '-13', 'PICHIDEGUA'), (reg.code || '-14', 'QUINTA DE TILCOCO'), (reg.code || '-15', 'RENGO'), (reg.code || '-16', 'REQUINOA'), (reg.code || '-17', 'SAN VICENTE'), (reg.code || '-18', 'PICHILEMU'), (reg.code || '-19', 'LA ESTRELLA'), (reg.code || '-20', 'LITUECHE'), (reg.code || '-21', 'MARCHIHUE'), (reg.code || '-22', 'NAVIDAD'), (reg.code || '-23', 'PAREDONES'), (reg.code || '-24', 'SAN FERNANDO'), (reg.code || '-25', 'CHIMBARONGO'), (reg.code || '-26', 'LOLOL'), (reg.code || '-27', 'NANCAGUA'), (reg.code || '-28', 'PALMILLA'), (reg.code || '-29', 'PERALILLO'), (reg.code || '-30', 'PLACILLA'), (reg.code || '-31', 'PUMANQUE'), (reg.code || '-32', 'SANTA CRUZ'), (reg.code || '-33', 'CHEPICA')
) AS codes(code, name) WHERE reg.code = 'LI';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'TALCA'), (reg.code || '-02', 'CONSTITUCION'), (reg.code || '-03', 'CUREPTO'), (reg.code || '-04', 'EMPEDRADO'), (reg.code || '-05', 'MAULE'), (reg.code || '-06', 'PELARCO'), (reg.code || '-07', 'PENCAHUE'), (reg.code || '-08', 'RIO CLARO'), (reg.code || '-09', 'SAN CLEMENTE'), (reg.code || '-10', 'SAN RAFAEL'), (reg.code || '-11', 'CAUQUENES'), (reg.code || '-12', 'CHANCO'), (reg.code || '-13', 'PELLUHUE'), (reg.code || '-14', 'CURICO'), (reg.code || '-15', 'HUALAÑE'), (reg.code || '-16', 'LICANTEN'), (reg.code || '-17', 'MOLINA'), (reg.code || '-18', 'RAUCO'), (reg.code || '-19', 'ROMERAL'), (reg.code || '-20', 'SAGRADA FAMILIA'), (reg.code || '-21', 'TENO'), (reg.code || '-22', 'VICHUQUEN'), (reg.code || '-23', 'LINARES'), (reg.code || '-24', 'COLBUN'), (reg.code || '-25', 'LONGAVI'), (reg.code || '-26', 'PARRAL'), (reg.code || '-27', 'RETIRO'), (reg.code || '-28', 'SAN JAVIER'), (reg.code || '-29', 'VILLA ALEGRE'), (reg.code || '-30', 'YERBAS BUENAS')
) AS codes(code, name) WHERE reg.code = 'ML';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'CHILLAN'), (reg.code || '-02', 'BULNES'), (reg.code || '-03', 'COBQUECURA'), (reg.code || '-04', 'COELEMU'), (reg.code || '-05', 'COIHUECO'), (reg.code || '-06', 'CHILLAN VIEJO'), (reg.code || '-07', 'EL CARMEN'), (reg.code || '-08', 'NINHUE'), (reg.code || '-09', 'ÑIQUEN'), (reg.code || '-10', 'PEMUCO'), (reg.code || '-11', 'PINTO'), (reg.code || '-12', 'PORTEZUELO'), (reg.code || '-13', 'QUILLON'), (reg.code || '-14', 'QUIRIHUE'), (reg.code || '-15', 'RANQUIL'), (reg.code || '-16', 'SAN CARLOS'), (reg.code || '-17', 'SAN FABIAN'), (reg.code || '-18', 'SAN IGNACIO'), (reg.code || '-19', 'SAN NICOLAS'), (reg.code || '-20', 'TREGUACO'), (reg.code || '-21', 'YUNGAY')
) AS codes(code, name) WHERE reg.code = 'NB';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'CONCEPCION'), (reg.code || '-02', 'CORONEL'), (reg.code || '-03', 'CHIGUAYANTE'), (reg.code || '-04', 'FLORIDA'), (reg.code || '-05', 'HUALQUI'), (reg.code || '-06', 'LOTA'), (reg.code || '-07', 'PENCO'), (reg.code || '-08', 'SAN PEDRO DE LA PAZ'), (reg.code || '-09', 'SANTA JUANA'), (reg.code || '-10', 'TALCAHUANO'), (reg.code || '-11', 'TOME'), (reg.code || '-12', 'HUALPEN'), (reg.code || '-13', 'LEBU'), (reg.code || '-14', 'ARAUCO'), (reg.code || '-15', 'CAÑETE'), (reg.code || '-16', 'CONTULMO'), (reg.code || '-17', 'CURANILAHUE'), (reg.code || '-18', 'LOS ALAMOS'), (reg.code || '-19', 'TIRUA'), (reg.code || '-20', 'LOS ANGELES'), (reg.code || '-21', 'ANTUCO'), (reg.code || '-22', 'CABRERO'), (reg.code || '-23', 'LAJA'), (reg.code || '-24', 'MULCHEN'), (reg.code || '-25', 'NACIMIENTO'), (reg.code || '-26', 'NEGRETE'), (reg.code || '-27', 'QUILACO'), (reg.code || '-28', 'QUILLECO'), (reg.code || '-29', 'SAN ROSENDO'), (reg.code || '-30', 'SANTA BARBARA'), (reg.code || '-31', 'TUCAPEL'), (reg.code || '-32', 'YUMBEL'), (reg.code || '-33', 'ALTO BIOBIO')
) AS codes(code, name) WHERE reg.code = 'BI';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'TEMUCO'), (reg.code || '-02', 'CARAHUE'), (reg.code || '-03', 'CUNCO'), (reg.code || '-04', 'CURARREHUE'), (reg.code || '-05', 'FREIRE'), (reg.code || '-06', 'GALVARINO'), (reg.code || '-07', 'GORBEA'), (reg.code || '-08', 'LAUTARO'), (reg.code || '-09', 'LONCOCHE'), (reg.code || '-10', 'MELIPEUCO'), (reg.code || '-11', 'NUEVA IMPERIAL'), (reg.code || '-12', 'PADRE LAS CASAS'), (reg.code || '-13', 'PERQUENCO'), (reg.code || '-14', 'PITRUFQUEN'), (reg.code || '-15', 'PUCON'), (reg.code || '-16', 'SAAVEDRA'), (reg.code || '-17', 'TEODORO SCHMIDT'), (reg.code || '-18', 'TOLTEN'), (reg.code || '-19', 'VILCUN'), (reg.code || '-20', 'VILLARRICA'), (reg.code || '-21', 'CHOLCHOL'), (reg.code || '-22', 'ANGOL'), (reg.code || '-23', 'COLLIPULLI'), (reg.code || '-24', 'CURACAUTIN'), (reg.code || '-25', 'ERCILIA'), (reg.code || '-26', 'LONQUIMAY'), (reg.code || '-27', 'LOS SAUCES'), (reg.code || '-28', 'LUMACO'), (reg.code || '-29', 'PUREN'), (reg.code || '-30', 'RENAICO'), (reg.code || '-31', 'TRAIGUEN'), (reg.code || '-32', 'VICTORIA')
) AS codes(code, name) WHERE reg.code = 'AR';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'VALDIVIA'), (reg.code || '-02', 'CORRAL'), (reg.code || '-03', 'FUTRONO'), (reg.code || '-04', 'LA UNION'), (reg.code || '-05', 'LAGO RANCO'), (reg.code || '-06', 'LOS LAGOS'), (reg.code || '-07', 'MAFIL'), (reg.code || '-08', 'MARIQUINA'), (reg.code || '-09', 'PAILLACO'), (reg.code || '-10', 'PANGUIPULLI'), (reg.code || '-11', 'RIO BUENO')
) AS codes(code, name) WHERE reg.code = 'LR';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'PUERTO MONTT'), (reg.code || '-02', 'CALBUCO'), (reg.code || '-03', 'COCHAMO'), (reg.code || '-04', 'FRESIA'), (reg.code || '-05', 'FRUTILLAR'), (reg.code || '-06', 'LLANQUIHUE'), (reg.code || '-07', 'LOS MUERMOS'), (reg.code || '-08', 'MAULLIN'), (reg.code || '-09', 'PUERTO VARAS'), (reg.code || '-10', 'CASTRO'), (reg.code || '-11', 'ANCUD'), (reg.code || '-12', 'CHONCHI'), (reg.code || '-13', 'CURACO DE VELEZ'), (reg.code || '-14', 'DALCAHUE'), (reg.code || '-15', 'PUQUELDON'), (reg.code || '-16', 'QUEILEN'), (reg.code || '-17', 'QUELLON'), (reg.code || '-18', 'QUEMCHI'), (reg.code || '-19', 'QUINCHAO'), (reg.code || '-20', 'OSORNO'), (reg.code || '-21', 'PUERTO OCTAY'), (reg.code || '-22', 'PURRANQUE'), (reg.code || '-23', 'PUYEHUE'), (reg.code || '-24', 'RIO NEGRO'), (reg.code || '-25', 'SAN JUAN DE LA COSTA'), (reg.code || '-26', 'SAN PABLO'), (reg.code || '-27', 'CHAITEN'), (reg.code || '-28', 'FUTALEUFU'), (reg.code || '-29', 'HUALAIHUE'), (reg.code || '-30', 'PALENA')
) AS codes(code, name) WHERE reg.code = 'LL';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'COYHAIQUE'), (reg.code || '-02', 'LAGO VERDE'), (reg.code || '-03', 'AYSEN'), (reg.code || '-04', 'CISNES'), (reg.code || '-05', 'GUAITECAS'), (reg.code || '-06', 'RIO IBAÑEZ'), (reg.code || '-07', 'CHILE CHICO'), (reg.code || '-08', 'TORTEL'), (reg.code || '-09', 'COCHRANE'), (reg.code || '-10', 'O''HIGGINS'), (reg.code || '-11', 'TORTEL')
) AS codes(code, name) WHERE reg.code = 'AI';

WITH reg AS (SELECT id, code FROM portal.regions)
INSERT INTO portal.communes (region_id, code, name, normalized_name) SELECT reg.id, codes.code, codes.name, codes.name FROM reg CROSS JOIN LATERAL (VALUES
    (reg.code || '-01', 'PUNTA ARENAS'), (reg.code || '-02', 'LAGUNA BLANCA'), (reg.code || '-03', 'RIO VERDE'), (reg.code || '-04', 'SAN GREGORIO'), (reg.code || '-05', 'PORVENIR'), (reg.code || '-06', 'PRIMAVERA'), (reg.code || '-07', 'TIMAUKEL'), (reg.code || '-08', 'NATALES'), (reg.code || '-09', 'TORRES DEL PAINE'), (reg.code || '-10', 'CABO DE HORNOS'), (reg.code || '-11', 'ANTARTICA')
) AS codes(code, name) WHERE reg.code = 'MG';
