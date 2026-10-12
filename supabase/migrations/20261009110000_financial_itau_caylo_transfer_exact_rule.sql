-- Add the current Itaú signature without replacing the historical rule.
do $$
declare
  v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
  v_itau_account_id uuid := '85bba5e4-66e1-42ac-9e25-348fac2303bd';
  v_category_id uuid;
begin
  select id into v_category_id
  from comercial.financial_categories
  where company_id = v_company_id and code = 'INCOME_INTERNAL_TRANSFER' and is_active;
  if v_category_id is null then
    raise exception 'Falta la categoría INCOME_INTERNAL_TRANSFER.';
  end if;
  if not exists (
    select 1 from comercial.financial_bank_classification_rules
    where company_id = v_company_id
      and bank_account_id = v_itau_account_id
      and direction = 'HABER'
      and match_type = 'EXACT'
      and match_value = 'TRANSF DE 77196005 7 CAYLO'
  ) then
    insert into comercial.financial_bank_classification_rules(
      id, company_id, name, active, direction, bank_account_id,
      match_type, match_value, category_id, mode
    ) values (
      'f6afc99b-89d6-48b2-90cc-5aa8e9d0e9aa', v_company_id,
      'Itaú: transferencia de Caylo formato actual', true, 'HABER', v_itau_account_id,
      'EXACT', 'TRANSF DE 77196005 7 CAYLO', v_category_id, 'AUTO'
    );
  end if;
end
$$;
