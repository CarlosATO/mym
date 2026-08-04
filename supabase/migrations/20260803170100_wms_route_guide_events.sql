-- Migration: 20260803170100_wms_route_guide_events.sql
-- Description: Fase WMS-RG.1. Control optimista (version_number) y tabla de
--              eventos de edicion (route_guide_events) con idempotencia.
-- Author: Assistant

-- ============================================================
-- 1. CONTROL OPTIMISTA
-- ============================================================
ALTER TABLE logistica.route_guides
    ADD COLUMN version_number integer NOT NULL DEFAULT 1;

-- ============================================================
-- 2. EVENTOS DE EDICION
-- ============================================================
CREATE TABLE IF NOT EXISTS logistica.route_guide_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    route_guide_id uuid NOT NULL REFERENCES logistica.route_guides(id) ON DELETE CASCADE,
    actor_user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    event_type varchar(30) NOT NULL CHECK (event_type IN ('EDITED')),
    reason text NOT NULL,
    version_before integer NOT NULL,
    version_after integer NOT NULL,
    guide_status varchar(30) NOT NULL,
    header_changes jsonb NOT NULL DEFAULT '{}'::jsonb,
    items_added jsonb NOT NULL DEFAULT '[]'::jsonb,
    items_modified jsonb NOT NULL DEFAULT '[]'::jsonb,
    items_deleted jsonb NOT NULL DEFAULT '[]'::jsonb,
    totals_before jsonb NOT NULL DEFAULT '{}'::jsonb,
    totals_after jsonb NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key uuid NOT NULL,
    request_hash char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_route_guide_events_company_key UNIQUE (company_id, idempotency_key),
    CONSTRAINT chk_route_guide_events_reason
        CHECK (pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 5 AND 1000)
);

CREATE INDEX idx_route_guide_events_guide
    ON logistica.route_guide_events (company_id, route_guide_id, created_at DESC);

GRANT SELECT ON TABLE logistica.route_guide_events TO authenticated, service_role;
GRANT INSERT ON TABLE logistica.route_guide_events TO authenticated, service_role;
