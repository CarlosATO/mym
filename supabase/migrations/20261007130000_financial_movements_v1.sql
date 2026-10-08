-- Financial Movements V1: recognized expenses, petty cash and loans.
-- This migration is intentionally additive and is not applied by this change.

alter table comercial.financial_expense_entries
  drop constraint if exists financial_expense_entries_source_type_check;
alter table comercial.financial_expense_entries
  add constraint financial_expense_entries_source_type_check
  check (source_type in ('MANUAL', 'BANK_LINKED', 'IMPORT', 'PETTY_CASH', 'LOAN'));

alter table comercial.financial_bank_movements
  add constraint financial_bank_movements_company_id_id_unique unique (company_id, id);

create or replace function comercial.financial_expense_recognition_allowed_codes()
returns text[] language sql immutable as $$
  select array[
    'EXPENSE_SOFTWARE_SUBSCRIPTIONS',
    'EXPENSE_OFFICE_CONSUMPTION',
    'EXPENSE_VEHICLE_OPERATING',
    'EXPENSE_NOTARY',
    'EXPENSE_EXTERNAL_SERVICES',
    'EXPENSE_INSURANCE',
    'EXPENSE_TELECOM',
    'EXPENSE_OTHER'
  ]::text[];
$$;

create or replace function comercial.financial_cash_expense_allowed_codes()
returns text[] language sql immutable as $$
  select comercial.financial_expense_recognition_allowed_codes();
$$;

create or replace function comercial.validate_financial_cash_expense_category(
  p_company_id uuid, p_category_id uuid
) returns void language plpgsql security definer
set search_path = pg_catalog, comercial as $$
begin
  if not exists (
    select 1 from comercial.financial_categories c
    where c.company_id = p_company_id
      and c.id = p_category_id
      and c.is_active
      and c.code = any(comercial.financial_cash_expense_allowed_codes())
      and c.direction in ('EXPENSE', 'BOTH')
      and not exists (
        select 1 from comercial.financial_categories child
        where child.company_id = c.company_id
          and child.parent_id = c.id
          and child.is_active
      )
  ) then
    raise exception 'La categoría no está habilitada para gastos de caja chica.';
  end if;
end;
$$;

create table comercial.financial_cash_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  name text not null check (btrim(name) <> ''),
  currency text not null default 'CLP' check (currency = 'CLP'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (company_id, id),
  unique (company_id, name)
);

create table comercial.financial_cash_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  cash_account_id uuid not null,
  movement_date date not null,
  movement_type text not null check (movement_type in ('FUNDING', 'EXPENSE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT')),
  amount numeric(20, 0) not null check (amount > 0),
  description text not null check (btrim(description) <> ''),
  counterparty_name text,
  category_id uuid,
  expense_entry_id uuid,
  bank_movement_id uuid,
  source_reference text,
  status text not null default 'POSTED' check (status in ('POSTED', 'VOIDED')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  voided_by uuid references auth.users(id),
  voided_at timestamptz,
  void_reason text,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, cash_account_id) references comercial.financial_cash_accounts(company_id, id),
  foreign key (company_id, category_id) references comercial.financial_categories(company_id, id),
  foreign key (company_id, expense_entry_id) references comercial.financial_expense_entries(company_id, id),
  foreign key (company_id, bank_movement_id) references comercial.financial_bank_movements(company_id, id),
  check ((status = 'VOIDED' and btrim(coalesce(void_reason, '')) <> '' and voided_by is not null and voided_at is not null) or status <> 'VOIDED')
);

create index financial_cash_movements_company_account_date_idx
  on comercial.financial_cash_movements(company_id, cash_account_id, movement_date desc);

create table comercial.financial_loans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  lender_name text not null check (btrim(lender_name) <> ''),
  loan_name text not null check (btrim(loan_name) <> ''),
  original_principal numeric(20, 0) not null check (original_principal > 0),
  currency text not null default 'CLP' check (currency = 'CLP'),
  disbursement_date date not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAID', 'VOIDED')),
  contract_reference text,
  notes text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  unique (company_id, id),
  unique (company_id, idempotency_key)
);

create table comercial.financial_loan_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  loan_id uuid not null,
  payment_date date not null,
  total_amount numeric(20, 0) not null check (total_amount > 0),
  principal_amount numeric(20, 0) not null default 0 check (principal_amount >= 0),
  interest_amount numeric(20, 0) not null default 0 check (interest_amount >= 0),
  fee_amount numeric(20, 0) not null default 0 check (fee_amount >= 0),
  bank_movement_id uuid,
  notes text,
  status text not null default 'POSTED' check (status in ('POSTED', 'VOIDED')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  voided_by uuid references auth.users(id),
  voided_at timestamptz,
  void_reason text,
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, loan_id) references comercial.financial_loans(company_id, id),
  foreign key (company_id, bank_movement_id) references comercial.financial_bank_movements(company_id, id),
  check (principal_amount + interest_amount + fee_amount = total_amount),
  check ((status = 'VOIDED' and btrim(coalesce(void_reason, '')) <> '' and voided_by is not null and voided_at is not null) or status <> 'VOIDED')
);

create index financial_loans_company_status_idx on comercial.financial_loans(company_id, status, created_at desc);
create index financial_loan_payments_company_loan_date_idx on comercial.financial_loan_payments(company_id, loan_id, payment_date desc);
create unique index financial_loan_payments_company_bank_posted_uidx
  on comercial.financial_loan_payments(company_id, bank_movement_id)
  where bank_movement_id is not null and status = 'POSTED';

create or replace function comercial.set_financial_loan_updated_at()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger financial_loans_updated_at
before update on comercial.financial_loans
for each row execute function comercial.set_financial_loan_updated_at();

-- Seed only the account definition, never a movement or a real loan.
insert into comercial.financial_cash_accounts(company_id, name, currency, status, created_by)
values ('d1000000-0000-0000-0000-000000000001', 'Caja Chica Caylo', 'CLP', 'ACTIVE', null)
on conflict (company_id, name) do nothing;

create or replace function comercial.create_financial_cash_funding(
  p_company_id uuid, p_cash_account_id uuid, p_movement_date date, p_amount numeric,
  p_description text, p_source_reference text, p_notes text, p_metadata jsonb,
  p_idempotency_key text, p_actor uuid, p_bank_movement_id uuid default null
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_id uuid;
begin
  select id into v_id from comercial.financial_cash_movements
  where company_id = p_company_id and idempotency_key = btrim(p_idempotency_key);
  if v_id is not null then return v_id; end if;
  if p_amount <= 0 then raise exception 'El monto debe ser mayor que cero.'; end if;
  if not exists (select 1 from comercial.financial_cash_accounts where company_id = p_company_id and id = p_cash_account_id and status = 'ACTIVE') then raise exception 'La cuenta de caja chica no pertenece a la empresa activa o está inactiva.'; end if;
  if p_bank_movement_id is not null and not exists (
    select 1 from comercial.financial_bank_movements
    where company_id = p_company_id and id = p_bank_movement_id and direction = 'DEBE' and debit_amount >= p_amount
  ) then raise exception 'El movimiento bancario no pertenece a la empresa, no es DEBE o no cubre el funding.'; end if;
  insert into comercial.financial_cash_movements(company_id, cash_account_id, movement_date, movement_type, amount, description, bank_movement_id, source_reference, metadata, idempotency_key, created_by)
  values (p_company_id, p_cash_account_id, p_movement_date, 'FUNDING', p_amount, btrim(p_description), p_bank_movement_id, nullif(btrim(p_source_reference), ''), coalesce(p_metadata, '{}'::jsonb), btrim(p_idempotency_key), p_actor)
  returning id into v_id;
  insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  select 'financial_cash_movements', v_id, 'FUNDING', to_jsonb(m), p_actor
  from comercial.financial_cash_movements m where m.company_id = p_company_id and m.id = v_id;
  return v_id;
end;
$$;

create or replace function comercial.create_financial_cash_expense(
  p_company_id uuid, p_cash_account_id uuid, p_movement_date date, p_amount numeric,
  p_category_id uuid, p_counterparty_name text, p_description text, p_document_number text,
  p_notes text, p_metadata jsonb, p_idempotency_key text, p_actor uuid
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_id uuid; v_expense_id uuid; v_balance numeric; v_account_id uuid;
begin
  select id into v_id from comercial.financial_cash_movements
  where company_id = p_company_id and idempotency_key = btrim(p_idempotency_key);
  if v_id is not null then return v_id; end if;
  if p_amount <= 0 then raise exception 'El monto debe ser mayor que cero.'; end if;
  perform comercial.validate_financial_cash_expense_category(p_company_id, p_category_id);
  select id into v_account_id from comercial.financial_cash_accounts
  where company_id = p_company_id and id = p_cash_account_id and status = 'ACTIVE' for update;
  if v_account_id is null then raise exception 'La cuenta de caja chica no pertenece a la empresa activa o está inactiva.'; end if;
  select coalesce(sum(case when movement_type in ('FUNDING', 'ADJUSTMENT_IN') then amount else -amount end), 0)
  into v_balance
  from comercial.financial_cash_movements
  where company_id = p_company_id and cash_account_id = p_cash_account_id and status = 'POSTED';
  if v_balance < p_amount then raise exception 'El gasto excede el saldo disponible de caja chica.'; end if;
  insert into comercial.financial_cash_movements(company_id, cash_account_id, movement_date, movement_type, amount, description, counterparty_name, category_id, source_reference, metadata, idempotency_key, created_by)
  values (p_company_id, p_cash_account_id, p_movement_date, 'EXPENSE', p_amount, btrim(p_description), nullif(btrim(p_counterparty_name), ''), p_category_id, null, coalesce(p_metadata, '{}'::jsonb), btrim(p_idempotency_key), p_actor)
  returning id into v_id;
  insert into comercial.financial_expense_entries(company_id, period_year, period_month, category_id, recognized_amount, currency, description, counterparty_name, document_date, document_number, source_type, source_reference, notes, metadata, idempotency_key, created_by, status, posted_by, posted_at)
  values (p_company_id, extract(year from p_movement_date)::integer, extract(month from p_movement_date)::integer, p_category_id, p_amount, 'CLP', btrim(p_description), nullif(btrim(p_counterparty_name), ''), p_movement_date, nullif(btrim(p_document_number), ''), 'PETTY_CASH', 'petty_cash:' || v_id::text, nullif(btrim(p_notes), ''), coalesce(p_metadata, '{}'::jsonb), 'petty_cash:' || p_idempotency_key, p_actor, 'POSTED', p_actor, now())
  returning id into v_expense_id;
  update comercial.financial_cash_movements set expense_entry_id = v_expense_id, source_reference = 'petty_cash:' || v_id::text where company_id = p_company_id and id = v_id;
  insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  select 'financial_cash_movements', v_id, 'EXPENSE', jsonb_build_object('movement', to_jsonb(m), 'expense_entry_id', v_expense_id), p_actor
  from comercial.financial_cash_movements m where m.company_id = p_company_id and m.id = v_id;
  return v_id;
end;
$$;

create or replace function comercial.create_financial_loan(
  p_company_id uuid, p_lender_name text, p_loan_name text, p_original_principal numeric,
  p_disbursement_date date, p_contract_reference text, p_notes text, p_metadata jsonb, p_idempotency_key text, p_actor uuid
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_id uuid;
begin
  select id into v_id from comercial.financial_loans where company_id = p_company_id and idempotency_key = btrim(p_idempotency_key);
  if v_id is not null then return v_id; end if;
  if p_original_principal <= 0 then raise exception 'El principal original debe ser mayor que cero.'; end if;
  insert into comercial.financial_loans(company_id, lender_name, loan_name, original_principal, disbursement_date, contract_reference, notes, metadata, idempotency_key, created_by)
  values (p_company_id, btrim(p_lender_name), btrim(p_loan_name), p_original_principal, p_disbursement_date, nullif(btrim(p_contract_reference), ''), nullif(btrim(p_notes), ''), coalesce(p_metadata, '{}'::jsonb), btrim(p_idempotency_key), p_actor)
  returning id into v_id;
  insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  select 'financial_loans', v_id, 'CREATE', to_jsonb(l), p_actor from comercial.financial_loans l where l.company_id = p_company_id and l.id = v_id;
  return v_id;
end;
$$;

create or replace function comercial.create_financial_loan_payment(
  p_company_id uuid, p_loan_id uuid, p_payment_date date, p_total_amount numeric,
  p_principal_amount numeric, p_interest_amount numeric, p_fee_amount numeric,
  p_notes text, p_metadata jsonb, p_idempotency_key text, p_actor uuid, p_bank_movement_id uuid default null
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_id uuid; v_interest_id uuid; v_fee_id uuid; v_original numeric; v_paid numeric; v_interest_category_id uuid;
begin
  select id into v_id from comercial.financial_loan_payments where company_id = p_company_id and idempotency_key = btrim(p_idempotency_key);
  if v_id is not null then return v_id; end if;
  if p_total_amount <= 0 or p_principal_amount < 0 or p_interest_amount < 0 or p_fee_amount < 0 or p_principal_amount + p_interest_amount + p_fee_amount <> p_total_amount then raise exception 'Los componentes de la cuota deben ser no negativos y sumar el total.'; end if;
  select original_principal into v_original from comercial.financial_loans where company_id = p_company_id and id = p_loan_id and status = 'ACTIVE' for update;
  if v_original is null then raise exception 'El préstamo no pertenece a la empresa activa o no está activo.'; end if;
  if p_bank_movement_id is not null and not exists (
    select 1 from comercial.financial_bank_movements
    where company_id = p_company_id and id = p_bank_movement_id and direction = 'DEBE' and debit_amount >= p_total_amount
  ) then raise exception 'El movimiento bancario no pertenece a la empresa, no es DEBE o no cubre la cuota.'; end if;
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

create or replace function comercial.void_financial_cash_movement(
  p_company_id uuid, p_movement_id uuid, p_reason text, p_actor uuid
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_movement jsonb; v_expense jsonb; v_expense_id uuid;
begin
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'El motivo de anulación es obligatorio.'; end if;
  select to_jsonb(m), m.expense_entry_id into v_movement, v_expense_id
  from comercial.financial_cash_movements m
  where m.company_id = p_company_id and m.id = p_movement_id and m.status = 'POSTED'
  for update;
  if v_movement is null then raise exception 'El movimiento no existe o ya está anulado.'; end if;
  if v_movement->>'movement_type' <> 'EXPENSE' then raise exception 'V1 sólo permite anular gastos de caja chica.'; end if;
  if v_expense_id is null then raise exception 'El gasto de caja no tiene partida reconocida asociada.'; end if;
  select to_jsonb(e) into v_expense from comercial.financial_expense_entries e
  where e.company_id = p_company_id and e.id = v_expense_id and e.status = 'POSTED' for update;
  if v_expense is null then raise exception 'La partida asociada no existe o no está POSTED.'; end if;
  update comercial.financial_cash_movements
  set status = 'VOIDED', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason)
  where company_id = p_company_id and id = p_movement_id;
  update comercial.financial_expense_entries
  set status = 'VOIDED', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason)
  where company_id = p_company_id and id = v_expense_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  values ('financial_cash_movements', p_movement_id, 'VOID', v_movement, (select to_jsonb(m) from comercial.financial_cash_movements m where m.company_id = p_company_id and m.id = p_movement_id), p_actor);
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  values ('financial_expense_entries', v_expense_id, 'VOID', v_expense, (select to_jsonb(e) from comercial.financial_expense_entries e where e.company_id = p_company_id and e.id = v_expense_id), p_actor);
  return p_movement_id;
end;
$$;

create or replace function comercial.void_financial_loan_payment(
  p_company_id uuid, p_payment_id uuid, p_reason text, p_actor uuid
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_payment jsonb; v_loan_id uuid; v_original numeric; v_paid numeric; v_expense_id uuid; v_expense_before jsonb;
begin
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'El motivo de anulación es obligatorio.'; end if;
  select to_jsonb(p), p.loan_id into v_payment, v_loan_id
  from comercial.financial_loan_payments p
  where p.company_id = p_company_id and p.id = p_payment_id and p.status = 'POSTED'
  for update;
  if v_payment is null then raise exception 'La cuota no existe o ya está anulada.'; end if;
  select original_principal into v_original from comercial.financial_loans where company_id = p_company_id and id = v_loan_id for update;
  if v_original is null then raise exception 'El préstamo no pertenece a la empresa activa.'; end if;
  update comercial.financial_loan_payments
  set status = 'VOIDED', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason)
  where company_id = p_company_id and id = p_payment_id;
  for v_expense_id, v_expense_before in
    select e.id, to_jsonb(e) from comercial.financial_expense_entries e
    where e.company_id = p_company_id and e.source_type = 'LOAN' and e.source_reference = 'loan_payment:' || p_payment_id::text and e.status = 'POSTED'
    for update
  loop
    update comercial.financial_expense_entries
    set status = 'VOIDED', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason)
    where company_id = p_company_id and id = v_expense_id;
    insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
    values ('financial_expense_entries', v_expense_id, 'VOID', v_expense_before, (select to_jsonb(e) from comercial.financial_expense_entries e where e.company_id = p_company_id and e.id = v_expense_id), p_actor);
  end loop;
  select coalesce(sum(principal_amount), 0) into v_paid from comercial.financial_loan_payments
  where company_id = p_company_id and loan_id = v_loan_id and status = 'POSTED';
  update comercial.financial_loans set status = case when v_paid >= v_original then 'PAID' else 'ACTIVE' end
  where company_id = p_company_id and id = v_loan_id and status <> 'VOIDED';
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  values ('financial_loan_payments', p_payment_id, 'VOID', v_payment, (select to_jsonb(p) from comercial.financial_loan_payments p where p.company_id = p_company_id and p.id = p_payment_id), p_actor);
  return p_payment_id;
end;
$$;

create or replace function comercial.void_financial_loan(
  p_company_id uuid, p_loan_id uuid, p_reason text, p_actor uuid
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_before jsonb;
begin
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'El motivo de anulación es obligatorio.'; end if;
  select to_jsonb(l) into v_before from comercial.financial_loans l
  where l.company_id = p_company_id and l.id = p_loan_id and l.status <> 'VOIDED' for update;
  if v_before is null then raise exception 'El préstamo no existe o ya está anulado.'; end if;
  if exists (select 1 from comercial.financial_loan_payments where company_id = p_company_id and loan_id = p_loan_id and status = 'POSTED') then raise exception 'No se puede anular un préstamo con cuotas POSTED.'; end if;
  update comercial.financial_loans set status = 'VOIDED', notes = concat_ws(E'\n', notes, 'Anulado: ' || btrim(p_reason)) where company_id = p_company_id and id = p_loan_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  values ('financial_loans', p_loan_id, 'VOID', v_before, (select to_jsonb(l) from comercial.financial_loans l where l.company_id = p_company_id and l.id = p_loan_id), p_actor);
  return p_loan_id;
end;
$$;

alter table comercial.financial_cash_accounts enable row level security;
alter table comercial.financial_cash_movements enable row level security;
alter table comercial.financial_loans enable row level security;
alter table comercial.financial_loan_payments enable row level security;
revoke all on table comercial.financial_cash_accounts, comercial.financial_cash_movements, comercial.financial_loans, comercial.financial_loan_payments from public, anon, authenticated, service_role;
grant select on table comercial.financial_cash_accounts, comercial.financial_cash_movements, comercial.financial_loans, comercial.financial_loan_payments to service_role;
revoke all on function comercial.create_financial_cash_funding(uuid, uuid, date, numeric, text, text, text, jsonb, text, uuid, uuid), comercial.create_financial_cash_expense(uuid, uuid, date, numeric, uuid, text, text, text, text, jsonb, text, uuid), comercial.create_financial_loan(uuid, text, text, numeric, date, text, text, jsonb, text, uuid), comercial.create_financial_loan_payment(uuid, uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid, uuid), comercial.void_financial_cash_movement(uuid, uuid, text, uuid), comercial.void_financial_loan_payment(uuid, uuid, text, uuid), comercial.void_financial_loan(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.create_financial_cash_funding(uuid, uuid, date, numeric, text, text, text, jsonb, text, uuid, uuid), comercial.create_financial_cash_expense(uuid, uuid, date, numeric, uuid, text, text, text, text, jsonb, text, uuid), comercial.create_financial_loan(uuid, text, text, numeric, date, text, text, jsonb, text, uuid), comercial.create_financial_loan_payment(uuid, uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid, uuid), comercial.void_financial_cash_movement(uuid, uuid, text, uuid), comercial.void_financial_loan_payment(uuid, uuid, text, uuid), comercial.void_financial_loan(uuid, uuid, text, uuid) to service_role;

insert into portal.permissions(code, name, description, module_id)
select v.code, v.name, v.description, m.id
from portal.modules m
cross join (values
  ('analisis_comercial.control_financiero.manage_cash', 'Gestionar Caja Chica', 'Permite registrar fondos y gastos de caja chica.'),
  ('analisis_comercial.control_financiero.manage_loans', 'Gestionar Préstamos', 'Permite registrar préstamos y cuotas financieras.')
) v(code, name, description)
where m.code in ('analisis_comercial', 'analisis-comercial')
on conflict (code) do update set name = excluded.name, description = excluded.description, module_id = excluded.module_id;

insert into portal.role_permissions(role_id, permission_id)
select r.id, p.id from portal.roles r cross join portal.permissions p
where r.name in ('FINANZAS', 'GERENCIA', 'SUPER_USUARIO')
  and p.code in ('analisis_comercial.control_financiero.manage_cash', 'analisis_comercial.control_financiero.manage_loans')
on conflict do nothing;

insert into portal.permissions(code, name, description, module_id)
select 'analisis_comercial.control_financiero.view', 'Ver Control Financiero', 'Acceso de lectura a Movimientos Financieros.', m.id
from portal.modules m where m.code in ('analisis-comercial', 'analisis_comercial')
on conflict (code) do update set name = excluded.name, description = excluded.description, module_id = excluded.module_id;

insert into portal.role_permissions(role_id, permission_id)
select r.id, p.id from portal.roles r cross join portal.permissions p
where r.name in ('FINANZAS', 'GERENCIA', 'SUPER_USUARIO')
  and p.code = 'analisis_comercial.control_financiero.view'
on conflict do nothing;
