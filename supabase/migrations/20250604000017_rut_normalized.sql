ALTER TABLE adquisiciones.suppliers
    ADD COLUMN IF NOT EXISTS rut_normalized varchar(20);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_rut_normalized ON adquisiciones.suppliers (rut_normalized) WHERE rut_normalized IS NOT NULL;

UPDATE adquisiciones.suppliers
SET rut_normalized = regexp_replace(regexp_replace(COALESCE(rut, ''), '[.-]', '', 'g'), '\s', '', 'g')
WHERE rut_normalized IS NULL AND rut IS NOT NULL;

CREATE OR REPLACE FUNCTION adquisiciones.normalize_rut(rut_in text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT regexp_replace(regexp_replace(COALESCE(rut_in, ''), '[.-]', '', 'g'), '\s', '', 'g');
$$;
