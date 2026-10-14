-- OPEN imports remain append-only and audit Banco de Chile balance restatements.
-- Existing financial_bank_movements are never updated or deleted here.
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
    v_expected_count integer;
    v_actual_count integer;
    v_expected_balance numeric;
    v_expected_coverage date;
    v_amount numeric := coalesce((p_reconciliation->>'amount_signed')::numeric, 0);
    v_resolution_id uuid := nullif(p_reconciliation->>'compatible_difference_id', '')::uuid;
    v_resolved_count integer := 0;
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

    select id, status = 'OPEN', opening_balance
      into v_period_id, v_existing_open, v_opening
    from comercial.financial_statement_periods
    where company_id = p_company_id and bank_account_id = p_bank_account_id
      and year = (p_period->>'year')::integer and month = (p_period->>'month')::integer
    for update;
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

    v_expected_count := nullif(p_import->'metadata'->>'expected_existing_count', '')::integer;
    v_expected_balance := nullif(p_import->'metadata'->>'expected_current_balance', '')::numeric;
    v_expected_coverage := nullif(p_import->'metadata'->>'expected_coverage_through', '')::date;
    if v_expected_count is not null then
        select count(*) into v_actual_count
        from comercial.financial_bank_movements
        where company_id = p_company_id and bank_account_id = p_bank_account_id
          and statement_period_id = v_period_id;
        if v_actual_count <> v_expected_count
           or (v_period_id is not null and (select current_balance from comercial.financial_statement_periods where id = v_period_id) is distinct from v_expected_balance)
           or (v_period_id is not null and (select coverage_through from comercial.financial_statement_periods where id = v_period_id) is distinct from v_expected_coverage) then
            raise exception 'El período cambió desde el análisis. Vuelve a analizar la cartola.';
        end if;
    end if;

    if v_amount <> 0 then
        raise exception 'La importación OPEN tiene una diferencia inexplicada y no puede confirmarse.';
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
      x.source_row_number, x.fingerprint, x.movement_identity, x.movement_content_hash, x.raw_payload
    from jsonb_to_recordset(p_movements) as x(
      transaction_date date, operation_description text, credit_amount numeric,
      debit_amount numeric, balance_after numeric, document_number text,
      transaction_number text, branch text, cashier text, source_row_number integer,
      fingerprint text, movement_identity text, movement_content_hash text, raw_payload jsonb
    );

    if v_resolution_id is not null then
        if p_import->'metadata'->>'resolve_previous_compatible' <> 'true'
           or (p_import->'metadata'->>'balance_restatement_count')::integer <= 0
           or (p_import->'metadata'->>'true_conflict_count')::integer <> 0
           or (p_import->'metadata'->>'existing_missing_count')::integer <> 0
           or (p_import->'metadata'->>'unexplained_difference')::numeric <> 0 then
            raise exception 'La incidencia previa no cumple las condiciones de resolución segura.';
        end if;
        update comercial.financial_bank_reconciliation_differences
        set status = 'RESOLVED', resolved_at = now(), resolved_by = p_imported_by,
            note = concat_ws(' | ', nullif(note, ''), 'Resuelta por evidencia acumulativa de saldo OPEN.')
        where id = v_resolution_id and company_id = p_company_id and bank_account_id = p_bank_account_id
          and statement_period_id = v_period_id and status = 'PENDING'
          and amount_signed = nullif(p_reconciliation->>'compatible_amount', '')::numeric
          and reported_balance - expected_balance = nullif(p_reconciliation->>'compatible_amount', '')::numeric
          and financial_date = (p_reconciliation->>'coverage_date')::date;
        get diagnostics v_resolved_count = row_count;
        if v_resolved_count <> 1 then
            raise exception 'La incidencia previa compatible ya cambió o no es única.';
        end if;
    end if;

    return jsonb_build_object(
      'import_id', v_import_id,
      'statement_period_id', v_period_id,
      'inserted_count', jsonb_array_length(p_movements),
      'resolved_difference_count', v_resolved_count
    );
exception when unique_violation then
    raise exception 'La actualización contiene un movimiento duplicado o una importación ya existente.';
end;
$$;

revoke all on function comercial.confirm_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function comercial.confirm_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb)
  to service_role;

-- The definitive close uses the same stale-preview guard while preserving the
-- existing append-only finalization semantics.
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
    v_expected_count integer;
    v_expected_balance numeric;
    v_expected_coverage date;
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
    select id, status, opening_balance
      into v_period_id, v_period_status, v_opening
    from comercial.financial_statement_periods
    where company_id = p_company_id and bank_account_id = p_bank_account_id
      and year = (p_period->>'year')::integer and month = (p_period->>'month')::integer
    for update;
    if v_period_id is null or v_period_status <> 'OPEN' then
        raise exception 'El período debe existir y estar OPEN para cerrarlo definitivamente.';
    end if;
    if v_opening <> (p_period->>'opening_balance')::numeric then
        raise exception 'El saldo inicial no coincide con el período abierto.';
    end if;
    v_expected_count := nullif(p_import->'metadata'->>'expected_existing_count', '')::integer;
    v_expected_balance := nullif(p_import->'metadata'->>'expected_current_balance', '')::numeric;
    v_expected_coverage := nullif(p_import->'metadata'->>'expected_coverage_through', '')::date;
    if v_expected_count is not null then
        select count(*) into v_existing_count
        from comercial.financial_bank_movements
        where company_id = p_company_id and bank_account_id = p_bank_account_id
          and statement_period_id = v_period_id;
        if v_existing_count <> v_expected_count
           or (select current_balance from comercial.financial_statement_periods where id = v_period_id) is distinct from v_expected_balance
           or (select coverage_through from comercial.financial_statement_periods where id = v_period_id) is distinct from v_expected_coverage then
            raise exception 'El período cambió desde el análisis. Vuelve a analizar la cartola.';
        end if;
    end if;
    select count(*) into v_existing_count
    from comercial.financial_bank_movements
    where company_id = p_company_id and bank_account_id = p_bank_account_id
      and statement_period_id = v_period_id;
    if jsonb_array_length(p_movements) = 0 then
        raise exception 'La cartola definitiva no contiene movimientos.';
    end if;
    if (p_period->>'opening_balance')::numeric + (p_period->>'total_credits')::numeric
         - (p_period->>'total_debits')::numeric <> (p_period->>'closing_balance')::numeric then
        raise exception 'La cartola definitiva no concilia globalmente.';
    end if;
    select count(*) into v_file_count from jsonb_to_recordset(p_movements) as x(movement_identity text, movement_content_hash text);
    if exists (select 1 from jsonb_to_recordset(p_movements) as x(movement_identity text, movement_content_hash text) group by movement_identity having count(*) > 1) then
        raise exception 'La cartola definitiva contiene identidades duplicadas.';
    end if;
    if exists (
      select 1 from comercial.financial_bank_movements m
      where m.company_id = p_company_id and m.bank_account_id = p_bank_account_id and m.statement_period_id = v_period_id
        and not exists (select 1 from jsonb_to_recordset(p_movements) as x(movement_identity text, movement_content_hash text) where x.movement_identity = m.movement_identity)
    ) then raise exception 'La cartola definitiva omite movimientos ya confirmados.'; end if;
    if exists (
      select 1 from comercial.financial_bank_movements m
      join jsonb_to_recordset(p_movements) as x(movement_identity text, movement_content_hash text) on x.movement_identity = m.movement_identity
      where m.company_id = p_company_id and m.bank_account_id = p_bank_account_id and m.statement_period_id = v_period_id
        and x.movement_content_hash <> m.movement_content_hash
    ) then raise exception 'La cartola definitiva contiene conflictos de contenido.'; end if;
    select count(*) into v_new_count
    from jsonb_to_recordset(p_movements) as x(movement_identity text, movement_content_hash text)
    where not exists (
      select 1 from comercial.financial_bank_movements m
      where m.company_id = p_company_id and m.bank_account_id = p_bank_account_id and m.statement_period_id = v_period_id and m.movement_identity = x.movement_identity
    );
    insert into comercial.financial_imports (company_id, source_type, original_filename, file_hash, period_year, period_month, status, row_count, imported_by, metadata)
    values (p_company_id, 'BANK_STATEMENT_FINAL_CLOSE', p_import->>'original_filename', p_import->>'file_hash', (p_period->>'year')::integer, (p_period->>'month')::integer, 'CONFIRMED', v_file_count, p_imported_by, coalesce(p_import->'metadata', '{}'::jsonb)) returning id into v_import_id;
    insert into comercial.financial_bank_movements (
      company_id, bank_account_id, import_id, statement_period_id, transaction_date, operation_description,
      credit_amount, debit_amount, balance_after, document_number, transaction_number, branch, cashier,
      source_row_number, fingerprint, movement_identity, movement_content_hash, raw_payload
    ) select p_company_id, p_bank_account_id, v_import_id, v_period_id, x.transaction_date, x.operation_description,
      x.credit_amount, x.debit_amount, x.balance_after, x.document_number, x.transaction_number, x.branch, x.cashier,
      x.source_row_number, x.fingerprint, x.movement_identity, x.movement_content_hash, x.raw_payload
    from jsonb_to_recordset(p_movements) as x(
      transaction_date date, operation_description text, credit_amount numeric, debit_amount numeric, balance_after numeric,
      document_number text, transaction_number text, branch text, cashier text, source_row_number integer, fingerprint text,
      movement_identity text, movement_content_hash text, raw_payload jsonb
    ) where not exists (
      select 1 from comercial.financial_bank_movements m
      where m.company_id = p_company_id and m.bank_account_id = p_bank_account_id and m.statement_period_id = v_period_id and m.movement_identity = x.movement_identity
    );
    update comercial.financial_statement_periods
    set status = 'CLOSED', total_credits = (p_period->>'total_credits')::numeric, total_debits = (p_period->>'total_debits')::numeric,
        closing_balance = (p_period->>'closing_balance')::numeric, current_balance = (p_period->>'closing_balance')::numeric,
        coverage_through = (p_period->>'last_transaction_date')::date, first_transaction_date = (p_period->>'first_transaction_date')::date,
        last_transaction_date = (p_period->>'last_transaction_date')::date, movement_count = v_file_count, import_id = v_import_id
    where id = v_period_id and company_id = p_company_id;
    update comercial.financial_bank_reconciliation_differences
    set status = 'RESOLVED', resolved_at = now(), resolved_by = p_imported_by,
        note = concat_ws(' | ', nullif(note, ''), 'Resuelta al cerrar con cartola definitiva.')
    where company_id = p_company_id and bank_account_id = p_bank_account_id and statement_period_id = v_period_id and status in ('PENDING', 'IDENTIFIED');
    return jsonb_build_object('import_id', v_import_id, 'statement_period_id', v_period_id, 'existing_count', v_existing_count, 'new_count', v_new_count, 'status', 'CLOSED');
exception when unique_violation then
    raise exception 'La cartola definitiva o uno de sus movimientos ya existe.';
end;
$$;

revoke all on function comercial.finalize_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function comercial.finalize_financial_bank_statement_open(uuid, uuid, jsonb, jsonb, jsonb, uuid)
  to service_role;
