-- Canonical, flexible and atomic contract for bulk location creation.

CREATE OR REPLACE FUNCTION logistica._bulk_location_code(
    p_template text,
    p_prefix text,
    p_aisle text,
    p_rack text,
    p_level text,
    p_position text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_code text := coalesce(nullif(pg_catalog.btrim(p_template), ''), '{prefix}P{aisle}-R{rack}-N{level}-U{position}');
BEGIN
    v_code := pg_catalog.replace(v_code, '{prefix}', coalesce(p_prefix, ''));
    v_code := pg_catalog.replace(v_code, '{aisle}', coalesce(p_aisle, ''));
    v_code := pg_catalog.replace(v_code, '{rack}', coalesce(p_rack, ''));
    v_code := pg_catalog.replace(v_code, '{level}', coalesce(p_level, ''));
    v_code := pg_catalog.replace(v_code, '{position}', coalesce(p_position, ''));

    IF coalesce(p_aisle, '') = '' THEN
        v_code := pg_catalog.regexp_replace(v_code, '(^|[-_/])P(?=[-_/]|$)', '\1', 'gi');
        v_code := pg_catalog.regexp_replace(v_code, '(^|[-_/])PAS(?=[-_/]|$)', '\1', 'gi');
    END IF;
    IF coalesce(p_rack, '') = '' THEN
        v_code := pg_catalog.regexp_replace(v_code, '(^|[-_/])R(?=[-_/]|$)', '\1', 'gi');
        v_code := pg_catalog.regexp_replace(v_code, '(^|[-_/])RACK(?=[-_/]|$)', '\1', 'gi');
    END IF;
    IF coalesce(p_level, '') = '' THEN
        v_code := pg_catalog.regexp_replace(v_code, '(^|[-_/])N(?=[-_/]|$)', '\1', 'gi');
        v_code := pg_catalog.regexp_replace(v_code, '(^|[-_/])NIV(?=[-_/]|$)', '\1', 'gi');
    END IF;
    IF coalesce(p_position, '') = '' THEN
        v_code := pg_catalog.regexp_replace(v_code, '(^|[-_/])U(?=[-_/]|$)', '\1', 'gi');
        v_code := pg_catalog.regexp_replace(v_code, '(^|[-_/])POS(?=[-_/]|$)', '\1', 'gi');
    END IF;

    v_code := pg_catalog.regexp_replace(v_code, '[-_/]{2,}', '-', 'g');
    RETURN pg_catalog.upper(pg_catalog.regexp_replace(pg_catalog.btrim(v_code), '^[-_/]+|[-_/]+$', '', 'g'));
END;
$$;

CREATE OR REPLACE FUNCTION logistica._generate_location_bulk_rows(p_request jsonb)
RETURNS TABLE (
    code text,
    aisle text,
    rack text,
    level text,
    position_value text,
    error_message text
)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
    SELECT
        c.code,
        nullif(pg_catalog.btrim(a.aisle), ''),
        nullif(pg_catalog.btrim(r.rack), ''),
        nullif(pg_catalog.btrim(l.level), ''),
        nullif(pg_catalog.btrim(p.position), ''),
        CASE
            WHEN c.code = '' THEN 'El código resultante está vacío.'
            WHEN pg_catalog.length(c.code) > 50 THEN 'El código resultante supera 50 caracteres.'
            WHEN c.code ~ '[[:cntrl:]]' THEN 'El código resultante contiene caracteres de control.'
            ELSE NULL
        END
    FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(p_request->'aisles') = 'array' AND jsonb_array_length(p_request->'aisles') > 0
             THEN p_request->'aisles' ELSE '[""]'::jsonb END
    ) a(aisle)
    CROSS JOIN jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(p_request->'racks') = 'array' AND jsonb_array_length(p_request->'racks') > 0
             THEN p_request->'racks' ELSE '[""]'::jsonb END
    ) r(rack)
    CROSS JOIN jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(p_request->'levels') = 'array' AND jsonb_array_length(p_request->'levels') > 0
             THEN p_request->'levels' ELSE '[""]'::jsonb END
    ) l(level)
    CROSS JOIN jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(p_request->'positions') = 'array' AND jsonb_array_length(p_request->'positions') > 0
             THEN p_request->'positions' ELSE '[""]'::jsonb END
    ) p(position)
    CROSS JOIN LATERAL (
        SELECT logistica._bulk_location_code(
            p_request->>'code_format',
            pg_catalog.upper(pg_catalog.btrim(coalesce(p_request->>'prefix', ''))),
            pg_catalog.upper(pg_catalog.btrim(a.aisle)),
            pg_catalog.upper(pg_catalog.btrim(r.rack)),
            pg_catalog.upper(pg_catalog.btrim(l.level)),
            pg_catalog.upper(pg_catalog.btrim(p.position))
        ) AS code
    ) c;
$$;

CREATE OR REPLACE FUNCTION logistica.preview_location_bulk(
    p_company_id uuid,
    p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_warehouse_id uuid := (p_request->>'warehouse_id')::uuid;
    v_limit integer := 2000;
    v_rows jsonb;
    v_requested integer;
    v_valid integer;
    v_existing integer;
    v_duplicate integer;
    v_errors integer;
BEGIN
    IF v_warehouse_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'La bodega es obligatoria.');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM adquisiciones.warehouses w
        WHERE w.id = v_warehouse_id AND w.company_id = p_company_id AND w.is_active
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'La bodega no existe, está inactiva o no pertenece a la empresa activa.');
    END IF;

    WITH generated AS (SELECT * FROM logistica._generate_location_bulk_rows(p_request)),
    classified AS (
        SELECT g.*,
               count(*) OVER (PARTITION BY g.code) > 1 AS is_duplicate,
               EXISTS (SELECT 1 FROM logistica.locations x WHERE x.company_id = p_company_id AND x.warehouse_id = v_warehouse_id AND x.code = g.code) AS is_existing
        FROM generated g
    )
    SELECT
        count(*),
        count(*) FILTER (WHERE error_message IS NULL AND NOT is_duplicate AND NOT is_existing),
        count(*) FILTER (WHERE error_message IS NULL AND is_existing),
        count(*) FILTER (WHERE error_message IS NULL AND is_duplicate),
        count(*) FILTER (WHERE error_message IS NOT NULL),
        coalesce(jsonb_agg(jsonb_build_object(
            'code', code,
            'reason', CASE WHEN error_message IS NOT NULL THEN error_message WHEN is_duplicate THEN 'Código duplicado dentro de la generación.' ELSE 'El código ya existe en la bodega.' END
        ) ORDER BY code) FILTER (WHERE error_message IS NOT NULL OR is_duplicate OR is_existing), '[]'::jsonb)
    INTO v_requested, v_valid, v_existing, v_duplicate, v_errors, v_rows
    FROM classified;

    RETURN jsonb_build_object(
        'success', true,
        'warehouse_id', v_warehouse_id,
        'requested_count', v_requested,
        'valid_count', v_valid,
        'existing_count', v_existing,
        'duplicate_count', v_duplicate,
        'error_count', v_errors,
        'limit', v_limit,
        'limit_exceeded', v_requested > v_limit,
        'codes', coalesce((SELECT jsonb_agg(code ORDER BY code) FROM logistica._generate_location_bulk_rows(p_request)), '[]'::jsonb),
        'conflicts', v_rows
    );
END;
$$;

CREATE OR REPLACE FUNCTION logistica.create_location_bulk(
    p_company_id uuid,
    p_request jsonb,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_preview jsonb;
    v_warehouse_id uuid := (p_request->>'warehouse_id')::uuid;
    v_created integer;
BEGIN
    v_preview := logistica.preview_location_bulk(p_company_id, p_request);
    IF coalesce((v_preview->>'success')::boolean, false) IS NOT TRUE THEN
        RETURN v_preview;
    END IF;
    IF (v_preview->>'limit_exceeded')::boolean OR (v_preview->>'error_count')::integer > 0
       OR (v_preview->>'existing_count')::integer > 0 OR (v_preview->>'duplicate_count')::integer > 0 THEN
        RETURN v_preview || jsonb_build_object('success', false, 'error', 'La generación contiene conflictos y no se creó ninguna ubicación.');
    END IF;

    INSERT INTO logistica.locations (
        company_id, warehouse_id, code, name, aisle, rack, level, position,
        description, is_active, created_by, updated_by
    )
    SELECT p_company_id, v_warehouse_id, g.code,
           coalesce(nullif(pg_catalog.concat_ws(' ',
               CASE WHEN g.aisle IS NOT NULL THEN 'PASIL ' || g.aisle END,
               CASE WHEN g.rack IS NOT NULL THEN 'RACK ' || g.rack END,
               CASE WHEN g.level IS NOT NULL THEN 'NIVEL ' || g.level END,
               CASE WHEN g.position_value IS NOT NULL THEN 'POS ' || g.position_value END
           ), ''), 'UBICACION ' || g.code),
           g.aisle, g.rack, g.level, g.position_value,
           'GENERADA MASIVAMENTE - ' || g.code, true, p_user_id, p_user_id
    FROM logistica._generate_location_bulk_rows(p_request) g;

    GET DIAGNOSTICS v_created = ROW_COUNT;
    RETURN v_preview || jsonb_build_object('success', true, 'created_count', v_created);
EXCEPTION WHEN unique_violation THEN
    RETURN v_preview || jsonb_build_object('success', false, 'created_count', 0, 'error', 'La generación cambió mientras se validaba. No se creó ninguna ubicación.');
END;
$$;

GRANT EXECUTE ON FUNCTION logistica.preview_location_bulk(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.create_location_bulk(uuid, jsonb, uuid) TO authenticated, service_role;
