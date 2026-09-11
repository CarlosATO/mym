-- Existing NORMAL snapshot products remain informationally classified as
-- BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT, but are operationally eligible for a
-- supplemental contribution at a different location.
-- This migration changes only the already-deployed function contracts.

DO $migration$
DECLARE
    v_definition text;
    v_updated text;
BEGIN
    -- Keep the physical classification while separating it from operational
    -- eligibility. Missing Bsale variants remain blocked.
    v_definition := pg_catalog.pg_get_functiondef(
        'inventarios.classify_supplemental_finding(uuid,uuid,uuid,integer)'::pg_catalog.regprocedure);
    v_updated := pg_catalog.replace(
        v_definition,
        '(v_classification IN (''ELIGIBLE_CANONICAL'',''ELIGIBLE_OUT_OF_THEORETICAL''));',
        '(v_classification IN (''ELIGIBLE_CANONICAL'',''ELIGIBLE_OUT_OF_THEORETICAL'',''BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT''));');
    IF v_updated = v_definition THEN
        RAISE EXCEPTION 'Could not update supplemental classification eligibility';
    END IF;
    EXECUTE v_updated;

    -- Consolidation explicitly admits the approved existing-normal code, not
    -- every BLOCKED_* classification.
    v_definition := pg_catalog.pg_get_functiondef(
        'inventarios.consolidate_inventory_campaign_supplemental_findings(uuid,uuid,uuid,uuid)'::pg_catalog.regprocedure);
    v_updated := pg_catalog.replace(
        v_definition,
        'IN (''ELIGIBLE_CANONICAL'',''ELIGIBLE_OUT_OF_THEORETICAL'')',
        'IN (''ELIGIBLE_CANONICAL'',''ELIGIBLE_OUT_OF_THEORETICAL'',''BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT'')');
    IF v_updated = v_definition THEN
        RAISE EXCEPTION 'Could not update supplemental consolidation eligibility';
    END IF;

    -- A supplemental finding is additive only when it contributes at a new
    -- location. The same product at the same NORMAL location keeps the
    -- historical anti-duplication guard.
    v_updated := pg_catalog.replace(
        v_updated,
        'AND sp.bsale_variant_id = v_finding.bsale_variant_id',
        'AND sp.bsale_variant_id = v_finding.bsale_variant_id
               AND EXISTS (
                   SELECT 1
                   FROM inventarios.snapshot_locations sl
                   WHERE sl.company_id = os.company_id
                     AND sl.snapshot_id = os.id
                     AND sl.inventory_site_location_id = v_finding.inventory_site_location_id
               )');
    v_updated := pg_catalog.replace(
        v_updated,
        'AND (sp.product_id = v_finding.product_id OR sp.bsale_variant_id = v_finding.bsale_variant_id)',
        'AND (sp.product_id = v_finding.product_id OR sp.bsale_variant_id = v_finding.bsale_variant_id)
               AND EXISTS (
                   SELECT 1
                   FROM inventarios.snapshot_locations sl
                   WHERE sl.company_id = os.company_id
                     AND sl.snapshot_id = os.id
                     AND sl.inventory_site_location_id = v_finding.inventory_site_location_id
               )');
    EXECUTE v_updated;

    -- The campaign orchestrator has its own explicit filter in addition to
    -- the classifier and consolidation guards.
    v_definition := pg_catalog.pg_get_functiondef(
        'inventarios.sync_inventory_campaign_supplemental_findings(uuid,uuid,uuid)'::pg_catalog.regprocedure);
    v_updated := pg_catalog.replace(
        v_definition,
        'IN (''ELIGIBLE_CANONICAL'',''ELIGIBLE_OUT_OF_THEORETICAL'')',
        'IN (''ELIGIBLE_CANONICAL'',''ELIGIBLE_OUT_OF_THEORETICAL'',''BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT'')');
    IF v_updated = v_definition THEN
        RAISE EXCEPTION 'Could not update supplemental sync eligibility';
    END IF;
    EXECUTE v_updated;

    -- The prepare contract has the same location guard. It must not reject a
    -- product merely because another NORMAL location already contains it.
    v_definition := pg_catalog.pg_get_functiondef(
        'inventarios.prepare_supplemental_findings_session(uuid,uuid,jsonb,uuid)'::pg_catalog.regprocedure);
    v_updated := pg_catalog.replace(
        v_definition,
        'AND sp.bsale_variant_id = v_finding.bsale_variant_id',
        'AND sp.bsale_variant_id = v_finding.bsale_variant_id
               AND EXISTS (
                   SELECT 1
                   FROM inventarios.snapshot_locations sl
                   WHERE sl.company_id = os.company_id
                     AND sl.snapshot_id = os.id
                     AND sl.inventory_site_location_id = v_finding.inventory_site_location_id
               )');
    v_updated := pg_catalog.replace(
        v_updated,
        'AND (sp.product_id = v_finding.product_id OR sp.bsale_variant_id = v_finding.bsale_variant_id)',
        'AND (sp.product_id = v_finding.product_id OR sp.bsale_variant_id = v_finding.bsale_variant_id)
               AND EXISTS (
                   SELECT 1
                   FROM inventarios.snapshot_locations sl
                   WHERE sl.company_id = os.company_id
                     AND sl.snapshot_id = os.id
                     AND sl.inventory_site_location_id = v_finding.inventory_site_location_id
               )');
    IF v_updated = v_definition THEN
        RAISE EXCEPTION 'Could not update supplemental prepare location eligibility';
    END IF;
    EXECUTE v_updated;

    -- The orchestrator already derives blocked_draft_remaining from
    -- classify_supplemental_finding.can_consolidate and derives
    -- draft_eligible_processed from consolidation's consolidated_count. No
    -- separate metric rewrite is needed after the canonical eligibility fix.
END;
$migration$;
