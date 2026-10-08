-- External non-bank inflows. Loan persistence remains in its existing model.
create table comercial.financial_inflow_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  entry_type text not null check (entry_type in ('OWNER_CONTRIBUTION', 'OTHER_INCOME')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED', 'VOIDED')),
  period_year integer not null check (period_year between 2000 and 2100),
  period_month integer not null check (period_month between 1 and 12),
  amount numeric(20, 0) not null check (amount > 0),
  category_id uuid,
  description text not null check (btrim(description) <> ''),
  counterparty_name text,
  document_date date,
  document_number text,
  notes text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  posted_by uuid references auth.users(id),
  posted_at timestamptz,
  voided_by uuid references auth.users(id),
  voided_at timestamptz,
  void_reason text,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, category_id) references comercial.financial_categories(company_id, id),
  check ((entry_type = 'OWNER_CONTRIBUTION' and category_id is null) or (entry_type = 'OTHER_INCOME' and category_id is not null)),
  check ((status = 'POSTED' and posted_by is not null and posted_at is not null) or status <> 'POSTED'),
  check ((status = 'VOIDED' and voided_by is not null and voided_at is not null and btrim(coalesce(void_reason, '')) <> '') or status <> 'VOIDED')
);

create index financial_inflow_entries_company_period_status_idx
  on comercial.financial_inflow_entries(company_id, period_year, period_month, status);
create index financial_inflow_entries_company_type_period_idx
  on comercial.financial_inflow_entries(company_id, entry_type, period_year, period_month);

create or replace function comercial.set_financial_inflow_updated_at()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger financial_inflow_entries_updated_at
before update on comercial.financial_inflow_entries
for each row execute function comercial.set_financial_inflow_updated_at();

create or replace function comercial.validate_financial_inflow(
  p_company_id uuid, p_entry_type text, p_category_id uuid
) returns void language plpgsql security definer
set search_path = pg_catalog, comercial as $$
begin
  if p_entry_type not in ('OWNER_CONTRIBUTION', 'OTHER_INCOME') then
    raise exception 'Tipo de entrada inválido.';
  end if;
  if p_entry_type = 'OWNER_CONTRIBUTION' then
    if p_category_id is not null then raise exception 'Un aporte de socio no usa categoría EERR.'; end if;
    return;
  end if;
  if not exists (
    select 1
    from comercial.financial_categories category
    where category.company_id = p_company_id
      and category.id = p_category_id
      and category.code = 'INCOME_OTHER_CASH'
      and category.is_active
      and category.direction in ('INCOME', 'BOTH')
      and category.affects_pnl_directly
      and not exists (
        select 1
        from comercial.financial_categories child
        where child.company_id = category.company_id
          and child.parent_id = category.id
          and child.is_active
      )
  ) then
    raise exception 'La categoría de Otro ingreso no está disponible o no es la categoría financiera válida.';
  end if;
end;
$$;

create or replace function comercial.create_financial_inflow_draft(
  p_company_id uuid, p_entry_type text, p_period_year integer, p_period_month integer,
  p_amount numeric, p_category_id uuid, p_description text, p_counterparty_name text,
  p_document_date date, p_document_number text, p_notes text, p_metadata jsonb,
  p_idempotency_key text, p_created_by uuid
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_id uuid;
begin
  perform comercial.validate_financial_inflow(p_company_id, p_entry_type, p_category_id);
  if p_period_year not between 2000 and 2100 or p_period_month not between 1 and 12 then raise exception 'Período contable inválido.'; end if;
  if p_amount <= 0 then raise exception 'El monto debe ser mayor que cero.'; end if;
  insert into comercial.financial_inflow_entries(company_id, entry_type, period_year, period_month, amount, category_id, description, counterparty_name, document_date, document_number, notes, metadata, idempotency_key, created_by)
  values (p_company_id, p_entry_type, p_period_year, p_period_month, p_amount, p_category_id, btrim(p_description), nullif(btrim(p_counterparty_name), ''), p_document_date, nullif(btrim(p_document_number), ''), nullif(btrim(p_notes), ''), coalesce(p_metadata, '{}'::jsonb), btrim(p_idempotency_key), p_created_by)
  on conflict (company_id, idempotency_key) do update set updated_at = now()
  returning id into v_id;
  insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  select 'financial_inflow_entries', v_id, 'CREATE_DRAFT', to_jsonb(entry), p_created_by
  from comercial.financial_inflow_entries entry where entry.company_id = p_company_id and entry.id = v_id;
  return v_id;
end;
$$;

create or replace function comercial.update_financial_inflow_draft(
  p_company_id uuid, p_entry_id uuid, p_entry_type text, p_period_year integer, p_period_month integer,
  p_amount numeric, p_category_id uuid, p_description text, p_counterparty_name text,
  p_document_date date, p_document_number text, p_notes text, p_metadata jsonb, p_actor uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_before jsonb; v_after jsonb;
begin
  perform comercial.validate_financial_inflow(p_company_id, p_entry_type, p_category_id);
  if p_period_year not between 2000 and 2100 or p_period_month not between 1 and 12 then raise exception 'Período contable inválido.'; end if;
  if p_amount <= 0 then raise exception 'El monto debe ser mayor que cero.'; end if;
  select to_jsonb(entry) into v_before from comercial.financial_inflow_entries entry where entry.company_id = p_company_id and entry.id = p_entry_id and entry.status = 'DRAFT' for update;
  if v_before is null then raise exception 'Sólo se pueden editar entradas DRAFT.'; end if;
  update comercial.financial_inflow_entries
  set entry_type = p_entry_type, period_year = p_period_year, period_month = p_period_month, amount = p_amount,
      category_id = p_category_id, description = btrim(p_description), counterparty_name = nullif(btrim(p_counterparty_name), ''),
      document_date = p_document_date, document_number = nullif(btrim(p_document_number), ''), notes = nullif(btrim(p_notes), ''), metadata = coalesce(p_metadata, '{}'::jsonb)
  where company_id = p_company_id and id = p_entry_id;
  select to_jsonb(entry) into v_after from comercial.financial_inflow_entries entry where entry.company_id = p_company_id and entry.id = p_entry_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by) values ('financial_inflow_entries', p_entry_id, 'UPDATE_DRAFT', v_before, v_after, p_actor);
  return v_after;
end;
$$;

create or replace function comercial.post_financial_inflow(
  p_company_id uuid, p_entry_id uuid, p_actor uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_before jsonb; v_after jsonb;
begin
  select to_jsonb(entry) into v_before from comercial.financial_inflow_entries entry where entry.company_id = p_company_id and entry.id = p_entry_id for update;
  if v_before is null or v_before->>'status' <> 'DRAFT' then raise exception 'Sólo se pueden publicar entradas DRAFT.'; end if;
  perform comercial.validate_financial_inflow(p_company_id, v_before->>'entry_type', (v_before->>'category_id')::uuid);
  update comercial.financial_inflow_entries set status = 'POSTED', posted_by = p_actor, posted_at = now() where company_id = p_company_id and id = p_entry_id;
  select to_jsonb(entry) into v_after from comercial.financial_inflow_entries entry where entry.company_id = p_company_id and entry.id = p_entry_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by) values ('financial_inflow_entries', p_entry_id, 'POST', v_before, v_after, p_actor);
  return v_after;
end;
$$;

create or replace function comercial.void_financial_inflow(
  p_company_id uuid, p_entry_id uuid, p_reason text, p_actor uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_before jsonb; v_after jsonb;
begin
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'El motivo de anulación es obligatorio.'; end if;
  select to_jsonb(entry) into v_before from comercial.financial_inflow_entries entry where entry.company_id = p_company_id and entry.id = p_entry_id and entry.status <> 'VOIDED' for update;
  if v_before is null then raise exception 'La entrada no existe o ya está anulada.'; end if;
  update comercial.financial_inflow_entries set status = 'VOIDED', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason) where company_id = p_company_id and id = p_entry_id;
  select to_jsonb(entry) into v_after from comercial.financial_inflow_entries entry where entry.company_id = p_company_id and entry.id = p_entry_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by) values ('financial_inflow_entries', p_entry_id, 'VOID', v_before, v_after, p_actor);
  return v_after;
end;
$$;

alter table comercial.financial_inflow_entries enable row level security;
revoke all on table comercial.financial_inflow_entries from public, anon, authenticated, service_role;
grant select on table comercial.financial_inflow_entries to service_role;
revoke all on function comercial.validate_financial_inflow(uuid, text, uuid), comercial.create_financial_inflow_draft(uuid, text, integer, integer, numeric, uuid, text, text, date, text, text, jsonb, text, uuid), comercial.update_financial_inflow_draft(uuid, uuid, text, integer, integer, numeric, uuid, text, text, date, text, text, jsonb, uuid), comercial.post_financial_inflow(uuid, uuid, uuid), comercial.void_financial_inflow(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.create_financial_inflow_draft(uuid, text, integer, integer, numeric, uuid, text, text, date, text, text, jsonb, text, uuid), comercial.update_financial_inflow_draft(uuid, uuid, text, integer, integer, numeric, uuid, text, text, date, text, text, jsonb, uuid), comercial.post_financial_inflow(uuid, uuid, uuid), comercial.void_financial_inflow(uuid, uuid, text, uuid) to service_role;

insert into portal.permissions(code, name, description, module_id)
select 'analisis_comercial.control_financiero.manage_inflows', 'Gestionar Entradas Financieras', 'Permite crear, publicar y anular entradas financieras externas.', id
from portal.modules where code = 'analisis_comercial'
on conflict (code) do update set name = excluded.name, description = excluded.description;

insert into portal.role_permissions(role_id, permission_id)
select roles.id, permissions.id
from portal.roles roles
cross join portal.permissions permissions
where roles.name in ('FINANZAS', 'GERENCIA', 'SUPER_USUARIO')
  and permissions.code = 'analisis_comercial.control_financiero.manage_inflows'
on conflict do nothing;
