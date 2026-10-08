-- Allow safe bank reconciliation for already posted recognized expenses.
-- The expense economics and lifecycle status remain immutable.

create or replace function comercial.link_financial_expense_bank_movement(
  p_company_id uuid, p_expense_entry_id uuid, p_bank_movement_id uuid,
  p_allocated_amount numeric, p_actor uuid
) returns uuid language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare
  v_id uuid;
  v_amount numeric;
  v_expense numeric;
  v_direct boolean;
  v_status text;
  v_source_type text;
  v_before jsonb;
  v_after jsonb;
begin
  if p_allocated_amount <= 0 then
    raise exception 'La asignacion debe ser mayor que cero.';
  end if;

  -- Lock the expense first, so concurrent allocations for one expense serialize.
  select to_jsonb(e), e.status, e.source_type, e.recognized_amount
    into v_before, v_status, v_source_type, v_expense
  from comercial.financial_expense_entries e
  where e.company_id = p_company_id and e.id = p_expense_entry_id
  for update;
  if not found then
    raise exception 'La partida no pertenece a la empresa activa.';
  end if;
  if v_status not in ('DRAFT', 'POSTED') then
    raise exception 'Solo se pueden vincular partidas DRAFT o POSTED.';
  end if;
  if v_status = 'POSTED' and v_source_type not in ('MANUAL', 'BANK_LINKED') then
    raise exception 'Solo se pueden conciliar partidas POSTED MANUAL o BANK_LINKED; IMPORT, PETTY_CASH y LOAN no son compatibles.';
  end if;
  if v_status = 'POSTED'
    and v_source_type = 'MANUAL'
    and exists (
      select 1 from comercial.financial_expense_bank_links l
      where l.company_id = p_company_id and l.expense_entry_id = p_expense_entry_id
    ) then
    raise exception 'La partida POSTED MANUAL ya tiene vinculos bancarios inconsistentes.';
  end if;

  -- Lock the movement before checking its remaining assignable amount.
  select m.debit_amount, coalesce(c.affects_pnl_directly, false)
    into v_amount, v_direct
  from comercial.financial_bank_movements m
  left join comercial.financial_categories c
    on c.company_id = m.company_id and c.id = m.category_id
  where m.company_id = p_company_id
    and m.id = p_bank_movement_id
    and m.direction = 'DEBE'
  for update of m;
  if not found then
    raise exception 'Solo se pueden vincular movimientos DEBE de la empresa activa.';
  end if;
  if coalesce(v_amount, 0) <= 0 then
    raise exception 'El movimiento bancario debe tener un monto DEBE positivo.';
  end if;
  if v_direct then
    raise exception 'El movimiento bancario ya esta configurado para afectar resultados. Corrige primero su clasificacion bancaria antes de vincularlo.';
  end if;
  if exists (
    select 1 from comercial.financial_expense_bank_links l
    where l.company_id = p_company_id
      and l.expense_entry_id = p_expense_entry_id
      and l.bank_movement_id = p_bank_movement_id
  ) then
    raise exception 'El gasto ya esta vinculado a ese movimiento bancario.';
  end if;
  if p_allocated_amount + coalesce((
    select sum(l.allocated_amount)
    from comercial.financial_expense_bank_links l
    where l.company_id = p_company_id and l.bank_movement_id = p_bank_movement_id
  ), 0) > v_amount then
    raise exception 'Las asignaciones exceden el monto DEBE disponible.';
  end if;
  if p_allocated_amount + coalesce((
    select sum(l.allocated_amount)
    from comercial.financial_expense_bank_links l
    where l.company_id = p_company_id and l.expense_entry_id = p_expense_entry_id
  ), 0) > v_expense then
    raise exception 'Las asignaciones exceden el monto reconocido.';
  end if;

  insert into comercial.financial_expense_bank_links(
    company_id, expense_entry_id, bank_movement_id, allocated_amount, created_by
  )
  values (
    p_company_id, p_expense_entry_id, p_bank_movement_id, p_allocated_amount, p_actor
  )
  returning id into v_id;

  insert into portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  values (
    'financial_expense_bank_links', v_id, 'BANK_LINK',
    jsonb_build_object(
      'expense_entry_id', p_expense_entry_id,
      'bank_movement_id', p_bank_movement_id,
      'allocated_amount', p_allocated_amount
    ), p_actor
  );

  -- DRAFT source semantics remain unchanged until the normal POST transition.
  if v_status = 'POSTED' and v_source_type <> 'BANK_LINKED' then
    update comercial.financial_expense_entries
    set source_type = 'BANK_LINKED'
    where company_id = p_company_id and id = p_expense_entry_id;

    select to_jsonb(e) into v_after
    from comercial.financial_expense_entries e
    where e.company_id = p_company_id and e.id = p_expense_entry_id;
    insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
    values (
      'financial_expense_entries', p_expense_entry_id, 'BANK_SOURCE_CHANGE',
      v_before, v_after, p_actor
    );
  end if;

  return v_id;
end;
$$;

create or replace function comercial.unlink_financial_expense_bank_movement(
  p_company_id uuid, p_link_id uuid, p_actor uuid
) returns void language plpgsql security definer
set search_path = pg_catalog, comercial as $$
declare
  v_old jsonb;
  v_expense uuid;
  v_status text;
  v_source_type text;
  v_before jsonb;
  v_after jsonb;
begin
  select l.expense_entry_id into v_expense
  from comercial.financial_expense_bank_links l
  where l.company_id = p_company_id and l.id = p_link_id;
  if not found then
    raise exception 'El vinculo no existe.';
  end if;

  -- Match link-side locking order with the link RPC: expense first, link second.
  select to_jsonb(e), e.status, e.source_type
    into v_before, v_status, v_source_type
  from comercial.financial_expense_entries e
  where e.company_id = p_company_id and e.id = v_expense
  for update;
  if not found then
    raise exception 'La partida no pertenece a la empresa activa.';
  end if;
  if v_status not in ('DRAFT', 'POSTED') then
    raise exception 'Solo se pueden quitar vinculos de partidas DRAFT o POSTED.';
  end if;
  if v_status = 'POSTED' and v_source_type <> 'BANK_LINKED' then
    raise exception 'Solo se pueden quitar vinculos de partidas POSTED BANK_LINKED.';
  end if;

  select to_jsonb(l) into v_old
  from comercial.financial_expense_bank_links l
  where l.company_id = p_company_id and l.id = p_link_id
  for update;
  if not found then
    raise exception 'El vinculo no existe.';
  end if;

  delete from comercial.financial_expense_bank_links
  where company_id = p_company_id and id = p_link_id;

  insert into portal.audit_logs(table_name, record_id, action, old_data, performed_by)
  values ('financial_expense_bank_links', p_link_id, 'BANK_UNLINK', v_old, p_actor);

  -- Only POSTED expenses derive their source marker from reconciliation links.
  if v_status = 'POSTED' then
    update comercial.financial_expense_entries
    set source_type = case when exists (
      select 1 from comercial.financial_expense_bank_links l
      where l.company_id = p_company_id and l.expense_entry_id = v_expense
    ) then 'BANK_LINKED' else 'MANUAL' end
    where company_id = p_company_id and id = v_expense;

    select to_jsonb(e) into v_after
    from comercial.financial_expense_entries e
    where e.company_id = p_company_id and e.id = v_expense;
    if v_before <> v_after then
      insert into portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
      values (
        'financial_expense_entries', v_expense, 'BANK_SOURCE_CHANGE',
        v_before, v_after, p_actor
      );
    end if;
  end if;
end;
$$;

revoke all on function comercial.link_financial_expense_bank_movement(uuid, uuid, uuid, numeric, uuid) from public, anon, authenticated, service_role;
revoke all on function comercial.unlink_financial_expense_bank_movement(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function comercial.link_financial_expense_bank_movement(uuid, uuid, uuid, numeric, uuid), comercial.unlink_financial_expense_bank_movement(uuid, uuid, uuid) to service_role;
