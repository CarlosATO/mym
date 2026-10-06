-- Enable immediate BSale synchronization only for the validated CAYLO configuration.
UPDATE integraciones.bsale_purchase_receipt_settings
SET auto_sync_enabled = true,
    enabled = true,
    office_id = 1,
    service_variant_id = 4554,
    updated_at = now()
WHERE company_id = 'd1000000-0000-0000-0000-000000000001'::uuid;
