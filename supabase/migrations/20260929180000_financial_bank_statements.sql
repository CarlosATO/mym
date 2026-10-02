-- Closed bank statement imports. These tables are deliberately separate from
-- the income statement model: a bank movement is not a P&L transaction.
create table if not exists comercial.financial_bank_accounts (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references core.companies(id) on delete restrict,
    bank_name text not null,
    account_type text not null default 'CHECKING',
    account_number text not null,
    currency text not null default 'CLP',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    unique (company_id, id),
    unique (company_id, account_number)
);

create table if not exists comercial.financial_imports (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references core.companies(id) on delete restrict,
    source_type text not null check (source_type = 'BANK_STATEMENT_CLOSED'),
    original_filename text not null,
    file_hash text not null,
    period_year integer not null,
    period_month integer not null check (period_month between 1 and 12),
    status text not null check (status in ('CONFIRMED', 'REJECTED')),
    row_count integer not null default 0,
    imported_by uuid references auth.users(id),
    imported_at timestamptz not null default now(),
    metadata jsonb not null default '{}'::jsonb,
    unique (company_id, file_hash)
);

create table if not exists comercial.financial_statement_periods (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references core.companies(id) on delete restrict,
    bank_account_id uuid not null,
    year integer not null,
    month integer not null check (month between 1 and 12),
    status text not null default 'CLOSED' check (status = 'CLOSED'),
    opening_balance numeric(20, 0) not null,
    total_credits numeric(20, 0) not null,
    total_debits numeric(20, 0) not null,
    closing_balance numeric(20, 0) not null,
    first_transaction_date date not null,
    last_transaction_date date not null,
    movement_count integer not null default 0,
    import_id uuid not null references comercial.financial_imports(id) on delete restrict,
    unique (company_id, bank_account_id, year, month),
    unique (company_id, id),
    foreign key (company_id, bank_account_id) references comercial.financial_bank_accounts(company_id, id)
);

create table if not exists comercial.financial_bank_movements (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references core.companies(id) on delete restrict,
    bank_account_id uuid not null,
    import_id uuid not null references comercial.financial_imports(id) on delete restrict,
    statement_period_id uuid not null,
    transaction_date date not null,
    operation_description text not null,
    credit_amount numeric(20, 0) not null default 0,
    debit_amount numeric(20, 0) not null default 0,
    balance_after numeric(20, 0) not null,
    document_number text,
    transaction_number text,
    branch text,
    cashier text,
    source_row_number integer not null,
    fingerprint text not null,
    raw_payload jsonb not null default '{}'::jsonb,
    unique (company_id, fingerprint),
    foreign key (company_id, bank_account_id) references comercial.financial_bank_accounts(company_id, id),
    foreign key (company_id, statement_period_id) references comercial.financial_statement_periods(company_id, id)
);

create index if not exists financial_imports_company_period_idx
    on comercial.financial_imports(company_id, period_year, period_month);
create index if not exists financial_bank_movements_month_idx
    on comercial.financial_bank_movements(company_id, bank_account_id, transaction_date, id);

create or replace function comercial.confirm_financial_bank_statement(
    p_company_id uuid,
    p_bank_account_id uuid,
    p_import jsonb,
    p_period jsonb,
    p_movements jsonb,
    p_imported_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, comercial
as $$
declare
    v_import_id uuid;
    v_period_id uuid;
    v_existing uuid;
begin
    if not exists (
        select 1 from comercial.financial_bank_accounts
        where id = p_bank_account_id and company_id = p_company_id and is_active
    ) then raise exception 'La cuenta bancaria no pertenece a la empresa activa.'; end if;

    select id into v_existing from comercial.financial_imports
      where company_id = p_company_id and file_hash = p_import->>'file_hash';
    if v_existing is not null then raise exception 'La misma cartola ya fue importada.'; end if;

    if exists (
        select 1 from comercial.financial_statement_periods
        where company_id = p_company_id and bank_account_id = p_bank_account_id
          and year = (p_period->>'year')::integer and month = (p_period->>'month')::integer
    ) then raise exception 'Ya existe una cartola cerrada para esta cuenta y período.'; end if;

    insert into comercial.financial_imports (
      company_id, source_type, original_filename, file_hash, period_year,
      period_month, status, row_count, imported_by, metadata
    ) values (
      p_company_id, 'BANK_STATEMENT_CLOSED', p_import->>'original_filename',
      p_import->>'file_hash', (p_period->>'year')::integer, (p_period->>'month')::integer,
      'CONFIRMED', jsonb_array_length(p_movements), p_imported_by,
      coalesce(p_import->'metadata', '{}'::jsonb)
    ) returning id into v_import_id;

    insert into comercial.financial_statement_periods (
      company_id, bank_account_id, year, month, opening_balance, total_credits,
      total_debits, closing_balance, first_transaction_date, last_transaction_date, movement_count, import_id
    ) values (
      p_company_id, p_bank_account_id, (p_period->>'year')::integer, (p_period->>'month')::integer,
      (p_period->>'opening_balance')::numeric, (p_period->>'total_credits')::numeric,
      (p_period->>'total_debits')::numeric, (p_period->>'closing_balance')::numeric,
      (p_period->>'first_transaction_date')::date, (p_period->>'last_transaction_date')::date,
      jsonb_array_length(p_movements), v_import_id
    ) returning id into v_period_id;

    insert into comercial.financial_bank_movements (
      company_id, bank_account_id, import_id, statement_period_id, transaction_date,
      operation_description, credit_amount, debit_amount, balance_after,
      document_number, transaction_number, branch, cashier, source_row_number,
      fingerprint, raw_payload
    ) select p_company_id, p_bank_account_id, v_import_id, v_period_id,
      x.transaction_date, x.operation_description, x.credit_amount, x.debit_amount,
      x.balance_after, x.document_number, x.transaction_number, x.branch, x.cashier,
      x.source_row_number, x.fingerprint, x.raw_payload
    from jsonb_to_recordset(p_movements) as x(
      transaction_date date, operation_description text, credit_amount numeric,
      debit_amount numeric, balance_after numeric, document_number text,
      transaction_number text, branch text, cashier text, source_row_number integer,
      fingerprint text, raw_payload jsonb
    );

    return jsonb_build_object('import_id', v_import_id, 'statement_period_id', v_period_id);
exception when unique_violation then
    raise exception 'La cartola o uno de sus movimientos ya existe para esta empresa.';
end;
$$;
