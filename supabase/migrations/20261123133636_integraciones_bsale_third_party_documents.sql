-- Espejo de documentos tributarios recibidos desde Bsale (third_party_documents), exclusivamente para Caylo.
-- Conserva exactamente los estados originales de Bsale (incluido sii_status NULL), sin interpretar
-- automáticamente un documento como aceptado, pagado o correspondiente a Servicios.

BEGIN;

CREATE SCHEMA IF NOT EXISTS integraciones;

CREATE TABLE IF NOT EXISTS integraciones.bsale_third_party_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    bsale_document_id bigint NOT NULL,
    bsale_href text,
    code_sii text NOT NULL,
    document_number bigint NOT NULL,
    document_folio text NOT NULL,
    client_code text NOT NULL,
    issuer_rut_normalized text NOT NULL,
    client_activity text NOT NULL,
    emission_timestamp bigint NOT NULL,
    emission_date date NOT NULL,
    sii_reception_timestamp bigint,
    sii_reception_date timestamptz,
    book_type text NOT NULL,
    tax_month integer NOT NULL,
    tax_year integer NOT NULL,
    exempt_amount numeric(18,2) NOT NULL DEFAULT 0,
    net_amount numeric(18,2) NOT NULL DEFAULT 0,
    iva_rate numeric(6,2) NOT NULL DEFAULT 0,
    iva_amount numeric(18,2) NOT NULL DEFAULT 0,
    iva_out_of_time_amount numeric(18,2) NOT NULL DEFAULT 0,
    iva_not_recoverable_amount numeric(18,2) NOT NULL DEFAULT 0,
    iva_amount_withheld numeric(18,2) NOT NULL DEFAULT 0,
    fixed_asset_amount numeric(18,2) NOT NULL DEFAULT 0,
    commission_total_net_amount numeric(18,2) NOT NULL DEFAULT 0,
    commission_total_exempt_amount numeric(18,2) NOT NULL DEFAULT 0,
    commission_total_iva_amount numeric(18,2) NOT NULL DEFAULT 0,
    specific_tax_code text,
    specific_tax_rate_raw text,
    specific_tax_rate numeric(10,4),
    specific_tax_amount_raw text,
    specific_tax_amount numeric(18,2),
    additional_tax_amount numeric(18,2),
    total_amount numeric(18,2) NOT NULL DEFAULT 0,
    reported_sii integer NOT NULL DEFAULT 0,
    third_sii integer NOT NULL DEFAULT 0,
    canceled integer NOT NULL DEFAULT 0,
    add_book integer NOT NULL DEFAULT 0,
    docs_count integer NOT NULL DEFAULT 0,
    include_flag integer NOT NULL DEFAULT 0,
    sii_in_progress boolean NOT NULL DEFAULT false,
    sii_status text[],
    liquidation_code text,
    url_pdf text,
    url_xml text,
    raw_json jsonb NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    last_sync_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT bsale_third_party_documents_company_caylo_chk
        CHECK (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid),
    CONSTRAINT bsale_third_party_documents_bsale_id_chk
        CHECK (bsale_document_id > 0),
    CONSTRAINT bsale_third_party_documents_company_bsale_id_key
        UNIQUE (company_id, bsale_document_id),
    CONSTRAINT bsale_third_party_documents_code_sii_chk
        CHECK (code_sii IN ('33', '34', '61', '56')),
    CONSTRAINT bsale_third_party_documents_doc_number_chk
        CHECK (document_number >= 0),
    CONSTRAINT bsale_third_party_documents_doc_folio_chk
        CHECK (document_folio ~ '^(0|[1-9][0-9]*)$'),
    CONSTRAINT bsale_third_party_documents_client_code_chk
        CHECK (btrim(client_code) <> ''),
    CONSTRAINT bsale_third_party_documents_issuer_rut_chk
        CHECK (issuer_rut_normalized ~ '^[0-9]{1,8}[0-9K]$'),
    CONSTRAINT bsale_third_party_documents_client_activity_chk
        CHECK (btrim(client_activity) <> ''),
    CONSTRAINT bsale_third_party_documents_emission_date_chk
        CHECK (emission_date >= DATE '2026-01-01'),
    CONSTRAINT bsale_third_party_documents_book_type_chk
        CHECK (btrim(book_type) <> ''),
    CONSTRAINT bsale_third_party_documents_tax_month_chk
        CHECK (tax_month BETWEEN 1 AND 12),
    CONSTRAINT bsale_third_party_documents_tax_year_chk
        CHECK (tax_year >= 2026),
    CONSTRAINT bsale_third_party_documents_amounts_non_negative_chk
        CHECK (
            exempt_amount >= 0
            AND net_amount >= 0
            AND iva_rate >= 0
            AND iva_amount >= 0
            AND iva_out_of_time_amount >= 0
            AND iva_not_recoverable_amount >= 0
            AND iva_amount_withheld >= 0
            AND fixed_asset_amount >= 0
            AND total_amount >= 0
            AND (specific_tax_amount IS NULL OR specific_tax_amount >= 0)
        ),
    CONSTRAINT bsale_third_party_documents_raw_json_object_chk
        CHECK (jsonb_typeof(raw_json) = 'object')
);

CREATE INDEX IF NOT EXISTS bsale_third_party_docs_reconciliation_idx
    ON integraciones.bsale_third_party_documents (company_id, issuer_rut_normalized, code_sii, document_folio);

CREATE INDEX IF NOT EXISTS bsale_third_party_docs_emission_date_idx
    ON integraciones.bsale_third_party_documents (company_id, emission_date DESC, bsale_document_id DESC);

CREATE INDEX IF NOT EXISTS bsale_third_party_docs_tax_period_idx
    ON integraciones.bsale_third_party_documents (company_id, tax_year DESC, tax_month DESC);

CREATE INDEX IF NOT EXISTS bsale_third_party_docs_last_sync_idx
    ON integraciones.bsale_third_party_documents (company_id, last_sync_at DESC);

-- Protección contra eliminación de documentos espejados.
CREATE OR REPLACE FUNCTION integraciones.prevent_bsale_third_party_document_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    RAISE EXCEPTION 'Los documentos tributarios sincronizados desde Bsale no pueden eliminarse'
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION integraciones.prevent_bsale_third_party_document_delete()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prevent_bsale_third_party_document_delete
    ON integraciones.bsale_third_party_documents;

CREATE TRIGGER prevent_bsale_third_party_document_delete
    BEFORE DELETE ON integraciones.bsale_third_party_documents
    FOR EACH ROW
    EXECUTE FUNCTION integraciones.prevent_bsale_third_party_document_delete();

-- Seguridad y control de acceso:
-- La tabla reside en el esquema integraciones (expuesto en PostgREST), por lo que se revoca
-- el acceso directo a PUBLIC, anon y authenticated para proteger los datos tributarios y
-- los enlaces firmados (url_pdf, url_xml y raw_json).
ALTER TABLE integraciones.bsale_third_party_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_third_party_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bsale_third_party_documents_service_role_all
    ON integraciones.bsale_third_party_documents;

CREATE POLICY bsale_third_party_documents_service_role_all
    ON integraciones.bsale_third_party_documents
    FOR ALL
    TO service_role
    USING (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid)
    WITH CHECK (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid);

DROP POLICY IF EXISTS bsale_third_party_documents_cxp_read
    ON integraciones.bsale_third_party_documents;

CREATE POLICY bsale_third_party_documents_cxp_read
    ON integraciones.bsale_third_party_documents
    FOR SELECT
    TO authenticated
    USING (cuentas_por_pagar.can_access(company_id));

REVOKE ALL ON TABLE integraciones.bsale_third_party_documents
    FROM PUBLIC, anon, authenticated;
REVOKE DELETE ON TABLE integraciones.bsale_third_party_documents
    FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE integraciones.bsale_third_party_documents
    TO service_role;

-- RPC atómica e idempotente (UPSERT) para sincronización manual paginada de documentos tributarios de terceros.
CREATE OR REPLACE FUNCTION integraciones.upsert_bsale_third_party_documents_sync(
    p_company_id uuid,
    p_documents jsonb,
    p_synced_at timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, integraciones, cuentas_por_pagar, public
AS $$
DECLARE
    v_caylo_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_synced_at timestamptz := COALESCE(p_synced_at, clock_timestamp());
    v_invoker_role text := COALESCE(NULLIF(NULLIF(current_setting('role', true), ''), 'none'), session_user);
    v_jwt_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
    v_inserted_count integer := 0;
    v_updated_count integer := 0;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION 'p_company_id es obligatorio' USING ERRCODE = '23502';
    END IF;

    IF p_company_id <> v_caylo_id THEN
        RAISE EXCEPTION 'La sincronización de third_party_documents está habilitada exclusivamente para Caylo'
            USING ERRCODE = '23514';
    END IF;

    IF v_invoker_role NOT IN ('postgres', 'service_role')
       AND NOT (v_invoker_role NOT IN ('anon', 'authenticated') AND v_jwt_role = 'service_role')
    THEN
        RAISE EXCEPTION 'Acceso denegado: la escritura del espejo Bsale está restringida exclusivamente a service_role'
            USING ERRCODE = '42501';
    END IF;

    IF p_documents IS NULL OR jsonb_typeof(p_documents) <> 'array' THEN
        RAISE EXCEPTION 'p_documents debe ser un arreglo JSONB' USING ERRCODE = '22023';
    END IF;

    IF jsonb_array_length(p_documents) = 0 THEN
        RETURN jsonb_build_object(
            'company_id', p_company_id,
            'processed_count', 0,
            'inserted_count', 0,
            'updated_count', 0,
            'synced_at', v_synced_at
        );
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_documents) AS d
        WHERE NULLIF(btrim(d->>'bsale_document_id'), '') IS NULL
    ) THEN
        RAISE EXCEPTION 'Todo documento del lote debe incluir bsale_document_id'
            USING ERRCODE = '23502';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_documents) AS d
        GROUP BY (d->>'bsale_document_id')::bigint
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'El lote contiene bsale_document_id duplicados'
            USING ERRCODE = '23505';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_documents) AS d
        WHERE COALESCE(d->>'code_sii', '') NOT IN ('33', '34', '61', '56')
    ) THEN
        RAISE EXCEPTION 'El lote incluye documentos con code_sii fuera del alcance permitido (33, 34, 61, 56)'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_documents) AS d
        WHERE (d->>'emission_date')::date < DATE '2026-01-01'
    ) THEN
        RAISE EXCEPTION 'El lote incluye documentos emitidos antes del 2026-01-01'
            USING ERRCODE = '23514';
    END IF;

    WITH input_rows AS (
        SELECT
            p_company_id AS company_id,
            (d->>'bsale_document_id')::bigint AS bsale_document_id,
            NULLIF(btrim(d->>'bsale_href'), '') AS bsale_href,
            btrim(d->>'code_sii') AS code_sii,
            (d->>'document_number')::bigint AS document_number,
            regexp_replace(btrim(d->>'document_folio'), '^0+([0-9])', '\1') AS document_folio,
            btrim(d->>'client_code') AS client_code,
            upper(regexp_replace(COALESCE(d->>'issuer_rut_normalized', d->>'client_code', ''), '[.[:space:]-]', '', 'g')) AS issuer_rut_normalized,
            btrim(d->>'client_activity') AS client_activity,
            (d->>'emission_timestamp')::bigint AS emission_timestamp,
            (d->>'emission_date')::date AS emission_date,
            NULLIF(btrim(d->>'sii_reception_timestamp'), '')::bigint AS sii_reception_timestamp,
            NULLIF(btrim(d->>'sii_reception_date'), '')::timestamptz AS sii_reception_date,
            btrim(d->>'book_type') AS book_type,
            (d->>'tax_month')::integer AS tax_month,
            (d->>'tax_year')::integer AS tax_year,
            COALESCE(NULLIF(btrim(d->>'exempt_amount'), '')::numeric(18,2), 0) AS exempt_amount,
            COALESCE(NULLIF(btrim(d->>'net_amount'), '')::numeric(18,2), 0) AS net_amount,
            COALESCE(NULLIF(btrim(d->>'iva_rate'), '')::numeric(6,2), 0) AS iva_rate,
            COALESCE(NULLIF(btrim(d->>'iva_amount'), '')::numeric(18,2), 0) AS iva_amount,
            COALESCE(NULLIF(btrim(d->>'iva_out_of_time_amount'), '')::numeric(18,2), 0) AS iva_out_of_time_amount,
            COALESCE(NULLIF(btrim(d->>'iva_not_recoverable_amount'), '')::numeric(18,2), 0) AS iva_not_recoverable_amount,
            COALESCE(NULLIF(btrim(d->>'iva_amount_withheld'), '')::numeric(18,2), 0) AS iva_amount_withheld,
            COALESCE(NULLIF(btrim(d->>'fixed_asset_amount'), '')::numeric(18,2), 0) AS fixed_asset_amount,
            COALESCE(NULLIF(btrim(d->>'commission_total_net_amount'), '')::numeric(18,2), 0) AS commission_total_net_amount,
            COALESCE(NULLIF(btrim(d->>'commission_total_exempt_amount'), '')::numeric(18,2), 0) AS commission_total_exempt_amount,
            COALESCE(NULLIF(btrim(d->>'commission_total_iva_amount'), '')::numeric(18,2), 0) AS commission_total_iva_amount,
            NULLIF(btrim(d->>'specific_tax_code'), '') AS specific_tax_code,
            NULLIF(btrim(d->>'specific_tax_rate_raw'), '') AS specific_tax_rate_raw,
            NULLIF(btrim(d->>'specific_tax_rate'), '')::numeric(10,4) AS specific_tax_rate,
            NULLIF(btrim(d->>'specific_tax_amount_raw'), '') AS specific_tax_amount_raw,
            NULLIF(btrim(d->>'specific_tax_amount'), '')::numeric(18,2) AS specific_tax_amount,
            NULLIF(btrim(d->>'additional_tax_amount'), '')::numeric(18,2) AS additional_tax_amount,
            COALESCE(NULLIF(btrim(d->>'total_amount'), '')::numeric(18,2), 0) AS total_amount,
            COALESCE(NULLIF(btrim(d->>'reported_sii'), '')::integer, 0) AS reported_sii,
            COALESCE(NULLIF(btrim(d->>'third_sii'), '')::integer, 0) AS third_sii,
            COALESCE(NULLIF(btrim(d->>'canceled'), '')::integer, 0) AS canceled,
            COALESCE(NULLIF(btrim(d->>'add_book'), '')::integer, 0) AS add_book,
            COALESCE(NULLIF(btrim(d->>'docs_count'), '')::integer, 0) AS docs_count,
            COALESCE(NULLIF(btrim(d->>'include_flag'), '')::integer, 0) AS include_flag,
            COALESCE(NULLIF(btrim(d->>'sii_in_progress'), '')::boolean, false) AS sii_in_progress,
            CASE
                WHEN d->'sii_status' IS NULL OR jsonb_typeof(d->'sii_status') = 'null' THEN NULL
                WHEN jsonb_typeof(d->'sii_status') = 'array' THEN ARRAY(
                    SELECT jsonb_array_elements_text(d->'sii_status')
                )
                ELSE NULL
            END AS sii_status,
            NULLIF(btrim(d->>'liquidation_code'), '') AS liquidation_code,
            NULLIF(btrim(d->>'url_pdf'), '') AS url_pdf,
            NULLIF(btrim(d->>'url_xml'), '') AS url_xml,
            (d->'raw_json')::jsonb AS raw_json
        FROM jsonb_array_elements(p_documents) AS d
    ),
    upserted AS (
        INSERT INTO integraciones.bsale_third_party_documents AS target (
            company_id,
            bsale_document_id,
            bsale_href,
            code_sii,
            document_number,
            document_folio,
            client_code,
            issuer_rut_normalized,
            client_activity,
            emission_timestamp,
            emission_date,
            sii_reception_timestamp,
            sii_reception_date,
            book_type,
            tax_month,
            tax_year,
            exempt_amount,
            net_amount,
            iva_rate,
            iva_amount,
            iva_out_of_time_amount,
            iva_not_recoverable_amount,
            iva_amount_withheld,
            fixed_asset_amount,
            commission_total_net_amount,
            commission_total_exempt_amount,
            commission_total_iva_amount,
            specific_tax_code,
            specific_tax_rate_raw,
            specific_tax_rate,
            specific_tax_amount_raw,
            specific_tax_amount,
            additional_tax_amount,
            total_amount,
            reported_sii,
            third_sii,
            canceled,
            add_book,
            docs_count,
            include_flag,
            sii_in_progress,
            sii_status,
            liquidation_code,
            url_pdf,
            url_xml,
            raw_json,
            first_seen_at,
            last_seen_at,
            last_sync_at,
            created_at,
            updated_at
        )
        SELECT
            company_id,
            bsale_document_id,
            bsale_href,
            code_sii,
            document_number,
            document_folio,
            client_code,
            issuer_rut_normalized,
            client_activity,
            emission_timestamp,
            emission_date,
            sii_reception_timestamp,
            sii_reception_date,
            book_type,
            tax_month,
            tax_year,
            exempt_amount,
            net_amount,
            iva_rate,
            iva_amount,
            iva_out_of_time_amount,
            iva_not_recoverable_amount,
            iva_amount_withheld,
            fixed_asset_amount,
            commission_total_net_amount,
            commission_total_exempt_amount,
            commission_total_iva_amount,
            specific_tax_code,
            specific_tax_rate_raw,
            specific_tax_rate,
            specific_tax_amount_raw,
            specific_tax_amount,
            additional_tax_amount,
            total_amount,
            reported_sii,
            third_sii,
            canceled,
            add_book,
            docs_count,
            include_flag,
            sii_in_progress,
            sii_status,
            liquidation_code,
            url_pdf,
            url_xml,
            raw_json,
            v_synced_at,
            v_synced_at,
            v_synced_at,
            clock_timestamp(),
            clock_timestamp()
        FROM input_rows
        ON CONFLICT (company_id, bsale_document_id)
        DO UPDATE SET
            bsale_href = EXCLUDED.bsale_href,
            code_sii = EXCLUDED.code_sii,
            document_number = EXCLUDED.document_number,
            document_folio = EXCLUDED.document_folio,
            client_code = EXCLUDED.client_code,
            issuer_rut_normalized = EXCLUDED.issuer_rut_normalized,
            client_activity = EXCLUDED.client_activity,
            emission_timestamp = EXCLUDED.emission_timestamp,
            emission_date = EXCLUDED.emission_date,
            sii_reception_timestamp = EXCLUDED.sii_reception_timestamp,
            sii_reception_date = EXCLUDED.sii_reception_date,
            book_type = EXCLUDED.book_type,
            tax_month = EXCLUDED.tax_month,
            tax_year = EXCLUDED.tax_year,
            exempt_amount = EXCLUDED.exempt_amount,
            net_amount = EXCLUDED.net_amount,
            iva_rate = EXCLUDED.iva_rate,
            iva_amount = EXCLUDED.iva_amount,
            iva_out_of_time_amount = EXCLUDED.iva_out_of_time_amount,
            iva_not_recoverable_amount = EXCLUDED.iva_not_recoverable_amount,
            iva_amount_withheld = EXCLUDED.iva_amount_withheld,
            fixed_asset_amount = EXCLUDED.fixed_asset_amount,
            commission_total_net_amount = EXCLUDED.commission_total_net_amount,
            commission_total_exempt_amount = EXCLUDED.commission_total_exempt_amount,
            commission_total_iva_amount = EXCLUDED.commission_total_iva_amount,
            specific_tax_code = EXCLUDED.specific_tax_code,
            specific_tax_rate_raw = EXCLUDED.specific_tax_rate_raw,
            specific_tax_rate = EXCLUDED.specific_tax_rate,
            specific_tax_amount_raw = EXCLUDED.specific_tax_amount_raw,
            specific_tax_amount = EXCLUDED.specific_tax_amount,
            additional_tax_amount = EXCLUDED.additional_tax_amount,
            total_amount = EXCLUDED.total_amount,
            reported_sii = EXCLUDED.reported_sii,
            third_sii = EXCLUDED.third_sii,
            canceled = EXCLUDED.canceled,
            add_book = EXCLUDED.add_book,
            docs_count = EXCLUDED.docs_count,
            include_flag = EXCLUDED.include_flag,
            sii_in_progress = EXCLUDED.sii_in_progress,
            sii_status = EXCLUDED.sii_status,
            liquidation_code = EXCLUDED.liquidation_code,
            url_pdf = COALESCE(EXCLUDED.url_pdf, target.url_pdf),
            url_xml = COALESCE(EXCLUDED.url_xml, target.url_xml),
            raw_json = EXCLUDED.raw_json,
            last_seen_at = GREATEST(target.last_seen_at, v_synced_at),
            last_sync_at = GREATEST(target.last_sync_at, v_synced_at),
            updated_at = clock_timestamp()
        RETURNING (xmax = 0) AS is_inserted
    )
    SELECT
        count(*) FILTER (WHERE is_inserted),
        count(*) FILTER (WHERE NOT is_inserted)
    INTO v_inserted_count, v_updated_count
    FROM upserted;

    RETURN jsonb_build_object(
        'company_id', p_company_id,
        'processed_count', v_inserted_count + v_updated_count,
        'inserted_count', v_inserted_count,
        'updated_count', v_updated_count,
        'synced_at', v_synced_at
    );
END;
$$;

REVOKE ALL ON FUNCTION integraciones.upsert_bsale_third_party_documents_sync(uuid, jsonb, timestamptz)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.upsert_bsale_third_party_documents_sync(uuid, jsonb, timestamptz)
    TO service_role;

-- Consulta controlada de enlaces firmados (PDF/XML) de un documento espejado, restringida a Cuentas por Pagar Caylo.
CREATE OR REPLACE FUNCTION integraciones.get_bsale_third_party_document_signed_links(
    p_company_id uuid,
    p_bsale_document_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, integraciones, cuentas_por_pagar, public
AS $$
DECLARE
    v_invoker_role text := COALESCE(NULLIF(NULLIF(current_setting('role', true), ''), 'none'), session_user);
    v_jwt_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
    v_doc record;
BEGIN
    IF p_company_id IS NULL OR p_bsale_document_id IS NULL THEN
        RAISE EXCEPTION 'p_company_id y p_bsale_document_id son obligatorios'
            USING ERRCODE = '23502';
    END IF;

    IF NOT (
        v_invoker_role IN ('postgres', 'service_role')
        OR v_jwt_role = 'service_role'
        OR (v_invoker_role = 'authenticated' AND cuentas_por_pagar.can_access(p_company_id))
    ) THEN
        RAISE EXCEPTION 'Acceso denegado a enlaces firmados de documentos tributarios'
            USING ERRCODE = '42501';
    END IF;

    SELECT
        bsale_document_id,
        code_sii,
        document_folio,
        issuer_rut_normalized,
        url_pdf,
        url_xml
    INTO v_doc
    FROM integraciones.bsale_third_party_documents
    WHERE company_id = p_company_id
      AND bsale_document_id = p_bsale_document_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN jsonb_build_object(
        'bsale_document_id', v_doc.bsale_document_id,
        'code_sii', v_doc.code_sii,
        'document_folio', v_doc.document_folio,
        'issuer_rut_normalized', v_doc.issuer_rut_normalized,
        'url_pdf', v_doc.url_pdf,
        'url_xml', v_doc.url_xml
    );
END;
$$;

REVOKE ALL ON FUNCTION integraciones.get_bsale_third_party_document_signed_links(uuid, bigint)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.get_bsale_third_party_document_signed_links(uuid, bigint)
    TO authenticated, service_role;

COMMIT;
