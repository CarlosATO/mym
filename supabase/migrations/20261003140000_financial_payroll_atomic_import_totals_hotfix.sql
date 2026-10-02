-- Hotfix: enforce the explicit snake_case import metadata contract before inserting.

create or replace function comercial.import_financial_payroll_atomic(
  p_company_id uuid,
  p_imported_by uuid,
  p_metadata jsonb,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, comercial, auth, core
as $$
declare
  v_import_id uuid;
  v_imported_count integer;
  v_worker_count integer;
  v_total_earnings bigint;
  v_total_employer_contributions bigint;
  v_total_net_pay bigint;
  v_total_indemnities bigint;
  v_total_labor_cost bigint;
  v_field text;
  v_year integer := (p_metadata->>'period_year')::integer;
  v_month integer := (p_metadata->>'period_month')::integer;
  v_hash text := p_metadata->>'file_hash';
begin
  if p_company_id is null or p_imported_by is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'Importación de remuneraciones inválida.';
  end if;

  foreach v_field in array array[
    'row_count', 'worker_count', 'total_salary', 'total_taxable_earnings', 'total_non_taxable_earnings',
    'total_earnings', 'total_deductions', 'total_worker_contributions', 'total_employer_contributions',
    'total_net_pay', 'total_indemnities', 'total_labor_cost', 'recurring_labor_cost'
  ] loop
    if not (p_metadata ? v_field)
      or jsonb_typeof(p_metadata->v_field) <> 'number'
      or (p_metadata->>v_field) !~ '^-?[0-9]+$' then
      raise exception 'PAYROLL_METADATA_FIELD_MISSING:%', v_field;
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || v_year::text || ':' || v_month::text, 0));

  if exists (select 1 from comercial.financial_payroll_imports where company_id = p_company_id and file_hash = v_hash) then
    raise exception 'Este archivo ya fue importado.';
  end if;

  if exists (select 1 from comercial.financial_payroll_imports where company_id = p_company_id and period_year = v_year and period_month = v_month and status = 'IMPORTED') then
    raise exception 'Este período ya tiene una importación activa.';
  end if;

  insert into comercial.financial_payroll_imports (
    company_id, period_year, period_month, source_filename, file_hash, source_format, source_encoding,
    status, row_count, worker_count, total_salary, total_taxable_earnings, total_non_taxable_earnings,
    total_earnings, total_deductions, total_worker_contributions, total_employer_contributions,
    total_net_pay, total_indemnities, total_labor_cost, recurring_labor_cost,
    validation_summary, imported_at, imported_by
  ) values (
    p_company_id, v_year, v_month, p_metadata->>'source_filename', v_hash, p_metadata->>'source_format', p_metadata->>'source_encoding',
    'IMPORTED', (p_metadata->>'row_count')::integer, (p_metadata->>'worker_count')::integer,
    (p_metadata->>'total_salary')::bigint, (p_metadata->>'total_taxable_earnings')::bigint,
    (p_metadata->>'total_non_taxable_earnings')::bigint, (p_metadata->>'total_earnings')::bigint,
    (p_metadata->>'total_deductions')::bigint, (p_metadata->>'total_worker_contributions')::bigint,
    (p_metadata->>'total_employer_contributions')::bigint, (p_metadata->>'total_net_pay')::bigint,
    (p_metadata->>'total_indemnities')::bigint, (p_metadata->>'total_labor_cost')::bigint,
    (p_metadata->>'recurring_labor_cost')::bigint, coalesce(p_metadata->'validation_summary', '{}'::jsonb), now(), p_imported_by
  ) returning id into v_import_id;

  insert into comercial.financial_payroll_entries (
    import_id, company_id, source_row_number, line_sequence, worker_rut_original, worker_rut_normalized,
    worker_name_snapshot, contract_start_date, contract_end_date, days_worked, medical_leave_days, vacation_days,
    salary, gratification, business_salary, meal_allowance, transport_allowance, travel_allowance, family_allowance,
    holiday_indemnity, worker_pension, worker_health, worker_afc, income_tax, advances, employer_afc,
    employer_accident_sanna, employer_sis, total_earnings, taxable_earnings, non_taxable_earnings,
    non_taxable_taxable_earnings, total_deductions, total_worker_contributions, total_income_tax,
    total_other_deductions, total_employer_contributions, net_pay, total_indemnities, taxable_indemnities,
    non_taxable_indemnities
  )
  select v_import_id, p_company_id, e.source_row_number, 1, e.worker_rut_original, e.worker_rut_normalized,
    null, e.contract_start_date, e.contract_end_date, e.days_worked, e.medical_leave_days, e.vacation_days,
    e.salary, e.gratification, e.business_salary, e.meal_allowance, e.transport_allowance, e.travel_allowance,
    e.family_allowance, e.holiday_indemnity, e.worker_pension, e.worker_health, e.worker_afc, e.income_tax,
    e.advances, e.employer_afc, e.employer_accident_sanna, e.employer_sis, e.total_earnings, e.taxable_earnings,
    e.non_taxable_earnings, e.non_taxable_taxable_earnings, e.total_deductions, e.total_worker_contributions,
    e.total_income_tax, e.total_other_deductions, e.total_employer_contributions, e.net_pay, e.total_indemnities,
    e.taxable_indemnities, e.non_taxable_indemnities
  from jsonb_to_recordset(p_entries) as e(
    source_row_number integer, worker_rut_original text, worker_rut_normalized text,
    contract_start_date date, contract_end_date date, days_worked integer, medical_leave_days integer, vacation_days integer,
    salary bigint, gratification bigint, business_salary bigint, meal_allowance bigint, transport_allowance bigint,
    travel_allowance bigint, family_allowance bigint, holiday_indemnity bigint, worker_pension bigint,
    worker_health bigint, worker_afc bigint, income_tax bigint, advances bigint, employer_afc bigint,
    employer_accident_sanna bigint, employer_sis bigint, total_earnings bigint, taxable_earnings bigint,
    non_taxable_earnings bigint, non_taxable_taxable_earnings bigint, total_deductions bigint,
    total_worker_contributions bigint, total_income_tax bigint, total_other_deductions bigint,
    total_employer_contributions bigint, net_pay bigint, total_indemnities bigint, taxable_indemnities bigint,
    non_taxable_indemnities bigint
  );

  select count(*), count(distinct worker_rut_normalized), coalesce(sum(total_earnings), 0), coalesce(sum(total_employer_contributions), 0),
    coalesce(sum(net_pay), 0), coalesce(sum(total_indemnities), 0), coalesce(sum(total_earnings + total_employer_contributions), 0)
  into v_imported_count, v_worker_count, v_total_earnings, v_total_employer_contributions, v_total_net_pay, v_total_indemnities, v_total_labor_cost
  from comercial.financial_payroll_entries where import_id = v_import_id;

  if v_imported_count <> (p_metadata->>'row_count')::integer or v_worker_count <> (p_metadata->>'worker_count')::integer
    or v_total_earnings <> (p_metadata->>'total_earnings')::bigint or v_total_employer_contributions <> (p_metadata->>'total_employer_contributions')::bigint
    or v_total_net_pay <> (p_metadata->>'total_net_pay')::bigint or v_total_indemnities <> (p_metadata->>'total_indemnities')::bigint
    or v_total_labor_cost <> (p_metadata->>'total_labor_cost')::bigint then
    raise exception 'La verificación post-inserción no coincide.';
  end if;

  return jsonb_build_object('import_id', v_import_id, 'row_count', v_imported_count, 'worker_count', v_worker_count);
end;
$$;

revoke all on function comercial.import_financial_payroll_atomic(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function comercial.import_financial_payroll_atomic(uuid, uuid, jsonb, jsonb) to service_role;
