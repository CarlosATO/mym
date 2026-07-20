import fs from 'fs'

const code = `
export type SalesOrderPreparationMovement = {
  id: string
  company_id: string
  card_id: string
  from_status: string | null
  to_status: string
  moved_by: string | null
  movement_source: string
  pin_validated: boolean
  observation: string | null
  metadata: {
    moved_by_name?: string
  }
  created_at: string
}

export async function moveSalesOrderPreparationCard(params: {
  cardId: string
  toStatus: string
  observation?: string
}) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      throw new Error('No autorizado')
    }

    const { data: profile } = await supabase.schema('portal').from('users').select('role_id, roles:role_id(name)').eq('id', user.id).single()
    const roleName = profile?.roles?.name
    if (!['SUPER_USUARIO', 'GERENCIA', 'BODEGA'].includes(roleName)) {
      throw new Error('No tienes permisos para mover esta tarjeta')
    }

    const { data: userData } = await supabase.schema('portal').from('users').select('nombre, apellido').eq('id', user.id).single()
    const userName = \`\${userData?.nombre || ''} \${userData?.apellido || ''}\`.trim()

    const companyId = await getActiveCompanyId()

    const { data, error } = await supabase.schema('logistica').rpc('move_sales_order_preparation_card', {
      p_company_id: companyId,
      p_card_id: params.cardId,
      p_to_status: params.toStatus,
      p_observation: params.observation || null,
      p_user_id: user.id,
      p_user_name: userName
    })

    if (error) {
      return { ok: false, error: error.message }
    }

    return { ok: true, data }
  } catch (err: any) {
    return { ok: false, error: err.message || 'Error desconocido' }
  }
}

export async function getSalesOrderPreparationMovements(cardId: string) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId()

    const { data, error } = await supabase
      .schema('logistica')
      .from('sales_order_preparation_movements')
      .select('*')
      .eq('company_id', companyId)
      .eq('card_id', cardId)
      .order('created_at', { ascending: true })

    if (error) throw error

    return { data: data as SalesOrderPreparationMovement[], error: null }
  } catch (err: any) {
    return { data: [], error: err.message }
  }
}
`
fs.appendFileSync('src/app/actions/logistica/sales-order-preparation.ts', code)
