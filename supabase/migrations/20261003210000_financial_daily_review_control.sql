-- Daily bank movement review control. Historical movements remain readable,
-- while only post-cutoff DEBE movements require an operational review.

alter table comercial.financial_bank_movements
  add column if not exists review_status text;
alter table comercial.financial_bank_movements
  add column if not exists reviewed_by uuid references auth.users(id);
alter table comercial.financial_bank_movements
  add column if not exists reviewed_at timestamptz;

alter table comercial.financial_bank_movements
  drop constraint if exists financial_bank_movements_review_status_check;
alter table comercial.financial_bank_movements
  add constraint financial_bank_movements_review_status_check
  check (review_status is null or review_status in ('HISTORICAL', 'PENDING', 'REVIEWED'));

-- Existing DEBE movements are historical or operationally pending. HABER is
-- deliberately outside this review workflow.
update comercial.financial_bank_movements
set review_status = case
  when transaction_date < date '2026-10-01' then 'HISTORICAL'
  else 'PENDING'
end,
reviewed_by = null,
reviewed_at = null
where direction = 'DEBE';
update comercial.financial_bank_movements
set review_status = null, reviewed_by = null, reviewed_at = null
where direction <> 'DEBE' or direction is null;

create index if not exists financial_bank_movements_review_status_idx
  on comercial.financial_bank_movements(company_id, direction, review_status, transaction_date);

create or replace function comercial.set_financial_bank_review_status()
returns trigger language plpgsql as $$
begin
  if new.direction = 'DEBE' and new.review_status is null then
    new.review_status := case when new.transaction_date < date '2026-10-01' then 'HISTORICAL' else 'PENDING' end;
  elsif new.direction <> 'DEBE' or new.direction is null then
    new.review_status := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists financial_bank_review_status_trigger on comercial.financial_bank_movements;
create trigger financial_bank_review_status_trigger
before insert or update of direction, transaction_date, review_status
on comercial.financial_bank_movements
for each row execute function comercial.set_financial_bank_review_status();

update comercial.financial_categories
set affects_pnl_directly = true,
    affects_cash_flow = true,
    classification_group = 'OPERATING',
    cash_direction = 'DEBIT'
where code in ('EXPENSE_INSURANCE', 'EXPENSE_TELECOM', 'EXPENSE_EXTERNAL_SERVICES');

create or replace function comercial.confirm_financial_bank_movement_classification(
  p_company_id uuid, p_movement_id uuid, p_actor_user_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial, portal, core as $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  if p_actor_user_id is null
     or not core.has_company_access(p_actor_user_id, p_company_id)
     or not portal.user_has_permission(p_actor_user_id, 'analisis_comercial.control_financiero.classify') then
    raise exception 'No tienes permiso para confirmar clasificaciones financieras.' using errcode = '42501';
  end if;
  select to_jsonb(m) into v_before
  from comercial.financial_bank_movements m
  where m.company_id = p_company_id and m.id = p_movement_id and m.direction = 'DEBE'
  for update;
  if v_before is null then
    raise exception 'El movimiento no pertenece a la empresa activa o no es un DEBE.' using errcode = 'P0002';
  end if;
  if v_before->>'category_id' is null then
    raise exception 'No se puede confirmar un movimiento sin categoría.' using errcode = '22023';
  end if;
  update comercial.financial_bank_movements
  set review_status = 'REVIEWED', reviewed_by = p_actor_user_id, reviewed_at = now()
  where company_id = p_company_id and id = p_movement_id;
  select to_jsonb(m) into v_after
  from comercial.financial_bank_movements m
  where m.company_id = p_company_id and m.id = p_movement_id;
  insert into portal.audit_logs (
    table_name, record_id, action, old_data, new_data, performed_by,
    schema_name, module_code, event_type, severity, metadata
  ) values (
    'financial_bank_movements', p_movement_id, 'CONFIRM_CLASSIFICATION',
    v_before, v_after, p_actor_user_id, 'comercial', 'CONTROL_FINANCIERO',
    'financial_movement_classification_confirmed', 'INFO',
    jsonb_build_object('movement_id', p_movement_id, 'company_id', p_company_id)
  );
  return v_after;
end;
$$;

create or replace function comercial.update_financial_bank_movement_observation(
  p_company_id uuid, p_movement_id uuid, p_observation text, p_actor_user_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial, portal, core as $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  if p_actor_user_id is null
     or not core.has_company_access(p_actor_user_id, p_company_id)
     or not portal.user_has_permission(p_actor_user_id, 'analisis_comercial.control_financiero.classify') then
    raise exception 'No tienes permiso para editar observaciones financieras.' using errcode = '42501';
  end if;
  select to_jsonb(m) into v_before
  from comercial.financial_bank_movements m
  where m.company_id = p_company_id and m.id = p_movement_id and m.direction = 'DEBE'
  for update;
  if v_before is null then
    raise exception 'El movimiento no pertenece a la empresa activa o no es un DEBE.' using errcode = 'P0002';
  end if;
  update comercial.financial_bank_movements
  set classification_note = nullif(btrim(coalesce(p_observation, '')), '')
  where company_id = p_company_id and id = p_movement_id;
  select to_jsonb(m) into v_after
  from comercial.financial_bank_movements m
  where m.company_id = p_company_id and m.id = p_movement_id;
  insert into portal.audit_logs (
    table_name, record_id, action, old_data, new_data, performed_by,
    schema_name, module_code, event_type, severity, metadata
  ) values (
    'financial_bank_movements', p_movement_id, 'UPDATE_OBSERVATION',
    jsonb_build_object('classification_note', v_before->'classification_note'),
    jsonb_build_object('classification_note', v_after->'classification_note'),
    p_actor_user_id, 'comercial', 'CONTROL_FINANCIERO',
    'financial_movement_observation_updated', 'INFO',
    jsonb_build_object('movement_id', p_movement_id, 'company_id', p_company_id)
  );
  return v_after;
end;
$$;

create or replace function comercial.update_financial_bank_movement_category_manual(
  p_company_id uuid, p_movement_id uuid, p_category_id uuid,
  p_current_category_id uuid, p_reason text, p_actor_user_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial, portal, core as $$
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
  if v_movement.category_id is distinct from p_current_category_id then raise exception 'La categoría del movimiento cambió mientras lo estabas revisando.' using errcode = '40001'; end if;
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
  if not found then raise exception 'La categoría del movimiento cambió mientras lo estabas revisando.' using errcode = '40001'; end if;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by, schema_name, module_code, event_type, severity, metadata)
  select 'financial_bank_movements', p_movement_id, 'CHANGE_CATEGORY', v_old,
    jsonb_build_object('category_id', m.category_id, 'classification_source', m.classification_source, 'classification_rule_id', m.classification_rule_id, 'review_status', m.review_status),
    p_actor_user_id, 'comercial', 'CONTROL_FINANCIERO', 'financial_movement_category_changed', 'INFO',
    jsonb_build_object('movement_id', p_movement_id, 'company_id', p_company_id, 'reason', nullif(btrim(coalesce(p_reason, '')), ''))
  from comercial.financial_bank_movements m where m.company_id = p_company_id and m.id = p_movement_id;
  return jsonb_build_object('updated', true, 'movement_id', p_movement_id, 'category_id', p_category_id, 'classification_source', 'MANUAL', 'classification_rule_id', null);
end;
$$;

-- Keep automatic classification as a proposal. Explicit manual/bulk actions
-- are human review and therefore confirm only post-cutoff DEBE movements.
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
      classification_source = p_source, classification_rule_id = p_rule_id, classified_by = p_classified_by, classified_at = now(),
      review_status = case when direction = 'DEBE' and transaction_date >= date '2026-10-01' and p_source in ('MANUAL', 'BULK_EXACT') then 'REVIEWED' else review_status end,
      reviewed_by = case when direction = 'DEBE' and transaction_date >= date '2026-10-01' and p_source in ('MANUAL', 'BULK_EXACT') then p_classified_by else reviewed_by end,
      reviewed_at = case when direction = 'DEBE' and transaction_date >= date '2026-10-01' and p_source in ('MANUAL', 'BULK_EXACT') then now() else reviewed_at end
  where company_id = p_company_id and id = any(p_movement_ids)
    and (not p_only_pending or category_id is null)
    and (p_source = 'MANUAL' or classification_source is distinct from 'MANUAL');
  get diagnostics v_updated = row_count;
  return jsonb_build_object('updated_count', v_updated, 'requested_count', cardinality(p_movement_ids));
end;
$$;

revoke all on function comercial.confirm_financial_bank_movement_classification(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function comercial.update_financial_bank_movement_observation(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.confirm_financial_bank_movement_classification(uuid, uuid, uuid) to service_role;
grant execute on function comercial.update_financial_bank_movement_observation(uuid, uuid, text, uuid) to service_role;

-- The dormant schema remains available, but its operational role assignments are removed.
delete from portal.role_permissions
where permission_id = (select id from portal.permissions where code = 'analisis_comercial.control_financiero.manage_expenses');
