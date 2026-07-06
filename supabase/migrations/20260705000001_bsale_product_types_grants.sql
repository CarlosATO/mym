-- ============================================================================
-- Migration: Bsale Product Types Grants
-- ============================================================================

GRANT ALL ON TABLE integraciones.bsale_product_types TO service_role;
GRANT SELECT ON TABLE integraciones.bsale_product_types TO authenticated;
