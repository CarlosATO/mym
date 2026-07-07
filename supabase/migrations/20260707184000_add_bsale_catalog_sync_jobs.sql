-- supabase/migrations/20260707184000_add_bsale_catalog_sync_jobs.sql
DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
BEGIN
    -- 1. BSALE / product_types
    INSERT INTO integraciones.sync_job_configs (
        company_id, provider, entity, frequency_minutes, is_enabled
    )
    VALUES (
        v_company_id, 'BSALE', 'product_types', 720, true
    )
    ON CONFLICT (company_id, provider, entity) DO UPDATE
    SET frequency_minutes = EXCLUDED.frequency_minutes,
        is_enabled = EXCLUDED.is_enabled;

    -- 2. BSALE / products
    INSERT INTO integraciones.sync_job_configs (
        company_id, provider, entity, frequency_minutes, is_enabled
    )
    VALUES (
        v_company_id, 'BSALE', 'products', 60, true
    )
    ON CONFLICT (company_id, provider, entity) DO UPDATE
    SET frequency_minutes = EXCLUDED.frequency_minutes,
        is_enabled = EXCLUDED.is_enabled;

END $$;
