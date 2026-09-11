-- Migration: 20260908203522_inventarios_supplemental_web_record_post_record_guard_fix.sql
-- Description: Hotfix al RPC de registro WEB de hallazgos SUPPLEMENTAL_FINDINGS.
--              El comportamiento ya aplicado en producción exige que las guardas
--              de "lote ya registrado" se evalúen ANTES de exigir session.status =
--              PREPARED. Así, cuando la sesión ya está COUNTING (porque el lote ya
--              fue registrado) el RPC devuelve INV_SUPPLEMENTAL_COUNTS_ALREADY_RECORDED
--              (no INV_SESSION_INVALID_STATE), y cuando existe mezcla registrados/no
--              registrados devuelve INV_SUPPLEMENTAL_COUNTS_INCONSISTENT.
--
-- No se introducen mejoras nuevas: únicamente se desplaza la evaluación de las
-- guardas de conteo antes del chequeo PREPARED. El replay con la misma clave de
-- idempotencia sigue funcionando normalmente (retorna antes de estas guardas).
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- Author: Assistant

DO $migration$
DECLARE
    v_definition text;
    v_guard_block text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.record_inventory_campaign_supplemental_findings_counts(uuid,uuid,uuid)'::regprocedure
    ) INTO v_definition;

    IF pg_catalog.strpos(v_definition, 'INV_SUPPLEMENTAL_NO_FINDINGS') = 0 THEN
        RAISE EXCEPTION 'record_inventory_campaign_supplemental_findings_counts: guardas de conteo no encontradas';
    END IF;
    IF pg_catalog.strpos(v_definition, 'IF v_session_status <> ''PREPARED'' THEN') = 0 THEN
        RAISE EXCEPTION 'record_inventory_campaign_supplemental_findings_counts: guarda PREPARED no encontrada';
    END IF;

    v_guard_block := $guard$
    -- ---------- Guarda previa: el lote debe estar sin registrar o consistentemente pendiente ----------
    SELECT pg_catalog.count(*) INTO v_total_consolidated
    FROM inventarios.inventory_campaign_supplemental_findings f
    WHERE f.company_id = p_company_id
      AND f.supplemental_session_id = p_supplemental_session_id
      AND f.status = 'CONSOLIDATED';

    SELECT pg_catalog.count(*) INTO v_pending_count
    FROM inventarios.inventory_campaign_supplemental_findings f
    WHERE f.company_id = p_company_id
      AND f.supplemental_session_id = p_supplemental_session_id
      AND f.status = 'CONSOLIDATED'
      AND f.count_entry_id IS NULL;

    IF v_total_consolidated = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_NO_FINDINGS',
            DETAIL=pg_catalog.jsonb_build_object('message','El lote no tiene hallazgos CONSOLIDATED para registrar.','retryable',false)::text;
    END IF;
    IF v_pending_count = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_ALREADY_RECORDED',
            DETAIL=pg_catalog.jsonb_build_object('message','El lote ya fue registrado; no se debe volver a registrar con una nueva clave.','retryable',false)::text;
    END IF;
    IF v_pending_count <> v_total_consolidated THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_INCONSISTENT',
            DETAIL=pg_catalog.jsonb_build_object('message','El lote tiene una mezcla de hallazgos registrados y no registrados; no se repara automáticamente.','retryable',false,
                'consolidated_count',v_total_consolidated,'pending_count',v_pending_count)::text;
    END IF;

$guard$;

    v_definition := pg_catalog.replace(
        v_definition,
        'IF v_session_status <> ''PREPARED'' THEN',
        v_guard_block || '    IF v_session_status <> ''PREPARED'' THEN'
    );

    EXECUTE v_definition;
END;
$migration$;
