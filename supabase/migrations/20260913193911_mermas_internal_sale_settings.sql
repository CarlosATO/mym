-- MERMAS: configuración global del precio futuro de venta a trabajadores.

CREATE TABLE mermas.internal_sale_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES core.companies(id) ON DELETE CASCADE,
  worker_markup_percent numeric(8,3),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES portal.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES portal.users(id),
  CONSTRAINT internal_sale_settings_markup_check
    CHECK (worker_markup_percent IS NULL OR worker_markup_percent >= 0)
);

ALTER TABLE mermas.internal_sale_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY mermas_internal_sale_settings_select
  ON mermas.internal_sale_settings FOR SELECT TO authenticated
  USING (
    core.has_company_access(auth.uid(), company_id)
    AND portal.has_permission('logistica.mermas.view')
  );

GRANT SELECT ON mermas.internal_sale_settings TO authenticated;
GRANT ALL ON mermas.internal_sale_settings TO service_role;

CREATE OR REPLACE FUNCTION mermas.save_internal_sale_settings(
  p_company_id uuid,
  p_user_id uuid,
  p_worker_markup_percent numeric
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

  SELECT * INTO v_existing
  FROM mermas.internal_sale_settings
  WHERE company_id = p_company_id
  FOR UPDATE;

  IF v_existing.id IS NULL THEN
    INSERT INTO mermas.internal_sale_settings (
      company_id, worker_markup_percent, created_by, updated_by
    ) VALUES (
      p_company_id, p_worker_markup_percent, p_user_id, p_user_id
    ) RETURNING * INTO v_setting;
  ELSE
    UPDATE mermas.internal_sale_settings
    SET worker_markup_percent = p_worker_markup_percent,
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

  RETURN jsonb_build_object(
    'id', v_setting.id,
    'worker_markup_percent', v_setting.worker_markup_percent,
    'updated_at', v_setting.updated_at,
    'updated_by', v_setting.updated_by
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.save_internal_sale_settings(uuid, uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.save_internal_sale_settings(uuid, uuid, numeric)
  TO service_role;
