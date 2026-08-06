-- 4I.3C.7C.3C.1: equipo global de participantes de una campana.
-- Esta tabla representa el equipo de la campana: no implica participacion
-- automatica en todas las jornadas. session_participants seguira representando
-- el subconjunto autorizado por jornada. Un mismo usuario puede tener varios
-- roles activos simultaneamente (por ejemplo ADMINISTRATOR y COUNTER).

CREATE TABLE inventarios.inventory_campaign_participants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    user_id uuid NOT NULL,
    participant_role text NOT NULL,
    active_from timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    revocation_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_campaign_participants_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_campaign_participants_company_access
        FOREIGN KEY (user_id, company_id)
        REFERENCES core.user_company_access(user_id, company_id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_inventarios_campaign_participants_role
        CHECK (participant_role IN ('COUNTER', 'SUPERVISOR', 'ADMINISTRATOR', 'MANAGER')),
    CONSTRAINT chk_inventarios_campaign_participants_revocation
        CHECK (
            (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
            OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL)
        ),
    CONSTRAINT chk_inventarios_campaign_participants_reason
        CHECK (
            revocation_reason IS NULL
            OR pg_catalog.char_length(pg_catalog.btrim(revocation_reason)) >= 5
        )
);

COMMENT ON TABLE inventarios.inventory_campaign_participants IS
    'Equipo global de participantes de una campana. No implica participacion automatica en todas las jornadas.';
COMMENT ON COLUMN inventarios.inventory_campaign_participants.participant_role IS
    'Rol en la campana; session_participants representara el subconjunto autorizado por jornada. Los roles pueden coexistir para un mismo usuario.';

-- Unicidad de rol activo: permite roles multiples simultaneos, sin duplicar el mismo rol.
CREATE UNIQUE INDEX uq_inventarios_campaign_participants_active_role
    ON inventarios.inventory_campaign_participants (company_id, campaign_id, user_id, participant_role)
    WHERE revoked_at IS NULL;

-- Busqueda por campana (incluye historial revocado).
CREATE INDEX idx_inventarios_campaign_participants_campaign
    ON inventarios.inventory_campaign_participants (company_id, campaign_id);

-- Busqueda de campanas activas de un usuario.
CREATE INDEX idx_inventarios_campaign_participants_user
    ON inventarios.inventory_campaign_participants (company_id, user_id)
    WHERE revoked_at IS NULL;

-- RLS sin policies: acceso exclusivo mediante RPC SECURITY DEFINER.
ALTER TABLE inventarios.inventory_campaign_participants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE inventarios.inventory_campaign_participants FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE inventarios.inventory_campaign_participants TO service_role;
