-- Payroll payments are formal by default. Only explicit OFF_BOOK allocations
-- are persisted as exceptions; the formal remainder is derived from the batch.
alter table comercial.financial_payroll_payment_batches
  add column if not exists formal_expected_amount bigint,
  add column if not exists formal_payroll_amount bigint,
  add column if not exists formal_reconciliation_status text,
  add column if not exists formal_difference bigint;

alter table comercial.financial_payroll_payment_batches
  drop constraint if exists financial_payroll_payment_batches_formal_status_check;

alter table comercial.financial_payroll_payment_batches
  add constraint financial_payroll_payment_batches_formal_status_check
  check (formal_reconciliation_status is null or formal_reconciliation_status in ('PENDING_PAYROLL', 'MATCHED', 'AMOUNT_DIFFERENCE'));

create or replace function comercial.validate_financial_payroll_payment_batch()
returns trigger
language plpgsql
set search_path = pg_catalog, comercial
as $$
declare
  v_movement record;
  v_off_book bigint;
begin
  if tg_op <> 'INSERT' and old.status = 'COMPLETE' and new.status <> 'COMPLETE' then
    raise exception 'Un batch COMPLETE sólo puede reabrirse mediante el flujo controlado.';
  end if;
  select direction, debit_amount into v_movement
  from comercial.financial_bank_movements
  where company_id = new.company_id and id = new.bank_movement_id;
  if not found or v_movement.direction <> 'DEBE' or coalesce(v_movement.debit_amount, 0) <= 0 then
    raise exception 'El batch requiere un movimiento DEBE con débito positivo.';
  end if;
  select coalesce(sum(amount), 0) into v_off_book
  from comercial.financial_payroll_payment_allocations
  where company_id = new.company_id and batch_id = new.id and allocation_type = 'OFF_BOOK';
  if v_off_book > v_movement.debit_amount then
    raise exception 'Las allocations fuera de libro superan el débito bancario.';
  end if;
  new.bank_amount := v_movement.debit_amount;
  new.formal_expected_amount := v_movement.debit_amount - v_off_book;
  if new.status = 'DRAFT' and new.formal_reconciliation_status is null then
    new.formal_reconciliation_status := 'PENDING_PAYROLL';
  end if;
  if new.status = 'COMPLETE' then
    new.completed_at := coalesce(new.completed_at, now());
    if new.formal_reconciliation_status is null then new.formal_reconciliation_status := 'PENDING_PAYROLL'; end if;
  end if;
  return new;
end;
$$;

create or replace function comercial.save_financial_payroll_payment_draft(
  p_company_id uuid,
  p_bank_movement_id uuid,
  p_period_year integer,
  p_period_month integer,
  p_created_by uuid,
  p_allocations jsonb,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, comercial
as $$
declare
  v_movement record;
  v_batch record;
  v_item jsonb;
  v_name text;
  v_rut text;
  v_amount bigint;
  v_total bigint := 0;
  v_existing boolean := false;
begin
  if p_period_year not between 2000 and 2100 or p_period_month not between 1 and 12 then raise exception 'El período económico no es válido.'; end if;
  if jsonb_typeof(p_allocations) <> 'array' then raise exception 'Las allocations deben ser un arreglo.'; end if;
  select id, transaction_date, debit_amount, direction into v_movement
  from comercial.financial_bank_movements where company_id = p_company_id and id = p_bank_movement_id for update;
  if not found or v_movement.direction <> 'DEBE' or coalesce(v_movement.debit_amount, 0) <= 0 then raise exception 'Sólo se puede desglosar un pago bancario DEBE.'; end if;
  select * into v_batch from comercial.financial_payroll_payment_batches where company_id = p_company_id and bank_movement_id = p_bank_movement_id for update;
  if found and v_batch.status = 'COMPLETE' then raise exception 'El desglose ya está COMPLETE.'; end if;
  v_existing := found;

  for v_item in select * from jsonb_array_elements(p_allocations) loop
    if v_item->>'allocation_type' <> 'OFF_BOOK' then raise exception 'El nuevo flujo sólo guarda excepciones fuera de libro.'; end if;
    v_name := nullif(btrim(v_item->>'worker_name_snapshot'), '');
    v_rut := comercial.normalize_financial_worker_rut(nullif(btrim(v_item->>'worker_rut'), ''));
    v_amount := (v_item->>'amount')::bigint;
    if v_name is null then raise exception 'El nombre de cada persona es obligatorio.'; end if;
    if v_amount is null or v_amount <= 0 then raise exception 'Cada allocation debe tener un monto positivo.'; end if;
    v_total := v_total + v_amount;
  end loop;
  if v_total > v_movement.debit_amount then raise exception 'El total fuera de libro no puede superar el débito bancario.'; end if;

  if not v_existing then
    insert into comercial.financial_payroll_payment_batches(company_id, bank_movement_id, period_year, period_month, payment_date, bank_amount, status, note, created_by)
    values (p_company_id, p_bank_movement_id, p_period_year, p_period_month, v_movement.transaction_date, v_movement.debit_amount, 'DRAFT', nullif(btrim(p_note), ''), p_created_by)
    returning * into v_batch;
  else
    update comercial.financial_payroll_payment_batches
    set period_year = p_period_year, period_month = p_period_month, bank_amount = v_movement.debit_amount,
        note = nullif(btrim(p_note), ''), formal_reconciliation_status = 'PENDING_PAYROLL'
    where company_id = p_company_id and id = v_batch.id returning * into v_batch;
  end if;

  delete from comercial.financial_payroll_payment_allocations
  where company_id = p_company_id and batch_id = v_batch.id and allocation_type = 'OFF_BOOK';
  for v_item in select * from jsonb_array_elements(p_allocations) loop
    insert into comercial.financial_payroll_payment_allocations(company_id, batch_id, allocation_type, reconciliation_status, payroll_entry_id, worker_rut, worker_name_snapshot, amount, note)
    values (p_company_id, v_batch.id, 'OFF_BOOK', 'NOT_APPLICABLE', null,
      comercial.normalize_financial_worker_rut(nullif(btrim(v_item->>'worker_rut'), '')),
      nullif(btrim(v_item->>'worker_name_snapshot'), ''), (v_item->>'amount')::bigint, nullif(btrim(v_item->>'note'), ''));
  end loop;
  update comercial.financial_payroll_payment_batches set formal_expected_amount = v_movement.debit_amount - v_total where id = v_batch.id;
  return jsonb_build_object('batch_id', v_batch.id, 'status', 'DRAFT', 'bank_amount', v_movement.debit_amount, 'off_book_amount', v_total, 'formal_expected_amount', v_movement.debit_amount - v_total);
end;
$$;

create or replace function comercial.complete_financial_payroll_payment_batch(
  p_company_id uuid, p_bank_movement_id uuid, p_completed_by uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, comercial as $$
declare v_batch record;
begin
  select * into v_batch from comercial.financial_payroll_payment_batches where company_id = p_company_id and bank_movement_id = p_bank_movement_id for update;
  if not found then raise exception 'Primero guarda el desglose como borrador.'; end if;
  if v_batch.status = 'COMPLETE' then return jsonb_build_object('batch_id', v_batch.id, 'status', 'COMPLETE', 'bank_amount', v_batch.bank_amount); end if;
  update comercial.financial_payroll_payment_batches set status = 'COMPLETE', completed_by = p_completed_by where company_id = p_company_id and id = v_batch.id;
  return jsonb_build_object('batch_id', v_batch.id, 'status', 'COMPLETE', 'bank_amount', v_batch.bank_amount, 'formal_expected_amount', v_batch.formal_expected_amount);
end;
$$;

create or replace function comercial.reconcile_financial_payroll_payment_batches(p_company_id uuid, p_period_year integer, p_period_month integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, comercial as $$
declare v_batch record; v_payroll_total bigint; v_status text; v_difference bigint; v_matched integer := 0; v_pending integer := 0; v_difference_count integer := 0;
begin
  for v_batch in select * from comercial.financial_payroll_payment_batches where company_id = p_company_id and period_year = p_period_year and period_month = p_period_month and status = 'COMPLETE' for update loop
    select coalesce(sum(e.net_pay), 0) into v_payroll_total
    from comercial.financial_payroll_entries e join comercial.financial_payroll_imports i on i.company_id = e.company_id and i.id = e.import_id
    where e.company_id = p_company_id and i.period_year = v_batch.period_year and i.period_month = v_batch.period_month and i.status = 'IMPORTED';
    if not exists (select 1 from comercial.financial_payroll_imports where company_id = p_company_id and period_year = v_batch.period_year and period_month = v_batch.period_month and status = 'IMPORTED') then
      update comercial.financial_payroll_payment_batches set formal_payroll_amount = null, formal_difference = null, formal_reconciliation_status = 'PENDING_PAYROLL' where id = v_batch.id;
      v_pending := v_pending + 1;
    else
      v_difference := v_payroll_total - coalesce(v_batch.formal_expected_amount, v_batch.bank_amount);
      v_status := case when v_difference = 0 then 'MATCHED' else 'AMOUNT_DIFFERENCE' end;
      update comercial.financial_payroll_payment_batches set formal_payroll_amount = v_payroll_total, formal_difference = v_difference, formal_reconciliation_status = v_status where id = v_batch.id;
      if v_status = 'MATCHED' then v_matched := v_matched + 1; else v_difference_count := v_difference_count + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('matched', v_matched, 'pending_payroll', v_pending, 'amount_difference', v_difference_count);
end;
$$;

-- Keep the legacy entry point compatible with the residual model.
create or replace function comercial.create_financial_payroll_payment_batch(
  p_company_id uuid, p_bank_movement_id uuid, p_period_year integer, p_period_month integer,
  p_created_by uuid, p_allocations jsonb, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, comercial as $$
declare v_draft jsonb; v_complete jsonb;
begin
  v_draft := comercial.save_financial_payroll_payment_draft(p_company_id, p_bank_movement_id, p_period_year, p_period_month, p_created_by, p_allocations, p_note);
  v_complete := comercial.complete_financial_payroll_payment_batch(p_company_id, p_bank_movement_id, p_created_by);
  return v_complete || jsonb_build_object('formal_expected_amount', v_draft->'formal_expected_amount');
end;
$$;

update comercial.financial_payroll_payment_batches b
set formal_expected_amount = b.bank_amount - coalesce((select sum(a.amount) from comercial.financial_payroll_payment_allocations a where a.company_id = b.company_id and a.batch_id = b.id and a.allocation_type = 'OFF_BOOK'), 0),
    formal_reconciliation_status = coalesce(b.formal_reconciliation_status, 'PENDING_PAYROLL')
where b.formal_expected_amount is null;
