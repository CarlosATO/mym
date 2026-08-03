-- Migration: 20260803150100_inventarios_product_scopes_no_bsale.sql
-- Description: Fase 4I.2H. Desacopla session_product_scopes de Bsale:
--              product_id pasa a ser identidad canonica y bsale_variant_id
--              opcional. Backfill por empresa/SKU inequivoco.
-- Author: Assistant

-- ============================================================
-- 1. BSALE_VARIANT_ID OPCIONAL
-- ============================================================
ALTER TABLE inventarios.session_product_scopes
    ALTER COLUMN bsale_variant_id DROP NOT NULL;

-- ============================================================
-- 2. UNIQUE POR SESSION + PRODUCT_ID
--    (si hay filas con product_id nulo, primero el backfill; se agrega
--     solo si no existen duplicados ambiguos)
-- ============================================================

-- ============================================================
-- 3. BACKFILL: resolver product_id desde bsale_variant_id cuando falta
--    Detener con error si existe ambiguedad o falta la variante.
-- ============================================================
DO $$
DECLARE
    v_ambiguous bigint;
    v_unmatched bigint;
BEGIN
    -- Ambiguedad: filas sin product_id cuya variante Bsale no resuelve a un solo producto
    SELECT pg_catalog.count(*) INTO v_ambiguous
    FROM (
        SELECT sps.id
        FROM inventarios.session_product_scopes sps
        JOIN integraciones.bsale_variants bv
          ON bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id
        LEFT JOIN adquisiciones.products p
          ON p.company_id = sps.company_id AND p.sku = bv.code
        WHERE sps.product_id IS NULL
        GROUP BY sps.id
        HAVING pg_catalog.count(p.id) <> 1
    ) x;

    IF v_ambiguous > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',
            MESSAGE='INV_BACKFILL_AMBIGUOUS',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','Existen productos sin product_id que no resuelven de forma inequivoca.',
                'ambiguous_rows', v_ambiguous, 'retryable', false)::text;
    END IF;

    -- Backfill inequivoco
    UPDATE inventarios.session_product_scopes sps
    SET product_id = p.id
    FROM integraciones.bsale_variants bv
    JOIN adquisiciones.products p
      ON p.company_id = bv.company_id AND p.sku = bv.code
    WHERE sps.product_id IS NULL
      AND bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id;

    -- Detectar filas que quedaron sin product_id (variante sin producto interno)
    SELECT pg_catalog.count(*) INTO v_unmatched
    FROM inventarios.session_product_scopes sps
    WHERE sps.product_id IS NULL;

    IF v_unmatched > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',
            MESSAGE='INV_BACKFILL_AMBIGUOUS',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','Existen productos seleccionados sin producto interno correspondiente.',
                'unmatched_rows', v_unmatched, 'retryable', false)::text;
    END IF;
END;
$$;

-- ============================================================
-- 4. UNIQUE POR SESSION + PRODUCT_ID
-- ============================================================
CREATE UNIQUE INDEX uq_inventarios_product_scopes_session_product
    ON inventarios.session_product_scopes (company_id, session_id, product_id)
    WHERE product_id IS NOT NULL;
