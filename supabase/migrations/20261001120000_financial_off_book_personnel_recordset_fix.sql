-- Fix every jsonb_to_recordset use in the off-book personnel classifier.
-- The payload contract is: movement_id, beneficiary_id, payment_concept.
create or replace function comercial.classify_off_book_personnel_movements(
  p_company_id uuid, p_year integer, p_bank_account_id uuid, p_category_id uuid,
  p_classified_by uuid, p_details jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare
  v_count integer;
  v_updated integer;
  v_category_code text;
begin
  if p_year < 2000 or p_year > 2200 then
    raise exception 'Año de auditoría inválido.';
  end if;

  select code into v_category_code
  from comercial.financial_categories
  where company_id = p_company_id and id = p_category_id and is_active;
  if coalesce(v_category_code, '') <> 'EXPENSE_PERSONNEL_OFF_BOOK' then
    raise exception 'La categoría no es la de personal fuera de libro.';
  end if;

  if p_details is null or jsonb_typeof(p_details) <> 'array' or jsonb_array_length(p_details) = 0 then
    raise exception 'Debe indicar el detalle de cada movimiento.';
  end if;

  select count(*) into v_count
  from jsonb_to_recordset(p_details) as d(
    movement_id uuid, beneficiary_id uuid, payment_concept text
  );

  if v_count <> (
    select count(distinct d.movement_id)
    from jsonb_to_recordset(p_details) as d(
      movement_id uuid, beneficiary_id uuid, payment_concept text
    )
  ) then
    raise exception 'No se permiten movimientos repetidos.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_details) as d(
      movement_id uuid, beneficiary_id uuid, payment_concept text
    )
    where d.movement_id is null
       or d.beneficiary_id is null
       or d.payment_concept not in ('SUELDO', 'QUINCENA', 'BONO', 'ANTICIPO', 'OTRO')
  ) then
    raise exception 'Cada movimiento requiere beneficiario y concepto válido.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_details) as d(
      movement_id uuid, beneficiary_id uuid, payment_concept text
    )
    left join comercial.financial_personnel_beneficiaries b
      on b.company_id = p_company_id and b.id = d.beneficiary_id and b.active
    where b.id is null
  ) then
    raise exception 'El beneficiario no pertenece a la empresa activa o está inactivo.';
  end if;

  if (
    select count(*)
    from comercial.financial_bank_movements m
    join jsonb_to_recordset(p_details) as d(
      movement_id uuid, beneficiary_id uuid, payment_concept text
    ) on d.movement_id = m.id
    where m.company_id = p_company_id
      and m.transaction_date >= make_date(p_year, 1, 1)
      and m.transaction_date < make_date(p_year + 1, 1, 1)
      and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
      and m.direction = 'DEBE'
      and coalesce(m.debit_amount, 0) > 0
      and m.category_id is null
  ) <> v_count then
    raise exception 'Uno o más movimientos ya no están pendientes o no pertenecen al alcance.';
  end if;

  update comercial.financial_bank_movements m
  set category_id = p_category_id,
      classification_source = 'MANUAL',
      classification_rule_id = null,
      classified_by = p_classified_by,
      classified_at = now()
  from jsonb_to_recordset(p_details) as d(
    movement_id uuid, beneficiary_id uuid, payment_concept text
  )
  where m.id = d.movement_id
    and m.company_id = p_company_id
    and m.category_id is null;
  get diagnostics v_updated = row_count;

  if v_updated <> v_count then
    raise exception 'La clasificación cambió durante la confirmación.';
  end if;

  insert into comercial.financial_bank_movement_personnel_details(
    movement_id, company_id, beneficiary_id, beneficiary_name_snapshot,
    payment_concept, created_by, updated_by
  )
  select d.movement_id, p_company_id, d.beneficiary_id, b.display_name,
         d.payment_concept, p_classified_by, p_classified_by
  from jsonb_to_recordset(p_details) as d(
    movement_id uuid, beneficiary_id uuid, payment_concept text
  )
  join comercial.financial_personnel_beneficiaries b
    on b.company_id = p_company_id and b.id = d.beneficiary_id and b.active;

  return jsonb_build_object(
    'requestedCount', v_count,
    'classifiedCount', v_updated,
    'omittedCount', 0,
    'errorCount', 0
  );
end;
$$;

revoke all on function comercial.classify_off_book_personnel_movements(uuid, integer, uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function comercial.classify_off_book_personnel_movements(uuid, integer, uuid, uuid, uuid, jsonb) to service_role;
