-- Persist editable payroll payment drafts without changing the EERR contract.
alter table comercial.financial_payroll_payment_allocations
  alter column worker_rut drop not null;

alter table comercial.financial_payroll_payment_allocations
  drop constraint financial_payroll_payment_allocations_check;

alter table comercial.financial_payroll_payment_allocations
  add constraint financial_payroll_payment_allocations_check
  check ((allocation_type = 'FORMAL' and worker_rut is not null and reconciliation_status <> 'NOT_APPLICABLE')
      or (allocation_type = 'OFF_BOOK' and reconciliation_status = 'NOT_APPLICABLE' and payroll_entry_id is null));

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
  v_type text;
  v_rut text;
  v_name text;
  v_amount bigint;
  v_total bigint := 0;
  v_existing boolean := false;
begin
  if p_period_year not between 2000 and 2100 or p_period_month not between 1 and 12 then
    raise exception 'El período económico no es válido.';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'Las allocations deben ser un arreglo.';
  end if;

  select id, transaction_date, debit_amount, direction into v_movement
  from comercial.financial_bank_movements
  where company_id = p_company_id and id = p_bank_movement_id
  for update;
  if not found or v_movement.direction <> 'DEBE' or coalesce(v_movement.debit_amount, 0) <= 0 then
    raise exception 'Sólo se puede desglosar un pago bancario DEBE.';
  end if;

  select * into v_batch
  from comercial.financial_payroll_payment_batches
  where company_id = p_company_id and bank_movement_id = p_bank_movement_id
  for update;
  if found and v_batch.status = 'COMPLETE' then
    raise exception 'El desglose ya está COMPLETE.';
  end if;
  v_existing := found;

  for v_item in select * from jsonb_array_elements(p_allocations) loop
    v_type := v_item->>'allocation_type';
    v_name := nullif(btrim(v_item->>'worker_name_snapshot'), '');
    v_amount := (v_item->>'amount')::bigint;
    v_rut := case when v_type = 'FORMAL' then comercial.normalize_financial_worker_rut(v_item->>'worker_rut') else null end;
    if v_type not in ('FORMAL', 'OFF_BOOK') then raise exception 'Tipo de allocation inválido.'; end if;
    if v_name is null then raise exception 'El nombre de cada persona es obligatorio.'; end if;
    if v_amount is null or v_amount <= 0 then raise exception 'Cada allocation debe tener un monto positivo.'; end if;
    if v_type = 'FORMAL' and v_rut is null then raise exception 'El RUT es obligatorio para una persona En libro.'; end if;
    v_total := v_total + v_amount;
  end loop;
  if v_total > v_movement.debit_amount then
    raise exception 'El total asignado no puede superar el débito bancario.';
  end if;

  if not v_existing then
    insert into comercial.financial_payroll_payment_batches(
      company_id, bank_movement_id, period_year, period_month, payment_date, bank_amount, status, note, created_by
    ) values (
      p_company_id, p_bank_movement_id, p_period_year, p_period_month, v_movement.transaction_date,
      v_movement.debit_amount, 'DRAFT', nullif(btrim(p_note), ''), p_created_by
    ) returning * into v_batch;
  else
    update comercial.financial_payroll_payment_batches
    set period_year = p_period_year, period_month = p_period_month,
        bank_amount = v_movement.debit_amount, note = nullif(btrim(p_note), '')
    where company_id = p_company_id and id = v_batch.id
    returning * into v_batch;
  end if;

  delete from comercial.financial_payroll_payment_allocations
  where company_id = p_company_id and batch_id = v_batch.id;

  for v_item in select * from jsonb_array_elements(p_allocations) loop
    v_type := v_item->>'allocation_type';
    v_rut := case when v_type = 'FORMAL' then comercial.normalize_financial_worker_rut(v_item->>'worker_rut') else null end;
    insert into comercial.financial_payroll_payment_allocations(
      company_id, batch_id, allocation_type, reconciliation_status, payroll_entry_id,
      worker_rut, worker_name_snapshot, amount, note
    ) values (
      p_company_id, v_batch.id, v_type,
      case when v_type = 'OFF_BOOK' then 'NOT_APPLICABLE' else 'PENDING_PAYROLL' end,
      null, v_rut, nullif(btrim(v_item->>'worker_name_snapshot'), ''),
      (v_item->>'amount')::bigint, nullif(btrim(v_item->>'note'), '')
    );
  end loop;

  return jsonb_build_object('batch_id', v_batch.id, 'status', 'DRAFT', 'bank_amount', v_movement.debit_amount, 'assigned_amount', v_total);
end;
$$;

create or replace function comercial.get_financial_payroll_payment_draft(
  p_company_id uuid,
  p_bank_movement_id uuid
) returns jsonb
language sql
security definer
set search_path = pg_catalog, comercial
as $$
  select coalesce(
    (select jsonb_build_object(
      'batch', to_jsonb(b),
      'allocations', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at, a.id) from comercial.financial_payroll_payment_allocations a where a.company_id = b.company_id and a.batch_id = b.id), '[]'::jsonb)
    ) from comercial.financial_payroll_payment_batches b where b.company_id = p_company_id and b.bank_movement_id = p_bank_movement_id),
    '{}'::jsonb
  );
$$;

create or replace function comercial.complete_financial_payroll_payment_batch(
  p_company_id uuid,
  p_bank_movement_id uuid,
  p_completed_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, comercial
as $$
declare
  v_batch record;
begin
  select * into v_batch
  from comercial.financial_payroll_payment_batches
  where company_id = p_company_id and bank_movement_id = p_bank_movement_id
  for update;
  if not found then raise exception 'Primero guarda el desglose como borrador.'; end if;
  if v_batch.status = 'COMPLETE' then
    return jsonb_build_object('batch_id', v_batch.id, 'status', 'COMPLETE', 'bank_amount', v_batch.bank_amount);
  end if;
  update comercial.financial_payroll_payment_batches
  set status = 'COMPLETE', completed_by = p_completed_by
  where company_id = p_company_id and id = v_batch.id;
  return jsonb_build_object('batch_id', v_batch.id, 'status', 'COMPLETE', 'bank_amount', v_batch.bank_amount);
end;
$$;

revoke all on function comercial.save_financial_payroll_payment_draft(uuid, uuid, integer, integer, uuid, jsonb, text), comercial.get_financial_payroll_payment_draft(uuid, uuid), comercial.complete_financial_payroll_payment_batch(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.save_financial_payroll_payment_draft(uuid, uuid, integer, integer, uuid, jsonb, text), comercial.get_financial_payroll_payment_draft(uuid, uuid), comercial.complete_financial_payroll_payment_batch(uuid, uuid, uuid) to service_role;
