-- Reclassify the 2026 operating-expense movements using an exact, guarded scope.
-- This preserves cash-flow impact and removes non-expense operating items from direct P&L.

do $$
declare
  v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
  v_operating_id uuid;
  v_old_category_id uuid;
  v_software_id uuid;
  v_office_id uuid;
  v_vehicle_id uuid;
  v_notary_id uuid;
  v_pending_id uuid;
  v_agrovet_id uuid;
  v_count integer;
  v_total numeric;
  v_ids uuid[];
begin
  select id into v_operating_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_OPERATING';

  v_old_category_id := v_operating_id;

  if v_old_category_id is null then
    raise exception 'No se encontro EXPENSE_OPERATING.';
  end if;

  -- The exact groups are represented by the existing classification rules.
  if (
    select count(*)
    from comercial.financial_bank_movements
    where company_id = v_company_id
      and category_id = v_old_category_id
      and transaction_date >= date '2026-01-01'
      and transaction_date < date '2027-01-01'
  ) <> 53 then
    raise exception 'La cantidad inicial de gastos operacionales no es 53.';
  end if;

  if (
    select coalesce(sum(debit_amount), 0)
    from comercial.financial_bank_movements
    where company_id = v_company_id
      and category_id = v_old_category_id
      and transaction_date >= date '2026-01-01'
      and transaction_date < date '2027-01-01'
  ) <> 20486656 then
    raise exception 'El total inicial de gastos operacionales no es 20486656.';
  end if;

  if (
    select count(*)
    from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id in (
        'ccc90c45-93b3-4822-b16b-28fe90952f72',
        '20072705-5311-4b0c-af6e-1985551886fe',
        '89de48d1-a635-43ef-a20c-c31aa042d98c',
        '2e40b98d-7ecc-4e73-8250-529c6818c003',
        'bcdab527-78e2-4874-864c-6301509f1f3c',
        'e4d330b5-c1eb-4ba8-9062-b3990178819a',
        '0d75b6d0-c1ef-46fe-aed7-c43e66a94d10',
        '5356e225-3a28-472f-a615-4541335ae990',
        'fdd74bbe-bd72-48c7-b791-e2e6647b4d4b'
      )
      and active
      and direction = 'DEBE'
      and match_type = 'EXACT'
      and mode = 'SUGGEST'
      and category_id = v_old_category_id
  ) <> 9 then
    raise exception 'Las nueve reglas de gastos operacionales no coinciden con las guardas.';
  end if;

  -- Create destination leaf categories only if they do not already exist.
  insert into comercial.financial_categories (
    company_id, parent_id, code, name, direction, sort_order,
    affects_cash_flow, affects_pnl_directly, classification_group,
    semantic_type, cash_direction
  )
  values
    (v_company_id, v_operating_id, 'EXPENSE_SOFTWARE_SUBSCRIPTIONS', 'Suscripciones de software', 'EXPENSE', 160, true, true, 'OPERATING', null, 'DEBIT'),
    (v_company_id, v_operating_id, 'EXPENSE_OFFICE_CONSUMPTION', 'Consumos de oficina', 'EXPENSE', 170, true, true, 'OPERATING', null, 'DEBIT'),
    (v_company_id, v_operating_id, 'EXPENSE_VEHICLE_OPERATING', 'Gastos operacionales de vehiculos', 'EXPENSE', 180, true, true, 'OPERATING', null, 'DEBIT'),
    (v_company_id, v_operating_id, 'EXPENSE_NOTARY', 'Gastos notariales', 'EXPENSE', 190, true, true, 'OPERATING', null, 'DEBIT'),
    (v_company_id, v_operating_id, 'EXPENSE_OPERATING_PENDING', 'Gastos operacionales pendientes de identificar', 'EXPENSE', 200, true, false, 'OPERATING', null, 'DEBIT'),
    (v_company_id, v_operating_id, 'EXPENSE_AGROVET_PENDING', 'Agrovet pendiente de identificar', 'EXPENSE', 210, true, false, 'OPERATING', null, 'DEBIT')
  on conflict (company_id, code) do nothing;

  select id into v_software_id from comercial.financial_categories where company_id = v_company_id and code = 'EXPENSE_SOFTWARE_SUBSCRIPTIONS';
  select id into v_office_id from comercial.financial_categories where company_id = v_company_id and code = 'EXPENSE_OFFICE_CONSUMPTION';
  select id into v_vehicle_id from comercial.financial_categories where company_id = v_company_id and code = 'EXPENSE_VEHICLE_OPERATING';
  select id into v_notary_id from comercial.financial_categories where company_id = v_company_id and code = 'EXPENSE_NOTARY';
  select id into v_pending_id from comercial.financial_categories where company_id = v_company_id and code = 'EXPENSE_OPERATING_PENDING';
  select id into v_agrovet_id from comercial.financial_categories where company_id = v_company_id and code = 'EXPENSE_AGROVET_PENDING';

  if v_software_id is null or v_office_id is null or v_vehicle_id is null
     or v_notary_id is null or v_pending_id is null or v_agrovet_id is null then
    raise exception 'No se pudieron resolver las categorias destino.';
  end if;

  if exists (
    select 1
    from comercial.financial_categories
    where company_id = v_company_id
      and code in ('EXPENSE_SOFTWARE_SUBSCRIPTIONS', 'EXPENSE_OFFICE_CONSUMPTION', 'EXPENSE_VEHICLE_OPERATING', 'EXPENSE_NOTARY')
      and (not is_active or not affects_cash_flow or not affects_pnl_directly or classification_group <> 'OPERATING' or cash_direction <> 'DEBIT' or direction <> 'EXPENSE' or parent_id <> v_operating_id)
  ) or exists (
    select 1
    from comercial.financial_categories
    where company_id = v_company_id
      and code in ('EXPENSE_OPERATING_PENDING', 'EXPENSE_AGROVET_PENDING')
      and (not is_active or not affects_cash_flow or affects_pnl_directly or classification_group <> 'OPERATING' or cash_direction <> 'DEBIT' or direction <> 'EXPENSE' or parent_id <> v_operating_id)
  ) then
    raise exception 'Las categorias destino no tienen metadata valida.';
  end if;

  -- Fixed movement sets. Each guard checks old category, rule, count and amount.
  v_ids := array['42eeb20c-2684-4c13-b744-d96d8d887a21'::uuid, '8f1174d9-97e5-483a-aca4-a2ad94a24c83'::uuid, '05e9b78b-7eb8-452d-b93e-cc606aba450e'::uuid, '4c609335-3ad3-49c7-ba5f-2371549820f4'::uuid, '67487f71-e102-48c5-a37c-0f6b03e91230'::uuid, '79382f69-7f2a-4114-8970-be836166c035'::uuid, '9bdd48cc-f729-4465-aa7d-28f8ad105a2e'::uuid, '13a4ce52-091b-44a9-8a35-d5f7513264f9'::uuid, 'b1bee6bb-b8a9-4a98-a67e-0fb93f47e06a'::uuid];
  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id and classification_rule_id = '0d75b6d0-c1ef-46fe-aed7-c43e66a94d10') <> 9 or (select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id) <> 819664 then raise exception 'Guardas de Bsale fallaron.'; end if;
  update comercial.financial_bank_movements set category_id = v_software_id where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id;

  v_ids := array['bb20f5a3-98a0-42c0-9c5f-3f93c6d64aa8'::uuid, 'bd5b1e75-b94f-4d2c-9709-1465e565c9ca'::uuid, 'bfbb2d51-4ab6-43f6-92c1-43ded04fa157'::uuid, 'c4bc5b1f-28d5-4722-9ad2-56b56067bafc'::uuid, 'deae1cdc-a19e-4465-9895-68d73adaf285'::uuid, 'e3d47423-734b-4d55-aff9-deaecb7c6c99'::uuid, 'f8124afc-1d93-4e9f-9a4d-097282d083d7'::uuid];
  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id and classification_rule_id = 'fdd74bbe-bd72-48c7-b791-e2e6647b4d4b') <> 7 or (select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id) <> 142599 then raise exception 'Guardas de agua fallaron.'; end if;
  update comercial.financial_bank_movements set category_id = v_office_id where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id;

  v_ids := array['b4a8cbca-cff0-4047-9bf9-0772e5eba38f'::uuid];
  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id and classification_rule_id = '20072705-5311-4b0c-af6e-1985551886fe') <> 1 or (select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id) <> 107008 then raise exception 'Guardas de Copec fallaron.'; end if;
  update comercial.financial_bank_movements set category_id = v_vehicle_id where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id;

  v_ids := array['86606fa1-92d2-4e68-850f-c07b1c17f5cb'::uuid];
  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id and classification_rule_id = '2e40b98d-7ecc-4e73-8250-529c6818c003') <> 1 then raise exception 'Guardas de notaria fallaron.'; end if;
  update comercial.financial_bank_movements set category_id = v_notary_id where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id;

  v_ids := array['fc61e620-8c49-4e00-bf1d-38dca099b625'::uuid];
  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id and classification_rule_id = '5356e225-3a28-472f-a615-4541335ae990') <> 1 then raise exception 'Guardas de Agrovet fallaron.'; end if;
  update comercial.financial_bank_movements set category_id = v_agrovet_id where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id;

  v_ids := array['11de139a-6107-4150-a89e-01275445e1b5'::uuid, '36095c3d-49bf-432c-aacc-e58df4a2908a'::uuid, '3eed2768-4e6e-4cb1-bd5c-caf99d6f8c28'::uuid, '470f4e73-9a42-47a0-baa1-1a2b0395346a'::uuid, '567c924a-156e-4745-904b-b63c3ae694ed'::uuid, '6985dcfa-fa79-4159-8bc7-38752b908f16'::uuid, '6a763529-8689-4c86-a6e7-f8483afb6efd'::uuid, '8b548a18-c5c6-4f6b-92f7-c5869168963a'::uuid, 'b1287fa4-3549-43e7-8728-ef75235a1183'::uuid, 'b1abb209-3e74-4d18-8a2d-a089177792db'::uuid, 'c946d391-2a7e-48bd-8e2c-b590d3a4b91a'::uuid, 'decc0ae4-8868-4a71-bf42-78f44d4c899c'::uuid];
  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id and classification_rule_id = 'e4d330b5-c1eb-4ba8-9062-b3990178819a') <> 12 or (select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id) <> 12082924 then raise exception 'Guardas de recaudacion fallaron.'; end if;
  update comercial.financial_bank_movements set category_id = v_pending_id where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id;

  v_ids := array['1caceda4-c025-48e1-9974-b96ac5b89c37'::uuid, '673d5eb5-a16b-4f1c-abd5-dc3f4cf4ef8b'::uuid, 'a17f1394-d086-4f3e-9e2c-0fabac205fe4'::uuid, 'd6be73fb-2940-47a8-9ea9-f617bbcb5ab4'::uuid, '002ae0b2-9bcd-4eec-b834-0af6c86864ac'::uuid, 'bed1f2cf-0c61-4ea7-916b-a81984002ee8'::uuid, 'e031a56b-c34d-4848-bfa0-51e73b5246d0'::uuid, '81df7877-572b-46b2-9ab3-90a774643425'::uuid, 'b103271a-9d56-42cc-b783-f544464d5147'::uuid, 'b9bdd4c2-ed37-49cf-bb3a-2759d9e53814'::uuid, 'd313afa2-eb89-4b0c-925d-8c24d38deac8'::uuid, 'e84d5ca1-72b5-495a-a5c1-8d8a6c2d928f'::uuid, 'd948643d-ccac-408e-81f5-21feaaea688e'::uuid, 'e096301a-1ea9-4c7c-90e1-87cc7cc9243f'::uuid, '24fb472e-414c-4770-b8f5-3a49935754bf'::uuid, '50b30197-92fa-4926-a520-35f681be2f52'::uuid, '71ab9fa6-b5ed-40a8-8287-e4376e8615d7'::uuid, '6291dae1-56a6-445b-8322-b95dcc9fc096'::uuid, '5ef225b6-0017-4bc4-bdfb-29e3f8032ad6'::uuid];
  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id and classification_rule_id = 'ccc90c45-93b3-4822-b16b-28fe90952f72') <> 19 or (select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id) <> 6510517 then raise exception 'Guardas de Servipag fallaron.'; end if;
  update comercial.financial_bank_movements set category_id = v_pending_id where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id;

  v_ids := array['3a4a01cc-7ec0-4f08-85ae-839455a0a8af'::uuid, 'd5e642c6-8d75-4e27-bc35-50289ffa0713'::uuid];
  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id and classification_rule_id = 'bcdab527-78e2-4874-864c-6301509f1f3c') <> 2 then raise exception 'Guardas de Mercadoli fallaron.'; end if;
  update comercial.financial_bank_movements set category_id = v_pending_id where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id;

  v_ids := array['484315c4-bd4c-447d-b2c6-162eb3d4f03c'::uuid];
  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id and classification_rule_id = '89de48d1-a635-43ef-a20c-c31aa042d98c') <> 1 then raise exception 'Guardas de Ilumiled fallaron.'; end if;
  update comercial.financial_bank_movements set category_id = v_pending_id where company_id = v_company_id and id = any(v_ids) and category_id = v_old_category_id;

  -- Keep the rules synchronized with their movement destinations.
  update comercial.financial_bank_classification_rules set category_id = v_software_id where company_id = v_company_id and id = '0d75b6d0-c1ef-46fe-aed7-c43e66a94d10';
  update comercial.financial_bank_classification_rules set category_id = v_office_id where company_id = v_company_id and id = 'fdd74bbe-bd72-48c7-b791-e2e6647b4d4b';
  update comercial.financial_bank_classification_rules set category_id = v_vehicle_id where company_id = v_company_id and id = '20072705-5311-4b0c-af6e-1985551886fe';
  update comercial.financial_bank_classification_rules set category_id = v_notary_id where company_id = v_company_id and id = '2e40b98d-7ecc-4e73-8250-529c6818c003';
  update comercial.financial_bank_classification_rules set category_id = v_pending_id where company_id = v_company_id and id in ('ccc90c45-93b3-4822-b16b-28fe90952f72', 'e4d330b5-c1eb-4ba8-9062-b3990178819a', 'bcdab527-78e2-4874-864c-6301509f1f3c', '89de48d1-a635-43ef-a20c-c31aa042d98c');
  update comercial.financial_bank_classification_rules set category_id = v_agrovet_id where company_id = v_company_id and id = '5356e225-3a28-472f-a615-4541335ae990';

  select count(*), coalesce(sum(debit_amount), 0)
    into v_count, v_total
  from comercial.financial_bank_movements
  where company_id = v_company_id
    and transaction_date >= date '2026-01-01'
    and transaction_date < date '2027-01-01'
    and category_id in (v_software_id, v_office_id, v_vehicle_id, v_notary_id, v_pending_id, v_agrovet_id);

  if v_count <> 53 or v_total <> 20486656 then
    raise exception 'La validacion final de movimientos fallo: count=%, total=%.', v_count, v_total;
  end if;

  if (select count(*) from comercial.financial_bank_movements where company_id = v_company_id and category_id = v_old_category_id and transaction_date >= date '2026-01-01' and transaction_date < date '2027-01-01') <> 0 then
    raise exception 'Quedaron movimientos en EXPENSE_OPERATING.';
  end if;

  if (select count(*) from comercial.financial_bank_classification_rules where company_id = v_company_id and id in ('ccc90c45-93b3-4822-b16b-28fe90952f72','20072705-5311-4b0c-af6e-1985551886fe','89de48d1-a635-43ef-a20c-c31aa042d98c','2e40b98d-7ecc-4e73-8250-529c6818c003','bcdab527-78e2-4874-864c-6301509f1f3c','e4d330b5-c1eb-4ba8-9062-b3990178819a','0d75b6d0-c1ef-46fe-aed7-c43e66a94d10','5356e225-3a28-472f-a615-4541335ae990','fdd74bbe-bd72-48c7-b791-e2e6647b4d4b') and category_id = v_old_category_id) <> 0 then
    raise exception 'Quedaron reglas apuntando a EXPENSE_OPERATING.';
  end if;
end;
$$;
