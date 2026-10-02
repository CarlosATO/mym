-- Allow ID-scoped pending debit classification to use any valid debit leaf.
-- This flow never creates classification rules.

insert into comercial.financial_categories (
  company_id, parent_id, code, name, direction, sort_order,
  affects_cash_flow, affects_pnl_directly, classification_group,
  semantic_type, cash_direction
)
select companies.id, parent.id, 'EXPENSE_REIMBURSEMENTS',
       'Reembolso de gastos / rendiciones', 'EXPENSE', 55,
       true, false, 'OPERATING', 'EXPENSE_REIMBURSEMENT', 'DEBIT'
from core.companies companies
join comercial.financial_categories parent
  on parent.company_id = companies.id
 and parent.code = 'EXPENSE_OPERATING'
on conflict (company_id, code) do update set
  parent_id = excluded.parent_id,
  name = excluded.name,
  direction = excluded.direction,
  sort_order = excluded.sort_order,
  is_active = true,
  affects_cash_flow = excluded.affects_cash_flow,
  affects_pnl_directly = excluded.affects_pnl_directly,
  classification_group = excluded.classification_group,
  semantic_type = excluded.semantic_type,
  cash_direction = excluded.cash_direction;

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
  v_ids uuid[] := coalesce(p_movement_ids, '{}'::uuid[]);
begin
  if p_year < 2000 or p_year > 2200 then
    raise exception 'Año de auditoría inválido.';
  end if;
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('requestedCount', 0, 'classifiedCount', 0,
                              'omittedCount', 0, 'errorCount', 0);
  end if;

  if not exists (
    select 1
    from comercial.financial_categories category
    where category.company_id = p_company_id
      and category.id = p_category_id
      and category.is_active
      and category.parent_id is not null
      and category.direction in ('EXPENSE', 'BOTH')
      and category.cash_direction in ('DEBIT', 'BOTH')
      and category.affects_cash_flow
      and not exists (
        select 1
        from comercial.financial_categories child
        where child.company_id = category.company_id
          and child.parent_id = category.id
          and child.is_active
      )
  ) then
    raise exception 'La categoría no es una hoja activa y compatible con movimientos DEBE.';
  end if;

  -- IDs outside the active company, account, year or positive debit scope are rejected.
  if (
    select count(*)
    from comercial.financial_bank_movements movement
    where movement.company_id = p_company_id
      and movement.id = any(v_ids)
      and movement.transaction_date >= make_date(p_year, 1, 1)
      and movement.transaction_date < make_date(p_year + 1, 1, 1)
      and (p_bank_account_id is null or movement.bank_account_id = p_bank_account_id)
      and movement.direction = 'DEBE'
      and coalesce(movement.debit_amount, 0) > 0
  ) <> cardinality(v_ids) then
    raise exception 'Uno o más movimientos no pertenecen al alcance de auditoría.';
  end if;

  select count(*)::integer into v_requested
  from comercial.financial_bank_movements movement
  where movement.company_id = p_company_id
    and movement.id = any(v_ids)
    and movement.transaction_date >= make_date(p_year, 1, 1)
    and movement.transaction_date < make_date(p_year + 1, 1, 1)
    and (p_bank_account_id is null or movement.bank_account_id = p_bank_account_id)
    and movement.direction = 'DEBE'
    and coalesce(movement.debit_amount, 0) > 0
    and movement.category_id is null;

  update comercial.financial_bank_movements movement
  set category_id = p_category_id,
      counterparty = case
        when movement.counterparty is null
         and movement.operation_description ~* '^\s*TRASPASO\s+A\s*:\s*[^:]+\s*$'
          then btrim(regexp_replace(movement.operation_description, '^\s*TRASPASO\s+A\s*:\s*', '', 1, 1, 'i'))
        else movement.counterparty
      end,
      classification_source = 'BULK_EXACT',
      classification_rule_id = null,
      classified_by = p_classified_by,
      classified_at = now()
  where movement.company_id = p_company_id
    and movement.id = any(v_ids)
    and movement.transaction_date >= make_date(p_year, 1, 1)
    and movement.transaction_date < make_date(p_year + 1, 1, 1)
    and (p_bank_account_id is null or movement.bank_account_id = p_bank_account_id)
    and movement.direction = 'DEBE'
    and coalesce(movement.debit_amount, 0) > 0
    and movement.category_id is null;
  get diagnostics v_classified = row_count;

  return jsonb_build_object('requestedCount', v_requested,
    'classifiedCount', v_classified, 'omittedCount', v_requested - v_classified,
    'errorCount', 0);
end;
$$;

revoke all on function comercial.classify_pending_debit_movements(uuid, integer, uuid, uuid[], uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.classify_pending_debit_movements(uuid, integer, uuid, uuid[], uuid, uuid) to service_role;
