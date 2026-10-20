-- Auditoría: SUPER_USUARIO puede auditar su propia preparación.
-- La autorización sigue siendo server-side y no modifica el lock ni el cierre.

BEGIN;

-- La prohibición anterior era un CHECK estático; la nueva regla depende del rol
-- canónico y por ello debe vivir en los RPC que asignan y finalizan la auditoría.
ALTER TABLE logistica.sales_order_audits
    DROP CONSTRAINT IF EXISTS sales_order_audits_not_preparer;

DO $migration$
DECLARE
    v_definition text;
    v_original text;
    v_replacement text;
BEGIN
    SELECT pg_get_functiondef(p.oid)
      INTO v_definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'logistica'
       AND p.proname = 'take_sales_order_audit'
       AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_card_id uuid, p_reason text';

    IF v_definition IS NULL THEN
        RAISE EXCEPTION 'No existe logistica.take_sales_order_audit(uuid, uuid, text).';
    END IF;

    v_original := 'IF v_card.assigned_user_id = v_actor THEN';
    v_replacement := 'IF v_card.assigned_user_id = v_actor AND NOT portal.is_super_usuario(v_actor) THEN';

    IF position(v_original IN v_definition) = 0 THEN
        RAISE EXCEPTION 'No se encontró el gate de preparador en take_sales_order_audit.';
    END IF;
    v_definition := replace(v_definition, v_original, v_replacement);

    v_original := 'IF v_audit.prepared_by_user_id_snapshot = v_actor THEN';
    v_replacement := 'IF v_audit.prepared_by_user_id_snapshot = v_actor AND NOT portal.is_super_usuario(v_actor) THEN';

    IF position(v_original IN v_definition) = 0 THEN
        RAISE EXCEPTION 'No se encontró el gate de snapshot en take_sales_order_audit.';
    END IF;
    v_definition := replace(v_definition, v_original, v_replacement);
    EXECUTE v_definition;
END
$migration$;

DO $migration$
DECLARE
    v_definition text;
    v_original text;
    v_replacement text;
BEGIN
    SELECT pg_get_functiondef(p.oid)
      INTO v_definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'logistica'
       AND p.proname = 'finalize_sales_order_audit'
       AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_card_id uuid, p_audit_id uuid';

    IF v_definition IS NULL THEN
        RAISE EXCEPTION 'No existe logistica.finalize_sales_order_audit(uuid, uuid, uuid).';
    END IF;

    v_original := 'IF v_audit.prepared_by_user_id_snapshot = v_actor THEN';
    v_replacement := 'IF v_audit.prepared_by_user_id_snapshot = v_actor AND NOT portal.is_super_usuario(v_actor) THEN';

    IF position(v_original IN v_definition) = 0 THEN
        RAISE EXCEPTION 'No se encontró el gate de preparador en finalize_sales_order_audit.';
    END IF;
    EXECUTE replace(v_definition, v_original, v_replacement);
END
$migration$;

COMMIT;
