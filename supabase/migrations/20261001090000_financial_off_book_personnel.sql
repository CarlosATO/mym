-- Structured classification for personnel payments outside the payroll book.

create table if not exists comercial.financial_personnel_beneficiaries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete cascade,
  display_name text not null check (btrim(display_name) <> ''),
  normalized_name text generated always as (
    upper(btrim(regexp_replace(display_name, '\s+', ' ', 'g')))
  ) stored,
  rut text,
  employee_id uuid,
  active boolean not null default true,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

create unique index if not exists financial_personnel_beneficiaries_company_name_uidx
  on comercial.financial_personnel_beneficiaries(company_id, normalized_name);
create index if not exists financial_personnel_beneficiaries_company_active_idx
  on comercial.financial_personnel_beneficiaries(company_id, active, display_name);

create table if not exists comercial.financial_bank_movement_personnel_details (
  movement_id uuid primary key references comercial.financial_bank_movements(id) on delete cascade,
  company_id uuid not null references core.companies(id) on delete cascade,
  beneficiary_id uuid not null,
  beneficiary_name_snapshot text not null check (btrim(beneficiary_name_snapshot) <> ''),
  payment_concept text not null check (payment_concept in ('SUELDO', 'QUINCENA', 'BONO', 'ANTICIPO', 'OTRO')),
  payroll_status text not null default 'NOT_IN_PAYROLL' check (payroll_status = 'NOT_IN_PAYROLL'),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  foreign key (company_id, beneficiary_id)
    references comercial.financial_personnel_beneficiaries(company_id, id)
);

create index if not exists financial_bank_movement_personnel_details_company_beneficiary_idx
  on comercial.financial_bank_movement_personnel_details(company_id, beneficiary_id);

alter table comercial.financial_personnel_beneficiaries enable row level security;
alter table comercial.financial_bank_movement_personnel_details enable row level security;
revoke all on comercial.financial_personnel_beneficiaries, comercial.financial_bank_movement_personnel_details from public, anon, authenticated, service_role;
grant select, insert, update on comercial.financial_personnel_beneficiaries to service_role;
grant select, insert, update on comercial.financial_bank_movement_personnel_details to service_role;

create or replace function comercial.set_financial_personnel_updated_at()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists financial_personnel_beneficiaries_updated_at on comercial.financial_personnel_beneficiaries;
create trigger financial_personnel_beneficiaries_updated_at
before update on comercial.financial_personnel_beneficiaries
for each row execute function comercial.set_financial_personnel_updated_at();
drop trigger if exists financial_bank_movement_personnel_details_updated_at on comercial.financial_bank_movement_personnel_details;
create trigger financial_bank_movement_personnel_details_updated_at
before update on comercial.financial_bank_movement_personnel_details
for each row execute function comercial.set_financial_personnel_updated_at();

insert into comercial.financial_categories (
  company_id, parent_id, code, name, direction, sort_order,
  affects_cash_flow, affects_pnl_directly, classification_group,
  semantic_type, cash_direction
)
select companies.id, parent.id, 'EXPENSE_PERSONNEL_OFF_BOOK',
       'Pagos de personal fuera de libro / no conciliados', 'EXPENSE', 26,
       true, true, 'OPERATING', 'PERSONNEL_OUT_OF_BOOK', 'DEBIT'
from core.companies companies
join comercial.financial_categories parent
  on parent.company_id = companies.id and parent.code = 'EXPENSE'
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

create or replace function comercial.create_financial_personnel_beneficiary(
  p_company_id uuid, p_display_name text, p_rut text, p_note text, p_created_by uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_id uuid; v_existing uuid; v_name text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
begin
  if v_name = '' then raise exception 'El nombre del beneficiario es obligatorio.'; end if;
  select id into v_existing from comercial.financial_personnel_beneficiaries
    where company_id = p_company_id and normalized_name = upper(v_name) and active;
  if v_existing is not null then
    return jsonb_build_object('created', false, 'duplicate', true, 'id', v_existing);
  end if;
  insert into comercial.financial_personnel_beneficiaries(company_id, display_name, rut, note, created_by, updated_by)
  values (p_company_id, v_name, nullif(btrim(p_rut), ''), nullif(btrim(p_note), ''), p_created_by, p_created_by)
  returning id into v_id;
  return jsonb_build_object('created', true, 'duplicate', false, 'id', v_id);
exception when unique_violation then
  select id into v_existing from comercial.financial_personnel_beneficiaries
    where company_id = p_company_id and normalized_name = upper(v_name) and active;
  if v_existing is null then raise; end if;
  return jsonb_build_object('created', false, 'duplicate', true, 'id', v_existing);
end;
$$;

create or replace function comercial.classify_off_book_personnel_movements(
  p_company_id uuid, p_year integer, p_bank_account_id uuid, p_category_id uuid,
  p_classified_by uuid, p_details jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_count integer; v_updated integer; v_category_code text;
begin
  if p_year < 2000 or p_year > 2200 then raise exception 'Año de auditoría inválido.'; end if;
  select code into v_category_code from comercial.financial_categories
    where company_id = p_company_id and id = p_category_id and is_active;
  if v_category_code <> 'EXPENSE_PERSONNEL_OFF_BOOK' then raise exception 'La categoría no es la de personal fuera de libro.'; end if;
  if p_details is null or jsonb_typeof(p_details) <> 'array' or jsonb_array_length(p_details) = 0 then raise exception 'Debe indicar el detalle de cada movimiento.'; end if;
  select count(*) into v_count from jsonb_to_recordset(p_details) as d(movement_id uuid, beneficiary_id uuid, payment_concept text);
  if v_count <> (select count(distinct movement_id) from jsonb_to_recordset(p_details) as d(movement_id uuid, beneficiary_id uuid, payment_concept text)) then raise exception 'No se permiten movimientos repetidos.'; end if;
  if exists (select 1 from jsonb_to_recordset(p_details) as d(movement_id uuid, beneficiary_id uuid, payment_concept text) where d.movement_id is null or d.beneficiary_id is null or d.payment_concept not in ('SUELDO','QUINCENA','BONO','ANTICIPO','OTRO')) then raise exception 'Cada movimiento requiere beneficiario y concepto válido.'; end if;
  if exists (select 1 from jsonb_to_recordset(p_details) as d(movement_id uuid, beneficiary_id uuid, payment_concept text) left join comercial.financial_personnel_beneficiaries b on b.company_id = p_company_id and b.id = d.beneficiary_id and b.active where b.id is null) then raise exception 'El beneficiario no pertenece a la empresa activa o está inactivo.'; end if;
  if (select count(*) from comercial.financial_bank_movements m join jsonb_to_recordset(p_details) d on d.movement_id = m.id where m.company_id = p_company_id and m.transaction_date >= make_date(p_year, 1, 1) and m.transaction_date < make_date(p_year + 1, 1, 1) and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id) and m.direction = 'DEBE' and coalesce(m.debit_amount, 0) > 0 and m.category_id is null) <> v_count then raise exception 'Uno o más movimientos ya no están pendientes o no pertenecen al alcance.'; end if;
  update comercial.financial_bank_movements m set category_id = p_category_id, classification_source = 'MANUAL', classification_rule_id = null, classified_by = p_classified_by, classified_at = now()
    from jsonb_to_recordset(p_details) d
    where m.id = d.movement_id and m.company_id = p_company_id and m.category_id is null;
  get diagnostics v_updated = row_count;
  if v_updated <> v_count then raise exception 'La clasificación cambió durante la confirmación.'; end if;
  insert into comercial.financial_bank_movement_personnel_details(movement_id, company_id, beneficiary_id, beneficiary_name_snapshot, payment_concept, created_by, updated_by)
    select d.movement_id, p_company_id, d.beneficiary_id, b.display_name, d.payment_concept, p_classified_by, p_classified_by
    from jsonb_to_recordset(p_details) d
    join comercial.financial_personnel_beneficiaries b on b.company_id = p_company_id and b.id = d.beneficiary_id;
  return jsonb_build_object('requestedCount', v_count, 'classifiedCount', v_updated, 'omittedCount', 0, 'errorCount', 0);
end;
$$;

-- Generic paths must not be able to create an incomplete off-book record.
create or replace function comercial.classify_pending_debit_movements(
  p_company_id uuid, p_year integer, p_bank_account_id uuid, p_movement_ids uuid[], p_category_id uuid, p_classified_by uuid
) returns jsonb language plpgsql security definer set search_path = pg_catalog, comercial as $$
declare v_code text; v_requested integer := 0; v_classified integer := 0; v_ids uuid[] := coalesce(p_movement_ids, '{}'::uuid[]);
begin
  select code into v_code from comercial.financial_categories where company_id = p_company_id and id = p_category_id and is_active;
  if v_code = 'EXPENSE_PERSONNEL_OFF_BOOK' then raise exception 'Use la clasificación especializada de personal fuera de libro.'; end if;
  if p_year < 2000 or p_year > 2200 then raise exception 'Año de auditoría inválido.'; end if;
  if not exists (select 1 from comercial.financial_categories c where c.company_id = p_company_id and c.id = p_category_id and c.is_active and c.parent_id is not null and c.direction in ('EXPENSE','BOTH') and c.cash_direction in ('DEBIT','BOTH') and c.affects_cash_flow and not exists (select 1 from comercial.financial_categories child where child.company_id = c.company_id and child.parent_id = c.id and child.is_active)) then raise exception 'La categoría no es una hoja activa y compatible con movimientos DEBE.'; end if;
  if cardinality(v_ids) = 0 then return jsonb_build_object('requestedCount', 0, 'classifiedCount', 0, 'omittedCount', 0, 'errorCount', 0); end if;
  if (select count(*) from comercial.financial_bank_movements m where m.company_id = p_company_id and m.id = any(v_ids) and m.transaction_date >= make_date(p_year, 1, 1) and m.transaction_date < make_date(p_year + 1, 1, 1) and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id) and m.direction = 'DEBE' and coalesce(m.debit_amount, 0) > 0) <> cardinality(v_ids) then raise exception 'Uno o más movimientos no pertenecen al alcance de auditoría.'; end if;
  select count(*) into v_requested from comercial.financial_bank_movements m where m.company_id = p_company_id and m.id = any(v_ids) and m.transaction_date >= make_date(p_year, 1, 1) and m.transaction_date < make_date(p_year + 1, 1, 1) and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id) and m.direction = 'DEBE' and coalesce(m.debit_amount, 0) > 0 and m.category_id is null;
  update comercial.financial_bank_movements m set category_id = p_category_id, counterparty = case when m.counterparty is null and m.operation_description ~* '^\s*TRASPASO\s+A\s*:\s*[^:]+\s*$' then btrim(regexp_replace(m.operation_description, '^\s*TRASPASO\s+A\s*:\s*', '', 1, 1, 'i')) else m.counterparty end, classification_source = 'BULK_EXACT', classification_rule_id = null, classified_by = p_classified_by, classified_at = now() where m.company_id = p_company_id and m.id = any(v_ids) and m.transaction_date >= make_date(p_year, 1, 1) and m.transaction_date < make_date(p_year + 1, 1, 1) and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id) and m.direction = 'DEBE' and coalesce(m.debit_amount, 0) > 0 and m.category_id is null;
  get diagnostics v_classified = row_count;
  return jsonb_build_object('requestedCount', v_requested, 'classifiedCount', v_classified, 'omittedCount', v_requested - v_classified, 'errorCount', 0);
end;
$$;

create or replace function comercial.classify_financial_bank_movements(
  p_company_id uuid, p_movement_ids uuid[], p_category_id uuid, p_counterparty text, p_note text, p_source text, p_rule_id uuid, p_only_pending boolean, p_classified_by uuid
) returns jsonb language plpgsql security definer set search_path = pg_catalog, comercial as $$
declare v_code text; v_updated integer;
begin
  select code into v_code from comercial.financial_categories where company_id = p_company_id and id = p_category_id and is_active;
  if v_code = 'EXPENSE_PERSONNEL_OFF_BOOK' then raise exception 'La categoría de personal fuera de libro requiere detalle estructurado.'; end if;
  if p_source not in ('MANUAL', 'BULK_EXACT', 'RULE', 'AUTO_RULE') then raise exception 'Fuente de clasificación inválida.'; end if;
  if not exists (select 1 from comercial.financial_categories where company_id = p_company_id and id = p_category_id and is_active) then raise exception 'La categoría no pertenece a la empresa activa.'; end if;
  if p_rule_id is not null and not exists (select 1 from comercial.financial_bank_classification_rules where company_id = p_company_id and id = p_rule_id) then raise exception 'La regla no pertenece a la empresa activa.'; end if;
  if (select count(*) from comercial.financial_bank_movements where company_id = p_company_id and id = any(p_movement_ids)) <> cardinality(p_movement_ids) then raise exception 'Uno o más movimientos no pertenecen a la empresa activa.'; end if;
  update comercial.financial_bank_movements set category_id = p_category_id, counterparty = nullif(trim(p_counterparty), ''), classification_note = nullif(trim(p_note), ''), classification_source = p_source, classification_rule_id = p_rule_id, classified_by = p_classified_by, classified_at = now() where company_id = p_company_id and id = any(p_movement_ids) and (not p_only_pending or category_id is null);
  get diagnostics v_updated = row_count;
  return jsonb_build_object('updated_count', v_updated, 'requested_count', cardinality(p_movement_ids));
end;
$$;

create or replace function comercial.create_financial_bank_classification_rule(
  p_company_id uuid, p_name text, p_direction text, p_bank_account_id uuid, p_match_type text, p_match_value text, p_category_id uuid, p_counterparty text, p_mode text, p_created_by uuid, p_apply_movement_ids uuid[]
) returns jsonb language plpgsql security definer set search_path = pg_catalog, comercial as $$
declare v_code text; v_rule_id uuid; v_applied integer := 0;
begin
  select code into v_code from comercial.financial_categories where company_id = p_company_id and id = p_category_id and is_active;
  if v_code = 'EXPENSE_PERSONNEL_OFF_BOOK' then raise exception 'No se pueden crear reglas para personal fuera de libro.'; end if;
  if p_match_type not in ('EXACT', 'CONTAINS', 'STARTS_WITH') or p_mode not in ('SUGGEST', 'AUTO') then raise exception 'Configuración de regla inválida.'; end if;
  if not exists (select 1 from comercial.financial_categories where company_id = p_company_id and id = p_category_id and is_active) then raise exception 'La categoría no pertenece a la empresa activa.'; end if;
  insert into comercial.financial_bank_classification_rules(company_id, name, direction, bank_account_id, match_type, match_value, category_id, counterparty, mode, created_by) values (p_company_id, trim(p_name), nullif(p_direction, ''), p_bank_account_id, p_match_type, trim(p_match_value), p_category_id, nullif(trim(p_counterparty), ''), p_mode, p_created_by) returning id into v_rule_id;
  if cardinality(p_apply_movement_ids) > 0 then update comercial.financial_bank_movements set category_id = p_category_id, counterparty = nullif(trim(p_counterparty), ''), classification_source = 'RULE', classification_rule_id = v_rule_id, classified_by = p_created_by, classified_at = now() where company_id = p_company_id and id = any(p_apply_movement_ids) and category_id is null; get diagnostics v_applied = row_count; end if;
  return jsonb_build_object('rule_id', v_rule_id, 'applied_count', v_applied);
end;
$$;

revoke all on function comercial.create_financial_personnel_beneficiary(uuid, text, text, text, uuid), comercial.classify_off_book_personnel_movements(uuid, integer, uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function comercial.create_financial_personnel_beneficiary(uuid, text, text, text, uuid), comercial.classify_off_book_personnel_movements(uuid, integer, uuid, uuid, uuid, jsonb) to service_role;
