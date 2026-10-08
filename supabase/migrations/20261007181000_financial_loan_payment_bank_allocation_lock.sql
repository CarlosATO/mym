-- Serialize loan-payment allocations with bank reconciliation allocations.
-- Capital is not an expense link; only interest and fees consume this allocation.

create or replace function comercial.create_financial_loan_payment(
  p_company_id uuid, p_loan_id uuid, p_payment_date date, p_total_amount numeric,
  p_principal_amount numeric, p_interest_amount numeric, p_fee_amount numeric,
  p_notes text, p_metadata jsonb, p_idempotency_key text, p_actor uuid, p_bank_movement_id uuid default null
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare
  v_id uuid;
  v_interest_id uuid;
  v_fee_id uuid;
  v_original numeric;
  v_paid numeric;
  v_interest_category_id uuid;
  v_bank_amount numeric;
  v_linked_amount numeric;
begin
  select id into v_id from comercial.financial_loan_payments where company_id = p_company_id and idempotency_key = btrim(p_idempotency_key);
  if v_id is not null then return v_id; end if;
  if p_total_amount <= 0 or p_principal_amount < 0 or p_interest_amount < 0 or p_fee_amount < 0 or p_principal_amount + p_interest_amount + p_fee_amount <> p_total_amount then raise exception 'Los componentes de la cuota deben ser no negativos y sumar el total.'; end if;
  select original_principal into v_original from comercial.financial_loans where company_id = p_company_id and id = p_loan_id and status = 'ACTIVE' for update;
  if v_original is null then raise exception 'El préstamo no pertenece a la empresa activa o no está activo.'; end if;

  -- Keep the movement lock until all loan links have been inserted.
  if p_bank_movement_id is not null then
    select m.debit_amount into v_bank_amount
    from comercial.financial_bank_movements m
    where m.company_id = p_company_id and m.id = p_bank_movement_id and m.direction = 'DEBE'
    for update;
    if not found or coalesce(v_bank_amount, 0) < p_total_amount then
      raise exception 'El movimiento bancario no pertenece a la empresa, no es DEBE o no cubre la cuota.';
    end if;

    select coalesce(sum(l.allocated_amount), 0)
      into v_linked_amount
    from comercial.financial_expense_bank_links l
    where l.company_id = p_company_id and l.bank_movement_id = p_bank_movement_id;
    if v_linked_amount + p_interest_amount + p_fee_amount > v_bank_amount then
      raise exception 'Las asignaciones exceden el monto DEBE disponible.';
    end if;
  end if;

  select coalesce(sum(principal_amount), 0) into v_paid from comercial.financial_loan_payments where company_id = p_company_id and loan_id = p_loan_id and status = 'POSTED';
  if p_principal_amount > v_original - v_paid then raise exception 'El capital de la cuota excede el saldo principal pendiente.'; end if;
  if p_interest_amount + p_fee_amount > 0 then
    select id into v_interest_category_id from comercial.financial_categories
    where company_id = p_company_id and code = 'EXPENSE_FINANCIAL_INTEREST' and is_active limit 1;
    if v_interest_category_id is null then raise exception 'La categoría de intereses financieros no está disponible para la empresa activa.'; end if;
  end if;
  insert into comercial.financial_loan_payments(company_id, loan_id, payment_date, total_amount, principal_amount, interest_amount, fee_amount, bank_movement_id, notes, metadata, idempotency_key, created_by)
  values (p_company_id, p_loan_id, p_payment_date, p_total_amount, p_principal_amount, p_interest_amount, p_fee_amount, p_bank_movement_id, nullif(btrim(p_notes), ''), coalesce(p_metadata, '{}'::jsonb), btrim(p_idempotency_key), p_actor)
  returning id into v_id;
  if p_interest_amount > 0 then
    insert into comercial.financial_expense_entries(company_id, period_year, period_month, category_id, recognized_amount, currency, description, document_date, source_type, source_reference, notes, metadata, idempotency_key, created_by, status, posted_by, posted_at)
    select p_company_id, extract(year from p_payment_date)::integer, extract(month from p_payment_date)::integer, c.id, p_interest_amount, 'CLP', 'Interés de préstamo', p_payment_date, 'LOAN', 'loan_payment:' || v_id::text, p_notes, coalesce(p_metadata, '{}'::jsonb), 'loan_payment:' || v_id::text || ':interest', p_actor, 'POSTED', p_actor, now()
    from comercial.financial_categories c where c.company_id = p_company_id and c.code = 'EXPENSE_FINANCIAL_INTEREST' and c.is_active limit 1 returning id into v_interest_id;
    if p_bank_movement_id is not null then
      insert into comercial.financial_expense_bank_links(company_id, expense_entry_id, bank_movement_id, allocated_amount, created_by)
      values (p_company_id, v_interest_id, p_bank_movement_id, p_interest_amount, p_actor);
      insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by)
      select 'financial_expense_bank_links', l.id, 'BANK_LINK', to_jsonb(l), p_actor
      from comercial.financial_expense_bank_links l
      where l.company_id = p_company_id and l.expense_entry_id = v_interest_id and l.bank_movement_id = p_bank_movement_id;
    end if;
  end if;
  if p_fee_amount > 0 then
    insert into comercial.financial_expense_entries(company_id, period_year, period_month, category_id, recognized_amount, currency, description, document_date, source_type, source_reference, notes, metadata, idempotency_key, created_by, status, posted_by, posted_at)
    select p_company_id, extract(year from p_payment_date)::integer, extract(month from p_payment_date)::integer, c.id, p_fee_amount, 'CLP', 'Comisión o gasto financiero de préstamo', p_payment_date, 'LOAN', 'loan_payment:' || v_id::text, p_notes, coalesce(p_metadata, '{}'::jsonb), 'loan_payment:' || v_id::text || ':fee', p_actor, 'POSTED', p_actor, now()
    from comercial.financial_categories c where c.company_id = p_company_id and c.code = 'EXPENSE_FINANCIAL_INTEREST' and c.is_active limit 1 returning id into v_fee_id;
    if p_bank_movement_id is not null then
      insert into comercial.financial_expense_bank_links(company_id, expense_entry_id, bank_movement_id, allocated_amount, created_by)
      values (p_company_id, v_fee_id, p_bank_movement_id, p_fee_amount, p_actor);
      insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by)
      select 'financial_expense_bank_links', l.id, 'BANK_LINK', to_jsonb(l), p_actor
      from comercial.financial_expense_bank_links l
      where l.company_id = p_company_id and l.expense_entry_id = v_fee_id and l.bank_movement_id = p_bank_movement_id;
    end if;
  end if;
  update comercial.financial_loans set status = case when p_principal_amount >= v_original - v_paid then 'PAID' else 'ACTIVE' end where company_id = p_company_id and id = p_loan_id;
  insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  select 'financial_loan_payments', v_id, 'CREATE', jsonb_build_object('payment', to_jsonb(p), 'interest_expense_id', v_interest_id, 'fee_expense_id', v_fee_id), p_actor from comercial.financial_loan_payments p where p.company_id = p_company_id and p.id = v_id;
  return v_id;
end;
$$;

revoke all on function comercial.create_financial_loan_payment(uuid, uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.create_financial_loan_payment(uuid, uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid, uuid) to service_role;
