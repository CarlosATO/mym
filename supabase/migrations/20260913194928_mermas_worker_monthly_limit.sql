-- MERMAS: límite mensual administrativo para futuras ventas a trabajadores.

ALTER TABLE mermas.internal_sale_settings
  ADD COLUMN worker_monthly_limit_amount numeric(14,0),
  ADD CONSTRAINT internal_sale_settings_monthly_limit_check
    CHECK (worker_monthly_limit_amount IS NULL OR worker_monthly_limit_amount > 0);

DROP FUNCTION IF EXISTS mermas.save_internal_sale_settings(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION mermas.save_internal_sale_settings(
  p_company_id uuid,
  p_user_id uuid,
  p_worker_markup_percent numeric,
  p_worker_monthly_limit_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, mermas
AS $$
DECLARE
  v_role_name text;
  v_existing mermas.internal_sale_settings%ROWTYPE;
  v_setting mermas.internal_sale_settings%ROWTYPE;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id) THEN
    RAISE EXCEPTION 'No autorizado para configurar el precio de Mermas';
  END IF;

  SELECT r.name INTO v_role_name
  FROM portal.users u
  JOIN portal.roles r ON r.id = u.role_id
  WHERE u.id = p_user_id
    AND u.is_active
    AND u.deleted_at IS NULL
    AND r.is_active;

  IF v_role_name IS DISTINCT FROM 'SUPER_USUARIO' THEN
    RAISE EXCEPTION 'Solo SUPER_USUARIO puede modificar esta configuración';
  END IF;
  IF p_worker_markup_percent IS NOT NULL AND p_worker_markup_percent < 0 THEN
    RAISE EXCEPTION 'El porcentaje no puede ser negativo';
  END IF;
  IF p_worker_monthly_limit_amount IS NOT NULL
     AND (p_worker_monthly_limit_amount <= 0 OR p_worker_monthly_limit_amount <> trunc(p_worker_monthly_limit_amount)) THEN
    RAISE EXCEPTION 'El tope mensual debe ser un monto entero mayor que 0';
  END IF;

  SELECT * INTO v_existing
  FROM mermas.internal_sale_settings
  WHERE company_id = p_company_id
  FOR UPDATE;

  IF v_existing.id IS NULL THEN
    INSERT INTO mermas.internal_sale_settings (
      company_id, worker_markup_percent, worker_monthly_limit_amount,
      created_by, updated_by
    ) VALUES (
      p_company_id, p_worker_markup_percent, p_worker_monthly_limit_amount,
      p_user_id, p_user_id
    ) RETURNING * INTO v_setting;
  ELSE
    UPDATE mermas.internal_sale_settings
    SET worker_markup_percent = p_worker_markup_percent,
        worker_monthly_limit_amount = p_worker_monthly_limit_amount,
        updated_at = now(),
        updated_by = p_user_id
    WHERE id = v_existing.id
    RETURNING * INTO v_setting;
  END IF;

  IF v_existing.id IS NULL
     OR v_existing.worker_markup_percent IS DISTINCT FROM v_setting.worker_markup_percent THEN
    INSERT INTO portal.audit_logs (
      table_name, record_id, action, old_data, new_data, performed_by
    ) VALUES (
      'mermas.internal_sale_settings', v_setting.id, 'MERMA_PRICE_CONFIG',
      CASE WHEN v_existing.id IS NULL THEN NULL
        ELSE jsonb_build_object('worker_markup_percent', v_existing.worker_markup_percent) END,
      jsonb_build_object('worker_markup_percent', v_setting.worker_markup_percent),
      p_user_id
    );
  END IF;
  IF v_existing.id IS NULL
     OR v_existing.worker_monthly_limit_amount IS DISTINCT FROM v_setting.worker_monthly_limit_amount THEN
    INSERT INTO portal.audit_logs (
      table_name, record_id, action, old_data, new_data, performed_by
    ) VALUES (
      'mermas.internal_sale_settings', v_setting.id, 'MERMA_LIMIT_CONFIG',
      CASE WHEN v_existing.id IS NULL THEN NULL
        ELSE jsonb_build_object('worker_monthly_limit_amount', v_existing.worker_monthly_limit_amount) END,
      jsonb_build_object('worker_monthly_limit_amount', v_setting.worker_monthly_limit_amount),
      p_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'id', v_setting.id,
    'worker_markup_percent', v_setting.worker_markup_percent,
    'worker_monthly_limit_amount', v_setting.worker_monthly_limit_amount,
    'updated_at', v_setting.updated_at,
    'updated_by', v_setting.updated_by
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.save_internal_sale_settings(uuid, uuid, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.save_internal_sale_settings(uuid, uuid, numeric, numeric)
  TO service_role;
