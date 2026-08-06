-- Migration: 20260806092000_inventarios_campaign_snapshot_product_fields.sql
-- Description: Fase 4I.3C.7B.1. Completa el modelo fisico de
--              inventarios.inventory_campaign_snapshot_products para congelar
--              el catalogo de la campana: descripcion escrita en el Excel,
--              marca, presentacion y estado activo. Solo modelo fisico; la
--              poblacion llega en 4I.3C.7C via RPC.
-- Author: Assistant

-- ============================================================
-- CAMPOS AGREGADOS
-- - entered_description: descripcion humana escrita en el Excel (referencia
--   secundaria; la identidad sigue siendo product_id).
-- - brand: marca congelada de adquisiciones.products.brand al capturar.
-- - presentation: presentacion congelada de adquisiciones.products.presentation.
-- - is_active: estado activo congelado de adquisiciones.products.is_active.
--   Sin DEFAULT: una poblacion incompleta no puede ocultarse.
-- ============================================================
ALTER TABLE inventarios.inventory_campaign_snapshot_products
    ADD COLUMN IF NOT EXISTS entered_description text,
    ADD COLUMN IF NOT EXISTS brand text,
    ADD COLUMN IF NOT EXISTS presentation text,
    ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL;
