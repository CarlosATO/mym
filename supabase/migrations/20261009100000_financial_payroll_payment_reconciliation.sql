-- Reconciliation layer between bank payroll payments and the payroll book.
-- Batch completeness and payroll reconciliation are deliberately separate.

create or replace function comercial.normalize_financial_worker_rut(p_rut text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  with cleaned as (
    select upper(regexp_replace(coalesce(p_rut, ''), '[^0-9K]', '', 'g')) as value
  )
  select case
    when length(value) between 8 and 9 then left(value, length(value) - 1) || '-' || right(value, 1)
    else null
  end
  from cleaned;
$$;

alter table comercial.financial_payroll_entries
  add constraint financial_payroll_entries_company_id_uidx unique (company_id, id);

create table comercial.financial_payroll_payment_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  bank_movement_id uuid not null,
  period_year integer not null check (period_year between 2000 and 2100),
  period_month integer not null check (period_month between 1 and 12),
  payment_date date not null,
  bank_amount bigint not null check (bank_amount > 0),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'COMPLETE')),
  note text,
  created_by uuid references auth.users(id) on delete restrict,
  completed_by uuid references auth.users(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, bank_movement_id),
  foreign key (company_id, bank_movement_id)
    references comercial.financial_bank_movements(company_id, id)
    on delete restrict
);

create table comercial.financial_payroll_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  batch_id uuid not null,
  allocation_type text not null check (allocation_type in ('FORMAL', 'OFF_BOOK')),
  reconciliation_status text not null default 'PENDING_PAYROLL'
    check (reconciliation_status in ('PENDING_PAYROLL', 'MATCHED', 'AMOUNT_DIFFERENCE', 'NOT_FOUND_IN_PAYROLL', 'NOT_APPLICABLE')),
  payroll_entry_id uuid,
  worker_rut text not null,
  worker_name_snapshot text,
  amount bigint not null check (amount > 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (batch_id, worker_rut, allocation_type),
  foreign key (company_id, batch_id)
    references comercial.financial_payroll_payment_batches(company_id, id)
    on delete cascade,
  foreign key (company_id, payroll_entry_id)
    references comercial.financial_payroll_entries(company_id, id)
    on delete restrict,
  check (worker_rut = comercial.normalize_financial_worker_rut(worker_rut)),
  check ((allocation_type = 'FORMAL' and reconciliation_status <> 'NOT_APPLICABLE')
      or (allocation_type = 'OFF_BOOK' and reconciliation_status = 'NOT_APPLICABLE' and payroll_entry_id is null))
);

create index financial_payroll_payment_batches_company_period_idx
  on comercial.financial_payroll_payment_batches(company_id, period_year, period_month);
create index financial_payroll_payment_allocations_batch_idx
  on comercial.financial_payroll_payment_allocations(company_id, batch_id);
create index financial_payroll_payment_allocations_rut_idx
  on comercial.financial_payroll_payment_allocations(company_id, worker_rut);

create or replace function comercial.set_financial_payroll_payment_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger financial_payroll_payment_batches_updated_at
before update on comercial.financial_payroll_payment_batches
for each row execute function comercial.set_financial_payroll_payment_updated_at();

create trigger financial_payroll_payment_allocations_updated_at
before update on comercial.financial_payroll_payment_allocations
for each row execute function comercial.set_financial_payroll_payment_updated_at();

create or replace function comercial.validate_financial_payroll_payment_batch()
returns trigger
language plpgsql
set search_path = pg_catalog, comercial
as $$
declare
  v_movement record;
  v_total bigint;
  v_reopen boolean := current_setting('comercial.payroll_reconciliation_reopen', true) = 'on';
begin
  if tg_op <> 'INSERT' and old.status = 'COMPLETE' and not v_reopen then
    raise exception 'Un batch COMPLETE sólo puede reabrirse mediante el flujo controlado.';
  end if;
  if new.status = 'COMPLETE' then
    select direction, debit_amount into v_movement
    from comercial.financial_bank_movements
    where company_id = new.company_id and id = new.bank_movement_id;
    if not found or v_movement.direction <> 'DEBE' or coalesce(v_movement.debit_amount, 0) <= 0 then
      raise exception 'El batch COMPLETE requiere un movimiento DEBE con débito positivo.';
    end if;
    select coalesce(sum(amount), 0) into v_total
    from comercial.financial_payroll_payment_allocations
    where company_id = new.company_id and batch_id = new.id;
    if v_total <> v_movement.debit_amount then
      raise exception 'La suma de allocations (%) no coincide con el débito bancario (%).', v_total, v_movement.debit_amount;
    end if;
    new.bank_amount := v_movement.debit_amount;
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  return new;
end;
$$;

create trigger financial_payroll_payment_batches_validate
before insert or update on comercial.financial_payroll_payment_batches
for each row execute function comercial.validate_financial_payroll_payment_batch();

create or replace function comercial.protect_financial_payroll_payment_allocations()
returns trigger
language plpgsql
set search_path = pg_catalog, comercial
as $$
declare
  v_status text;
  v_company_id uuid;
  v_batch_id uuid;
  v_reconcile boolean := current_setting('comercial.payroll_reconciliation_reconcile', true) = 'on';
begin
  if tg_op = 'DELETE' then
    v_company_id := old.company_id;
    v_batch_id := old.batch_id;
  else
    v_company_id := new.company_id;
    v_batch_id := new.batch_id;
  end if;
  select status into v_status
  from comercial.financial_payroll_payment_batches
  where company_id = v_company_id and id = v_batch_id;
  if v_status = 'COMPLETE' and not v_reconcile then
    raise exception 'No se puede modificar allocations de un batch COMPLETE.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger financial_payroll_payment_allocations_protect
before insert or update or delete on comercial.financial_payroll_payment_allocations
for each row execute function comercial.protect_financial_payroll_payment_allocations();

create or replace function comercial.reconcile_financial_payroll_payment_batches(
  p_company_id uuid,
  p_period_year integer,
  p_period_month integer
)
returns jsonb
language plpgsql
set search_path = pg_catalog, comercial
as $$
declare
  v_batch record;
  v_allocation record;
  v_import_exists boolean;
  v_entry_count integer;
  v_net_pay bigint;
  v_entry_id uuid;
  v_matched integer := 0;
  v_pending integer := 0;
  v_difference integer := 0;
  v_not_found integer := 0;
begin
  perform set_config('comercial.payroll_reconciliation_reconcile', 'on', true);
  select exists (
    select 1 from comercial.financial_payroll_imports
    where company_id = p_company_id and period_year = p_period_year and period_month = p_period_month and status = 'IMPORTED'
  ) into v_import_exists;
  for v_batch in
    select id from comercial.financial_payroll_payment_batches
    where company_id = p_company_id and period_year = p_period_year and period_month = p_period_month and status = 'COMPLETE'
  loop
    for v_allocation in
      select id, worker_rut, amount from comercial.financial_payroll_payment_allocations
      where company_id = p_company_id and batch_id = v_batch.id and allocation_type = 'FORMAL'
    loop
      if not v_import_exists then
        update comercial.financial_payroll_payment_allocations set reconciliation_status = 'PENDING_PAYROLL', payroll_entry_id = null where id = v_allocation.id;
        v_pending := v_pending + 1;
      else
        select count(*)::integer, coalesce(sum(e.net_pay), 0)::bigint, (array_agg(e.id order by e.id))[1]
          into v_entry_count, v_net_pay, v_entry_id
        from comercial.financial_payroll_entries e
        join comercial.financial_payroll_imports i on i.company_id = e.company_id and i.id = e.import_id
        where e.company_id = p_company_id and e.worker_rut_normalized = v_allocation.worker_rut
          and i.period_year = p_period_year and i.period_month = p_period_month and i.status = 'IMPORTED';
        if v_entry_count = 0 then
          update comercial.financial_payroll_payment_allocations set reconciliation_status = 'NOT_FOUND_IN_PAYROLL', payroll_entry_id = null where id = v_allocation.id;
          v_not_found := v_not_found + 1;
        elsif v_net_pay = v_allocation.amount then
          update comercial.financial_payroll_payment_allocations set reconciliation_status = 'MATCHED', payroll_entry_id = case when v_entry_count = 1 then v_entry_id else null end where id = v_allocation.id;
          v_matched := v_matched + 1;
        else
          update comercial.financial_payroll_payment_allocations set reconciliation_status = 'AMOUNT_DIFFERENCE', payroll_entry_id = case when v_entry_count = 1 then v_entry_id else null end where id = v_allocation.id;
          v_difference := v_difference + 1;
        end if;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('matched', v_matched, 'pending_payroll', v_pending, 'amount_difference', v_difference, 'not_found', v_not_found);
end;
$$;

create or replace function comercial.create_financial_payroll_payment_batch(
  p_company_id uuid,
  p_bank_movement_id uuid,
  p_period_year integer,
  p_period_month integer,
  p_created_by uuid,
  p_allocations jsonb,
  p_note text default null
)
returns jsonb
language plpgsql
set search_path = pg_catalog, comercial
as $$
declare
  v_movement record;
  v_batch_id uuid;
  v_total bigint;
  v_item jsonb;
  v_rut text;
  v_entry_count integer;
  v_net_pay bigint;
  v_entry_id uuid;
  v_import_exists boolean;
  v_status text;
begin
  select id, transaction_date, debit_amount, direction into v_movement
  from comercial.financial_bank_movements
  where company_id = p_company_id and id = p_bank_movement_id;
  if not found then raise exception 'El movimiento bancario no pertenece a la empresa.'; end if;
  if v_movement.direction <> 'DEBE' or coalesce(v_movement.debit_amount, 0) <= 0 then raise exception 'Sólo se puede conciliar un pago bancario DEBE.'; end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then raise exception 'La nómina debe contener al menos una asignación.'; end if;
  v_total := (select sum((a->>'amount')::bigint) from jsonb_array_elements(p_allocations) a);
  if v_total is null or v_total <> v_movement.debit_amount then raise exception 'La suma asignada (%) no coincide con el débito bancario (%).', v_total, v_movement.debit_amount; end if;
  if exists (select 1 from comercial.financial_payroll_payment_batches where company_id = p_company_id and bank_movement_id = p_bank_movement_id) then raise exception 'Este movimiento ya tiene un batch de nómina.'; end if;
  select exists (select 1 from comercial.financial_payroll_imports where company_id = p_company_id and period_year = p_period_year and period_month = p_period_month and status = 'IMPORTED') into v_import_exists;

  insert into comercial.financial_payroll_payment_batches(company_id, bank_movement_id, period_year, period_month, payment_date, bank_amount, status, note, created_by)
  values (p_company_id, p_bank_movement_id, p_period_year, p_period_month, v_movement.transaction_date, v_movement.debit_amount, 'DRAFT', p_note, p_created_by)
  returning id into v_batch_id;
  for v_item in select * from jsonb_array_elements(p_allocations) loop
    v_rut := comercial.normalize_financial_worker_rut(v_item->>'worker_rut');
    if v_rut is null then raise exception 'El RUT no tiene formato canónico válido.'; end if;
    if v_item->>'allocation_type' not in ('FORMAL', 'OFF_BOOK') then raise exception 'Tipo de asignación inválido.'; end if;
    if v_item->>'allocation_type' = 'OFF_BOOK' then
      v_status := 'NOT_APPLICABLE';
    elsif not v_import_exists then
      v_status := 'PENDING_PAYROLL';
    else
      select count(*)::integer, coalesce(sum(e.net_pay), 0)::bigint, (array_agg(e.id order by e.id))[1]
        into v_entry_count, v_net_pay, v_entry_id
      from comercial.financial_payroll_entries e
      join comercial.financial_payroll_imports i on i.company_id = e.company_id and i.id = e.import_id
      where e.company_id = p_company_id and e.worker_rut_normalized = v_rut
        and i.period_year = p_period_year and i.period_month = p_period_month and i.status = 'IMPORTED';
      if v_entry_count = 0 then v_status := 'NOT_FOUND_IN_PAYROLL';
      elsif v_net_pay = (v_item->>'amount')::bigint then v_status := 'MATCHED';
      else v_status := 'AMOUNT_DIFFERENCE'; end if;
    end if;
    insert into comercial.financial_payroll_payment_allocations(company_id, batch_id, allocation_type, reconciliation_status, payroll_entry_id, worker_rut, worker_name_snapshot, amount, note)
    values (p_company_id, v_batch_id, v_item->>'allocation_type', v_status, case when v_item->>'allocation_type' = 'FORMAL' and v_entry_count = 1 then v_entry_id else null end, v_rut, nullif(v_item->>'worker_name_snapshot', ''), (v_item->>'amount')::bigint, nullif(v_item->>'note', ''));
    v_entry_count := 0;
    v_entry_id := null;
  end loop;
  update comercial.financial_payroll_payment_batches set status = 'COMPLETE', completed_by = p_created_by where id = v_batch_id;
  return jsonb_build_object('batch_id', v_batch_id, 'status', 'COMPLETE', 'bank_amount', v_movement.debit_amount);
exception when others then
  if v_batch_id is not null then delete from comercial.financial_payroll_payment_batches where id = v_batch_id; end if;
  raise;
end;
$$;

create or replace function comercial.reopen_financial_payroll_payment_batch(p_company_id uuid, p_batch_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, comercial
as $$
begin
  perform set_config('comercial.payroll_reconciliation_reopen', 'on', true);
  update comercial.financial_payroll_payment_batches set status = 'DRAFT', completed_at = null, completed_by = null where company_id = p_company_id and id = p_batch_id and status = 'COMPLETE';
  if not found then raise exception 'El batch no existe o no está COMPLETE.'; end if;
  return jsonb_build_object('batch_id', p_batch_id, 'status', 'DRAFT');
end;
$$;

alter table comercial.financial_payroll_payment_batches enable row level security;
alter table comercial.financial_payroll_payment_allocations enable row level security;
revoke all on comercial.financial_payroll_payment_batches, comercial.financial_payroll_payment_allocations from public, anon, authenticated;
grant select, insert, update on comercial.financial_payroll_payment_batches to service_role;
grant select, insert, update on comercial.financial_payroll_payment_allocations to service_role;
revoke all on function comercial.create_financial_payroll_payment_batch(uuid, uuid, integer, integer, uuid, jsonb, text), comercial.reconcile_financial_payroll_payment_batches(uuid, integer, integer), comercial.reopen_financial_payroll_payment_batch(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.create_financial_payroll_payment_batch(uuid, uuid, integer, integer, uuid, jsonb, text), comercial.reconcile_financial_payroll_payment_batches(uuid, integer, integer), comercial.reopen_financial_payroll_payment_batch(uuid, uuid) to service_role;
revoke all on function comercial.normalize_financial_worker_rut(text) from public, anon, authenticated;
grant execute on function comercial.normalize_financial_worker_rut(text) to service_role;
