-- Final Caylo financial cash-flow category and P&L normalization.
-- This migration is intentionally ID-scoped and aborts on any catalog or data drift.
do $$
declare
  v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
  v_interest_movement_id uuid := '2bce1c32-fad7-409f-963c-191e0e1b9fd7';

  v_expense_id uuid;
  v_operating_id uuid;
  v_non_operating_id uuid;
  v_social_id uuid;
  v_owner_withdrawal_id uuid;
  v_taxes_id uuid;
  v_insurance_id uuid;
  v_telecom_id uuid;
  v_external_services_id uuid;
  v_interest_category_id uuid;

  v_previred_ids uuid[] := array[
    '4de1be52-eba1-442c-b24b-8a5f2852d4b6',
    '3c68913a-9482-4161-b255-4f77c1fe93cc',
    '3722efc8-0f1c-4466-894e-bc6048682504',
    '54160980-6b99-41b8-9b6d-693073581b34',
    '1ebeb8b6-f3c9-4a7f-a21f-6f54e2039142',
    '81c800a8-b5fc-4b40-b18c-059665a0183c',
    '07526212-6968-4ec9-b1aa-afc7b0e7ffff',
    '74abd639-1c05-4fbd-a5bd-0e72a1522640',
    '0ea1b1f3-9dbe-4726-ad36-9bb5de789257'
  ]::uuid[];

  v_auto_insurance_ids uuid[] := array[
    '6d5915d9-96b3-48e3-91a5-1f0741c2e05a',
    'd225656a-036c-4542-961f-561bca617082',
    '5f000d91-7856-4bed-900c-02063587a076',
    '72e0f2f2-b937-4d0a-8d7c-84423ea5aace',
    'bfa3cd40-3f20-419e-aee1-e7715c2887bc',
    'be3551b2-4628-4284-a117-5fddd8f2ec34',
    '19a720e9-dd2b-4e48-87f5-3c89eb92891f',
    '23b5b610-97c2-4d0e-b7a7-9763de4373d6',
    '3f70b66e-1d70-4c6c-b973-1a55c4239454',
    '5caf82f0-ca47-428f-941b-5b1c04284075',
    '9bd19a40-1505-42fd-a481-de59034091d6',
    'c3246b29-7653-4d3b-b5a2-662c0529e659',
    '800ef03e-d03a-4ed8-80bc-c2051eb358a7',
    '4fbaed4c-00c8-4aea-98f8-4c24ba780795',
    '5b4ab1c5-4b97-4cd1-811d-c5faeebe8dbc',
    '20b62254-fa6c-4ff8-808d-c7350c91e95c',
    '2658eb18-cbbb-41b0-99cb-ba0fd651ea38'
  ]::uuid[];

  v_zurich_ids uuid[] := array[
    'd61bff70-bded-4dc1-924d-a69facbd2f30',
    '3a1fd128-62a6-4bef-aeef-7e084935e127',
    '65bb1493-76e0-400d-98b2-91a9d2779550',
    '0e1f9ca1-5967-4b20-8f70-675cba7903bc',
    '7c623119-b063-4664-a191-45b09c622d9b',
    '89979b66-f513-4fdf-b63a-b77de20036e5',
    '036f83fe-32e0-42c6-b247-d2888229bec7'
  ]::uuid[];

  v_starlink_ids uuid[] := array[
    '2121e693-b94b-4205-bdb4-c68dcb1e2b09',
    '8da336b4-5bbb-49e0-8ced-213594517ea0',
    'e3ddb3a0-0997-45aa-9c24-e48a56ce8c77',
    '55c85f93-cd68-4488-aee8-4fdf5e8a9fd9',
    '54d39ec6-12eb-43ed-8e65-105091e6f0ae',
    '6263c5fa-e12c-41c0-9389-af7a8c378a30',
    'dc8d418f-317c-4366-bcfb-84fe2c5559e0',
    '5a45b6fe-e681-4918-9e55-1bea22cc6cf4',
    '8dcfa6fa-fd4c-4822-af09-438f3b155272'
  ]::uuid[];

  v_mauricio_ids uuid[] := array[
    'd50f0b9c-0d94-4d88-a244-d32be9447dcb',
    'c6610b76-d180-473a-b042-794c9993c135',
    '007c81cc-93e6-4fce-87a4-2d81e1db7ed5',
    '0ae7a3ad-2aae-464a-b24b-98071a7dc20e',
    '66f6a169-d985-4609-ac93-b6fb1b6153d6',
    '9f70e327-e142-4c6c-9daa-3ce9ea82ccd9',
    'd3f9e5b7-76db-4544-b0ee-20c06d2b9405',
    'e5c68834-0f6e-4e02-b87e-e1f03b81a341',
    '2547f3e2-d98a-4b3e-b831-b9218fddbf2f',
    'b502f41b-c450-4f6b-a752-8093cfb95428',
    '177051af-f58d-4941-a949-d64f630ebb3b'
  ]::uuid[];

  v_vector_ids uuid[] := array[
    'edc4a39c-6d09-4c3e-a4a9-084cfdb3f6a0',
    '07cbde5d-664a-4bc0-818e-1fb5ff5f5ee1',
    '93317492-1897-4661-9b90-a7b172c0fcfd',
    'aef2c782-36e3-4826-b6f8-81feebd4438d',
    'c0c51d1d-b8b7-4e01-a1f0-c0b5be4768fe',
    'c4ff507c-611d-4a38-b806-c19dcc978816'
  ]::uuid[];

  v_all_movement_ids uuid[];
  v_rule_ids uuid[] := array[
    'c322731c-4685-448a-a7f4-e5836c76c5be',
    '71689d1f-110f-4b67-8632-0653ada12015',
    '5ddc85db-f32f-4cda-8603-aaed9ca780ac',
    '8f079547-7d92-400c-bbfc-776225edbb43',
    'b08632a7-b3ad-421c-9475-99cf05b63821',
    '4825ea84-7fe4-4bfd-948d-0e2b3d0071ff',
    '8218c59f-8aaf-4a7c-a3a6-724d3a45f846',
    'c6647f4d-aaa3-4619-b727-560396a604e0',
    '3683b77c-4b43-43e5-b2f5-aeaa95ec31f7'
  ]::uuid[];

  v_expected_category_id uuid;
begin
  v_all_movement_ids := v_previred_ids
    || v_auto_insurance_ids
    || v_zurich_ids
    || v_starlink_ids
    || v_mauricio_ids
    || v_vector_ids
    || array[v_interest_movement_id]::uuid[];

  if cardinality(v_all_movement_ids) <> 60
     or (select count(distinct id) from unnest(v_all_movement_ids) as x(id)) <> 60 then
    raise exception 'Guard global de movimientos falló: se esperaban 60 IDs distintos.';
  end if;

  select id into v_expense_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE';

  select id into v_operating_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_OPERATING';

  select id into v_non_operating_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_NON_OPERATING';

  select id into v_social_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_SALARIES_SOCIAL';

  select id into v_owner_withdrawal_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_OWNER_WITHDRAWAL';

  select id into v_taxes_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_TAXES';

  if v_expense_id is null or v_operating_id is null
     or v_non_operating_id is null or v_social_id is null
     or v_owner_withdrawal_id is null or v_taxes_id is null then
    raise exception 'Faltan categorías base requeridas.';
  end if;

  if exists (
    select 1
    from comercial.financial_categories
    where company_id = v_company_id
      and code in (
        'EXPENSE_INSURANCE',
        'EXPENSE_TELECOM',
        'EXPENSE_EXTERNAL_SERVICES',
        'EXPENSE_FINANCIAL_INTEREST'
      )
  ) then
    raise exception 'Una categoría nueva ya existe; se aborta para evitar redefinición silenciosa.';
  end if;

  if (
    select count(*)
    from comercial.financial_bank_movements
    where company_id = v_company_id
      and id = any(v_all_movement_ids)
  ) <> 60
  or exists (
    select 1
    from comercial.financial_bank_movements
    where id = any(v_all_movement_ids)
      and (company_id <> v_company_id or direction <> 'DEBE')
  ) then
    raise exception 'Guard global de company_id/direction falló.';
  end if;

  if (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_previred_ids)
      and category_id = v_operating_id
  ) <> 9
  or (
    select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_previred_ids)
  ) <> 17214926 then
    raise exception 'Guard Previred falló.';
  end if;

  if (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_auto_insurance_ids)
      and category_id = v_owner_withdrawal_id
  ) <> 17
  or (
    select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_auto_insurance_ids)
  ) <> 2948761 then
    raise exception 'Guard seguro automotriz falló.';
  end if;

  if (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_zurich_ids)
      and category_id = v_operating_id
  ) <> 7
  or (
    select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_zurich_ids)
  ) <> 490704 then
    raise exception 'Guard Zurich falló.';
  end if;

  if (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_starlink_ids)
      and category_id = v_operating_id
  ) <> 9
  or (
    select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_starlink_ids)
  ) <> 647996 then
    raise exception 'Guard Starlink falló.';
  end if;

  if (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_mauricio_ids)
      and category_id = v_operating_id
  ) <> 11
  or (
    select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_mauricio_ids)
  ) <> 7994602 then
    raise exception 'Guard Mauricio Ramos falló.';
  end if;

  if (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_vector_ids)
      and category_id = v_operating_id
  ) <> 6
  or (
    select coalesce(sum(debit_amount), 0) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_vector_ids)
  ) <> 499800 then
    raise exception 'Guard Vector Web falló.';
  end if;

  if (
       select count(*) from comercial.financial_bank_movements
       where company_id = v_company_id
         and id = v_interest_movement_id
         and category_id = v_taxes_id
         and debit_amount = 16466
     ) <> 1 then
    raise exception 'Guard interés sobregiro falló.';
  end if;

  if (
    select count(*)
    from comercial.financial_bank_classification_rules
    where company_id = v_company_id and id = any(v_rule_ids)
  ) <> 9
  or exists (
    select 1
    from comercial.financial_bank_classification_rules
    where id = any(v_rule_ids)
      and (company_id <> v_company_id or match_type <> 'EXACT' or mode <> 'SUGGEST')
  ) then
    raise exception 'Guard de las 9 reglas falló.';
  end if;

  if (
    select count(*) from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id = 'c322731c-4685-448a-a7f4-e5836c76c5be'
      and category_id = v_operating_id
  ) <> 1
  or (
    select count(*) from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id = '71689d1f-110f-4b67-8632-0653ada12015'
      and category_id = v_owner_withdrawal_id
  ) <> 1
  or (
    select count(*) from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id in (
        '5ddc85db-f32f-4cda-8603-aaed9ca780ac',
        '8f079547-7d92-400c-bbfc-776225edbb43',
        'b08632a7-b3ad-421c-9475-99cf05b63821',
        '4825ea84-7fe4-4bfd-948d-0e2b3d0071ff',
        '8218c59f-8aaf-4a7c-a3a6-724d3a45f846',
        'c6647f4d-aaa3-4619-b727-560396a604e0'
      )
      and category_id = v_operating_id
  ) <> 6
  or (
    select count(*) from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id = '3683b77c-4b43-43e5-b2f5-aeaa95ec31f7'
      and category_id = v_taxes_id
  ) <> 1 then
    raise exception 'Guard de categorías actuales de reglas falló.';
  end if;

  if (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_previred_ids)
      and classification_rule_id = 'c322731c-4685-448a-a7f4-e5836c76c5be'
  ) <> 9
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_auto_insurance_ids)
      and classification_rule_id = '71689d1f-110f-4b67-8632-0653ada12015'
  ) <> 17
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_zurich_ids)
      and classification_rule_id = '5ddc85db-f32f-4cda-8603-aaed9ca780ac'
  ) <> 7
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_starlink_ids)
      and classification_rule_id in (
        '8f079547-7d92-400c-bbfc-776225edbb43',
        'b08632a7-b3ad-421c-9475-99cf05b63821',
        '4825ea84-7fe4-4bfd-948d-0e2b3d0071ff'
      )
  ) <> 9
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_mauricio_ids)
      and classification_rule_id = '8218c59f-8aaf-4a7c-a3a6-724d3a45f846'
  ) <> 11
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_vector_ids)
      and classification_rule_id = 'c6647f4d-aaa3-4619-b727-560396a604e0'
  ) <> 6
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = v_interest_movement_id
      and classification_rule_id = '3683b77c-4b43-43e5-b2f5-aeaa95ec31f7'
  ) <> 1 then
    raise exception 'Guard movement-to-rule mapping falló.';
  end if;

  insert into comercial.financial_categories (
    company_id, parent_id, code, name, direction, sort_order,
    affects_cash_flow, affects_pnl_directly, classification_group,
    semantic_type, cash_direction
  )
  values
    (v_company_id, v_operating_id, 'EXPENSE_INSURANCE',
     'Seguros', 'EXPENSE', 110, true, false, 'OPERATING', null, 'DEBIT'),
    (v_company_id, v_operating_id, 'EXPENSE_TELECOM',
     'Telecomunicaciones e Internet', 'EXPENSE', 120, true, false, 'OPERATING', null, 'DEBIT'),
    (v_company_id, v_operating_id, 'EXPENSE_EXTERNAL_SERVICES',
     'Servicios profesionales y externos', 'EXPENSE', 130, true, false, 'OPERATING', null, 'DEBIT'),
    (v_company_id, v_non_operating_id, 'EXPENSE_FINANCIAL_INTEREST',
     'Intereses y gastos financieros', 'EXPENSE', 140, true, true, 'NON_OPERATING', null, 'DEBIT');

  select id into v_insurance_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_INSURANCE';

  select id into v_telecom_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_TELECOM';

  select id into v_external_services_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_EXTERNAL_SERVICES';

  select id into v_interest_category_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'EXPENSE_FINANCIAL_INTEREST';

  if v_insurance_id is null or v_telecom_id is null
     or v_external_services_id is null or v_interest_category_id is null then
    raise exception 'No se pudieron resolver todas las categorías destino.';
  end if;

  update comercial.financial_categories
  set affects_pnl_directly = false
  where company_id = v_company_id
    and code in (
      'EXPENSE_SUPPLIERS',
      'EXPENSE_SALARIES_WAGES',
      'EXPENSE_SALARIES_SOCIAL',
      'EXPENSE_TAXES'
    );

  update comercial.financial_bank_movements
  set category_id = v_social_id
  where company_id = v_company_id and id = any(v_previred_ids);

  update comercial.financial_bank_movements
  set category_id = v_insurance_id
  where company_id = v_company_id
    and id = any(v_auto_insurance_ids || v_zurich_ids);

  update comercial.financial_bank_movements
  set category_id = v_telecom_id
  where company_id = v_company_id and id = any(v_starlink_ids);

  update comercial.financial_bank_movements
  set category_id = v_external_services_id
  where company_id = v_company_id
    and id = any(v_mauricio_ids || v_vector_ids);

  update comercial.financial_bank_movements
  set category_id = v_interest_category_id
  where company_id = v_company_id and id = v_interest_movement_id;

  update comercial.financial_bank_classification_rules
  set category_id = v_social_id
  where company_id = v_company_id
    and id = 'c322731c-4685-448a-a7f4-e5836c76c5be';

  update comercial.financial_bank_classification_rules
  set category_id = v_insurance_id
  where company_id = v_company_id
    and id in (
      '71689d1f-110f-4b67-8632-0653ada12015',
      '5ddc85db-f32f-4cda-8603-aaed9ca780ac'
    );

  update comercial.financial_bank_classification_rules
  set category_id = v_telecom_id
  where company_id = v_company_id
    and id in (
      '8f079547-7d92-400c-bbfc-776225edbb43',
      'b08632a7-b3ad-421c-9475-99cf05b63821',
      '4825ea84-7fe4-4bfd-948d-0e2b3d0071ff'
    );

  update comercial.financial_bank_classification_rules
  set category_id = v_external_services_id
  where company_id = v_company_id
    and id in (
      '8218c59f-8aaf-4a7c-a3a6-724d3a45f846',
      'c6647f4d-aaa3-4619-b727-560396a604e0'
    );

  update comercial.financial_bank_classification_rules
  set category_id = v_interest_category_id
  where company_id = v_company_id
    and id = '3683b77c-4b43-43e5-b2f5-aeaa95ec31f7';

  if (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_previred_ids)
      and category_id = v_social_id
  ) <> 9
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id
      and id = any(v_auto_insurance_ids || v_zurich_ids)
      and category_id = v_insurance_id
  ) <> 24
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id and id = any(v_starlink_ids)
      and category_id = v_telecom_id
  ) <> 9
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id
      and id = any(v_mauricio_ids || v_vector_ids)
      and category_id = v_external_services_id
  ) <> 17
  or (
    select count(*) from comercial.financial_bank_movements
    where company_id = v_company_id
      and id = v_interest_movement_id
      and category_id = v_interest_category_id
  ) <> 1 then
    raise exception 'Validación final de categorías destino falló.';
  end if;

  if (
    select coalesce(sum(debit_amount), 0)
    from comercial.financial_bank_movements
    where company_id = v_company_id
      and id = any(v_auto_insurance_ids || v_zurich_ids)
      and category_id = v_insurance_id
  ) <> 3439465
  or (
    select coalesce(sum(debit_amount), 0)
    from comercial.financial_bank_movements
    where company_id = v_company_id
      and id = any(v_starlink_ids)
      and category_id = v_telecom_id
  ) <> 647996
  or (
    select coalesce(sum(debit_amount), 0)
    from comercial.financial_bank_movements
    where company_id = v_company_id
      and id = any(v_mauricio_ids || v_vector_ids)
      and category_id = v_external_services_id
  ) <> 8494402
  or (
    select coalesce(sum(debit_amount), 0)
    from comercial.financial_bank_movements
    where company_id = v_company_id
      and id = v_interest_movement_id
      and category_id = v_interest_category_id
  ) <> 16466 then
    raise exception 'Validación final de montos destino falló.';
  end if;

  if (
    select count(*)
    from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id = any(v_rule_ids)
      and mode = 'SUGGEST'
      and category_id in (
        v_social_id,
        v_insurance_id,
        v_telecom_id,
        v_external_services_id,
        v_interest_category_id
      )
  ) <> 9 then
    raise exception 'Validación final de las 9 reglas falló.';
  end if;

  if (
    select count(*) from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id = 'c322731c-4685-448a-a7f4-e5836c76c5be'
      and category_id = v_social_id and mode = 'SUGGEST'
  ) <> 1
  or (
    select count(*) from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id in (
        '71689d1f-110f-4b67-8632-0653ada12015',
        '5ddc85db-f32f-4cda-8603-aaed9ca780ac'
      )
      and category_id = v_insurance_id and mode = 'SUGGEST'
  ) <> 2
  or (
    select count(*) from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id in (
        '8f079547-7d92-400c-bbfc-776225edbb43',
        'b08632a7-b3ad-421c-9475-99cf05b63821',
        '4825ea84-7fe4-4bfd-948d-0e2b3d0071ff'
      )
      and category_id = v_telecom_id and mode = 'SUGGEST'
  ) <> 3
  or (
    select count(*) from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id in (
        '8218c59f-8aaf-4a7c-a3a6-724d3a45f846',
        'c6647f4d-aaa3-4619-b727-560396a604e0'
      )
      and category_id = v_external_services_id and mode = 'SUGGEST'
  ) <> 2
  or (
    select count(*) from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and id = '3683b77c-4b43-43e5-b2f5-aeaa95ec31f7'
      and category_id = v_interest_category_id and mode = 'SUGGEST'
  ) <> 1 then
    raise exception 'Validación final regla-destino falló.';
  end if;
end
$$;
