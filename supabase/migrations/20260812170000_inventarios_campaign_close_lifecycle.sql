-- Cierre Global y Definitivo del Inventario (V1) — Lifecycle de campaign.
--
-- Agrega close_reason a inventory_campaigns para registrar el motivo del cierre
-- administrativo. El estado final reutiliza 'APPROVED' (no se crea estado nuevo).
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

ALTER TABLE inventarios.inventory_campaigns
    ADD COLUMN IF NOT EXISTS close_reason text;

COMMENT ON COLUMN inventarios.inventory_campaigns.close_reason
    IS 'Motivo del cierre administrativo global del Inventario (admin_close_inventory_campaign).';

COMMIT;
