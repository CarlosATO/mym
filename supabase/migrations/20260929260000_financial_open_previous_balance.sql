-- Keep the confirmed balance before each OPEN update as an auditable fact.
alter table comercial.financial_imports
  add column if not exists previous_current_balance numeric(20, 0);

alter table comercial.financial_bank_reconciliation_differences
  add column if not exists previous_known_balance numeric(20, 0);

-- The existing September incident can be recovered without changing any
-- movement: the preceding OPEN import stored its confirmed resulting balance.
update comercial.financial_bank_reconciliation_differences d
set previous_known_balance = (
  select coalesce(
    previous_import.metadata->>'resulting_balance',
    previous_import.metadata->>'current_balance'
  )::numeric
  from comercial.financial_bank_movements previous_movement
  join comercial.financial_imports previous_import
    on previous_import.id = previous_movement.import_id
   and previous_import.company_id = d.company_id
  where previous_movement.company_id = d.company_id
    and previous_movement.bank_account_id = d.bank_account_id
    and previous_movement.statement_period_id = d.statement_period_id
    and previous_movement.import_id <> d.detected_import_id
    and previous_import.source_type = 'BANK_STATEMENT_OPEN_UPDATE'
    and previous_import.imported_at < (
      select detected_import.imported_at
      from comercial.financial_imports detected_import
      where detected_import.id = d.detected_import_id
        and detected_import.company_id = d.company_id
    )
    and coalesce(
      previous_import.metadata->>'resulting_balance',
      previous_import.metadata->>'current_balance'
    ) ~ '^-?[0-9]+(\.[0-9]+)?$'
  order by previous_import.imported_at desc, previous_import.id desc
  limit 1
)
where d.previous_known_balance is null;

update comercial.financial_imports i
set previous_current_balance = d.previous_known_balance
from comercial.financial_bank_reconciliation_differences d
where d.detected_import_id = i.id
  and d.company_id = i.company_id
  and d.previous_known_balance is not null
  and i.previous_current_balance is null;

drop function if exists comercial.confirm_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb);

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
    v_previous_current_balance numeric;
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

    select id, status = 'OPEN', opening_balance, current_balance
      into v_period_id, v_existing_open, v_opening, v_previous_current_balance
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
        v_previous_current_balance := v_previous_closing;
    elsif v_opening <> (p_period->>'opening_balance')::numeric then
        raise exception 'El saldo inicial no coincide con el período abierto existente.';
    end if;

    insert into comercial.financial_imports (
      company_id, source_type, original_filename, file_hash, period_year, period_month,
      status, row_count, imported_by, metadata, previous_current_balance
    ) values (
      p_company_id, 'BANK_STATEMENT_OPEN_UPDATE', p_import->>'original_filename',
      p_import->>'file_hash', (p_period->>'year')::integer, (p_period->>'month')::integer,
      'CONFIRMED', (p_import->>'rows_in_file')::integer, p_imported_by,
      coalesce(p_import->'metadata', '{}'::jsonb), v_previous_current_balance
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
        previous_known_balance, reason_type, category_id, counterparty, note
      ) values (
        p_company_id, p_bank_account_id, v_period_id, v_import_id,
        (p_reconciliation->>'coverage_date')::date, v_amount,
        (p_reconciliation->>'expected_balance')::numeric,
        (p_reconciliation->>'reported_balance')::numeric,
        v_previous_current_balance,
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

revoke all on function comercial.confirm_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function comercial.confirm_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb) to service_role;
