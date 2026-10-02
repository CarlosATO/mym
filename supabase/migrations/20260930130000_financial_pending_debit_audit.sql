-- Server-side audit and historical bulk classification for pending debit groups.
-- This flow intentionally does not create or apply classification rules.

insert into comercial.financial_categories (
  company_id, parent_id, code, name, direction, sort_order,
  affects_cash_flow, affects_pnl_directly, classification_group,
  semantic_type, cash_direction
)
select companies.id, parent.id, 'EXPENSE_PERSONNEL_CASH',
       'Pagos a trabajadores / personal', 'EXPENSE', 25,
       true, false, 'OPERATING', 'WORKER_CASH_PAYMENT', 'DEBIT'
from core.companies companies
join comercial.financial_categories parent
  on parent.company_id = companies.id and parent.code = 'EXPENSE'
on conflict (company_id, code) do update set
  parent_id = excluded.parent_id,
  name = excluded.name,
  direction = excluded.direction,
  affects_cash_flow = excluded.affects_cash_flow,
  affects_pnl_directly = excluded.affects_pnl_directly,
  classification_group = excluded.classification_group,
  semantic_type = excluded.semantic_type,
  cash_direction = excluded.cash_direction;

create or replace function comercial.audit_pending_debit_groups(
  p_company_id uuid,
  p_year integer,
  p_bank_account_id uuid default null,
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 50
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 50), 1), 100);
  v_search text := trim(coalesce(p_search, ''));
  v_total integer;
  v_groups jsonb;
begin
  if p_year < 2000 or p_year > 2200 then
    raise exception 'Año de auditoría inválido.';
  end if;

  with filtered as (
    select m.*
    from comercial.financial_bank_movements m
    where m.company_id = p_company_id
      and m.transaction_date >= make_date(p_year, 1, 1)
      and m.transaction_date < make_date(p_year + 1, 1, 1)
      and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
      and m.direction = 'DEBE'
      and m.category_id is null
      and (
        v_search = '' or
        m.normalized_description ilike '%' || comercial.normalize_financial_bank_operation(v_search) || '%' or
        m.operation_description ilike '%' || v_search || '%'
      )
  ), grouped as (
    select classification_signature, bank_account_id,
           min(operation_description) as operation_description,
           count(*)::integer as movement_count,
           sum(coalesce(debit_amount, 0)) as total_debit,
           min(transaction_date) as first_date,
           max(transaction_date) as last_date,
           array_agg(distinct extract(month from transaction_date)::integer order by extract(month from transaction_date)::integer) as months
    from filtered
    group by classification_signature, bank_account_id
  )
  select count(*)::integer into v_total from grouped;

  with filtered as (
    select m.*
    from comercial.financial_bank_movements m
    where m.company_id = p_company_id
      and m.transaction_date >= make_date(p_year, 1, 1)
      and m.transaction_date < make_date(p_year + 1, 1, 1)
      and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
      and m.direction = 'DEBE'
      and m.category_id is null
      and (
        v_search = '' or
        m.normalized_description ilike '%' || comercial.normalize_financial_bank_operation(v_search) || '%' or
        m.operation_description ilike '%' || v_search || '%'
      )
  ), grouped as (
    select classification_signature, bank_account_id,
           min(operation_description) as operation_description,
           count(*)::integer as movement_count,
           sum(coalesce(debit_amount, 0)) as total_debit,
           min(transaction_date) as first_date,
           max(transaction_date) as last_date,
           array_agg(distinct extract(month from transaction_date)::integer order by extract(month from transaction_date)::integer) as months
    from filtered
    group by classification_signature, bank_account_id
    order by movement_count desc, last_date desc, operation_description
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'groupKey', g.classification_signature,
    'bankAccountId', g.bank_account_id,
    'operationDescription', g.operation_description,
    'counterparty', case
      when g.operation_description ~* '^\s*TRASPASO\s+A\s*:\s*[^:]+\s*$'
        then btrim(regexp_replace(g.operation_description, '^\s*TRASPASO\s+A\s*:\s*', '', 1, 1, 'i'))
      else g.operation_description
    end,
    'movementCount', g.movement_count,
    'totalDebit', g.total_debit,
    'firstDate', g.first_date,
    'lastDate', g.last_date,
    'months', g.months,
    'sampleAmounts', coalesce((
      select jsonb_agg(amount order by amount desc)
      from (
        select distinct coalesce(f.debit_amount, 0) as amount
        from filtered f
        where f.classification_signature = g.classification_signature
          and f.bank_account_id = g.bank_account_id
        order by amount desc
        limit 5
      ) samples
    ), '[]'::jsonb)
  )), '[]'::jsonb) into v_groups from grouped g;

  return jsonb_build_object('groups', v_groups, 'totalGroups', v_total,
                            'page', v_page, 'pageSize', v_page_size);
end;
$$;

create or replace function comercial.classify_pending_debit_groups(
  p_company_id uuid,
  p_year integer,
  p_bank_account_id uuid,
  p_group_keys text[],
  p_category_id uuid,
  p_classified_by uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare
  v_requested integer := 0;
  v_classified integer := 0;
  v_category_code text;
begin
  if p_year < 2000 or p_year > 2200 then raise exception 'Año de auditoría inválido.'; end if;
  select code into v_category_code
  from comercial.financial_categories
  where company_id = p_company_id and id = p_category_id and is_active;
  if v_category_code <> 'EXPENSE_PERSONNEL_CASH' then
    raise exception 'La categoría de auditoría no es válida.';
  end if;
  if p_group_keys is null or cardinality(p_group_keys) = 0 then
    return jsonb_build_object('requestedCount', 0, 'classifiedCount', 0, 'omittedCount', 0, 'errorCount', 0);
  end if;

  select count(*)::integer into v_requested
  from comercial.financial_bank_movements m
  where m.company_id = p_company_id
    and m.transaction_date >= make_date(p_year, 1, 1)
    and m.transaction_date < make_date(p_year + 1, 1, 1)
    and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
    and m.direction = 'DEBE'
    and m.classification_signature = any(p_group_keys)
    and m.category_id is null;

  update comercial.financial_bank_movements m
  set category_id = p_category_id,
      counterparty = case
        when m.operation_description ~* '^\s*TRASPASO\s+A\s*:\s*[^:]+\s*$'
          then btrim(regexp_replace(m.operation_description, '^\s*TRASPASO\s+A\s*:\s*', '', 1, 1, 'i'))
        else m.counterparty
      end,
      classification_source = 'BULK_EXACT',
      classification_rule_id = null,
      classified_by = p_classified_by,
      classified_at = now()
  where m.company_id = p_company_id
    and m.transaction_date >= make_date(p_year, 1, 1)
    and m.transaction_date < make_date(p_year + 1, 1, 1)
    and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
    and m.direction = 'DEBE'
    and m.classification_signature = any(p_group_keys)
    and m.category_id is null;
  get diagnostics v_classified = row_count;

  return jsonb_build_object('requestedCount', v_requested,
    'classifiedCount', v_classified, 'omittedCount', v_requested - v_classified,
    'errorCount', 0);
end;
$$;

revoke all on function comercial.audit_pending_debit_groups(uuid, integer, uuid, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function comercial.classify_pending_debit_groups(uuid, integer, uuid, text[], uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.audit_pending_debit_groups(uuid, integer, uuid, text, integer, integer) to service_role;
grant execute on function comercial.classify_pending_debit_groups(uuid, integer, uuid, text[], uuid, uuid) to service_role;
