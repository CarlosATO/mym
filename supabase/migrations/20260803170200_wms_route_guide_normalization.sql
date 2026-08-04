-- Migration: 20260803170200_wms_route_guide_normalization.sql
-- Description: Fase WMS-RG.1. Normalizacion de metodo de pago y montos en
--              backend para no confiar en valores del cliente. Replica las
--              reglas principales de route-guide-validation (frontend).
-- Author: Assistant

-- ============================================================
-- 1. NORMALIZAR TEXTO (minusculas, sin acentos, sin puntuacion)
-- ============================================================
CREATE OR REPLACE FUNCTION logistica.normalize_payment_text(p_input text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_s text;
BEGIN
    IF p_input IS NULL THEN RETURN ''; END IF;
    v_s := pg_catalog.lower(pg_catalog.btrim(p_input));
    v_s := pg_catalog.translate(v_s,
        'áéíóúàèìòùäëïöüñ', 'aeiouaeiouaeioun');
    v_s := pg_catalog.translate(v_s, '.,;:', '    ');
    v_s := pg_catalog.regexp_replace(v_s, '\s+', ' ', 'g');
    RETURN pg_catalog.btrim(v_s);
END;
$$;

-- ============================================================
-- 2. NORMALIZAR METODO DE PAGO
--    Devuelve CASH/CHECK/TRANSFER/CREDIT/UNKNOWN
-- ============================================================
CREATE OR REPLACE FUNCTION logistica.normalize_payment_method(p_original text)
RETURNS varchar(30) LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_s text;
BEGIN
    v_s := logistica.normalize_payment_text(p_original);
    IF v_s = '' THEN RETURN 'UNKNOWN'; END IF;

    IF v_s IN ('al dia','aldia','efectivo','contado','cash','pago contra entrega','prepago','48 horas')
       OR v_s LIKE '%efectivo%' THEN
        RETURN 'CASH';
    END IF;

    IF v_s IN ('cheque','chq','cheq','documento cheque')
       OR v_s LIKE '%cheque%' OR v_s LIKE '%cheq%' OR v_s LIKE '%chq%' THEN
        RETURN 'CHECK';
    END IF;

    IF v_s LIKE '%transferencia%' OR v_s LIKE '%tranferencia%'
       OR v_s LIKE '%transf%' OR v_s LIKE '%deposito%' THEN
        RETURN 'TRANSFER';
    END IF;

    IF v_s LIKE '%credito%' OR v_s LIKE '%cuenta corriente%'
       OR v_s LIKE '%cta cte%' OR v_s LIKE '%fiado%' THEN
        RETURN 'CREDIT';
    END IF;

    RETURN 'UNKNOWN';
END;
$$;

-- ============================================================
-- 3. REQUIERE RENDICION
-- ============================================================
CREATE OR REPLACE FUNCTION logistica.payment_requires_settlement(p_normalized text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    RETURN p_normalized IN ('CASH', 'CHECK', 'TRANSFER');
END;
$$;

-- ============================================================
-- 4. PARSEAR MONTO CHILENO (12500, 12.500, $12.500, 12,500)
-- ============================================================
CREATE OR REPLACE FUNCTION logistica.parse_chilean_amount(p_raw text)
RETURNS numeric(14,2) LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_clean text;
    v_n numeric;
BEGIN
    IF p_raw IS NULL THEN RETURN 0; END IF;
    v_clean := pg_catalog.regexp_replace(p_raw::text, '[^\d]', '', 'g');
    IF v_clean = '' THEN RETURN 0; END IF;
    BEGIN
        v_n := v_clean::numeric;
        RETURN v_n;
    EXCEPTION WHEN OTHERS THEN
        RETURN 0;
    END;
END;
$$;

-- ============================================================
-- 5. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION logistica.normalize_payment_text(text) OWNER TO postgres;
ALTER FUNCTION logistica.normalize_payment_method(text) OWNER TO postgres;
ALTER FUNCTION logistica.payment_requires_settlement(text) OWNER TO postgres;
ALTER FUNCTION logistica.parse_chilean_amount(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION logistica.normalize_payment_text(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.normalize_payment_method(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.payment_requires_settlement(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.parse_chilean_amount(text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION logistica.normalize_payment_text(text) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.normalize_payment_method(text) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.payment_requires_settlement(text) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.parse_chilean_amount(text) TO authenticated;
