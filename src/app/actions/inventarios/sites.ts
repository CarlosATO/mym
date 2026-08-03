'use server'

import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'

async function inventariosAdmin() {
  return createInventariosClient()
}

export interface InventorySite {
  id: string
  company_id: string
  name: string
  code: string
  site_type: 'INTERNAL_WAREHOUSE' | 'OWN_STORE' | 'EXTERNAL_SITE'
  warehouse_id: string | null
  warehouse_name: string | null
  is_active: boolean
  inventory_enabled: boolean
  location_count: number
  created_at: string
  updated_at: string
}

export interface InventorySiteLocation {
  id: string
  company_id: string
  inventory_site_id: string
  source_logistics_location_id: string | null
  code: string
  name: string | null
  aisle: string | null
  rack: string | null
  level: string | null
  position: string | null
  is_active: boolean
}

export async function getActiveCompanySites(): Promise<{
  data: InventorySite[] | null
  error: string | null
  companyId: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_sites', {
      p_company_id: companyId,
    })
    if (error) {
      console.error('list_inventory_sites error:', error.message)
      return { data: null, error: 'No se pudieron cargar las unidades inventariables.', companyId }
    }
    const sites = (data as { sites?: InventorySite[] } | null)?.sites ?? []
    return { data: sites, error: null, companyId }
  } catch (err) {
    console.error('list_inventory_sites exception:', err)
    return { data: null, error: 'No se pudieron cargar las unidades inventariables.', companyId }
  }
}

export async function updateInventorySiteInventoryConfig(
  siteId: string,
  inventoryEnabled: boolean
): Promise<{ data: { site_id: string } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  }
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('set_inventory_site_inventory_config', {
      p_company_id: companyId,
      p_site_id: siteId,
      p_inventory_enabled: inventoryEnabled,
    })
    if (error) {
      console.error('set_inventory_site_inventory_config error:', error.message)
      return { data: null, error: 'No se pudo actualizar la configuración de la unidad.' }
    }
    return { data: { site_id: siteId }, error: null }
  } catch (err) {
    console.error('set_inventory_site_inventory_config exception:', err)
    return { data: null, error: 'No se pudo actualizar la configuración de la unidad.' }
  }
}
