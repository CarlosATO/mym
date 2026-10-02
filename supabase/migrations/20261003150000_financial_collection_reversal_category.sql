-- Move returned deposited checks out of direct P&L while preserving cash-flow impact.
-- The guarded data correction is intentionally limited to eight Caylo movements.

do $$
declare
  v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
  v_old_category_id uuid;
  v_category_id uuid;
  v_rule_id uuid := 'f980ea37-7bcd-4857-b9f8-1a2168cf5190';
  v_ids uuid[] := array[
    'e3af6847-4012-4394-a5a1-74bb30b3604f'::uuid,
    '026a81ae-5ad6-465f-a995-5d403926d8f5'::uuid,
    '24c999c1-edd4-4bef-b180-230e5aba046e'::uuid,
    '3d327676-fcb2-4af3-8ad0-d1d396b351e4'::uuid,
    'ad01af4c-0a25-4cab-a29d-2d65d6c8a111'::uuid,
    'f4af6f10-b318-4aef-b626-7bb7263e1daa'::uuid,
    '460b30b6-02c6-4c75-990e-8930f91fbbf7'::uuid,
    'db13807a-ee25-4dd6-a9ca-9bb9af4bd63b'::uuid
  ];
  v_count integer;
  v_total numeric;
begin
  select id into v_old_category_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_OTHER';

  if v_old_category_id is null then
    raise exception 'No se encontró EXPENSE_OTHER para Caylo.';
  end if;

  select count(*), coalesce(sum(debit_amount), 0)
    into v_count, v_total
  from comercial.financial_bank_movements
  where company_id = v_company_id
    and id = any(v_ids)
    and category_id = v_old_category_id
    and operation_description = 'CHEQUE DEPOSITADO DEVUELTO';

  if v_count <> 8 or v_total <> 13445447 then
    raise exception 'Guardas de cheques devueltos fallaron: count=%, total=%.', v_count, v_total;
  end if;

  if (select count(*) from unnest(v_ids)) <> 8 then
    raise exception 'La lista de movimientos autorizados no contiene ocho IDs únicos.';
  end if;

  if not exists (
    select 1
    from comercial.financial_bank_classification_rules
    where id = v_rule_id
      and company_id = v_company_id
      and active
      and direction = 'DEBE'
      and match_type = 'EXACT'
      and match_value = 'CHEQUE DEPOSITADO DEVUELTO'
      and mode = 'SUGGEST'
      and category_id = v_old_category_id
  ) then
    raise exception 'La regla de cheques devueltos no coincide con las guardas esperadas.';
  end if;

  select id into v_category_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'COLLECTION_REVERSAL';

  if v_category_id is null then
    insert into comercial.financial_categories (
      company_id, parent_id, code, name, direction, sort_order,
      affects_cash_flow, affects_pnl_directly, classification_group,
      semantic_type, cash_direction
    )
    select v_company_id, parent.id, 'COLLECTION_REVERSAL',
           'Cheques devueltos / reversas de cobranza', 'EXPENSE', 150,
           true, false, 'OPERATING', 'COLLECTION_REVERSAL', 'DEBIT'
    from comercial.financial_categories parent
    where parent.company_id = v_company_id
      and parent.code = 'EXPENSE'
    returning id into v_category_id;
  end if;

  if v_category_id is null then
    raise exception 'No se pudo crear o encontrar COLLECTION_REVERSAL.';
  end if;

  if not exists (
    select 1
    from comercial.financial_categories
    where id = v_category_id
      and company_id = v_company_id
      and code = 'COLLECTION_REVERSAL'
      and name = 'Cheques devueltos / reversas de cobranza'
      and direction = 'EXPENSE'
      and is_active
      and affects_cash_flow
      and not affects_pnl_directly
      and classification_group = 'OPERATING'
      and cash_direction = 'DEBIT'
  ) then
    raise exception 'La categoría COLLECTION_REVERSAL no tiene metadata válida.';
  end if;

  update comercial.financial_bank_movements
  set category_id = v_category_id
  where company_id = v_company_id
    and id = any(v_ids)
    and category_id = v_old_category_id
    and operation_description = 'CHEQUE DEPOSITADO DEVUELTO';

  get diagnostics v_count = row_count;
  if v_count <> 8 then
    raise exception 'La actualización de cheques devueltos afectó % filas.', v_count;
  end if;

  update comercial.financial_bank_classification_rules
  set category_id = v_category_id
  where id = v_rule_id
    and company_id = v_company_id
    and category_id = v_old_category_id
    and active
    and direction = 'DEBE'
    and match_type = 'EXACT'
    and match_value = 'CHEQUE DEPOSITADO DEVUELTO'
    and mode = 'SUGGEST';

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'La actualización de la regla de cheques devueltos afectó % filas.', v_count;
  end if;

  select count(*), coalesce(sum(debit_amount), 0)
    into v_count, v_total
  from comercial.financial_bank_movements
  where company_id = v_company_id
    and id = any(v_ids)
    and category_id = v_category_id
    and operation_description = 'CHEQUE DEPOSITADO DEVUELTO';

  if v_count <> 8 or v_total <> 13445447 then
    raise exception 'Validación final de COLLECTION_REVERSAL falló: count=%, total=%.', v_count, v_total;
  end if;

  select count(*), coalesce(sum(debit_amount), 0)
    into v_count, v_total
  from comercial.financial_bank_movements
  where company_id = v_company_id
    and category_id = v_old_category_id
    and operation_description = 'CHEQUE DEPOSITADO DEVUELTO';

  if v_count <> 0 or v_total <> 0 then
    raise exception 'Quedaron cheques devueltos en EXPENSE_OTHER: count=%, total=%.', v_count, v_total;
  end if;
end;
$$;
