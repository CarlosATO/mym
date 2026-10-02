-- Versioned payroll storage only. No payroll rows are imported here.

create table comercial.financial_payroll_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id) on delete restrict,
  period_year integer not null check (period_year between 2000 and 2100),
  period_month integer not null check (period_month between 1 and 12),
  source_filename text not null check (btrim(source_filename) <> ''),
  file_hash text not null check (file_hash ~ '^[0-9a-fA-F]{64}$'),
  source_format text not null check (btrim(source_format) <> ''),
  source_encoding text,
  status text not null check (status in ('IMPORTED', 'SUPERSEDED', 'CANCELLED')),
  supersedes_import_id uuid,
  row_count integer not null check (row_count >= 0),
  worker_count integer not null check (worker_count >= 0 and worker_count <= row_count),
  total_salary bigint not null,
  total_taxable_earnings bigint not null,
  total_non_taxable_earnings bigint not null,
  total_earnings bigint not null,
  total_deductions bigint not null,
  total_worker_contributions bigint not null,
  total_employer_contributions bigint not null,
  total_net_pay bigint not null,
  total_indemnities bigint not null,
  total_labor_cost bigint not null,
  recurring_labor_cost bigint not null,
  validation_summary jsonb not null default '{}'::jsonb,
  imported_at timestamptz,
  imported_by uuid references auth.users(id) on delete restrict,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete restrict,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, file_hash),
  foreign key (company_id, supersedes_import_id)
    references comercial.financial_payroll_imports(company_id, id)
    on delete restrict,
  check (supersedes_import_id is null or supersedes_import_id <> id),
  check (total_labor_cost = total_earnings + total_employer_contributions),
  check (recurring_labor_cost = total_earnings - total_indemnities + total_employer_contributions)
);

create table comercial.financial_payroll_entries (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null,
  company_id uuid not null,
  source_row_number integer not null check (source_row_number > 0),
  line_sequence integer not null default 1 check (line_sequence > 0),
  worker_rut_original text not null check (btrim(worker_rut_original) <> ''),
  worker_rut_normalized text not null check (worker_rut_normalized ~ '^[0-9]{7,8}-[0-9K]$'),
  worker_name_snapshot text,
  contract_start_date date,
  contract_end_date date,
  days_worked integer,
  medical_leave_days integer,
  vacation_days integer,
  salary bigint,
  gratification bigint,
  business_salary bigint,
  meal_allowance bigint,
  transport_allowance bigint,
  travel_allowance bigint,
  family_allowance bigint,
  holiday_indemnity bigint,
  worker_pension bigint,
  worker_health bigint,
  worker_afc bigint,
  income_tax bigint,
  advances bigint,
  employer_afc bigint,
  employer_accident_sanna bigint,
  employer_sis bigint,
  total_earnings bigint,
  taxable_earnings bigint,
  non_taxable_earnings bigint,
  non_taxable_taxable_earnings bigint,
  total_deductions bigint,
  total_worker_contributions bigint,
  total_income_tax bigint,
  total_other_deductions bigint,
  total_employer_contributions bigint,
  net_pay bigint,
  total_indemnities bigint,
  taxable_indemnities bigint,
  non_taxable_indemnities bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (import_id, source_row_number),
  unique (import_id, worker_rut_normalized, line_sequence),
  foreign key (company_id, import_id)
    references comercial.financial_payroll_imports(company_id, id)
    on delete restrict
);

create unique index financial_payroll_imports_active_period_uidx
  on comercial.financial_payroll_imports(company_id, period_year, period_month)
  where status = 'IMPORTED';

create index financial_payroll_imports_company_period_idx
  on comercial.financial_payroll_imports(company_id, period_year, period_month);

create index financial_payroll_imports_company_status_idx
  on comercial.financial_payroll_imports(company_id, status);

create index financial_payroll_entries_import_idx
  on comercial.financial_payroll_entries(import_id);

create index financial_payroll_entries_company_idx
  on comercial.financial_payroll_entries(company_id);

create index financial_payroll_entries_worker_rut_idx
  on comercial.financial_payroll_entries(company_id, worker_rut_normalized);

create or replace function comercial.validate_financial_payroll_supersedes()
returns trigger
language plpgsql
set search_path = pg_catalog, comercial
as $$
declare
  v_period_year integer;
  v_period_month integer;
begin
  if new.supersedes_import_id is null then
    return new;
  end if;

  select period_year, period_month
    into v_period_year, v_period_month
  from comercial.financial_payroll_imports
  where company_id = new.company_id
    and id = new.supersedes_import_id;

  if not found then
    raise exception 'La importación reemplazada no pertenece a la empresa.';
  end if;

  if v_period_year <> new.period_year or v_period_month <> new.period_month then
    raise exception 'Una importación sólo puede reemplazar el mismo período.';
  end if;

  return new;
end;
$$;

create or replace function comercial.set_financial_payroll_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger financial_payroll_imports_updated_at
before update on comercial.financial_payroll_imports
for each row execute function comercial.set_financial_payroll_updated_at();

create trigger financial_payroll_entries_updated_at
before update on comercial.financial_payroll_entries
for each row execute function comercial.set_financial_payroll_updated_at();

create trigger financial_payroll_imports_supersedes_validation
before insert or update of company_id, period_year, period_month, supersedes_import_id
on comercial.financial_payroll_imports
for each row execute function comercial.validate_financial_payroll_supersedes();

comment on table comercial.financial_payroll_imports is
  'Versioned payroll imports; preview data is not persisted here.';
comment on table comercial.financial_payroll_entries is
  'Normalized payroll rows linked to one immutable import version.';
comment on column comercial.financial_payroll_imports.total_labor_cost is
  'Total earnings plus employer contributions; indemnities are already included in total earnings.';

alter table comercial.financial_payroll_imports enable row level security;
alter table comercial.financial_payroll_entries enable row level security;

revoke all on table comercial.financial_payroll_imports, comercial.financial_payroll_entries
  from public, anon, authenticated, service_role;
revoke all on function comercial.validate_financial_payroll_supersedes()
  from public, anon, authenticated, service_role;
revoke all on function comercial.set_financial_payroll_updated_at()
  from public, anon, authenticated, service_role;

grant usage on schema comercial to service_role;
grant select, insert, update on table
  comercial.financial_payroll_imports,
  comercial.financial_payroll_entries
  to service_role;
