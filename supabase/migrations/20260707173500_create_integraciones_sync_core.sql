-- 20260707173500_create_integraciones_sync_core.sql

-- Tabla integraciones.sync_runs
create table if not exists integraciones.sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id),
  provider text not null,              -- BSALE
  entity text not null,                -- clients / products / product_types / sales_documents / payments
  trigger_type text not null,          -- MANUAL / SCHEDULED / CLI / API
  status text not null,                -- RUNNING / SUCCESS / FAILED / SKIPPED
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  duration_ms integer null,
  read_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  message text null,
  metadata jsonb not null default '{}'::jsonb,
  requested_by uuid null references portal.users(id),
  created_at timestamptz not null default now(),
  
  constraint chk_provider_not_empty check (provider <> ''),
  constraint chk_entity_not_empty check (entity <> ''),
  constraint chk_status check (status in ('RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED')),
  constraint chk_trigger_type check (trigger_type in ('MANUAL', 'SCHEDULED', 'CLI', 'API'))
);

create index if not exists idx_sync_runs_company on integraciones.sync_runs(company_id);
create index if not exists idx_sync_runs_provider_entity on integraciones.sync_runs(provider, entity);
create index if not exists idx_sync_runs_status on integraciones.sync_runs(status);
create index if not exists idx_sync_runs_started on integraciones.sync_runs(started_at desc);
create index if not exists idx_sync_runs_compound on integraciones.sync_runs(company_id, provider, entity, started_at desc);

-- Tabla integraciones.sync_locks
create table if not exists integraciones.sync_locks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id),
  provider text not null,
  entity text not null,
  locked_at timestamptz not null default now(),
  locked_by text null,
  expires_at timestamptz not null,
  sync_run_id uuid null references integraciones.sync_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  
  constraint uq_sync_locks unique (company_id, provider, entity)
);

create index if not exists idx_sync_locks_company on integraciones.sync_locks(company_id);
create index if not exists idx_sync_locks_provider_entity on integraciones.sync_locks(provider, entity);
create index if not exists idx_sync_locks_expires on integraciones.sync_locks(expires_at);

-- Tabla integraciones.sync_errors
create table if not exists integraciones.sync_errors (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid not null references integraciones.sync_runs(id) on delete cascade,
  company_id uuid not null references core.companies(id),
  provider text not null,
  entity text not null,
  external_id text null,
  error_code text null,
  error_message text not null,
  safe_payload jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sync_errors_run on integraciones.sync_errors(sync_run_id);
create index if not exists idx_sync_errors_company_provider on integraciones.sync_errors(company_id, provider, entity);
create index if not exists idx_sync_errors_created on integraciones.sync_errors(created_at desc);

-- Tabla integraciones.sync_job_configs
create table if not exists integraciones.sync_job_configs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id),
  provider text not null,
  entity text not null,
  is_enabled boolean not null default true,
  frequency_minutes integer not null,
  last_run_at timestamptz null,
  last_success_at timestamptz null,
  last_failure_at timestamptz null,
  next_run_at timestamptz null,
  last_status text null,
  last_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  constraint uq_sync_job_configs unique (company_id, provider, entity),
  constraint chk_frequency_positive check (frequency_minutes > 0)
);

-- Habilitar RLS
alter table integraciones.sync_runs enable row level security;
alter table integraciones.sync_locks enable row level security;
alter table integraciones.sync_errors enable row level security;
alter table integraciones.sync_job_configs enable row level security;

-- Políticas estándar user_company_access
create policy "Usuarios ven sync_runs de su empresa"
on integraciones.sync_runs for select
using (company_id in (select company_id from core.user_company_access where user_id = auth.uid()));

create policy "Usuarios ven sync_locks de su empresa"
on integraciones.sync_locks for select
using (company_id in (select company_id from core.user_company_access where user_id = auth.uid()));

create policy "Usuarios ven sync_errors de su empresa"
on integraciones.sync_errors for select
using (company_id in (select company_id from core.user_company_access where user_id = auth.uid()));

create policy "Usuarios ven sync_job_configs de su empresa"
on integraciones.sync_job_configs for select
using (company_id in (select company_id from core.user_company_access where user_id = auth.uid()));

-- (Insert/Update/Delete estarán protegidas por defecto a Service Role)

-- Configuración inicial idempotente (Base company)
insert into integraciones.sync_job_configs (company_id, provider, entity, is_enabled, frequency_minutes)
values ('d1000000-0000-0000-0000-000000000001', 'BSALE', 'clients', true, 30)
on conflict (company_id, provider, entity) do nothing;

-- Permisos sobre las tablas nuevas
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.sync_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.sync_runs TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.sync_locks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.sync_locks TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.sync_errors TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.sync_errors TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.sync_job_configs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.sync_job_configs TO service_role;
