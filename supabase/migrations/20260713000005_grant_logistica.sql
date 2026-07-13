-- ============================================================================
-- Migración: Permisos para el esquema Logística
-- Fecha: 2026-07-13
-- ============================================================================

GRANT USAGE ON SCHEMA logistica TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA logistica TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA logistica TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA logistica TO service_role;

GRANT SELECT ON ALL TABLES IN SCHEMA logistica TO authenticated;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA logistica TO authenticated;
