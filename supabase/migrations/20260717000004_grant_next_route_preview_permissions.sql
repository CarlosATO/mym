-- ============================================================================
-- Migración: Permisos de lectura para UI de Preparación de Pedidos
-- Fecha: 2026-07-17
-- ============================================================================

GRANT USAGE ON SCHEMA logistica TO authenticated, service_role;

GRANT SELECT ON logistica.sales_order_route_exceptions TO authenticated, service_role;
GRANT SELECT ON logistica.sales_order_preparation_route_events TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION logistica.get_next_dispatch_route_context(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.preview_next_route_candidates(uuid, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.sync_next_route_preparation_cards(uuid, uuid, boolean, text) TO authenticated, service_role;
