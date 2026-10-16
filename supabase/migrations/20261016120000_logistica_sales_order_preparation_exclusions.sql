-- Logistica: exclusiones manuales y reversibles de Notas de Venta en Preparacion/Bodega.
--
-- Esta tabla es la fuente de verdad de EXCLUSIONES ADMINISTRATIVAS REVERSIBLES.
-- NO representa ni implica:
--   * anulacion de la NV en Bsale;
--   * facturacion / boleta / guia;
--   * cierre de la tarjeta (logistica.sales_order_preparation_cards);
--   * cambio de status ni de closure_reason del lifecycle actual.
--
-- En bloques posteriores, el board ocultara las NV con exclusion activa y
-- reconcile_bodega_preparation_cards omitira crearlas. La revocacion es logica
-- (active=false + revoked_*), sin borrado fisico, conservando historial.

CREATE TABLE IF NOT EXISTS logistica.sales_order_preparation_exclusions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id),
    bsale_nv_id bigint NOT NULL,
    nv_folio text NOT NULL,
    reason text NOT NULL,
    observation text,
    excluded_by uuid NOT NULL,
    excluded_by_name text,
    excluded_at timestamptz NOT NULL DEFAULT now(),
    active boolean NOT NULL DEFAULT true,
    revoked_by uuid,
    revoked_by_name text,
    revoked_at timestamptz,
    revoked_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sales_order_preparation_exclusions_reason_check
        CHECK (btrim(reason) <> ''),
    CONSTRAINT sales_order_preparation_exclusions_revocation_check
        CHECK (
            (
                active = true
                AND revoked_at IS NULL
                AND revoked_by IS NULL
                AND revoked_reason IS NULL
            )
            OR
            (
                active = false
                AND revoked_at IS NOT NULL
                AND revoked_by IS NOT NULL
                AND revoked_reason IS NOT NULL
                AND btrim(revoked_reason) <> ''
            )
        )
);

-- Una sola exclusion ACTIVA por empresa + NV. Las filas revocadas no colisionan.
CREATE UNIQUE INDEX IF NOT EXISTS sales_order_preparation_exclusions_active_key
    ON logistica.sales_order_preparation_exclusions (company_id, bsale_nv_id)
    WHERE active = true;

-- Consulta/listado por empresa filtrando por estado de la exclusion.
CREATE INDEX IF NOT EXISTS idx_sales_order_preparation_exclusions_company_active
    ON logistica.sales_order_preparation_exclusions (company_id, active);

CREATE TRIGGER trg_sales_order_preparation_exclusions_set_updated_at
    BEFORE UPDATE ON logistica.sales_order_preparation_exclusions
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

ALTER TABLE logistica.sales_order_preparation_exclusions ENABLE ROW LEVEL SECURITY;

-- Lectura segura por empresa.
DROP POLICY IF EXISTS sales_order_preparation_exclusions_select
    ON logistica.sales_order_preparation_exclusions;
CREATE POLICY sales_order_preparation_exclusions_select
    ON logistica.sales_order_preparation_exclusions
    FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));

-- Escritura administrativa reservada a service_role / RPCs de un bloque posterior.
DROP POLICY IF EXISTS sales_order_preparation_exclusions_service
    ON logistica.sales_order_preparation_exclusions;
CREATE POLICY sales_order_preparation_exclusions_service
    ON logistica.sales_order_preparation_exclusions
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE logistica.sales_order_preparation_exclusions FROM anon;
GRANT SELECT ON TABLE logistica.sales_order_preparation_exclusions TO authenticated;
GRANT ALL ON TABLE logistica.sales_order_preparation_exclusions TO service_role;

COMMENT ON TABLE logistica.sales_order_preparation_exclusions IS
    'Exclusion administrativa REVERSIBLE de Notas de Venta del flujo de Preparacion/Bodega. NO cancela la NV, NO factura, NO cierra la tarjeta y NO modifica el lifecycle de logistica.sales_order_preparation_cards. Fuente de verdad para que el board oculte NV excluidas y reconcile omita crearlas. Revocacion logica (active=false + revoked_*), sin borrado fisico; una sola exclusion activa por (company_id, bsale_nv_id).';

COMMENT ON COLUMN logistica.sales_order_preparation_exclusions.bsale_nv_id IS
    'Bsale document id de la Nota de Venta (document_type_id=23) excluida.';
COMMENT ON COLUMN logistica.sales_order_preparation_exclusions.reason IS
    'Motivo obligatorio y no vacio de la exclusion manual.';
COMMENT ON COLUMN logistica.sales_order_preparation_exclusions.active IS
    'true = exclusion vigente (oculta la NV). false = revocada (reversible), con revoked_* completo.';
COMMENT ON COLUMN logistica.sales_order_preparation_exclusions.excluded_by IS
    'Usuario administrativo que creo la exclusion.';
COMMENT ON COLUMN logistica.sales_order_preparation_exclusions.revoked_by IS
    'Usuario que revoco la exclusion. Obligatorio cuando active=false.';
COMMENT ON COLUMN logistica.sales_order_preparation_exclusions.revoked_reason IS
    'Motivo obligatorio y no vacio de la revocacion. Obligatorio cuando active=false.';
