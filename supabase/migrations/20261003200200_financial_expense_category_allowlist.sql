-- Explicit recognition eligibility. This is separate from bank P&L metadata.

create or replace function comercial.financial_expense_recognition_allowed_codes()
returns text[] language sql immutable as $$
  select array['EXPENSE_EXTERNAL_SERVICES', 'EXPENSE_INSURANCE', 'EXPENSE_TELECOM']::text[];
$$;

create or replace function comercial.validate_financial_expense_category(
  p_company_id uuid, p_category_id uuid
) returns void language plpgsql security definer
set search_path = pg_catalog, comercial as $$
begin
  if not exists (
    select 1
    from comercial.financial_categories c
    where c.company_id = p_company_id
      and c.id = p_category_id
      and c.is_active
      and c.code = any(comercial.financial_expense_recognition_allowed_codes())
      and c.direction in ('EXPENSE', 'BOTH')
      and not exists (
        select 1
        from comercial.financial_categories child
        where child.company_id = c.company_id
          and child.parent_id = c.id
          and child.is_active
      )
  ) then
    raise exception 'La categoría no está habilitada para Gastos Reconocidos.';
  end if;
end;
$$;

create or replace function comercial.get_financial_expense_recognition_categories(
  p_company_id uuid
) returns table (
  id uuid,
  code text,
  name text,
  parent_id uuid,
  direction text,
  is_active boolean
) language sql security definer
set search_path = pg_catalog, comercial as $$
  select c.id, c.code, c.name, c.parent_id, c.direction, c.is_active
  from comercial.financial_categories c
  where c.company_id = p_company_id
    and c.is_active
    and c.code = any(comercial.financial_expense_recognition_allowed_codes())
    and c.direction in ('EXPENSE', 'BOTH')
    and not exists (
      select 1
      from comercial.financial_categories child
      where child.company_id = c.company_id
        and child.parent_id = c.id
        and child.is_active
    )
  order by c.name;
$$;

create or replace function comercial.post_financial_expense(
  p_company_id uuid, p_expense_entry_id uuid, p_actor uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare v_before jsonb; v_after jsonb; v_category_id uuid;
begin
  select to_jsonb(e), e.category_id
    into v_before, v_category_id
  from comercial.financial_expense_entries e
  where e.company_id = p_company_id and e.id = p_expense_entry_id
  for update;
  if v_before is null or v_before->>'status' <> 'DRAFT' then
    raise exception 'Sólo se pueden reconocer partidas DRAFT.';
  end if;
  perform comercial.validate_financial_expense_category(p_company_id, v_category_id);
  if exists (
    select 1
    from comercial.financial_expense_bank_links l
    join comercial.financial_bank_movements m on m.id = l.bank_movement_id
    join comercial.financial_categories c on c.company_id = m.company_id and c.id = m.category_id
    where l.company_id = p_company_id and l.expense_entry_id = p_expense_entry_id
      and (m.direction <> 'DEBE' or coalesce(m.debit_amount, 0) <= 0 or c.affects_pnl_directly)
  ) then
    raise exception 'El movimiento bancario ya está configurado para afectar resultados. Corrige primero su clasificación bancaria antes de reconocer el gasto por esta vía.';
  end if;
  update comercial.financial_expense_entries
  set status = 'POSTED', posted_by = p_actor, posted_at = now(),
      source_type = case when exists (
        select 1 from comercial.financial_expense_bank_links
        where company_id = p_company_id and expense_entry_id = p_expense_entry_id
      ) then 'BANK_LINKED' else source_type end
  where company_id = p_company_id and id = p_expense_entry_id;
  select to_jsonb(e) into v_after
  from comercial.financial_expense_entries e
  where e.company_id = p_company_id and e.id = p_expense_entry_id;
  insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  values ('financial_expense_entries', p_expense_entry_id, 'POST', v_before, v_after, p_actor);
  return v_after;
end;
$$;

revoke all on function comercial.financial_expense_recognition_allowed_codes() from public, anon, authenticated, service_role;
revoke all on function comercial.get_financial_expense_recognition_categories(uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.get_financial_expense_recognition_categories(uuid) to service_role;
