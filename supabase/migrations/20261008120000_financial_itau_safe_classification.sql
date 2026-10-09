-- Deterministic AUTO rules for unambiguous Itaú and Banco de Chile movements.
-- Existing MANUAL classifications are never overwritten.
do $$
declare
  v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
  v_itau_account_id uuid := '85bba5e4-66e1-42ac-9e25-348fac2303bd';
  v_chile_account_id uuid := '139523fa-8aa3-44b8-b895-7bed7c68d0cc';
  v_old_chile_rule_id uuid := '95c10a1e-7a67-4d82-83eb-6b1da4003d7b';
  v_internal_income_id uuid;
  v_internal_expense_id uuid;
  v_financing_income_id uuid;
  v_financing_expense_id uuid;
  v_interest_expense_id uuid;
  v_bank_fees_id uuid;
  v_chile_exact_rule_id uuid := '25583251-7bd2-4d8e-bc71-4a1b972b9bcb';
begin
  select id into v_internal_income_id from comercial.financial_categories
    where company_id = v_company_id and code = 'INCOME_INTERNAL_TRANSFER';
  select id into v_internal_expense_id from comercial.financial_categories
    where company_id = v_company_id and code = 'EXPENSE_INTERNAL_TRANSFER';
  select id into v_financing_income_id from comercial.financial_categories
    where company_id = v_company_id and code = 'INCOME_FINANCING';
  select id into v_financing_expense_id from comercial.financial_categories
    where company_id = v_company_id and code = 'EXPENSE_FINANCING';
  select id into v_interest_expense_id from comercial.financial_categories
    where company_id = v_company_id and code = 'EXPENSE_FINANCIAL_INTEREST';
  select id into v_bank_fees_id from comercial.financial_categories
    where company_id = v_company_id and code = 'EXPENSE_BANK_FEES';

  if v_internal_income_id is null or v_internal_expense_id is null
     or v_financing_income_id is null or v_financing_expense_id is null
     or v_interest_expense_id is null or v_bank_fees_id is null then
    raise exception 'Faltan categorías financieras destino para las reglas Itaú/Banco de Chile.';
  end if;

  insert into comercial.financial_bank_classification_rules (
    id, company_id, name, active, direction, bank_account_id,
    match_type, match_value, category_id, mode
  )
  select rule_id, v_company_id, name, true, direction, bank_account_id,
         'EXACT', match_value, category_id, 'AUTO'
  from (values
    ('75badb40-7f6d-4858-9efc-18b42a21dc02'::uuid, 'Itaú: transferencia a Caylo', 'DEBE', v_itau_account_id, 'TRANSFERENCIA A CAYLO PREMIUM', v_internal_expense_id),
    ('65eff184-defd-4160-b5a3-2a77a7e17617'::uuid, 'Itaú: transferencia de Caylo', 'HABER', v_itau_account_id, 'TRANSFERENCIA DE CAYLO PREMIUM', v_internal_income_id),
    ('d55d8389-a2a4-49ac-beea-6602eb426164'::uuid, 'Itaú: transferencia de Caylo por RUT', 'HABER', v_itau_account_id, 'TRANSF DE 77196005 7 CAYLO PR', v_internal_income_id),
    ('7d1e6d3e-abfe-4867-81bd-8854005f909b'::uuid, 'Banco de Chile: traspaso desde Caylo', 'HABER', v_chile_account_id, 'TRASPASO DE CAYLO PREMIUM SPA', v_internal_income_id),
    (v_chile_exact_rule_id, 'Banco de Chile: traspaso a Caylo', 'DEBE', v_chile_account_id, 'TRASPASO A CAYLO PREMIUM SPA', v_internal_expense_id),
    ('7a0c4a19-7271-4eac-8423-a54d0d47ee90'::uuid, 'Itaú: préstamo recibido', 'HABER', v_itau_account_id, 'PRESTAMO', v_financing_income_id),
    ('62aca23b-cad6-4a67-9c73-715960773e9a'::uuid, 'Itaú: abono desde línea de crédito', 'HABER', v_itau_account_id, 'ABONO DESDE LINEA DE CREDITO', v_financing_income_id),
    ('6fd96f88-4992-49c1-bf6d-402491a6af53'::uuid, 'Itaú: cargo por traspaso de línea de crédito', 'DEBE', v_itau_account_id, 'CARGO CTACTE POR TRASPASO LC', v_financing_expense_id),
    ('fad60b30-efc3-45c4-b76e-aeb39a652d43'::uuid, 'Itaú: cuota de préstamo', 'DEBE', v_itau_account_id, 'CUOTA PRESTAMO', v_financing_expense_id),
    ('c1626891-a7ad-4b2c-88fc-7e07d0b7b638'::uuid, 'Itaú: intereses pactados', 'DEBE', v_itau_account_id, 'LIQUID INTERESES PACTADOS', v_interest_expense_id),
    ('fb5819a3-795f-4770-b4c5-d4c73aa11bee'::uuid, 'Itaú: impuesto sobre línea de crédito', 'DEBE', v_itau_account_id, 'IMP SOBREG LC', v_interest_expense_id),
    ('8a3c530d-5404-4ebd-b1ea-b2646dad4102'::uuid, 'Itaú: comisión garantía FOGAPE', 'DEBE', v_itau_account_id, 'COMISION GARANTIA FOGAPE', v_interest_expense_id),
    ('95d47d59-035e-4d86-a175-a2826db54d78'::uuid, 'Itaú: gastos notariales de línea de crédito', 'DEBE', v_itau_account_id, 'GTOS NOTARIALES POR ALTA DE LC', v_interest_expense_id),
    ('ad3f71b3-cd3b-447f-a8a9-8e7acb68f473'::uuid, 'Itaú: mantención de cuenta empresa', 'DEBE', v_itau_account_id, 'COM MANTENCION PLAN CUENTA EMP', v_bank_fees_id),
    ('e8e572a4-cde8-47c6-850a-2aa96374d0b8'::uuid, 'Itaú: emisión de vale vista', 'DEBE', v_itau_account_id, 'COM POR EMISION VALE VISTA', v_bank_fees_id),
    ('7acb854f-1c79-4a00-bcd3-f46b0ebaae18'::uuid, 'Itaú: IVA de gasto bancario', 'DEBE', v_itau_account_id, 'IMPUESTO AL VALOR AGREGADO', v_bank_fees_id)
  ) as rules(rule_id, name, direction, bank_account_id, match_value, category_id)
  on conflict (id) do update set
    company_id = excluded.company_id,
    name = excluded.name,
    active = excluded.active,
    direction = excluded.direction,
    bank_account_id = excluded.bank_account_id,
    match_type = excluded.match_type,
    match_value = excluded.match_value,
    category_id = excluded.category_id,
    mode = excluded.mode;

  update comercial.financial_bank_movements movement
  set category_id = rule.category_id,
      classification_source = 'AUTO_RULE',
      classification_rule_id = rule.id,
      classified_by = null,
      classified_at = now()
  from comercial.financial_bank_classification_rules rule
  where movement.company_id = v_company_id
    and movement.category_id is null
    and movement.classification_source is distinct from 'MANUAL'
    and rule.company_id = v_company_id
    and rule.id <> v_chile_exact_rule_id
    and rule.active
    and rule.mode = 'AUTO'
    and rule.bank_account_id = movement.bank_account_id
    and rule.direction = movement.direction
    and rule.match_type = 'EXACT'
    and rule.match_value = movement.normalized_description;

  if (select count(*) from comercial.financial_bank_movements
      where company_id = v_company_id and bank_account_id = v_chile_account_id
        and direction = 'DEBE' and normalized_description = 'TRASPASO A CAYLO PREMIUM SPA') <> 10 then
    raise exception 'La corrección Banco de Chile no coincide con los 10 movimientos esperados.';
  end if;

  update comercial.financial_bank_movements movement
  set category_id = v_internal_expense_id,
      classification_source = 'AUTO_RULE',
      classification_rule_id = v_chile_exact_rule_id,
      classified_by = null,
      classified_at = now()
  where movement.company_id = v_company_id
    and movement.bank_account_id = v_chile_account_id
    and movement.direction = 'DEBE'
    and movement.normalized_description = 'TRASPASO A CAYLO PREMIUM SPA'
    and movement.classification_source is distinct from 'MANUAL'
    and movement.classification_rule_id in (v_old_chile_rule_id, v_chile_exact_rule_id);

  if exists (
    select 1 from comercial.financial_bank_movements
    where company_id = v_company_id and bank_account_id = v_chile_account_id
      and direction = 'DEBE' and normalized_description = 'TRASPASO A CAYLO PREMIUM SPA'
      and classification_source is distinct from 'MANUAL'
      and (category_id is distinct from v_internal_expense_id
        or classification_rule_id is distinct from v_chile_exact_rule_id
        or classification_source is distinct from 'AUTO_RULE')
  ) then
    raise exception 'La clasificación final de los 10 traspasos Banco de Chile falló.';
  end if;
end
$$;
