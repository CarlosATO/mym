ALTER TABLE integraciones.bsale_clients
  ADD COLUMN IF NOT EXISTS sale_condition_id bigint,
  ADD COLUMN IF NOT EXISTS sale_condition_name text,
  ADD COLUMN IF NOT EXISTS has_credit boolean;

UPDATE integraciones.bsale_clients AS c
SET
  has_credit = CASE
    WHEN c.raw_payload ->> 'hasCredit' IN ('1', 'true') THEN true
    WHEN c.raw_payload ? 'hasCredit' THEN false
    ELSE NULL
  END,
  region = NULLIF(c.raw_payload ->> 'region', ''),
  price_list_name = NULLIF(c.raw_payload -> 'price_list' ->> 'name', '');

UPDATE integraciones.bsale_clients AS c
SET
  sale_condition_id = NULLIF(substring(c.raw_payload -> 'sale_condition' ->> 'href' FROM '/sale_conditions/([0-9]+)\.json$'), '')::bigint,
  sale_condition_name = (
    SELECT sc.name
    FROM integraciones.bsale_sale_conditions AS sc
    WHERE sc.company_id = c.company_id
      AND sc.bsale_id = NULLIF(substring(c.raw_payload -> 'sale_condition' ->> 'href' FROM '/sale_conditions/([0-9]+)\.json$'), '')::bigint
  );

UPDATE integraciones.bsale_clients AS c
SET
  payment_type_name = (
    SELECT pt.name
    FROM integraciones.bsale_payment_types AS pt
    WHERE pt.company_id = c.company_id
      AND pt.bsale_id = NULLIF(c.raw_payload -> 'payment_type' ->> 'id', '')::bigint
  );

CREATE INDEX IF NOT EXISTS bsale_clients_sale_condition_idx
  ON integraciones.bsale_clients(company_id, sale_condition_id);
