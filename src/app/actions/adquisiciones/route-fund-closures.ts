'use server'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getActiveCompanyId } from '@/app/actions/companies'
import { PendingFundExpense, PendingFundPayment, PendingRouteFund, PendingRouteFundGroup, PendingRouteFundDeposit, RouteFundClosureDepositSummary } from '@/modules/adquisiciones/rendicion-rutas/fund-closures-types'
import { SETTLEMENT_ATTACHMENT_ALLOWED_MIMES, SETTLEMENT_ATTACHMENT_BUCKET, SETTLEMENT_ATTACHMENT_MAX_SIZE, settlementAttachmentExtension } from '@/modules/adquisiciones/rendicion-rutas/utils/settlement-attachment-config'

async function createAdquisicionesClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'adquisiciones' },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    }
  )
}

async function requirePermission(db: any, userId: string, permissionCode: string) {
  const { data, error } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userId,
    p_permission_code: permissionCode,
  })

  if (error) throw error
  if (!data) throw new Error('No tiene permisos para realizar esta acción.')
}

export async function canCancelFundClosure() {
  const db = await createAdquisicionesClient()
  const { data: userData } = await db.auth.getUser()
  if (!userData?.user) return false;
  const { data } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userData.user.id,
    p_permission_code: 'adquisiciones.route_fund_closures.cancel'
  });
  return !!data;
}

// 1. Obtener fondos pendientes (PAID_CASH, CHECK_RECEIVED) que no están en un cierre activo
export async function getPendingRouteFunds(): Promise<PendingRouteFund[]> {
  const db = await createAdquisicionesClient()
  const { data: userData, error: userError } = await db.auth.getUser()
  if (userError || !userData?.user) throw new Error('No autorizado')

  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')

  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')

  // We need to fetch items from route_settlement_items
  // where status IN ('PAID_CASH', 'CHECK_RECEIVED')
  // AND id NOT IN (select route_settlement_item_id from route_fund_closure_items where released_at IS NULL)
  // Instead of complex raw SQL, we can do it via a simple RPC or fetching all and filtering in JS if not too large.
  // We'll fetch all cash/check items for the company and all active closure items.
  const [itemsRes, activeClosuresRes] = await Promise.all([
    db.from('route_settlement_items').select(`
      id,
      settlement_id,
      route_guide_item_id,
      invoice_number,
      customer_name,
      received_payment_method,
      status,
      received_amount,
      custody_user_id,
      route_settlements!inner ( route_guide_id, settlement_number )
    `)
    .eq('company_id', companyId)
    .in('status', ['PAID_CASH', 'CHECK_RECEIVED']),
    
    db.from('route_fund_closure_items').select('route_settlement_item_id')
    .eq('company_id', companyId)
    .is('released_at', null)
  ]);

  if (itemsRes.error) throw new Error(itemsRes.error.message);
  if (activeClosuresRes.error) throw new Error(activeClosuresRes.error.message);

  const activeItemIds = new Set(activeClosuresRes.data.map(i => i.route_settlement_item_id));

  const pendingFunds: PendingRouteFund[] = [];
  
  const { data: isSuper } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userData.user.id,
    p_permission_code: 'adquisiciones.route_fund_closures.cancel'
  });

  for (const item of itemsRes.data) {
    if (!isSuper && item.custody_user_id !== userData.user.id) continue;

    if (!activeItemIds.has(item.id)) {
      const settlement = Array.isArray(item.route_settlements) ? item.route_settlements[0] : item.route_settlements;
      pendingFunds.push({
        route_settlement_item_id: item.id,
        route_settlement_id: item.settlement_id,
        route_guide_id: settlement?.route_guide_id,
        invoice_number: item.invoice_number,
        customer_name: item.customer_name,
        payment_method: item.received_payment_method || (item.status === 'PAID_CASH' ? 'CASH' : 'CHECK'),
        amount: Number(item.received_amount || 0),
        settlement_number: settlement?.settlement_number,
        guide_number: null // Optional: could fetch guide number if needed
      });
    }
  }

  return pendingFunds;
}

/** Read model for the Payments-based pending-funds flow. UI wiring is intentionally separate. */
export async function getPendingRouteFundGroups(): Promise<PendingRouteFundGroup[]> {
  const db = await createAdquisicionesClient()
  const { data: userData, error: userError } = await db.auth.getUser()
  if (userError || !userData?.user) throw new Error('No autorizado')

  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')
  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')

  const { data, error } = await db.schema('adquisiciones').rpc('get_pending_route_fund_groups', {
    p_company_id: companyId,
  })
  if (error) throw new Error(error.message)

  const groups = (data ?? []) as PendingRouteFundGroup[]
  const settlementIds = [...new Set(groups.map(group => group.route_settlement_id))]
  const { data: settlements } = settlementIds.length > 0
    ? await db.from('route_settlements').select('id, closed_at').in('id', settlementIds).eq('company_id', companyId)
    : { data: [] }
  const closedAtBySettlement = new Map((settlements ?? []).map(settlement => [settlement.id, settlement.closed_at]))
  const custodyIds = [...new Set(groups.map(group => group.custody_user_id).filter(Boolean))]
  const { data: users } = custodyIds.length > 0
    ? await db.schema('portal').from('users').select('id, nombre, apellido').in('id', custodyIds)
    : { data: [] }
  const custodyNames = new Map((users ?? []).map(user => [
    user.id,
    [user.nombre, user.apellido].filter(Boolean).join(' ') || user.id,
  ]))

  const { data: expenses } = settlementIds.length > 0
    ? await db.from('route_fund_closure_expenses').select('route_settlement_id, amount').eq('company_id', companyId).in('route_settlement_id', settlementIds).eq('status', 'ACTIVE').is('voided_at', null).is('fund_closure_id', null)
    : { data: [] }
  const expensesBySettlement = new Map<string, number>()
  for (const expense of expenses ?? []) expensesBySettlement.set(expense.route_settlement_id, (expensesBySettlement.get(expense.route_settlement_id) ?? 0) + Number(expense.amount || 0))

  return groups.map(group => {
    const physicalItems = (group.physical_items ?? []).map((item: any) => ({
      ...item,
      payment_method_received: item.payment_method ?? item.payment_method_received,
      amount_received: Number(item.amount ?? item.amount_received ?? 0),
      post_settlement_payment_id: item.post_settlement_payment_id ?? null,
      payment_id: item.payment_id ?? null,
    }))
    const activeExpenses = expensesBySettlement.get(group.route_settlement_id) ?? 0
    return {
    ...group,
    closed_at: closedAtBySettlement.get(group.route_settlement_id) ?? null,
    custody_name: custodyNames.get(group.custody_user_id) ?? group.custody_user_id,
    active_route_expenses: activeExpenses,
    net_cash_pending: Math.max(Number(group.cash_received || 0) - activeExpenses, 0),
    physical_items: physicalItems,
  }
  })
}

export async function getPendingFundPayments(input: { paymentIds: string[]; postSettlementPaymentIds?: string[] }): Promise<PendingFundPayment[]> {
  const postSettlementPaymentIds = input.postSettlementPaymentIds ?? []
  if (input.paymentIds.length === 0 && postSettlementPaymentIds.length === 0) return []
  const db = await createAdquisicionesClient()
  const { data: userData, error: userError } = await db.auth.getUser()
  if (userError || !userData?.user) throw new Error('No autorizado')
  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')
  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')

  const [routeResult, postResult] = await Promise.all([
    input.paymentIds.length > 0
      ? db.from('route_settlement_payments').select('id, settlement_id, payment_method_received, amount_received, reference_number, bank_name, check_number, check_date, custody_user_id, custody_received_at, received_at').eq('company_id', companyId).in('id', input.paymentIds).eq('verification_status', 'CONFIRMED').is('voided_at', null).in('payment_method_received', ['CASH', 'CHECK'])
      : Promise.resolve({ data: [], error: null }),
    postSettlementPaymentIds.length > 0
      ? db.from('post_settlement_payments').select('id, route_settlement_id, payment_method_received, amount_received, reference_number, bank_name, check_number, check_date, custody_user_id, custody_received_at, received_at').eq('company_id', companyId).in('id', postSettlementPaymentIds).eq('verification_status', 'CONFIRMED').is('voided_at', null).in('payment_method_received', ['CASH', 'CHECK'])
      : Promise.resolve({ data: [], error: null }),
  ])
  if (routeResult.error) throw new Error(routeResult.error.message)
  if (postResult.error) throw new Error(postResult.error.message)
  const routePayments = (routeResult.data ?? []).map((payment: any) => ({ ...payment, route_settlement_id: payment.settlement_id, source_type: 'ROUTE_SETTLEMENT_PAYMENT' as const, post_settlement_payment_id: null }))
  const postPayments = (postResult.data ?? []).map((payment: any) => ({ ...payment, source_type: 'POST_SETTLEMENT_PAYMENT' as const, post_settlement_payment_id: payment.id }))
  const payments = [...routePayments, ...postPayments]
  const settlementIds = [...new Set(payments.map(payment => payment.route_settlement_id))]
  const paymentIds = payments.map(payment => payment.id)
  const [settlementsResult, allocationsResult, postAllocationsResult] = await Promise.all([
    settlementIds.length > 0 ? db.from('route_settlements').select('id, settlement_number, route_guide_id').in('id', settlementIds).eq('company_id', companyId) : Promise.resolve({ data: [], error: null }),
    paymentIds.length > 0 ? db.from('route_settlement_payment_allocations').select('payment_id, settlement_item_id').in('payment_id', paymentIds).is('voided_at', null) : Promise.resolve({ data: [], error: null }),
    postSettlementPaymentIds.length > 0 ? db.from('post_settlement_payment_allocations').select('payment_id, settlement_item_id').in('payment_id', postSettlementPaymentIds).is('voided_at', null) : Promise.resolve({ data: [], error: null }),
  ])
  if (settlementsResult.error) throw new Error(settlementsResult.error.message)
  if (allocationsResult.error) throw new Error(allocationsResult.error.message)
  if (postAllocationsResult.error) throw new Error(postAllocationsResult.error.message)
  const allAllocations = [...(allocationsResult.data ?? []), ...(postAllocationsResult.data ?? [])]
  const allocationIds = [...new Set(allAllocations.map((allocation: any) => allocation.settlement_item_id))]
  const { data: items, error: itemsError } = allocationIds.length > 0 ? await db.from('route_settlement_items').select('id, invoice_number, customer_name').in('id', allocationIds).eq('company_id', companyId) : { data: [], error: null }
  if (itemsError) throw new Error(itemsError.message)
  const allocationByPayment = new Map(allAllocations.map((allocation: any) => [allocation.payment_id, (items ?? []).find((item: any) => item.id === allocation.settlement_item_id)]))
  const settlements = new Map((settlementsResult.data ?? []).map((settlement: any) => [settlement.id, settlement]))
  return payments.map((payment: any) => {
    const settlement = settlements.get(payment.route_settlement_id)
    const item = allocationByPayment.get(payment.id)
    return { ...payment, settlement_number: settlement?.settlement_number, invoice_number: item?.invoice_number, customer_name: item?.customer_name }
  }) as PendingFundPayment[]
}

export async function getPendingFundExpenses(settlementIds: string[]): Promise<PendingFundExpense[]> {
  if (settlementIds.length === 0) return []
  const db = await createAdquisicionesClient()
  const { data: userData, error: userError } = await db.auth.getUser()
  if (userError || !userData?.user) throw new Error('No autorizado')
  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')
  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')
  const { data, error } = await db
    .from('route_fund_closure_expenses')
    .select('id, route_settlement_id, expense_type, amount, expense_date, notes')
    .eq('company_id', companyId)
    .in('route_settlement_id', settlementIds)
    .eq('status', 'ACTIVE')
    .is('voided_at', null)
    .is('fund_closure_id', null)
    .order('expense_date', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as PendingFundExpense[]
}

export async function createFundClosureFromPayments(input: {
  paymentIds: string[]
  checkPaymentIds: string[]
  cashDelivered: number
  notes: string | null
}) {
  if (input.paymentIds.length === 0) throw new Error('Debe seleccionar al menos una Rendición.')
  if (input.cashDelivered < 0) throw new Error('El efectivo entregado no puede ser negativo.')

  const db = await createAdquisicionesClient()
  const { data: userData, error: userError } = await db.auth.getUser()
  if (userError || !userData?.user) throw new Error('No autorizado')
  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')
  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.create')

  const { data, error } = await db.schema('adquisiciones').rpc('create_route_fund_closure_from_payments', {
    p_company_id: companyId,
    p_payment_ids: input.paymentIds,
    p_check_payment_ids: input.checkPaymentIds,
    p_cash_delivered: input.cashDelivered,
    p_notes: input.notes,
    p_user_id: userData.user.id,
  })
  if (error) throw new Error(error.message)
  return data as { closure_id: string; closure_number: string; status: string }
}

export async function createFundClosureFromMixedPayments(input: {
  paymentIds: string[]
  postSettlementPaymentIds: string[]
  checkPaymentIds: string[]
  cashDelivered: number
  notes: string | null
}) {
  if (input.paymentIds.length === 0 && input.postSettlementPaymentIds.length === 0) throw new Error('Debe seleccionar al menos un fondo.')
  if (input.cashDelivered < 0) throw new Error('El efectivo entregado no puede ser negativo.')
  const db = await createAdquisicionesClient()
  const { data: userData, error: userError } = await db.auth.getUser()
  if (userError || !userData?.user) throw new Error('No autorizado')
  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')
  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.create')
  const { data, error } = await db.schema('adquisiciones').rpc('create_route_fund_closure_from_mixed_payments', {
    p_company_id: companyId,
    p_payment_ids: input.paymentIds,
    p_post_settlement_payment_ids: input.postSettlementPaymentIds,
    p_check_payment_ids: input.checkPaymentIds,
    p_cash_delivered: input.cashDelivered,
    p_notes: input.notes,
    p_user_id: userData.user.id,
  })
  if (error) throw new Error(error.message)
  return data as { closure_id: string; closure_number: string; status: string }
}

// 2. Crear un cierre de fondos nuevo a partir de una lista de fondos
export async function createFundClosure(selectedFunds: PendingRouteFund[]) {
  if (!selectedFunds || selectedFunds.length === 0) throw new Error("Debe seleccionar al menos un fondo");
  
  const db = await createAdquisicionesClient()
  const { data: userData, error: userError } = await db.auth.getUser()
  if (userError || !userData?.user) throw new Error('No autorizado')

  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')

  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.create')

  let closureNumber = '';
  let newSequence = 1;
  const year = new Date().getFullYear();
  let closureId = '';
  
  // Validar propiedad de los fondos si no es superuser
  const { data: isSuper } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userData.user.id,
    p_permission_code: 'adquisiciones.route_fund_closures.cancel'
  });

  const selectedItemIds = selectedFunds.map(f => f.route_settlement_item_id);
  const { data: realItems, error: realItemsError } = await db.from('route_settlement_items')
    .select('id, custody_user_id, custody_received_at')
    .in('id', selectedItemIds)
    .eq('company_id', companyId);

  if (realItemsError || !realItems) throw new Error("Error validando los fondos seleccionados.");

  const itemsMap = new Map(realItems.map(i => [i.id, i]));

  if (!isSuper) {
    for (const item of realItems) {
      if (item.custody_user_id !== userData.user.id) {
        throw new Error("No puedes incluir fondos recibidos por otro usuario.");
      }
    }
  }

  // Tomamos el custody_user_id del primer ítem (o del usuario activo si por algún motivo no tienen)
  const closureCustodyUserId = realItems[0]?.custody_user_id || userData.user.id;

  let totalCash = 0;
  let totalCheck = 0;

  // Reintento para manejar colisiones raras del unique constraint a pesar de la RPC transaccional
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data: seqData, error: seqError } = await db.schema('adquisiciones').rpc('get_next_route_fund_closure_number', {
      p_company_id: companyId,
      p_year: year
    });

    if (seqError || !seqData) {
      throw new Error("No se pudo generar el correlativo del cierre: " + (seqError?.message || 'Error desconocido'));
    }

    newSequence = seqData;
    closureNumber = `CFC-${year}-${String(newSequence).padStart(6, '0')}`;

    const { data: closureData, error: closureError } = await db.from('route_fund_closures').insert({
      company_id: companyId,
      closure_number: closureNumber,
      closure_year: year,
      closure_sequence: newSequence,
      status: 'OPEN',
      total_cash_received: totalCash,
      total_check_received: totalCheck,
      total_pending: totalCash + totalCheck,
      created_by: userData.user.id,
      custody_user_id: closureCustodyUserId
    }).select('id').single();

    if (!closureError) {
      closureId = closureData.id;
      break; // Éxito
    }

    if (closureError.code === '23505' && attempt < 2) {
      continue; // Reintentar si hubo colisión
    }

    throw new Error("Error creando cabecera: " + closureError.message);
  }

  // Insert items
  const itemsToInsert = selectedFunds.map(f => {
    const rItem = itemsMap.get(f.route_settlement_item_id);
    return {
      company_id: companyId,
      fund_closure_id: closureId,
      route_settlement_item_id: f.route_settlement_item_id,
      route_settlement_id: f.route_settlement_id,
      route_guide_id: f.route_guide_id,
      invoice_number: f.invoice_number,
      customer_name: f.customer_name,
      payment_method: f.payment_method === 'CHECK' || f.payment_method === 'CHECK_RECEIVED' ? 'CHECK' : 'CASH',
      amount: f.amount,
      custody_user_id: rItem?.custody_user_id || closureCustodyUserId,
      custody_received_at: rItem?.custody_received_at
    };
  });

  const { error: itemsError } = await db.from('route_fund_closure_items').insert(itemsToInsert);
  if (itemsError) {
    // Cleanup if items fail to avoid partial states
    await db.from('route_fund_closures').delete().eq('id', closureId);
    if (itemsError.code === '23505') throw new Error("Uno o más fondos ya fueron asignados a otro cierre activo.");
    throw new Error("Error insertando ítems: " + itemsError.message);
  }

  await recalculateClosureTotals(closureId, companyId, db);

  return closureId;
}

// 3. Obtener cierres (para historial y activos)
export async function getFundClosures(filters?: {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  custody_user_id?: string;
}) {
  const db = await createAdquisicionesClient()
  const { data: userData, error: userError } = await db.auth.getUser()
  if (userError || !userData?.user) throw new Error('No autorizado')

  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')

  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')

  const { data: isSuper } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userData.user.id,
    p_permission_code: 'adquisiciones.route_fund_closures.cancel'
  });

  let query = db.from('route_fund_closures')
    .select(`
      *,
       items:route_fund_closure_items(route_guide_id, payment_id, post_settlement_payment_id, source_type, route_settlement_id, invoice_number, customer_name, payment_method, amount, released_at),
      attachments:route_fund_closure_attachments(id)
    `)
    .eq('company_id', companyId)

  if (!isSuper) {
    query = query.eq('custody_user_id', userData.user.id)
  } else if (filters?.custody_user_id) {
    query = query.eq('custody_user_id', filters.custody_user_id)
  }

  if (filters?.search) {
    query = query.ilike('closure_number', `%${filters.search}%`)
  }
  if (filters?.dateFrom) {
    query = query.gte('created_at', filters.dateFrom)
  }
  if (filters?.dateTo) {
    query = query.lte('created_at', filters.dateTo + 'T23:59:59.999Z')
  }
  if (filters?.status) {
    query = query.eq('status', filters.status)
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  if (data && data.length > 0) {
    const paymentToClosures = new Map<string, Set<string>>()
    const postPaymentToClosures = new Map<string, Set<string>>()
    data.forEach(closure => {
      for (const item of (closure.items || []) as Array<{ payment_id?: string; post_settlement_payment_id?: string }>) {
        if (item.payment_id) {
          const closureIds = paymentToClosures.get(item.payment_id) ?? new Set<string>()
          closureIds.add(closure.id)
          paymentToClosures.set(item.payment_id, closureIds)
        }
        if (item.post_settlement_payment_id) {
          const closureIds = postPaymentToClosures.get(item.post_settlement_payment_id) ?? new Set<string>()
          closureIds.add(closure.id)
          postPaymentToClosures.set(item.post_settlement_payment_id, closureIds)
        }
      }
    })
    const paymentIds = [...paymentToClosures.keys()]
    const postPaymentIds = [...postPaymentToClosures.keys()]
    const [paymentsResult, postPaymentsResult, allocationsResult, postAllocationsResult] = await Promise.all([
      paymentIds.length > 0
        ? db.from('route_settlement_payments').select('id').in('id', paymentIds).eq('verification_status', 'CONFIRMED').is('voided_at', null)
        : Promise.resolve({ data: [], error: null }),
      postPaymentIds.length > 0
        ? db.from('post_settlement_payments').select('id').in('id', postPaymentIds).eq('verification_status', 'CONFIRMED').is('voided_at', null)
        : Promise.resolve({ data: [], error: null }),
      paymentIds.length > 0
        ? db.from('route_settlement_payment_allocations').select('payment_id, settlement_item_id').in('payment_id', paymentIds).is('voided_at', null)
        : Promise.resolve({ data: [], error: null }),
      postPaymentIds.length > 0
        ? db.from('post_settlement_payment_allocations').select('payment_id, settlement_item_id').in('payment_id', postPaymentIds).is('voided_at', null)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (paymentsResult.error) throw new Error(paymentsResult.error.message)
    if (postPaymentsResult.error) throw new Error(postPaymentsResult.error.message)
    if (allocationsResult.error) throw new Error(allocationsResult.error.message)
    if (postAllocationsResult.error) throw new Error(postAllocationsResult.error.message)

    const activePaymentIds = new Set((paymentsResult.data ?? []).map(payment => payment.id))
    const activePostPaymentIds = new Set((postPaymentsResult.data ?? []).map(payment => payment.id))
    const invoiceCounts = new Map<string, Set<string>>()
    for (const allocation of (allocationsResult.data ?? []) as Array<{ payment_id: string; settlement_item_id: string }>) {
      if (!activePaymentIds.has(allocation.payment_id)) continue
      for (const closureId of paymentToClosures.get(allocation.payment_id) ?? []) {
        const invoiceIds = invoiceCounts.get(closureId) ?? new Set<string>()
        invoiceIds.add(allocation.settlement_item_id)
        invoiceCounts.set(closureId, invoiceIds)
      }
    }
    for (const allocation of (postAllocationsResult.data ?? []) as Array<{ payment_id: string; settlement_item_id: string }>) {
      if (!activePostPaymentIds.has(allocation.payment_id)) continue
      for (const closureId of postPaymentToClosures.get(allocation.payment_id) ?? []) {
        const invoiceIds = invoiceCounts.get(closureId) ?? new Set<string>()
        invoiceIds.add(allocation.settlement_item_id)
        invoiceCounts.set(closureId, invoiceIds)
      }
    }

    data.forEach(closure => {
      const items = (closure.items || []) as Array<{ payment_id?: string; post_settlement_payment_id?: string; released_at?: string | null }>
      const countableItems = closure.status === 'CANCELLED'
        ? items
        : items.filter(item => item.released_at == null)
      const routePaymentCount = new Set(countableItems.map(item => item.payment_id).filter((id): id is string => Boolean(id && activePaymentIds.has(id)))).size
      const postPaymentCount = new Set(countableItems.map(item => item.post_settlement_payment_id).filter((id): id is string => Boolean(id && activePostPaymentIds.has(id)))).size
      closure.payment_count = routePaymentCount + postPaymentCount
      closure.invoice_count = invoiceCounts.get(closure.id)?.size ?? 0
    })

    const userIds = [...new Set(data.map(d => d.custody_user_id).filter(Boolean))];
    const guideIds = [...new Set(data.flatMap(d => (d.items || []).map((i: any) => i.route_guide_id)).filter(Boolean))];

    const [usersRes, guidesRes] = await Promise.all([
      userIds.length > 0 ? db.schema('portal').from('users').select('id, nombre, apellido').in('id', userIds) : Promise.resolve({ data: null }),
      guideIds.length > 0 ? db.schema('logistica').from('route_guides').select('id, guide_number').in('id', guideIds) : Promise.resolve({ data: null })
    ]);

    const usersById = (usersRes.data || []).reduce((acc: any, u: any) => { acc[u.id] = u; return acc; }, {});
    const guidesById = (guidesRes.data || []).reduce((acc: any, g: any) => { acc[g.id] = g.guide_number; return acc; }, {});

    data.forEach(d => {
      if (d.custody_user_id && usersById[d.custody_user_id]) {
        d.custody_user = usersById[d.custody_user_id];
      }
      if (d.items) {
        d.items.forEach((i: any) => {
          if (i.route_guide_id && guidesById[i.route_guide_id]) {
            i.guide_number = guidesById[i.route_guide_id];
          }
        });
      }
    });
  }

  return data;
}

export async function getFundClosureById(id: string) {
  const db = await createAdquisicionesClient()
  const { data: userData, error: userError } = await db.auth.getUser()
  if (userError || !userData?.user) throw new Error('No autorizado')

  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')

  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')

  const { data: isSuper } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userData.user.id,
    p_permission_code: 'adquisiciones.route_fund_closures.cancel'
  });

  let closureQuery = db.from('route_fund_closures').select('*').eq('id', id).eq('company_id', companyId);
  if (!isSuper) {
    closureQuery = closureQuery.eq('custody_user_id', userData.user.id);
  }

  const [closure, items, expenses, deposits, attachments] = await Promise.all([
    closureQuery.single(),
    db.from('route_fund_closure_items').select('*').eq('fund_closure_id', id),
    db.from('route_fund_closure_expenses').select('*').eq('fund_closure_id', id),
    db.from('route_fund_closure_deposits').select('*').eq('fund_closure_id', id),
    db.from('route_fund_closure_attachments').select('*').eq('fund_closure_id', id)
  ]);

  if (closure.data && closure.data.custody_user_id) {
     const { data: cUserData } = await db.schema('portal').from('users').select('id, nombre, apellido').eq('id', closure.data.custody_user_id).single();
    if (cUserData) {
      closure.data.custody_user = cUserData;
    }
  }

  const closureItems = items.data || [];
  if (closureItems.length > 0) {
    const guideIds = [...new Set(closureItems.map((i: any) => i.route_guide_id).filter(Boolean))];
    const paymentIds = [...new Set(closureItems.map((i: any) => i.payment_id).filter(Boolean))];
    const postPaymentIds = [...new Set(closureItems.map((i: any) => i.post_settlement_payment_id).filter(Boolean))];
    const settlementIds = [...new Set(closureItems.map((i: any) => i.route_settlement_id).filter(Boolean))];
    const [{ data: allocations, error: allocationsError }, { data: settlements, error: settlementsError }, { data: postPayments, error: postPaymentsError }, { data: postAllocations, error: postAllocationsError }] = await Promise.all([
      paymentIds.length > 0
        ? db.from('route_settlement_payment_allocations').select('payment_id, settlement_item_id, amount_applied').in('payment_id', paymentIds).is('voided_at', null)
        : Promise.resolve({ data: [], error: null }),
      settlementIds.length > 0
        ? db.from('route_settlements').select('id, settlement_number').in('id', settlementIds).eq('company_id', companyId)
        : Promise.resolve({ data: [], error: null }),
      postPaymentIds.length > 0
        ? db.from('post_settlement_payments').select('id, received_at, payment_method_received, amount_received, reference_number, check_number').in('id', postPaymentIds).eq('company_id', companyId)
        : Promise.resolve({ data: [], error: null }),
      postPaymentIds.length > 0
        ? db.from('post_settlement_payment_allocations').select('payment_id, settlement_item_id, amount_applied').in('payment_id', postPaymentIds).is('voided_at', null)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (allocationsError) throw new Error(allocationsError.message);
    if (settlementsError) throw new Error(settlementsError.message);
    if (postPaymentsError) throw new Error(postPaymentsError.message);
    if (postAllocationsError) throw new Error(postAllocationsError.message);

    const allocationItemIds = [...new Set((allocations ?? []).map(allocation => allocation.settlement_item_id))];
    const { data: settlementItems, error: settlementItemsError } = allocationItemIds.length > 0
      ? await db.from('route_settlement_items').select('id, invoice_number, customer_name').in('id', allocationItemIds).eq('company_id', companyId)
      : { data: [], error: null };
    if (settlementItemsError) throw new Error(settlementItemsError.message);

    const settlementNumbers = new Map((settlements ?? []).map(settlement => [settlement.id, settlement.settlement_number]));
    const settlementItemsById = new Map((settlementItems ?? []).map(item => [item.id, item]));
    const allocationsByPayment = new Map<string, Array<{ settlement_item_id: string; amount_applied: number; invoice_number: string; customer_name: string }>>();
    for (const allocation of allocations ?? []) {
      const settlementItem = settlementItemsById.get(allocation.settlement_item_id);
      const paymentAllocations = allocationsByPayment.get(allocation.payment_id) ?? [];
      paymentAllocations.push({
        settlement_item_id: allocation.settlement_item_id,
        amount_applied: Number(allocation.amount_applied || 0),
        invoice_number: settlementItem?.invoice_number ?? allocation.settlement_item_id,
        customer_name: settlementItem?.customer_name ?? 'Cliente no disponible',
      });
      allocationsByPayment.set(allocation.payment_id, paymentAllocations);
    }
    for (const allocation of postAllocations ?? []) {
      const settlementItem = settlementItemsById.get(allocation.settlement_item_id);
      const paymentAllocations = allocationsByPayment.get(allocation.payment_id) ?? [];
      paymentAllocations.push({
        settlement_item_id: allocation.settlement_item_id,
        amount_applied: Number(allocation.amount_applied || 0),
        invoice_number: settlementItem?.invoice_number ?? allocation.settlement_item_id,
        customer_name: settlementItem?.customer_name ?? 'Cliente no disponible',
      });
      allocationsByPayment.set(allocation.payment_id, paymentAllocations);
    }

    closureItems.forEach((item: any) => {
      item.settlement_number = settlementNumbers.get(item.route_settlement_id) ?? item.route_settlement_id;
      item.allocations = allocationsByPayment.get(item.payment_id) ?? [];
      if (item.post_settlement_payment_id) {
        const postPayment = (postPayments ?? []).find((payment: any) => payment.id === item.post_settlement_payment_id);
        if (postPayment) {
          item.received_at = postPayment.received_at;
          item.payment_method_received = postPayment.payment_method_received;
          item.amount_received = postPayment.amount_received;
          item.reference_number = postPayment.reference_number;
          item.check_number = postPayment.check_number;
        }
      }
    });

    if (guideIds.length > 0) {
      const { data: guidesData } = await db.schema('logistica').from('route_guides').select('id, guide_number').in('id', guideIds);
      if (guidesData) {
        const guidesById = guidesData.reduce((acc: any, g: any) => { acc[g.id] = g.guide_number; return acc; }, {});
        closureItems.forEach((i: any) => {
          if (i.route_guide_id && guidesById[i.route_guide_id]) {
            i.guide_number = guidesById[i.route_guide_id];
          }
        });
      }
    }
  }

  return {
    closure: closure.data,
    items: items.data || [],
    allocations: closureItems.flatMap((item: any) => item.allocations || []),
    expenses: expenses.data || [],
    deposits: deposits.data || [],
    attachments: attachments.data || []
  };
}

export async function addClosureExpense(closureId: string, formData: FormData) {
  const db = await createAdquisicionesClient()
  const { data: userData } = await db.auth.getUser()
  if (!userData?.user) throw new Error('No autorizado')
  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')
  
  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.update')

  const route_guide_id = formData.get('route_guide_id') as string
  const expense_scope = formData.get('expense_scope') as string
  const expense_type = formData.get('expense_type') as string
  const amount = Number(formData.get('amount'))
  const expense_date = formData.get('expense_date') as string
  const notes = formData.get('notes') as string | null

  // 0. Validar status y propiedad
  const { data: closureDataCheck, error: closureCheckError } = await db.from('route_fund_closures').select('status, custody_user_id').eq('id', closureId).single();
  if (closureCheckError || !closureDataCheck) throw new Error("Cierre no encontrado");
  if (closureDataCheck.status === 'CLOSED' || closureDataCheck.status === 'CANCELLED') {
    throw new Error("Este cierre ya fue finalizado y no puede modificarse.");
  }
  
  const { data: isSuper } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userData.user.id,
    p_permission_code: 'adquisiciones.route_fund_closures.cancel'
  });
  if (!isSuper && closureDataCheck.custody_user_id !== userData.user.id) {
    throw new Error("No tienes permiso para modificar un cierre de otro usuario.");
  }

  const { data: closureItemContext, error: closureItemContextError } = await db
    .from('route_fund_closure_items')
    .select('route_settlement_id, route_guide_id')
    .eq('fund_closure_id', closureId)
    .eq('route_guide_id', route_guide_id)
    .eq('company_id', companyId)
    .limit(1)
    .maybeSingle();
  if (closureItemContextError || !closureItemContext) {
    throw new Error('La guía no pertenece a los fondos de este cierre.');
  }

  // 1. Insertar el gasto
  const { data: expenseData, error: expenseError } = await db.from('route_fund_closure_expenses').insert({
    company_id: companyId,
    fund_closure_id: closureId,
    route_settlement_id: closureItemContext.route_settlement_id,
    route_guide_id,
    custody_user_id: closureDataCheck.custody_user_id,
    expense_scope,
    expense_type,
    amount,
    expense_date,
    notes,
    created_by: userData.user.id
  }).select('id').single();

  if (expenseError) throw new Error(expenseError.message);
  
  // 2. Procesar adjunto si existe
  const file = formData.get('file') as File | null;
  if (file && file.size > 0) {
    if (file.size > SETTLEMENT_ATTACHMENT_MAX_SIZE) throw new Error('El archivo no puede superar 10 MB.')
    const extension = settlementAttachmentExtension(file.type)
    if (!extension) throw new Error('Tipo de archivo no permitido. Solo PDF, PNG, JPG o WebP.')
    const storagePath = `${companyId}/fund-closures/${closureId}/expenses/${crypto.randomUUID()}.${extension}`;
    
    const { error: uploadError } = await db.storage.from('rendicion-rutas').upload(storagePath, file);
    if (uploadError) throw new Error(`Error subiendo archivo: ${uploadError.message}`);
    
    const { error: attachError } = await db.from('route_fund_closure_attachments').insert({
      company_id: companyId,
      fund_closure_id: closureId,
      attachment_type: 'EXPENSE',
      expense_id: expenseData.id,
      file_name: file.name,
      storage_path: storagePath,
      file_mime_type: file.type,
      file_size: file.size,
      uploaded_by: userData.user.id
    });
    
    if (attachError) {
      await db.storage.from(SETTLEMENT_ATTACHMENT_BUCKET).remove([storagePath])
      throw new Error(`Error guardando metadata del adjunto: ${attachError.message}`);
    }
  }

  await recalculateClosureTotals(closureId, companyId, db);
}

export async function addClosureDeposit(closureId: string, formData: FormData) {
  const db = await createAdquisicionesClient()
  const { data: userData } = await db.auth.getUser()
  if (!userData?.user) throw new Error('No autorizado')
  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')
  
  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.update')

  const deposit_method = formData.get('deposit_method') as string
  const amount = Number(formData.get('amount'))
  const deposit_date = formData.get('deposit_date') as string
  const reference_number = formData.get('reference_number') as string | null
  const notes = formData.get('notes') as string | null

  // 0. Validar status y propiedad
  const { data: closureDataCheck, error: closureCheckError } = await db.from('route_fund_closures').select('status, custody_user_id').eq('id', closureId).single();
  if (closureCheckError || !closureDataCheck) throw new Error("Cierre no encontrado");
  if (closureDataCheck.status === 'CLOSED' || closureDataCheck.status === 'CANCELLED') {
    throw new Error("Este cierre ya fue finalizado y no puede modificarse.");
  }
  
  const { data: isSuper } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userData.user.id,
    p_permission_code: 'adquisiciones.route_fund_closures.cancel'
  });
  if (!isSuper && closureDataCheck.custody_user_id !== userData.user.id) {
    throw new Error("No tienes permiso para modificar un cierre de otro usuario.");
  }

  const { data: depositData, error: depositError } = await db.from('route_fund_closure_deposits').insert({
    company_id: companyId,
    fund_closure_id: closureId,
    deposit_method,
    amount,
    deposit_date,
    reference_number,
    notes,
    created_by: userData.user.id
  }).select('id').single();

  if (depositError) throw new Error(depositError.message);
  
  // Procesar adjunto si existe
  const file = formData.get('file') as File | null;
  if (file && file.size > 0) {
    if (file.size > SETTLEMENT_ATTACHMENT_MAX_SIZE) throw new Error('El archivo no puede superar 10 MB.')
    const extension = settlementAttachmentExtension(file.type)
    if (!extension) throw new Error('Tipo de archivo no permitido. Solo PDF, PNG, JPG o WebP.')
    const storagePath = `${companyId}/fund-closures/${closureId}/deposits/${depositData.id}/${crypto.randomUUID()}.${extension}`;
    
    const { error: uploadError } = await db.storage.from('rendicion-rutas').upload(storagePath, file);
    if (uploadError) throw new Error(`Error subiendo archivo: ${uploadError.message}`);
    
    const { error: attachError } = await db.from('route_fund_closure_attachments').insert({
      company_id: companyId,
      fund_closure_id: closureId,
      attachment_type: 'DEPOSIT',
      deposit_id: depositData.id,
      file_name: file.name,
      storage_path: storagePath,
      file_mime_type: file.type,
      file_size: file.size,
      uploaded_by: userData.user.id
    });
    
    if (attachError) {
      await db.storage.from(SETTLEMENT_ATTACHMENT_BUCKET).remove([storagePath])
      throw new Error(`Error guardando metadata del adjunto: ${attachError.message}`);
    }
  }

  await recalculateClosureTotals(closureId, companyId, db);
}

export interface RegisterRouteFundClosureDepositInput {
  fundClosureId: string
  amount: number
  depositDate: string
  depositMethod: 'DEPOSIT' | 'CASH_DELIVERY' | 'TRANSFER' | 'OTHER'
  referenceNumber?: string | null
  notes?: string | null
  checkPaymentIds?: string[]
}

export async function registerRouteFundClosureDeposit(input: RegisterRouteFundClosureDepositInput) {
  const db = await createAdquisicionesClient()
  try {
    const { data: userData, error: userError } = await db.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('Empresa no seleccionada')
    await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.update')
    if (!input.fundClosureId) throw new Error('El Cierre de Fondos es obligatorio.')
    if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('El monto del depósito debe ser mayor que cero.')
    if (!input.depositDate) throw new Error('La fecha del depósito es obligatoria.')
    if (!['DEPOSIT', 'CASH_DELIVERY', 'TRANSFER', 'OTHER'].includes(input.depositMethod)) throw new Error('Método de depósito inválido.')
    const { data, error } = await db.schema('adquisiciones').rpc('register_route_fund_closure_deposit', {
      p_fund_closure_id: input.fundClosureId,
      p_amount: input.amount,
      p_deposit_date: input.depositDate,
      p_deposit_method: input.depositMethod,
      p_reference_number: input.referenceNumber?.trim() || null,
      p_notes: input.notes?.trim() || null,
      p_check_payment_ids: input.checkPaymentIds ?? [],
    })
    if (error) throw new Error(error.message)
    return { data: data as { deposit_id: string; status: string; saldo_por_depositar: number; total_fisico_recibido: number; total_depositado: number } | null, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo registrar el depósito.'
    return { data: null, error: message }
  }
}

export async function voidRouteFundClosureDeposit(depositId: string, voidReason: string) {
  const db = await createAdquisicionesClient()
  try {
    const { data: userData, error: userError } = await db.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('Empresa no seleccionada')
    await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.update')
    if (!depositId) throw new Error('El depósito es obligatorio.')
    if (!voidReason.trim()) throw new Error('El motivo de anulación es obligatorio.')
    const { data, error } = await db.schema('adquisiciones').rpc('void_route_fund_closure_deposit', {
      p_deposit_id: depositId,
      p_void_reason: voidReason.trim(),
    })
    if (error) throw new Error(error.message)
    return { data: data as { deposit_id: string; status: string; saldo_por_depositar: number } | null, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo anular el depósito.'
    return { data: null, error: message }
  }
}

export async function getRouteFundClosureDepositSummary(fundClosureId: string) {
  const db = await createAdquisicionesClient()
  try {
    const { data: userData, error: userError } = await db.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('Empresa no seleccionada')
    await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')
    if (!fundClosureId) throw new Error('El Cierre de Fondos es obligatorio.')
    const { data, error } = await db.schema('adquisiciones').rpc('get_route_fund_closure_deposit_summary', {
      p_fund_closure_id: fundClosureId,
    })
    if (error) throw new Error(error.message)
    return { data: data as RouteFundClosureDepositSummary | null, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo consultar el detalle de depósitos.'
    return { data: null, error: message }
  }
}

export interface PendingRouteFundDepositFilters {
  closureNumber?: string
  custodyUserId?: string
  situation?: 'PENDING' | 'PARTIAL'
  dateFrom?: string
  dateTo?: string
}

export async function getPendingRouteFundDeposits(filters: PendingRouteFundDepositFilters = {}) {
  const db = await createAdquisicionesClient()
  try {
    const { data: userData, error: userError } = await db.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('Empresa no seleccionada')
    await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')
    const { data, error } = await db.schema('adquisiciones').rpc('get_pending_route_fund_deposits', {
      p_company_id: companyId,
      p_closure_number: filters.closureNumber?.trim() || null,
      p_custody_user_id: filters.custodyUserId || null,
      p_situation: filters.situation || null,
      p_date_from: filters.dateFrom || null,
      p_date_to: filters.dateTo || null,
    })
    if (error) throw new Error(error.message)
    return { data: (data ?? []) as PendingRouteFundDeposit[], error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudieron consultar los depósitos pendientes.'
    return { data: null, error: message }
  }
}

export async function saveRouteFundClosureDepositAttachment(depositId: string, fundClosureId: string, formData: FormData) {
  const db = await createAdquisicionesClient()
  try {
    const { data: userData, error: userError } = await db.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('Empresa no seleccionada')
    await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.update')
    if (!depositId || !fundClosureId) throw new Error('Depósito y Cierre de Fondos son obligatorios.')

    const file = formData.get('file')
    if (!(file instanceof File) || file.size <= 0) throw new Error('Selecciona un comprobante.')
    if (file.size > SETTLEMENT_ATTACHMENT_MAX_SIZE) throw new Error('El archivo no puede superar 10 MB.')
    if (!(SETTLEMENT_ATTACHMENT_ALLOWED_MIMES as readonly string[]).includes(file.type)) throw new Error('Tipo de archivo no permitido. Solo PDF, PNG, JPG o WebP.')

    const { data: deposit, error: depositError } = await db
      .from('route_fund_closure_deposits')
      .select('id, company_id, fund_closure_id')
      .eq('id', depositId)
      .eq('fund_closure_id', fundClosureId)
      .eq('company_id', companyId)
      .single()
    if (depositError || !deposit) throw new Error('Depósito no encontrado o sin acceso.')

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceKey) throw new Error('No está configurada la carga segura del comprobante.')
    const adminDb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      db: { schema: 'adquisiciones' },
      cookies: { getAll() { return [] }, setAll() {} },
    })
    const extension = settlementAttachmentExtension(file.type)
    if (!extension) throw new Error('Tipo de archivo no permitido. Solo PDF, PNG, JPG o WebP.')
    const storagePath = `${companyId}/fund-closures/${fundClosureId}/deposits/${depositId}/${crypto.randomUUID()}.${extension}`
    const { error: uploadError } = await adminDb.storage.from(SETTLEMENT_ATTACHMENT_BUCKET).upload(storagePath, file)
    if (uploadError) throw new Error(`No se pudo subir el comprobante: ${uploadError.message}`)

    const { data, error } = await adminDb.from('route_fund_closure_attachments').insert({
      company_id: companyId,
      fund_closure_id: fundClosureId,
      attachment_type: 'DEPOSIT',
      deposit_id: deposit.id,
      file_name: file.name,
      storage_path: storagePath,
      file_mime_type: file.type,
      file_size: file.size,
      uploaded_by: userData.user.id,
    }).select().single()
    if (error) {
      await adminDb.storage.from(SETTLEMENT_ATTACHMENT_BUCKET).remove([storagePath])
      throw new Error(`No se pudo guardar la metadata del comprobante: ${error.message}`)
    }
    return { data, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo guardar el comprobante del depósito.'
    return { data: null, error: message }
  }
}

export async function getRouteFundClosureDepositAttachments(depositId: string) {
  const db = await createAdquisicionesClient()
  try {
    const { data: userData, error: userError } = await db.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('Empresa no seleccionada')
    await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')
    const { data, error } = await db.from('route_fund_closure_attachments')
      .select('*').eq('deposit_id', depositId).eq('company_id', companyId).eq('attachment_type', 'DEPOSIT').order('uploaded_at', { ascending: true })
    if (error) throw error
    return { data: data ?? [], error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudieron cargar los comprobantes del depósito.'
    return { data: null, error: message }
  }
}

export async function getRouteFundClosureDepositAttachmentSignedUrl(attachmentId: string) {
  const db = await createAdquisicionesClient()
  try {
    const { data: userData, error: userError } = await db.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('Empresa no seleccionada')
    await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.view')
    const { data: attachment, error } = await db.from('route_fund_closure_attachments')
      .select('id, storage_path, file_name, file_mime_type').eq('id', attachmentId).eq('company_id', companyId).eq('attachment_type', 'DEPOSIT').single()
    if (error || !attachment) throw new Error('Comprobante no encontrado o sin acceso.')
    const { data: signed, error: signError } = await db.storage.from(SETTLEMENT_ATTACHMENT_BUCKET).createSignedUrl(attachment.storage_path, 300)
    if (signError || !signed?.signedUrl) throw new Error('No se pudo generar la URL del comprobante.')
    return { data: { signedUrl: signed.signedUrl, fileName: attachment.file_name, mimeType: attachment.file_mime_type, expiresIn: 300 }, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo abrir el comprobante.'
    return { data: null, error: message }
  }
}

export async function deleteRouteFundClosureDepositAttachment(attachmentId: string) {
  const db = await createAdquisicionesClient()
  try {
    const { data: userData, error: userError } = await db.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('Empresa no seleccionada')
    await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.update')
    const { data: attachment, error } = await db.from('route_fund_closure_attachments')
      .select('id, storage_path').eq('id', attachmentId).eq('company_id', companyId).eq('attachment_type', 'DEPOSIT').single()
    if (error || !attachment) throw new Error('Comprobante no encontrado o sin acceso.')
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceKey) throw new Error('No está configurada la eliminación segura del comprobante.')
    const adminDb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { db: { schema: 'adquisiciones' }, cookies: { getAll() { return [] }, setAll() {} } })
    const { error: storageError } = await adminDb.storage.from(SETTLEMENT_ATTACHMENT_BUCKET).remove([attachment.storage_path])
    if (storageError) throw new Error(`No se pudo eliminar el archivo: ${storageError.message}`)
    const { error: deleteError } = await adminDb.from('route_fund_closure_attachments').delete().eq('id', attachmentId).eq('company_id', companyId)
    if (deleteError) throw deleteError
    return { data: { deleted: true }, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo eliminar el comprobante.'
    return { data: null, error: message }
  }
}

export async function executeCloseFundClosure(closureId: string) {
  const db = await createAdquisicionesClient()
  const { data: userData } = await db.auth.getUser()
  if (!userData?.user) throw new Error('No autorizado')
  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')
  
  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.close')

  const { data: closure } = await db.from('route_fund_closures').select('*').eq('id', closureId).single();
  if (!closure) throw new Error("Cierre no encontrado");
  if (closure.status === 'CLOSED' || closure.status === 'CANCELLED') {
    throw new Error("Este cierre ya fue finalizado y no puede modificarse.");
  }

  const { data: isSuper } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userData.user.id,
    p_permission_code: 'adquisiciones.route_fund_closures.cancel'
  });
  if (!isSuper && closure.custody_user_id !== userData.user.id) {
    throw new Error("No tienes permiso para finalizar un cierre de otro usuario.");
  }

  await recalculateClosureTotals(closureId, companyId, db);
  
  const { data: updatedClosure } = await db.from('route_fund_closures').select('*').eq('id', closureId).single();

  let newStatus = 'CLOSED';
  if (updatedClosure.total_pending !== 0) {
    newStatus = 'WITH_DIFFERENCE';
  }

  const { error } = await db.from('route_fund_closures').update({
    status: newStatus,
    closed_at: new Date().toISOString(),
    closed_by: userData.user.id
  }).eq('id', closureId);

  if (error) throw new Error(error.message);
}

async function recalculateClosureTotals(closureId: string, companyId: string, db: any) {
  // Fetch items
  const { data: items } = await db.from('route_fund_closure_items').select('payment_method, amount').eq('fund_closure_id', closureId).is('released_at', null);
  
  let totalCash = 0;
  let totalCheck = 0;
  if (items) {
    items.forEach((item: any) => {
      if (item.payment_method === 'CASH') totalCash += Number(item.amount || 0);
      else if (item.payment_method === 'CHECK') totalCheck += Number(item.amount || 0);
    });
  }

  // Expenses
  const { data: expenses } = await db.from('route_fund_closure_expenses').select('amount').eq('fund_closure_id', closureId);
  const totalExpenses = (expenses || []).reduce((acc: number, curr: any) => acc + Number(curr.amount), 0);
  
  // Deposits
  const { data: deposits } = await db.from('route_fund_closure_deposits').select('amount').eq('fund_closure_id', closureId);
  const totalDeposits = (deposits || []).reduce((acc: number, curr: any) => acc + Number(curr.amount), 0);

  const totalPending = totalCash + totalCheck - totalExpenses - totalDeposits;

  await db.from('route_fund_closures').update({
    total_cash_received: totalCash,
    total_check_received: totalCheck,
    total_expenses: totalExpenses,
    total_deposits: totalDeposits,
    total_pending: totalPending,
    difference_amount: totalPending < 0 ? totalPending : 0
  }).eq('id', closureId);
}
export async function getAttachmentSignedUrl(storagePath: string) {
  const db = await createAdquisicionesClient()
  const { data: userData } = await db.auth.getUser()
  if (!userData?.user) throw new Error('No autorizado')

  const { data, error } = await db.storage.from('rendicion-rutas').createSignedUrl(storagePath, 60)
  if (error) throw new Error('No se pudo generar el enlace seguro: ' + error.message)
  
  return data.signedUrl
}

export async function cancelFundClosure(closureId: string, cancelReason: string) {
  const db = await createAdquisicionesClient()
  const { data: userData } = await db.auth.getUser()
  if (!userData?.user) throw new Error('No autorizado')
  const companyId = await getActiveCompanyId(userData.user)
  if (!companyId) throw new Error('Empresa no seleccionada')
  
  await requirePermission(db, userData.user.id, 'adquisiciones.route_fund_closures.cancel')

  if (!cancelReason || cancelReason.trim().length < 5) {
    throw new Error('Debe proporcionar un motivo válido para la anulación (mínimo 5 caracteres).');
  }

  const { error } = await db.schema('adquisiciones').rpc('cancel_route_fund_closure', {
    p_company_id: companyId,
    p_closure_id: closureId,
    p_cancel_reason: cancelReason.trim(),
    p_user_id: userData.user.id,
  });

  if (error) throw new Error(error.message);
}
