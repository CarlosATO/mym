-- Allow an authorized user to correct one movement without changing rules.
-- The operation is atomic so the classification and its audit entry agree.

insert into portal.permissions (code, name, description, module_id, is_active)
select 'analisis_comercial.control_financiero.classify',
       'Clasificar movimientos de Control Financiero',
       'Permite corregir manualmente la categoría de un movimiento bancario.',
       module.id, true
from portal.modules module
where module.code = 'analisis-comercial'
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  module_id = excluded.module_id,
  is_active = excluded.is_active;

insert into portal.role_permissions (role_id, permission_id)
select r.id, p.id
from portal.roles r
cross join portal.permissions p
where r.name in ('SUPER_USUARIO', 'GERENCIA', 'FINANZAS')
  and p.code = 'analisis_comercial.control_financiero.classify'
  and not exists (
    select 1 from portal.role_permissions existing
    where existing.role_id = r.id and existing.permission_id = p.id
  );

create or replace function comercial.update_financial_bank_movement_category_manual(
  p_company_id uuid,
  p_movement_id uuid,
  p_category_id uuid,
  p_current_category_id uuid,
  p_reason text,
  p_actor_user_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial, portal, core as $$
declare
  v_movement comercial.financial_bank_movements%rowtype;
  v_category comercial.financial_categories%rowtype;
  v_old_category_name text;
  v_new_category_name text;
begin
  if p_actor_user_id is null
     or not core.has_company_access(p_actor_user_id, p_company_id)
     or not portal.user_has_permission(p_actor_user_id, 'analisis_comercial.control_financiero.classify') then
    raise exception 'No tienes permiso para corregir categorías financieras.' using errcode = '42501';
  end if;

  select * into v_movement
  from comercial.financial_bank_movements
  where company_id = p_company_id and id = p_movement_id
  for update;

  if not found then
    raise exception 'El movimiento no pertenece a la empresa activa.' using errcode = 'P0002';
  end if;

  if v_movement.category_id is not distinct from p_category_id then
    return jsonb_build_object('updated', false, 'movement_id', v_movement.id,
      'category_id', v_movement.category_id, 'classification_source', v_movement.classification_source,
      'classification_rule_id', v_movement.classification_rule_id,
      'classified_at', v_movement.classified_at);
  end if;

  if v_movement.category_id is distinct from p_current_category_id then
    raise exception 'La categoría del movimiento cambió mientras lo estabas revisando. Actualiza el detalle e inténtalo nuevamente.' using errcode = '40001';
  end if;

  select * into v_category
  from comercial.financial_categories category
  where category.company_id = p_company_id
    and category.id = p_category_id
    and category.is_active
    and category.parent_id is not null
    and not exists (
      select 1 from comercial.financial_categories child
      where child.company_id = category.company_id
        and child.parent_id = category.id
        and child.is_active
    )
    and (
      (v_movement.direction = 'DEBE'
        and category.direction in ('EXPENSE', 'BOTH')
        and category.cash_direction in ('DEBIT', 'BOTH'))
      or (v_movement.direction = 'HABER'
        and category.direction in ('INCOME', 'BOTH')
        and category.cash_direction in ('CREDIT', 'BOTH'))
      or (v_movement.direction = 'MIXTO'
        and category.direction = 'BOTH'
        and category.cash_direction = 'BOTH')
    )
  for share;

  if not found then
    raise exception 'La categoría no es una hoja activa y compatible con la dirección del movimiento.' using errcode = '22023';
  end if;

  select name into v_old_category_name from comercial.financial_categories
  where company_id = p_company_id and id = v_movement.category_id;
  v_new_category_name := v_category.name;

  update comercial.financial_bank_movements
  set category_id = p_category_id,
      classification_source = 'MANUAL',
      classification_rule_id = null,
      classified_by = p_actor_user_id,
      classified_at = pg_catalog.now()
  where company_id = p_company_id
    and id = p_movement_id
    and category_id is not distinct from p_current_category_id;

  if not found then
    raise exception 'La categoría del movimiento cambió mientras lo estabas revisando. Actualiza el detalle e inténtalo nuevamente.' using errcode = '40001';
  end if;

  insert into portal.audit_logs (
    table_name, record_id, action, old_data, new_data, performed_by,
    schema_name, module_code, event_type, severity, metadata, diff_data
  ) values (
    'financial_bank_movements', p_movement_id, 'UPDATE',
    jsonb_build_object('movement_id', p_movement_id, 'company_id', p_company_id,
      'category_id', v_movement.category_id, 'category_name', v_old_category_name,
      'classification_source', v_movement.classification_source,
      'classification_rule_id', v_movement.classification_rule_id),
    jsonb_build_object('movement_id', p_movement_id, 'company_id', p_company_id,
      'category_id', p_category_id, 'category_name', v_new_category_name,
      'classification_source', 'MANUAL', 'classification_rule_id', null),
    p_actor_user_id, 'comercial', 'CONTROL_FINANCIERO',
    'financial_movement_category_manual_override', 'INFO',
    jsonb_build_object('movement_id', p_movement_id, 'company_id', p_company_id,
      'reason', nullif(pg_catalog.btrim(coalesce(p_reason, '')), '')),
    jsonb_build_object('category_id', jsonb_build_object('old', v_movement.category_id, 'new', p_category_id),
      'classification_source', jsonb_build_object('old', v_movement.classification_source, 'new', 'MANUAL'),
      'classification_rule_id', jsonb_build_object('old', v_movement.classification_rule_id, 'new', null))
  );

  return jsonb_build_object('updated', true, 'movement_id', p_movement_id,
    'category_id', p_category_id, 'category_name', v_new_category_name,
    'classification_source', 'MANUAL', 'classification_rule_id', null,
    'classified_at', pg_catalog.now());
end;
$$;

revoke all on function comercial.update_financial_bank_movement_category_manual(uuid, uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function comercial.update_financial_bank_movement_category_manual(uuid, uuid, uuid, uuid, text, uuid)
  to service_role;

-- Keep automatic/bulk callers from replacing an existing manual decision.
-- A later explicit manual call remains allowed and is handled above.
create or replace function comercial.classify_financial_bank_movements(
  p_company_id uuid, p_movement_ids uuid[], p_category_id uuid,
  p_counterparty text, p_note text, p_source text, p_rule_id uuid,
  p_only_pending boolean, p_classified_by uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_updated integer;
begin
  if p_source not in ('MANUAL', 'BULK_EXACT', 'RULE', 'AUTO_RULE') then raise exception 'Fuente de clasificación inválida.'; end if;
  if not exists (select 1 from comercial.financial_categories where company_id = p_company_id and id = p_category_id and is_active) then raise exception 'La categoría no pertenece a la empresa activa.'; end if;
  if p_rule_id is not null and not exists (select 1 from comercial.financial_bank_classification_rules where company_id = p_company_id and id = p_rule_id) then raise exception 'La regla no pertenece a la empresa activa.'; end if;
  if (select count(*) from comercial.financial_bank_movements where company_id = p_company_id and id = any(p_movement_ids)) <> cardinality(p_movement_ids) then raise exception 'Uno o más movimientos no pertenecen a la empresa activa.'; end if;
  update comercial.financial_bank_movements
  set category_id = p_category_id, counterparty = nullif(trim(p_counterparty), ''), classification_note = nullif(trim(p_note), ''),
      classification_source = p_source, classification_rule_id = p_rule_id, classified_by = p_classified_by, classified_at = now()
  where company_id = p_company_id and id = any(p_movement_ids)
    and (not p_only_pending or category_id is null)
    and (p_source = 'MANUAL' or classification_source is distinct from 'MANUAL');
  get diagnostics v_updated = row_count;
  return jsonb_build_object('updated_count', v_updated, 'requested_count', cardinality(p_movement_ids));
end;
$$;

revoke all on function comercial.classify_financial_bank_movements(uuid, uuid[], uuid, text, text, text, uuid, boolean, uuid)
  from public, anon, authenticated, service_role;
grant execute on function comercial.classify_financial_bank_movements(uuid, uuid[], uuid, text, text, text, uuid, boolean, uuid)
  to service_role;
