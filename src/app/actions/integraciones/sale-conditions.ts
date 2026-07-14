'use server'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getActiveCompanyId } from '@/app/actions/companies'
import { normalizePaymentMethodAdvanced } from '@/modules/logistica/guias-ruta/utils/payment-normalizer'
import { PaymentMethodNormalized } from '@/modules/logistica/guias-ruta/types'

export interface SaleConditionOption {
  id: string
  bsale_id: number
  name: string
  normalized: PaymentMethodNormalized
  label: string
}

export async function getSaleConditions(): Promise<SaleConditionOption[]> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'integraciones' },
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() {},
      },
    }
  )

  const { data, error } = await supabase
    .from('bsale_sale_conditions')
    .select('id, bsale_id, name')
    .eq('company_id', companyId)
    .order('name', { ascending: true })

  if (error || !data) {
    console.error('[getSaleConditions]', error?.message)
    return []
  }

  return data.map((sc) => {
    const result = normalizePaymentMethodAdvanced(sc.name)
    return {
      id: sc.id,
      bsale_id: sc.bsale_id,
      name: sc.name,
      normalized: result.normalized,
      label: `${sc.name} (${result.label})`,
    }
  })
}
