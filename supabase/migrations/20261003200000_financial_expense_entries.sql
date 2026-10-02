-- Independent recognized-expense source. It is intentionally not consumed by P&L yet.

create table comercial.financial_expense_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  period_year integer not null check (period_year between 2000 and 2100),
  period_month integer not null check (period_month between 1 and 12),
  category_id uuid not null,
  recognized_amount numeric(20, 0) not null check (recognized_amount > 0),
  currency text not null default 'CLP' check (btrim(currency) <> ''),
  description text not null check (btrim(description) <> ''),
  counterparty_name text,
  document_date date,
  document_number text,
  source_type text not null default 'MANUAL' check (source_type in ('MANUAL', 'BANK_LINKED', 'IMPORT')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED', 'VOIDED')),
  source_reference text,
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
  check ((status = 'VOIDED' and btrim(coalesce(void_reason, '')) <> '') or status <> 'VOIDED'),
  check ((status = 'POSTED' and posted_by is not null and posted_at is not null) or status <> 'POSTED'),
  check ((status <> 'VOIDED' or voided_by is not null) and (status <> 'VOIDED' or voided_at is not null))
);

create table comercial.financial_expense_bank_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  expense_entry_id uuid not null,
  bank_movement_id uuid not null,
  allocated_amount numeric(20, 0) not null check (allocated_amount > 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, expense_entry_id, bank_movement_id),
  foreign key (company_id, expense_entry_id) references comercial.financial_expense_entries(company_id, id) on delete restrict,
  foreign key (bank_movement_id) references comercial.financial_bank_movements(id) on delete restrict
);

create index financial_expense_entries_company_period_status_idx
  on comercial.financial_expense_entries(company_id, period_year, period_month, status);
create index financial_expense_entries_company_category_period_idx
  on comercial.financial_expense_entries(company_id, category_id, period_year, period_month);
create index financial_expense_bank_links_expense_idx
  on comercial.financial_expense_bank_links(company_id, expense_entry_id);
create index financial_expense_bank_links_movement_idx
  on comercial.financial_expense_bank_links(company_id, bank_movement_id);

create or replace function comercial.set_financial_expense_updated_at()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger financial_expense_entries_updated_at
before update on comercial.financial_expense_entries
for each row execute function comercial.set_financial_expense_updated_at();

create or replace function comercial.validate_financial_expense_category(
  p_company_id uuid, p_category_id uuid
) returns void language plpgsql security definer
set search_path = pg_catalog, comercial as $$
begin
  if not exists (
    select 1 from comercial.financial_categories c
    where c.company_id = p_company_id and c.id = p_category_id and c.is_active
      and c.direction in ('EXPENSE', 'BOTH')
      and not exists (
        select 1 from comercial.financial_categories child
        where child.company_id = c.company_id and child.parent_id = c.id and child.is_active
      )
  ) then
    raise exception 'La categoría debe ser una hoja activa de naturaleza gasto.';
  end if;
end;
$$;

create or replace function comercial.create_financial_expense_draft(
  p_company_id uuid, p_period_year integer, p_period_month integer, p_category_id uuid,
  p_recognized_amount numeric, p_currency text, p_description text, p_counterparty_name text,
  p_document_date date, p_document_number text, p_source_type text, p_source_reference text,
  p_notes text, p_metadata jsonb, p_idempotency_key text, p_created_by uuid
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_id uuid;
begin
  perform comercial.validate_financial_expense_category(p_company_id, p_category_id);
  if p_period_year not between 2000 and 2100 or p_period_month not between 1 and 12 then raise exception 'Período contable inválido.'; end if;
  if p_recognized_amount <= 0 then raise exception 'El monto reconocido debe ser mayor que cero.'; end if;
  if p_source_type not in ('MANUAL', 'BANK_LINKED', 'IMPORT') then raise exception 'Origen inválido.'; end if;
  insert into comercial.financial_expense_entries(company_id, period_year, period_month, category_id, recognized_amount, currency, description, counterparty_name, document_date, document_number, source_type, source_reference, notes, metadata, idempotency_key, created_by)
  values (p_company_id, p_period_year, p_period_month, p_category_id, p_recognized_amount, coalesce(nullif(btrim(p_currency), ''), 'CLP'), btrim(p_description), nullif(btrim(p_counterparty_name), ''), p_document_date, nullif(btrim(p_document_number), ''), p_source_type, nullif(btrim(p_source_reference), ''), nullif(btrim(p_notes), ''), coalesce(p_metadata, '{}'::jsonb), btrim(p_idempotency_key), p_created_by)
  on conflict (company_id, idempotency_key) do update set updated_at = now()
  returning id into v_id;
  insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  select 'financial_expense_entries', v_id, 'CREATE_DRAFT', to_jsonb(e), p_created_by
  from comercial.financial_expense_entries e where e.id = v_id and e.company_id = p_company_id;
  return v_id;
end;
$$;

create or replace function comercial.update_financial_expense_draft(
  p_company_id uuid, p_expense_entry_id uuid, p_period_year integer, p_period_month integer,
  p_category_id uuid, p_recognized_amount numeric, p_currency text, p_description text,
  p_counterparty_name text, p_document_date date, p_document_number text, p_source_type text,
  p_source_reference text, p_notes text, p_metadata jsonb, p_actor uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_before jsonb; v_after jsonb;
begin
  perform comercial.validate_financial_expense_category(p_company_id, p_category_id);
  if p_period_year not between 2000 and 2100 or p_period_month not between 1 and 12 then raise exception 'Período contable inválido.'; end if;
  if p_recognized_amount <= 0 then raise exception 'El monto reconocido debe ser mayor que cero.'; end if;
  select to_jsonb(e) into v_before from comercial.financial_expense_entries e where e.company_id = p_company_id and e.id = p_expense_entry_id and e.status = 'DRAFT' for update;
  if v_before is null then raise exception 'Sólo se pueden editar partidas DRAFT.'; end if;
  update comercial.financial_expense_entries set period_year=p_period_year, period_month=p_period_month, category_id=p_category_id, recognized_amount=p_recognized_amount, currency=coalesce(nullif(btrim(p_currency), ''), 'CLP'), description=btrim(p_description), counterparty_name=nullif(btrim(p_counterparty_name), ''), document_date=p_document_date, document_number=nullif(btrim(p_document_number), ''), source_type=p_source_type, source_reference=nullif(btrim(p_source_reference), ''), notes=nullif(btrim(p_notes), ''), metadata=coalesce(p_metadata, '{}'::jsonb) where company_id=p_company_id and id=p_expense_entry_id;
  select to_jsonb(e) into v_after from comercial.financial_expense_entries e where e.company_id=p_company_id and e.id=p_expense_entry_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by) values ('financial_expense_entries', p_expense_entry_id, 'UPDATE_DRAFT', v_before, v_after, p_actor);
  return v_after;
end;
$$;

create or replace function comercial.post_financial_expense(
  p_company_id uuid, p_expense_entry_id uuid, p_actor uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_before jsonb; v_after jsonb;
begin
  select to_jsonb(e) into v_before from comercial.financial_expense_entries e where e.company_id=p_company_id and e.id=p_expense_entry_id for update;
  if v_before is null or v_before->>'status' <> 'DRAFT' then raise exception 'Sólo se pueden reconocer partidas DRAFT.'; end if;
  if exists (select 1 from comercial.financial_expense_bank_links l join comercial.financial_bank_movements m on m.company_id=l.company_id and m.id=l.bank_movement_id join comercial.financial_categories c on c.company_id=m.company_id and c.id=m.category_id where l.company_id=p_company_id and l.expense_entry_id=p_expense_entry_id and (m.direction <> 'DEBE' or coalesce(m.debit_amount, 0) <= 0 or c.affects_pnl_directly)) then raise exception 'El movimiento bancario ya está configurado para afectar resultados. Corrige primero su clasificación bancaria antes de reconocer el gasto por esta vía.'; end if;
  update comercial.financial_expense_entries set status='POSTED', posted_by=p_actor, posted_at=now(), source_type=case when exists(select 1 from comercial.financial_expense_bank_links where company_id=p_company_id and expense_entry_id=p_expense_entry_id) then 'BANK_LINKED' else source_type end where company_id=p_company_id and id=p_expense_entry_id;
  select to_jsonb(e) into v_after from comercial.financial_expense_entries e where e.company_id=p_company_id and e.id=p_expense_entry_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by) values ('financial_expense_entries', p_expense_entry_id, 'POST', v_before, v_after, p_actor);
  return v_after;
end;
$$;

create or replace function comercial.void_financial_expense(
  p_company_id uuid, p_expense_entry_id uuid, p_reason text, p_actor uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_before jsonb; v_after jsonb;
begin
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'El motivo de anulación es obligatorio.'; end if;
  select to_jsonb(e) into v_before from comercial.financial_expense_entries e where e.company_id=p_company_id and e.id=p_expense_entry_id and e.status <> 'VOIDED' for update;
  if v_before is null then raise exception 'La partida no existe o ya está anulada.'; end if;
  update comercial.financial_expense_entries set status='VOIDED', voided_by=p_actor, voided_at=now(), void_reason=btrim(p_reason) where company_id=p_company_id and id=p_expense_entry_id;
  select to_jsonb(e) into v_after from comercial.financial_expense_entries e where e.company_id=p_company_id and e.id=p_expense_entry_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by) values ('financial_expense_entries', p_expense_entry_id, 'VOID', v_before, v_after, p_actor);
  return v_after;
end;
$$;

create or replace function comercial.link_financial_expense_bank_movement(
  p_company_id uuid, p_expense_entry_id uuid, p_bank_movement_id uuid, p_allocated_amount numeric, p_actor uuid
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_id uuid; v_amount numeric; v_expense numeric; v_direct boolean;
begin
  if p_allocated_amount <= 0 then raise exception 'La asignación debe ser mayor que cero.'; end if;
  if not exists (select 1 from comercial.financial_expense_entries where company_id=p_company_id and id=p_expense_entry_id and status='DRAFT') then raise exception 'Sólo se pueden vincular partidas DRAFT.'; end if;
  select debit_amount, coalesce(c.affects_pnl_directly, false) into v_amount, v_direct from comercial.financial_bank_movements m left join comercial.financial_categories c on c.company_id=m.company_id and c.id=m.category_id where m.company_id=p_company_id and m.id=p_bank_movement_id and m.direction='DEBE' for update;
  if not found then raise exception 'Sólo se pueden vincular movimientos DEBE de la empresa activa.'; end if;
  if v_direct then raise exception 'El movimiento bancario ya está configurado para afectar resultados. Corrige primero su clasificación bancaria antes de reconocer el gasto por esta vía.'; end if;
  if p_allocated_amount + coalesce((select sum(allocated_amount) from comercial.financial_expense_bank_links where company_id=p_company_id and bank_movement_id=p_bank_movement_id), 0) > v_amount then raise exception 'Las asignaciones exceden el monto DEBE disponible.'; end if;
  if p_allocated_amount + coalesce((select sum(allocated_amount) from comercial.financial_expense_bank_links where company_id=p_company_id and expense_entry_id=p_expense_entry_id), 0) > (select recognized_amount from comercial.financial_expense_entries where company_id=p_company_id and id=p_expense_entry_id) then raise exception 'Las asignaciones exceden el monto reconocido.'; end if;
  insert into comercial.financial_expense_bank_links(company_id, expense_entry_id, bank_movement_id, allocated_amount, created_by) values(p_company_id,p_expense_entry_id,p_bank_movement_id,p_allocated_amount,p_actor) returning id into v_id;
  insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by) values ('financial_expense_bank_links', v_id, 'BANK_LINK', jsonb_build_object('expense_entry_id',p_expense_entry_id,'bank_movement_id',p_bank_movement_id,'allocated_amount',p_allocated_amount), p_actor);
  return v_id;
end;
$$;

create or replace function comercial.unlink_financial_expense_bank_movement(
  p_company_id uuid, p_link_id uuid, p_actor uuid
) returns void language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_old jsonb; v_expense uuid;
begin
  select to_jsonb(l), l.expense_entry_id into v_old, v_expense from comercial.financial_expense_bank_links l where l.company_id=p_company_id and l.id=p_link_id;
  if v_old is null then raise exception 'El vínculo no existe.'; end if;
  if not exists(select 1 from comercial.financial_expense_entries where company_id=p_company_id and id=v_expense and status='DRAFT') then raise exception 'Sólo se pueden quitar vínculos de partidas DRAFT.'; end if;
  delete from comercial.financial_expense_bank_links where company_id=p_company_id and id=p_link_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, performed_by) values ('financial_expense_bank_links', p_link_id, 'BANK_UNLINK', v_old, p_actor);
end;
$$;

alter table comercial.financial_expense_entries enable row level security;
alter table comercial.financial_expense_bank_links enable row level security;
revoke all on table comercial.financial_expense_entries, comercial.financial_expense_bank_links from public, anon, authenticated, service_role;
grant select on table comercial.financial_expense_entries, comercial.financial_expense_bank_links to service_role;
revoke all on function comercial.validate_financial_expense_category(uuid, uuid), comercial.create_financial_expense_draft(uuid, integer, integer, uuid, numeric, text, text, text, date, text, text, text, text, jsonb, text, uuid), comercial.update_financial_expense_draft(uuid, uuid, integer, integer, uuid, numeric, text, text, text, date, text, text, text, text, jsonb, uuid), comercial.post_financial_expense(uuid, uuid, uuid), comercial.void_financial_expense(uuid, uuid, text, uuid), comercial.link_financial_expense_bank_movement(uuid, uuid, uuid, numeric, uuid), comercial.unlink_financial_expense_bank_movement(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.create_financial_expense_draft(uuid, integer, integer, uuid, numeric, text, text, text, date, text, text, text, text, jsonb, text, uuid), comercial.update_financial_expense_draft(uuid, uuid, integer, integer, uuid, numeric, text, text, text, date, text, text, text, text, jsonb, uuid), comercial.post_financial_expense(uuid, uuid, uuid), comercial.void_financial_expense(uuid, uuid, text, uuid), comercial.link_financial_expense_bank_movement(uuid, uuid, uuid, numeric, uuid), comercial.unlink_financial_expense_bank_movement(uuid, uuid, uuid) to service_role;

insert into portal.permissions(code, name, description, module_id)
select 'analisis_comercial.control_financiero.manage_expenses', 'Gestionar Gastos Reconocidos', 'Permite crear, reconocer y anular gastos financieros.', id
from portal.modules where code = 'analisis_comercial'
on conflict (code) do update set name=excluded.name, description=excluded.description;

insert into portal.role_permissions(role_id, permission_id)
select r.id, p.id from portal.roles r cross join portal.permissions p
where r.name in ('FINANZAS', 'GERENCIA', 'SUPER_USUARIO') and p.code='analisis_comercial.control_financiero.manage_expenses'
on conflict do nothing;
