-- Move the four explicitly reviewed miscellaneous expenses to the operating
-- pending bucket without changing cash-flow metadata or classification audit.

do $$
declare
  v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
  v_source_id uuid;
  v_destination_id uuid;
  v_ids uuid[] := array[
    '2dac0efd-a8aa-4880-ad09-073ecf874772'::uuid,
    '46855d72-2e44-4ac0-b391-9ce449635a4a'::uuid,
    '95381475-d3d1-4e01-b0f8-2282fb15fa37'::uuid,
    '4547b71a-43e7-4d15-97d8-17750771e87b'::uuid
  ];
  v_count integer;
  v_total numeric;
begin
  select id into v_source_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_OTHER';

  select id into v_destination_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_OPERATING_PENDING';

  if v_source_id is null or v_destination_id is null then
    raise exception 'No se pudieron resolver las categorias de origen y destino.';
  end if;

  if exists (
    select 1
    from comercial.financial_categories category
    where category.id = v_destination_id
      and (not category.is_active
        or not category.affects_cash_flow
        or category.affects_pnl_directly
        or category.classification_group <> 'OPERATING'
        or category.cash_direction <> 'DEBIT'
        or category.direction <> 'EXPENSE'
        or exists (
          select 1
          from comercial.financial_categories child
          where child.company_id = category.company_id
            and child.parent_id = category.id
            and child.is_active
        )
      )
  ) then
    raise exception 'La categoria destino no tiene metadata valida.';
  end if;

  select count(*)::integer, coalesce(sum(debit_amount), 0)
    into v_count, v_total
  from comercial.financial_bank_movements
  where company_id = v_company_id
    and id = any(v_ids)
    and category_id = v_source_id
    and classification_source = 'BULK_EXACT'
    and classification_rule_id is null;

  if v_count <> 4 or v_total <> 1354008 then
    raise exception 'La guarda de EXPENSE_OTHER fallo: count=%, total=%.', v_count, v_total;
  end if;

  update comercial.financial_bank_movements
  set category_id = v_destination_id
  where company_id = v_company_id
    and id = any(v_ids)
    and category_id = v_source_id;

  get diagnostics v_count = row_count;
  if v_count <> 4 then
    raise exception 'La actualizacion no afecto exactamente cuatro movimientos: %.', v_count;
  end if;

  if exists (
    select 1
    from comercial.financial_bank_movements
    where company_id = v_company_id
      and id = any(v_ids)
      and category_id <> v_destination_id
  ) then
    raise exception 'Uno o mas movimientos no quedaron en la categoria destino.';
  end if;
end;
$$;
