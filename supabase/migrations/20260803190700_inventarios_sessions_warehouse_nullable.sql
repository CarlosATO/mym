-- Migration: 20260803190700_inventarios_sessions_warehouse_nullable.sql
-- Description: Fase 4I.3B. sessions.warehouse_id pasa a ser opcional para
--              soportar unidades externas (OWN_STORE/EXTERNAL_SITE) que no
--              tienen bodega interna asociada. El warehouse se deriva del
--              sitio interno cuando aplica.
-- Author: Assistant

ALTER TABLE inventarios.sessions
    ALTER COLUMN warehouse_id DROP NOT NULL;
