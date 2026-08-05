-- Migration: 20260805152000_inventarios_campaign_import_validation_fix_2.sql
-- Description: Fix de los accesos a campos en los bucles de cobertura de validate_campaign_stock_import.
--              La migracion previa ya cambio el target a record; esta corrige los accesos a v_issue.*
-- Author: Assistant

DO $$
DECLARE
    v_def text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef('inventarios.validate_campaign_stock_import(uuid, uuid, jsonb, jsonb, uuid)'::pg_catalog.regprocedure)
    INTO v_def;

    v_def := pg_catalog.regexp_replace(v_def, 'v_issue\.product_id', 'v_coverage.product_id', 'g');
    v_def := pg_catalog.regexp_replace(v_def, 'v_issue\.sku', 'v_coverage.sku', 'g');
    v_def := pg_catalog.regexp_replace(v_def, 'v_issue\.inventory_site_id', 'v_coverage.inventory_site_id', 'g');
    v_def := pg_catalog.regexp_replace(v_def, 'v_issue\.site_code', 'v_coverage.site_code', 'g');
    v_def := pg_catalog.regexp_replace(v_def, 'v_issue\.inventory_site_location_id', 'v_coverage.inventory_site_location_id', 'g');
    v_def := pg_catalog.regexp_replace(v_def, 'v_issue\.location_code', 'v_coverage.location_code', 'g');

    EXECUTE v_def;
END $$;
