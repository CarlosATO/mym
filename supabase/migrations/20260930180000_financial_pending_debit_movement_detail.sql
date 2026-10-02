-- Lazy detail and ID-scoped historical classification for pending debit audit.
-- This flow never creates classification rules.

create or replace function comercial.audit_pending_debit_group_movements(
  p_company_id uuid,
  p_year integer,
  p_bank_account_id uuid,
  p_group_key text,
  p_page integer default 1,
  p_page_size integer default 100
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 100), 1), 200);
  v_total integer;
  v_movements jsonb;
begin
  if p_year < 2000 or p_year > 2200 then
    raise exception 'Año de auditoría inválido.';
  end if;
  if p_group_key is null or trim(p_group_key) = '' then
    raise exception 'Grupo de auditoría inválido.';
  end if;

  with scoped as (
    select m.*
    from comercial.financial_bank_movements m
    where m.company_id = p_company_id
      and m.transaction_date >= make_date(p_year, 1, 1)
      and m.transaction_date < make_date(p_year + 1, 1, 1)
      and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
      and m.bank_account_id is not null
      and m.direction = 'DEBE'
      and m.classification_signature = p_group_key
      and m.category_id is null
  )
  select count(*)::integer into v_total from scoped;

  with scoped as (
    select m.*
    from comercial.financial_bank_movements m
    where m.company_id = p_company_id
      and m.transaction_date >= make_date(p_year, 1, 1)
      and m.transaction_date < make_date(p_year + 1, 1, 1)
      and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
      and m.bank_account_id is not null
      and m.direction = 'DEBE'
      and m.classification_signature = p_group_key
      and m.category_id is null
    order by m.transaction_date, m.source_row_number, m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'bankAccountId', s.bank_account_id,
    'transactionDate', s.transaction_date,
    'operationDescription', s.operation_description,
    'creditAmount', s.credit_amount,
    'debitAmount', s.debit_amount,
    'balanceAfter', s.balance_after,
    'sourceRowNumber', s.source_row_number,
    'categoryId', s.category_id,
    'categoryName', null,
    'classificationStatus', 'PENDING'
  ) order by s.transaction_date, s.source_row_number, s.id), '[]'::jsonb)
  into v_movements
  from scoped s;

  return jsonb_build_object('movements', v_movements, 'totalMovements', v_total,
                            'page', v_page, 'pageSize', v_page_size);
end;
$$;

create or replace function comercial.classify_pending_debit_movements(
  p_company_id uuid,
  p_year integer,
  p_bank_account_id uuid,
  p_movement_ids uuid[],
  p_category_id uuid,
  p_classified_by uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare
  v_requested integer := 0;
  v_classified integer := 0;
  v_category_code text;
  v_ids uuid[] := coalesce(p_movement_ids, '{}'::uuid[]);
begin
  if p_year < 2000 or p_year > 2200 then
    raise exception 'Año de auditoría inválido.';
  end if;
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('requestedCount', 0, 'classifiedCount', 0,
                              'omittedCount', 0, 'errorCount', 0);
  end if;

  select code into v_category_code
  from comercial.financial_categories
  where company_id = p_company_id and id = p_category_id and is_active;
  if v_category_code <> 'EXPENSE_PERSONNEL_CASH' then
    raise exception 'La categoría de auditoría no es válida.';
  end if;

  -- IDs outside the active company, account, year or debit scope are rejected.
  if (
    select count(*)
    from comercial.financial_bank_movements m
    where m.company_id = p_company_id
      and m.id = any(v_ids)
      and m.transaction_date >= make_date(p_year, 1, 1)
      and m.transaction_date < make_date(p_year + 1, 1, 1)
      and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
      and m.direction = 'DEBE'
  ) <> cardinality(v_ids) then
    raise exception 'Uno o más movimientos no pertenecen al alcance de auditoría.';
  end if;

  select count(*)::integer into v_requested
  from comercial.financial_bank_movements m
  where m.company_id = p_company_id
    and m.id = any(v_ids)
    and m.transaction_date >= make_date(p_year, 1, 1)
    and m.transaction_date < make_date(p_year + 1, 1, 1)
    and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
    and m.direction = 'DEBE'
    and m.category_id is null;

  update comercial.financial_bank_movements m
  set category_id = p_category_id,
      counterparty = case
        when m.counterparty is null
         and m.operation_description ~* '^\s*TRASPASO\s+A\s*:\s*[^:]+\s*$'
          then btrim(regexp_replace(m.operation_description, '^\s*TRASPASO\s+A\s*:\s*', '', 1, 1, 'i'))
        else m.counterparty
      end,
      classification_source = 'BULK_EXACT',
      classification_rule_id = null,
      classified_by = p_classified_by,
      classified_at = now()
  where m.company_id = p_company_id
    and m.id = any(v_ids)
    and m.transaction_date >= make_date(p_year, 1, 1)
    and m.transaction_date < make_date(p_year + 1, 1, 1)
    and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
    and m.direction = 'DEBE'
    and m.category_id is null;
  get diagnostics v_classified = row_count;

  return jsonb_build_object('requestedCount', v_requested,
    'classifiedCount', v_classified, 'omittedCount', v_requested - v_classified,
    'errorCount', 0);
end;
$$;

revoke all on function comercial.audit_pending_debit_group_movements(uuid, integer, uuid, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function comercial.classify_pending_debit_movements(uuid, integer, uuid, uuid[], uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.audit_pending_debit_group_movements(uuid, integer, uuid, text, integer, integer) to service_role;
grant execute on function comercial.classify_pending_debit_movements(uuid, integer, uuid, uuid[], uuid, uuid) to service_role;
