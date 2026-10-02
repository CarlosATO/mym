-- Close an existing OPEN bank period from the definitive semicolon export.
-- The full file is checked against the accumulated identities before the
-- period, import and missing movements are committed in one transaction.
alter table comercial.financial_imports
  drop constraint if exists financial_imports_source_type_check;
alter table comercial.financial_imports
  add constraint financial_imports_source_type_check
  check (source_type in (
    'BANK_STATEMENT_CLOSED',
    'BANK_STATEMENT_OPEN_UPDATE',
    'BANK_STATEMENT_FINAL_CLOSE'
  ));

create or replace function comercial.finalize_financial_bank_statement_open(
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
    v_period_status text;
    v_opening numeric;
    v_existing_count integer;
    v_file_count integer;
    v_new_count integer;
begin
    perform pg_advisory_xact_lock(hashtextextended(
      p_company_id::text || ':' || p_bank_account_id::text || ':' ||
      (p_period->>'year') || '-' || (p_period->>'month'), 0));

    if not exists (
        select 1 from comercial.financial_bank_accounts
        where id = p_bank_account_id and company_id = p_company_id and is_active
    ) then
        raise exception 'La cuenta bancaria no pertenece a la empresa activa.';
    end if;

    if exists (
        select 1 from comercial.financial_imports
        where company_id = p_company_id and file_hash = p_import->>'file_hash'
    ) then
        raise exception 'Este archivo ya fue procesado.';
    end if;

    select id, status, opening_balance
      into v_period_id, v_period_status, v_opening
    from comercial.financial_statement_periods
    where company_id = p_company_id and bank_account_id = p_bank_account_id
      and year = (p_period->>'year')::integer
      and month = (p_period->>'month')::integer
    for update;

    if v_period_id is null or v_period_status <> 'OPEN' then
        raise exception 'El período debe existir y estar OPEN para cerrarlo definitivamente.';
    end if;
    if v_opening <> (p_period->>'opening_balance')::numeric then
        raise exception 'El saldo inicial no coincide con el período abierto.';
    end if;
    if jsonb_array_length(p_movements) = 0 then
        raise exception 'La cartola definitiva no contiene movimientos.';
    end if;
    if (p_period->>'opening_balance')::numeric
         + (p_period->>'total_credits')::numeric
         - (p_period->>'total_debits')::numeric
         <> (p_period->>'closing_balance')::numeric then
        raise exception 'La cartola definitiva no concilia globalmente.';
    end if;

    select count(*) into v_file_count from jsonb_to_recordset(p_movements) as x(
      movement_identity text, movement_content_hash text
    );
    select count(*) into v_existing_count
    from comercial.financial_bank_movements
    where company_id = p_company_id and bank_account_id = p_bank_account_id
      and statement_period_id = v_period_id;
    if exists (
      select 1 from jsonb_to_recordset(p_movements) as x(
        movement_identity text, movement_content_hash text
      ) group by movement_identity having count(*) > 1
    ) then
        raise exception 'La cartola definitiva contiene identidades duplicadas.';
    end if;
    if exists (
      select 1
      from comercial.financial_bank_movements m
      where m.company_id = p_company_id and m.bank_account_id = p_bank_account_id
        and m.statement_period_id = v_period_id
        and not exists (
          select 1 from jsonb_to_recordset(p_movements) as x(
            movement_identity text, movement_content_hash text
          ) where x.movement_identity = m.movement_identity
        )
    ) then
        raise exception 'La cartola definitiva omite movimientos ya confirmados.';
    end if;
    if exists (
      select 1
      from comercial.financial_bank_movements m
      join jsonb_to_recordset(p_movements) as x(
        movement_identity text, movement_content_hash text
      ) on x.movement_identity = m.movement_identity
      where m.company_id = p_company_id and m.bank_account_id = p_bank_account_id
        and m.statement_period_id = v_period_id
        and x.movement_content_hash <> m.movement_content_hash
    ) then
        raise exception 'La cartola definitiva contiene conflictos de contenido.';
    end if;

    select count(*) into v_new_count
    from jsonb_to_recordset(p_movements) as x(
      movement_identity text, movement_content_hash text
    )
    where not exists (
      select 1 from comercial.financial_bank_movements m
      where m.company_id = p_company_id and m.bank_account_id = p_bank_account_id
        and m.statement_period_id = v_period_id
        and m.movement_identity = x.movement_identity
    );

    insert into comercial.financial_imports (
      company_id, source_type, original_filename, file_hash, period_year,
      period_month, status, row_count, imported_by, metadata
    ) values (
      p_company_id, 'BANK_STATEMENT_FINAL_CLOSE', p_import->>'original_filename',
      p_import->>'file_hash', (p_period->>'year')::integer,
      (p_period->>'month')::integer, 'CONFIRMED', v_file_count,
      p_imported_by, coalesce(p_import->'metadata', '{}'::jsonb)
    ) returning id into v_import_id;

    insert into comercial.financial_bank_movements (
      company_id, bank_account_id, import_id, statement_period_id, transaction_date,
      operation_description, credit_amount, debit_amount, balance_after,
      document_number, transaction_number, branch, cashier, source_row_number,
      fingerprint, movement_identity, movement_content_hash, raw_payload
    ) select p_company_id, p_bank_account_id, v_import_id, v_period_id,
      x.transaction_date, x.operation_description, x.credit_amount, x.debit_amount,
      x.balance_after, x.document_number, x.transaction_number, x.branch, x.cashier,
      x.source_row_number, x.fingerprint, x.movement_identity, x.movement_content_hash,
      x.raw_payload
    from jsonb_to_recordset(p_movements) as x(
      transaction_date date, operation_description text, credit_amount numeric,
      debit_amount numeric, balance_after numeric, document_number text,
      transaction_number text, branch text, cashier text, source_row_number integer,
      fingerprint text, movement_identity text, movement_content_hash text, raw_payload jsonb
    )
    where not exists (
      select 1 from comercial.financial_bank_movements m
      where m.company_id = p_company_id and m.bank_account_id = p_bank_account_id
        and m.statement_period_id = v_period_id
        and m.movement_identity = x.movement_identity
    );

    update comercial.financial_statement_periods
    set status = 'CLOSED',
        total_credits = (p_period->>'total_credits')::numeric,
        total_debits = (p_period->>'total_debits')::numeric,
        closing_balance = (p_period->>'closing_balance')::numeric,
        current_balance = (p_period->>'closing_balance')::numeric,
        coverage_through = (p_period->>'last_transaction_date')::date,
        first_transaction_date = (p_period->>'first_transaction_date')::date,
        last_transaction_date = (p_period->>'last_transaction_date')::date,
        movement_count = v_file_count,
        import_id = v_import_id
    where id = v_period_id and company_id = p_company_id;

    update comercial.financial_bank_reconciliation_differences
    set status = 'RESOLVED',
        resolved_at = now(),
        resolved_by = p_imported_by,
        note = concat_ws(' | ', nullif(note, ''), 'Resuelta al cerrar con cartola definitiva.')
    where company_id = p_company_id and bank_account_id = p_bank_account_id
      and statement_period_id = v_period_id
      and status in ('PENDING', 'IDENTIFIED');

    return jsonb_build_object(
      'import_id', v_import_id,
      'statement_period_id', v_period_id,
      'existing_count', v_existing_count,
      'new_count', v_new_count,
      'status', 'CLOSED'
    );
exception when unique_violation then
    raise exception 'La cartola definitiva o uno de sus movimientos ya existe.';
end;
$$;

revoke all on function comercial.finalize_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function comercial.finalize_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid)
  to service_role;
