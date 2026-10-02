-- OPEN bank reconciliation differences are persisted separately from movements.
create table if not exists comercial.financial_bank_reconciliation_differences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  bank_account_id uuid not null,
  statement_period_id uuid not null,
  detected_import_id uuid not null,
  detected_at timestamptz not null default now(),
  financial_date date not null,
  amount_signed numeric(20, 0) not null,
  expected_balance numeric(20, 0) not null,
  reported_balance numeric(20, 0) not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'IDENTIFIED', 'RESOLVED')),
  reason_type text check (reason_type is null or reason_type in ('CLIENT_COLLECTION_NOT_LISTED', 'UNLISTED_PAYMENT', 'BANK_ADJUSTMENT', 'UNLISTED_TRANSFER', 'OTHER', 'PENDING_IDENTIFICATION')),
  category_id uuid,
  counterparty text,
  note text,
  affects_cash_flow boolean not null default true,
  affects_pnl_directly boolean not null default false,
  resolved_movement_id uuid,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, bank_account_id, statement_period_id, financial_date, amount_signed, expected_balance, reported_balance),
  foreign key (company_id, bank_account_id) references comercial.financial_bank_accounts(company_id, id),
  foreign key (company_id, statement_period_id) references comercial.financial_statement_periods(company_id, id),
  foreign key (company_id, category_id) references comercial.financial_categories(company_id, id),
  foreign key (resolved_movement_id) references comercial.financial_bank_movements(id)
);

create index if not exists financial_bank_reconciliation_differences_period_idx
  on comercial.financial_bank_reconciliation_differences(company_id, bank_account_id, statement_period_id, status);

drop function if exists comercial.confirm_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid);

create or replace function comercial.confirm_financial_bank_statement_open(
    p_company_id uuid,
    p_bank_account_id uuid,
    p_import jsonb,
    p_period jsonb,
    p_movements jsonb,
    p_imported_by uuid,
    p_reconciliation jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, comercial
as $$
declare
    v_import_id uuid;
    v_period_id uuid;
    v_existing_open boolean;
    v_opening numeric;
    v_previous_closing numeric;
    v_difference_id uuid;
    v_amount numeric := coalesce((p_reconciliation->>'amount_signed')::numeric, 0);
begin
    perform pg_advisory_xact_lock(hashtextextended(
      p_company_id::text || ':' || p_bank_account_id::text || ':' ||
      (p_period->>'year') || '-' || (p_period->>'month'), 0));
    if not exists (
        select 1 from comercial.financial_bank_accounts
        where id = p_bank_account_id and company_id = p_company_id and is_active
    ) then raise exception 'La cuenta bancaria no pertenece a la empresa activa.'; end if;
    if exists (select 1 from comercial.financial_imports where company_id = p_company_id and file_hash = p_import->>'file_hash') then
        raise exception 'Este archivo ya fue procesado.';
    end if;

    select id, status = 'OPEN', opening_balance into v_period_id, v_existing_open, v_opening
    from comercial.financial_statement_periods
    where company_id = p_company_id and bank_account_id = p_bank_account_id
      and year = (p_period->>'year')::integer and month = (p_period->>'month')::integer;
    if v_period_id is not null and not v_existing_open then raise exception 'El período seleccionado ya está cerrado.'; end if;

    if v_period_id is null then
        select closing_balance into v_previous_closing
        from comercial.financial_statement_periods
        where company_id = p_company_id and bank_account_id = p_bank_account_id and status = 'CLOSED'
          and (year, month) < ((p_period->>'year')::integer, (p_period->>'month')::integer)
        order by year desc, month desc limit 1;
        if v_previous_closing is null or v_previous_closing <> (p_period->>'opening_balance')::numeric then
            raise exception 'El saldo inicial no coincide con el cierre del período anterior.';
        end if;
    elsif v_opening <> (p_period->>'opening_balance')::numeric then
        raise exception 'El saldo inicial no coincide con el período abierto existente.';
    end if;

    insert into comercial.financial_imports (
      company_id, source_type, original_filename, file_hash, period_year, period_month,
      status, row_count, imported_by, metadata
    ) values (
      p_company_id, 'BANK_STATEMENT_OPEN_UPDATE', p_import->>'original_filename',
      p_import->>'file_hash', (p_period->>'year')::integer, (p_period->>'month')::integer,
      'CONFIRMED', (p_import->>'rows_in_file')::integer, p_imported_by,
      coalesce(p_import->'metadata', '{}'::jsonb)
    ) returning id into v_import_id;

    if v_period_id is null then
        insert into comercial.financial_statement_periods (
          company_id, bank_account_id, year, month, status, opening_balance, total_credits,
          total_debits, closing_balance, current_balance, coverage_through,
          first_transaction_date, last_transaction_date, movement_count, import_id
        ) values (
          p_company_id, p_bank_account_id, (p_period->>'year')::integer, (p_period->>'month')::integer,
          'OPEN', (p_period->>'opening_balance')::numeric, (p_period->>'total_credits')::numeric,
          (p_period->>'total_debits')::numeric, null, (p_period->>'current_balance')::numeric,
          (p_period->>'coverage_through')::date, (p_period->>'first_transaction_date')::date,
          (p_period->>'last_transaction_date')::date, (p_period->>'movement_count')::integer, v_import_id
        ) returning id into v_period_id;
    else
        update comercial.financial_statement_periods
        set total_credits = (p_period->>'total_credits')::numeric,
            total_debits = (p_period->>'total_debits')::numeric,
            current_balance = (p_period->>'current_balance')::numeric,
            coverage_through = (p_period->>'coverage_through')::date,
            first_transaction_date = least(first_transaction_date, (p_period->>'first_transaction_date')::date),
            last_transaction_date = greatest(last_transaction_date, (p_period->>'last_transaction_date')::date),
            movement_count = (p_period->>'movement_count')::integer
        where id = v_period_id and company_id = p_company_id and bank_account_id = p_bank_account_id;
    end if;

    insert into comercial.financial_bank_movements (
      company_id, bank_account_id, import_id, statement_period_id, transaction_date,
      operation_description, credit_amount, debit_amount, balance_after,
      document_number, transaction_number, branch, cashier, source_row_number,
      fingerprint, movement_identity, movement_content_hash, raw_payload
    ) select p_company_id, p_bank_account_id, v_import_id, v_period_id,
      x.transaction_date, x.operation_description, x.credit_amount, x.debit_amount,
      x.balance_after, x.document_number, x.transaction_number, x.branch, x.cashier,
      x.source_row_number, x.movement_content_hash, x.movement_identity, x.movement_content_hash, x.raw_payload
    from jsonb_to_recordset(p_movements) as x(
      transaction_date date, operation_description text, credit_amount numeric,
      debit_amount numeric, balance_after numeric, document_number text,
      transaction_number text, branch text, cashier text, source_row_number integer,
      movement_identity text, movement_content_hash text, raw_payload jsonb
    );

    if v_amount <> 0 then
      insert into comercial.financial_bank_reconciliation_differences (
        company_id, bank_account_id, statement_period_id, detected_import_id,
        financial_date, amount_signed, expected_balance, reported_balance,
        reason_type, category_id, counterparty, note
      ) values (
        p_company_id, p_bank_account_id, v_period_id, v_import_id,
        (p_reconciliation->>'coverage_date')::date, v_amount,
        (p_reconciliation->>'expected_balance')::numeric,
        (p_reconciliation->>'reported_balance')::numeric,
        nullif(p_reconciliation->>'reason_type', ''),
        nullif(p_reconciliation->>'category_id', '')::uuid,
        nullif(p_reconciliation->>'counterparty', ''),
        nullif(p_reconciliation->>'note', '')
      ) on conflict (company_id, bank_account_id, statement_period_id, financial_date, amount_signed, expected_balance, reported_balance)
      do nothing returning id into v_difference_id;
      if v_difference_id is null then
        select id into v_difference_id
        from comercial.financial_bank_reconciliation_differences
        where company_id = p_company_id and bank_account_id = p_bank_account_id
          and statement_period_id = v_period_id and financial_date = (p_reconciliation->>'coverage_date')::date
          and amount_signed = v_amount
          and expected_balance = (p_reconciliation->>'expected_balance')::numeric
          and reported_balance = (p_reconciliation->>'reported_balance')::numeric;
      end if;
    end if;
    return jsonb_build_object('import_id', v_import_id, 'statement_period_id', v_period_id, 'reconciliation_difference_id', v_difference_id);
exception when unique_violation then
    raise exception 'La actualización contiene un movimiento duplicado o una importación ya existente.';
end;
$$;

revoke all on table comercial.financial_bank_reconciliation_differences from public, anon, authenticated, service_role;
grant select on table comercial.financial_bank_reconciliation_differences to service_role;
revoke all on function comercial.confirm_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function comercial.confirm_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb) to service_role;
