-- Emergency isolation: PostgREST 14.x retries SQLSTATE 40001 indefinitely.
-- Preserve authorization, business guards, SECURITY DEFINER, search_path and existing EXECUTE grants.
-- Only two staleness guards change from SQLSTATE 40001 to PT409 (HTTP 409).
CREATE OR REPLACE FUNCTION comercial.update_financial_bank_movement_category_manual(p_company_id uuid, p_movement_id uuid, p_category_id uuid, p_current_category_id uuid, p_reason text, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'comercial', 'portal', 'core'
AS $function$
declare
  v_movement comercial.financial_bank_movements%rowtype;
  v_category comercial.financial_categories%rowtype;
  v_old jsonb;
begin
  if p_actor_user_id is null or not core.has_company_access(p_actor_user_id, p_company_id)
     or not portal.user_has_permission(p_actor_user_id, 'analisis_comercial.control_financiero.classify') then
    raise exception 'No tienes permiso para corregir categorías financieras.' using errcode = '42501';
  end if;
  select * into v_movement from comercial.financial_bank_movements
  where company_id = p_company_id and id = p_movement_id and direction = 'DEBE' for update;
  if not found then raise exception 'El movimiento no pertenece a la empresa activa o no es un DEBE.' using errcode = 'P0002'; end if;
  if v_movement.category_id is distinct from p_current_category_id then raise exception 'La categoría del movimiento cambió mientras lo estabas revisando.' using errcode = 'PT409'; end if;
  select * into v_category from comercial.financial_categories c
  where c.company_id = p_company_id and c.id = p_category_id and c.is_active and c.parent_id is not null
    and c.direction in ('EXPENSE', 'BOTH') and c.cash_direction in ('DEBIT', 'BOTH')
    and not exists (select 1 from comercial.financial_categories child where child.company_id = c.company_id and child.parent_id = c.id and child.is_active);
  if not found then raise exception 'La categoría no es una hoja activa compatible con DEBE.' using errcode = '22023'; end if;
  v_old := jsonb_build_object('category_id', v_movement.category_id, 'classification_source', v_movement.classification_source, 'classification_rule_id', v_movement.classification_rule_id, 'review_status', v_movement.review_status);
  update comercial.financial_bank_movements set category_id = p_category_id, classification_source = 'MANUAL', classification_rule_id = null,
    classification_note = coalesce(nullif(btrim(p_reason), ''), classification_note),
    review_status = case when transaction_date < date '2026-10-01' then 'HISTORICAL' else 'REVIEWED' end,
    reviewed_by = case when transaction_date < date '2026-10-01' then null else p_actor_user_id end,
    reviewed_at = case when transaction_date < date '2026-10-01' then null else now() end,
    classified_by = p_actor_user_id, classified_at = now()
  where company_id = p_company_id and id = p_movement_id and category_id is not distinct from p_current_category_id;
  if not found then raise exception 'La categoría del movimiento cambió mientras lo estabas revisando.' using errcode = 'PT409'; end if;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by, schema_name, module_code, event_type, severity, metadata)
  select 'financial_bank_movements', p_movement_id, 'CHANGE_CATEGORY', v_old,
    jsonb_build_object('category_id', m.category_id, 'classification_source', m.classification_source, 'classification_rule_id', m.classification_rule_id, 'review_status', m.review_status),
    p_actor_user_id, 'comercial', 'CONTROL_FINANCIERO', 'financial_movement_category_changed', 'INFO',
    jsonb_build_object('movement_id', p_movement_id, 'company_id', p_company_id, 'reason', nullif(btrim(coalesce(p_reason, '')), ''))
  from comercial.financial_bank_movements m where m.company_id = p_company_id and m.id = p_movement_id;
  return jsonb_build_object('updated', true, 'movement_id', p_movement_id, 'category_id', p_category_id, 'classification_source', 'MANUAL', 'classification_rule_id', null);
end;
$function$

