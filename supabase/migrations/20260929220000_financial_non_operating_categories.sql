-- Financial non-operating catalog metadata and Caylo's deterministic suggestion rule.
-- This migration deliberately does not classify existing bank movements.

alter table comercial.financial_categories
  add column if not exists affects_cash_flow boolean not null default true;
alter table comercial.financial_categories
  add column if not exists affects_pnl_directly boolean not null default true;
alter table comercial.financial_categories
  add column if not exists classification_group text not null default 'OPERATING';
alter table comercial.financial_categories
  add column if not exists semantic_type text;
alter table comercial.financial_categories
  add column if not exists cash_direction text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'financial_categories_classification_group_check'
      and conrelid = 'comercial.financial_categories'::regclass
  ) then
    alter table comercial.financial_categories
      add constraint financial_categories_classification_group_check
      check (classification_group in ('OPERATING', 'NON_OPERATING'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'financial_categories_cash_direction_check'
      and conrelid = 'comercial.financial_categories'::regclass
  ) then
    alter table comercial.financial_categories
      add constraint financial_categories_cash_direction_check
      check (cash_direction is null or cash_direction in ('CREDIT', 'DEBIT', 'BOTH'));
  end if;
end;
$$;

update comercial.financial_categories
set affects_cash_flow = true,
    affects_pnl_directly = true,
    classification_group = 'OPERATING',
    cash_direction = case direction when 'INCOME' then 'CREDIT' when 'EXPENSE' then 'DEBIT' else 'BOTH' end
where classification_group is null
   or cash_direction is null;

insert into comercial.financial_categories (
  company_id, code, name, direction, sort_order, affects_cash_flow,
  affects_pnl_directly, classification_group, semantic_type, cash_direction
)
select companies.id, v.code, v.name, v.direction, v.sort_order, true, false,
       'NON_OPERATING', v.semantic_type, v.cash_direction
from core.companies companies
cross join (values
  ('INCOME_NON_OPERATING', 'ENTRADAS NO OPERACIONALES', 'INCOME', 200, 'NON_OPERATING_GROUP', 'CREDIT'),
  ('EXPENSE_NON_OPERATING', 'SALIDAS NO OPERACIONALES', 'EXPENSE', 200, 'NON_OPERATING_GROUP', 'DEBIT')
) as v(code, name, direction, sort_order, semantic_type, cash_direction)
on conflict (company_id, code) do update set
  name = excluded.name,
  direction = excluded.direction,
  affects_cash_flow = excluded.affects_cash_flow,
  affects_pnl_directly = excluded.affects_pnl_directly,
  classification_group = excluded.classification_group,
  semantic_type = excluded.semantic_type,
  cash_direction = excluded.cash_direction;

-- Reuse the existing Aportes category instead of creating a duplicate.
update comercial.financial_categories contributions
set parent_id = parent.id,
    name = 'Aporte de socios',
    direction = 'INCOME',
    affects_cash_flow = true,
    affects_pnl_directly = false,
    classification_group = 'NON_OPERATING',
    semantic_type = 'OWNER_CONTRIBUTION',
    cash_direction = 'CREDIT'
from comercial.financial_categories parent
where contributions.code = 'INCOME_CONTRIBUTIONS'
  and parent.company_id = contributions.company_id
  and parent.code = 'INCOME_NON_OPERATING';

insert into comercial.financial_categories (
  company_id, parent_id, code, name, direction, sort_order, affects_cash_flow,
  affects_pnl_directly, classification_group, semantic_type, cash_direction
)
select companies.id, parent.id, 'EXPENSE_OWNER_WITHDRAWAL', 'Retiro de socio / propietario',
       'EXPENSE', 10, true, false, 'NON_OPERATING', 'OWNER_WITHDRAWAL', 'DEBIT'
from core.companies companies
join comercial.financial_categories parent
  on parent.company_id = companies.id
 and parent.code = 'EXPENSE_NON_OPERATING'
on conflict (company_id, code) do update set
  parent_id = excluded.parent_id,
  name = excluded.name,
  direction = excluded.direction,
  affects_cash_flow = excluded.affects_cash_flow,
  affects_pnl_directly = excluded.affects_pnl_directly,
  classification_group = excluded.classification_group,
  semantic_type = excluded.semantic_type,
  cash_direction = excluded.cash_direction;

-- Preserve the existing category model while making non-operating semantics explicit.
update comercial.financial_categories category
set classification_group = 'NON_OPERATING',
    affects_pnl_directly = false,
    cash_direction = case when category.direction = 'INCOME' then 'CREDIT' else 'DEBIT' end
where category.code in (
  'INCOME_FINANCING', 'EXPENSE_FINANCING', 'EXPENSE_ASSETS',
  'INCOME_INTERNAL_TRANSFER', 'EXPENSE_INTERNAL_TRANSFER',
  'INCOME_INTERCOMPANY', 'EXPENSE_INTERCOMPANY'
);

-- Caylo is the first company (d100...001) in the current company catalog.
-- The rule is SUGGEST only: no existing movement IDs are passed to the RPC.
do $$
declare
  v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
  v_account_id uuid;
  v_category_id uuid;
begin
  select id into v_account_id
  from comercial.financial_bank_accounts
  where company_id = v_company_id
    and is_active
  order by id
  limit 1;

  select id into v_category_id
  from comercial.financial_categories
  where company_id = v_company_id
    and code = 'EXPENSE_OWNER_WITHDRAWAL';

  if v_account_id is null then
    raise exception 'No se encontró una cuenta bancaria activa para Caylo.';
  end if;
  if v_category_id is null then
    raise exception 'No se encontró la categoría de retiro de socio para Caylo.';
  end if;

  if not exists (
    select 1 from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and bank_account_id = v_account_id
      and direction = 'DEBE'
      and match_type = 'EXACT'
      and match_value = 'GIRO CAJERO AUTOMATICO'
  ) then
    insert into comercial.financial_bank_classification_rules (
      company_id, name, active, direction, bank_account_id, match_type,
      match_value, category_id, mode
    ) values (
      v_company_id,
      'Giro cajero automático → retiro de socio',
      true,
      'DEBE',
      v_account_id,
      'EXACT',
      'GIRO CAJERO AUTOMATICO',
      v_category_id,
      'SUGGEST'
    );
  end if;
end;
$$;

grant select on table comercial.financial_categories to service_role;
grant select on table comercial.financial_bank_classification_rules to service_role;
