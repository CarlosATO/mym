-- Deterministic bank movement classification foundation.
create table if not exists comercial.financial_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  parent_id uuid,
  code text not null,
  name text not null,
  direction text not null check (direction in ('INCOME', 'EXPENSE', 'BOTH')),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, code),
  foreign key (company_id, parent_id) references comercial.financial_categories(company_id, id)
);

create index if not exists financial_categories_company_parent_idx
  on comercial.financial_categories(company_id, parent_id, sort_order);

create table if not exists comercial.financial_bank_classification_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  name text not null,
  active boolean not null default true,
  direction text check (direction is null or direction in ('HABER', 'DEBE', 'MIXTO')),
  bank_account_id uuid,
  match_type text not null check (match_type in ('EXACT', 'CONTAINS', 'STARTS_WITH')),
  match_value text not null,
  category_id uuid not null,
  counterparty text,
  mode text not null default 'SUGGEST' check (mode in ('SUGGEST', 'AUTO')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, bank_account_id) references comercial.financial_bank_accounts(company_id, id),
  foreign key (company_id, category_id) references comercial.financial_categories(company_id, id)
);

create index if not exists financial_classification_rules_company_active_idx
  on comercial.financial_bank_classification_rules(company_id, active);

alter table comercial.financial_bank_movements
  add column if not exists direction text;
alter table comercial.financial_bank_movements
  add column if not exists normalized_description text;
alter table comercial.financial_bank_movements
  add column if not exists classification_signature text;
alter table comercial.financial_bank_movements
  add column if not exists category_id uuid;
alter table comercial.financial_bank_movements
  add column if not exists counterparty text;
alter table comercial.financial_bank_movements
  add column if not exists classification_note text;
alter table comercial.financial_bank_movements
  add column if not exists classification_source text;
alter table comercial.financial_bank_movements
  add column if not exists classification_rule_id uuid;
alter table comercial.financial_bank_movements
  add column if not exists classified_by uuid references auth.users(id);
alter table comercial.financial_bank_movements
  add column if not exists classified_at timestamptz;
alter table comercial.financial_bank_movements
  add constraint financial_bank_movements_direction_check
  check (direction is null or direction in ('HABER', 'DEBE', 'MIXTO'));
alter table comercial.financial_bank_movements
  add constraint financial_bank_movements_classification_source_check
  check (classification_source is null or classification_source in ('MANUAL', 'BULK_EXACT', 'RULE', 'AUTO_RULE'));
alter table comercial.financial_bank_movements
  add constraint financial_bank_movements_category_company_fk
  foreign key (company_id, category_id) references comercial.financial_categories(company_id, id);
alter table comercial.financial_bank_movements
  add constraint financial_bank_movements_rule_company_fk
  foreign key (company_id, classification_rule_id) references comercial.financial_bank_classification_rules(company_id, id);

create or replace function comercial.normalize_financial_bank_operation(value text)
returns text language sql immutable as $$
  select trim(regexp_replace(
    regexp_replace(upper(translate(coalesce(value, ''), 'ÁÉÍÓÚÜÑÀÈÌÒÙ', 'AEIOUUNAEIOU')), '[^A-Z0-9]+', ' ', 'g'),
    '[[:space:]]+', ' ', 'g'
  ));
$$;

create or replace function comercial.set_financial_bank_classification_identity()
returns trigger language plpgsql as $$
begin
  new.direction := case
    when coalesce(new.credit_amount, 0) > 0 and coalesce(new.debit_amount, 0) > 0 then 'MIXTO'
    when coalesce(new.credit_amount, 0) > 0 then 'HABER'
    else 'DEBE'
  end;
  new.normalized_description := comercial.normalize_financial_bank_operation(new.operation_description);
  new.classification_signature := pg_catalog.encode(
    extensions.digest(
      new.company_id::text || '|' || new.bank_account_id::text || '|' || new.direction || '|' || new.normalized_description,
      'sha256'
    ), 'hex'
  );
  return new;
end;
$$;

drop trigger if exists financial_bank_classification_identity_trigger on comercial.financial_bank_movements;
create trigger financial_bank_classification_identity_trigger
before insert or update of company_id, bank_account_id, credit_amount, debit_amount, operation_description
on comercial.financial_bank_movements
for each row execute function comercial.set_financial_bank_classification_identity();

update comercial.financial_bank_movements
set direction = case
  when credit_amount > 0 and debit_amount > 0 then 'MIXTO'
  when credit_amount > 0 then 'HABER'
  else 'DEBE'
end,
  normalized_description = comercial.normalize_financial_bank_operation(operation_description),
  classification_signature = pg_catalog.encode(extensions.digest(company_id::text || '|' || bank_account_id::text || '|' ||
  case when credit_amount > 0 and debit_amount > 0 then 'MIXTO' when credit_amount > 0 then 'HABER' else 'DEBE' end || '|' ||
  comercial.normalize_financial_bank_operation(operation_description), 'sha256'), 'hex')
where direction is null or normalized_description is null or classification_signature is null;

create index if not exists financial_bank_movements_classification_signature_idx
  on comercial.financial_bank_movements(company_id, bank_account_id, classification_signature);
create index if not exists financial_bank_movements_category_idx
  on comercial.financial_bank_movements(company_id, category_id);

insert into comercial.financial_categories (company_id, code, name, direction, sort_order)
select c.id, v.code, v.name, v.direction, v.sort_order
from core.companies c
cross join (values
  ('INCOME', 'ENTRADAS', 'INCOME', 10),
  ('EXPENSE', 'SALIDAS', 'EXPENSE', 20)
) as v(code, name, direction, sort_order)
on conflict (company_id, code) do nothing;

insert into comercial.financial_categories (company_id, parent_id, code, name, direction, sort_order)
select c.id, parent.id, v.code, v.name, v.direction, v.sort_order
from core.companies c
cross join (values
  ('INCOME', 'INCOME_CUSTOMER_COLLECTIONS', 'Cobros de clientes', 'INCOME', 10),
  ('INCOME', 'INCOME_OTHER_CASH', 'Otros ingresos de caja', 'INCOME', 20),
  ('INCOME', 'INCOME_FINANCING', 'Financiamiento', 'INCOME', 30),
  ('INCOME', 'INCOME_CONTRIBUTIONS', 'Aportes', 'INCOME', 40),
  ('INCOME', 'INCOME_INTERNAL_TRANSFER', 'Transferencias internas', 'INCOME', 50),
  ('INCOME', 'INCOME_INTERCOMPANY', 'Intercompany', 'INCOME', 60),
  ('EXPENSE', 'EXPENSE_SUPPLIERS', 'Pago a proveedores', 'EXPENSE', 10),
  ('EXPENSE', 'EXPENSE_SALARIES', 'Remuneraciones', 'EXPENSE', 20),
  ('EXPENSE', 'EXPENSE_TAXES', 'Impuestos', 'EXPENSE', 30),
  ('EXPENSE', 'EXPENSE_BANK_FEES', 'Gastos bancarios', 'EXPENSE', 40),
  ('EXPENSE', 'EXPENSE_OPERATING', 'Gastos operacionales', 'EXPENSE', 50),
  ('EXPENSE', 'EXPENSE_FINANCING', 'Créditos / financiamiento', 'EXPENSE', 60),
  ('EXPENSE', 'EXPENSE_ASSETS', 'Inversiones / activos', 'EXPENSE', 70),
  ('EXPENSE', 'EXPENSE_INTERNAL_TRANSFER', 'Transferencias internas', 'EXPENSE', 80),
  ('EXPENSE', 'EXPENSE_INTERCOMPANY', 'Intercompany', 'EXPENSE', 90),
  ('EXPENSE', 'EXPENSE_OTHER', 'Otros', 'EXPENSE', 100)
) as v(parent_code, code, name, direction, sort_order)
join comercial.financial_categories parent on parent.company_id = c.id and parent.code = v.parent_code
on conflict (company_id, code) do nothing;

insert into comercial.financial_categories (company_id, parent_id, code, name, direction, sort_order)
select c.id, parent.id, v.code, v.name, 'EXPENSE', v.sort_order
from core.companies c
cross join (values
  ('EXPENSE_SALARIES_WAGES', 'Sueldos', 10),
  ('EXPENSE_SALARIES_SOCIAL', 'Cotizaciones / Previred', 20),
  ('EXPENSE_SALARIES_OTHER', 'Otros laborales', 30)
) as v(code, name, sort_order)
join comercial.financial_categories parent on parent.company_id = c.id and parent.code = 'EXPENSE_SALARIES'
on conflict (company_id, code) do nothing;

insert into comercial.financial_categories (company_id, parent_id, code, name, direction, sort_order)
select c.id, parent.id, v.code, v.name, 'EXPENSE', v.sort_order
from core.companies c
cross join (values
  ('EXPENSE_TAXES_VAT', 'IVA', 10),
  ('EXPENSE_TAXES_PPM', 'PPM', 20),
  ('EXPENSE_TAXES_OTHER', 'Otros impuestos', 30)
) as v(code, name, sort_order)
join comercial.financial_categories parent on parent.company_id = c.id and parent.code = 'EXPENSE_TAXES'
on conflict (company_id, code) do nothing;

create or replace function comercial.classify_financial_bank_movements(
  p_company_id uuid, p_movement_ids uuid[], p_category_id uuid,
  p_counterparty text, p_note text, p_source text, p_rule_id uuid,
  p_only_pending boolean, p_classified_by uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_updated integer;
begin
  if p_source not in ('MANUAL', 'BULK_EXACT', 'RULE', 'AUTO_RULE') then raise exception 'Fuente de clasificación inválida.'; end if;
  if not exists (select 1 from comercial.financial_categories where company_id = p_company_id and id = p_category_id and is_active) then raise exception 'La categoría no pertenece a la empresa activa.'; end if;
  if p_rule_id is not null and not exists (select 1 from comercial.financial_bank_classification_rules where company_id = p_company_id and id = p_rule_id) then raise exception 'La regla no pertenece a la empresa activa.'; end if;
  if (select count(*) from comercial.financial_bank_movements where company_id = p_company_id and id = any(p_movement_ids)) <> cardinality(p_movement_ids) then raise exception 'Uno o más movimientos no pertenecen a la empresa activa.'; end if;
  update comercial.financial_bank_movements
  set category_id = p_category_id, counterparty = nullif(trim(p_counterparty), ''), classification_note = nullif(trim(p_note), ''),
      classification_source = p_source, classification_rule_id = p_rule_id, classified_by = p_classified_by, classified_at = now()
  where company_id = p_company_id and id = any(p_movement_ids) and (not p_only_pending or category_id is null);
  get diagnostics v_updated = row_count;
  return jsonb_build_object('updated_count', v_updated, 'requested_count', cardinality(p_movement_ids));
end;
$$;

create or replace function comercial.create_financial_bank_classification_rule(
  p_company_id uuid, p_name text, p_direction text, p_bank_account_id uuid,
  p_match_type text, p_match_value text, p_category_id uuid, p_counterparty text,
  p_mode text, p_created_by uuid, p_apply_movement_ids uuid[]
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_rule_id uuid; v_applied integer := 0;
begin
  if p_match_type not in ('EXACT', 'CONTAINS', 'STARTS_WITH') or p_mode not in ('SUGGEST', 'AUTO') then raise exception 'Configuración de regla inválida.'; end if;
  if not exists (select 1 from comercial.financial_categories where company_id = p_company_id and id = p_category_id and is_active) then raise exception 'La categoría no pertenece a la empresa activa.'; end if;
  insert into comercial.financial_bank_classification_rules(company_id, name, direction, bank_account_id, match_type, match_value, category_id, counterparty, mode, created_by)
  values (p_company_id, trim(p_name), nullif(p_direction, ''), p_bank_account_id, p_match_type, trim(p_match_value), p_category_id, nullif(trim(p_counterparty), ''), p_mode, p_created_by)
  returning id into v_rule_id;
  if cardinality(p_apply_movement_ids) > 0 then
    update comercial.financial_bank_movements
    set category_id = p_category_id, counterparty = nullif(trim(p_counterparty), ''), classification_source = 'RULE', classification_rule_id = v_rule_id, classified_by = p_created_by, classified_at = now()
    where company_id = p_company_id and id = any(p_apply_movement_ids) and category_id is null;
    get diagnostics v_applied = row_count;
  end if;
  return jsonb_build_object('rule_id', v_rule_id, 'applied_count', v_applied);
end;
$$;

revoke all on table comercial.financial_categories, comercial.financial_bank_classification_rules from public, anon, authenticated, service_role;
grant select on table comercial.financial_categories, comercial.financial_bank_classification_rules to service_role;
revoke all on function comercial.classify_financial_bank_movements(uuid, uuid[], uuid, text, text, text, uuid, boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function comercial.create_financial_bank_classification_rule(uuid, text, text, uuid, text, text, uuid, text, text, uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function comercial.classify_financial_bank_movements(uuid, uuid[], uuid, text, text, text, uuid, boolean, uuid) to service_role;
grant execute on function comercial.create_financial_bank_classification_rule(uuid, text, text, uuid, text, text, uuid, text, text, uuid, uuid[]) to service_role;
