'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { createInventariosClient } from '@/lib/supabase/inventarios'

export interface InventoryWritePermissions {
  canCloseSession: boolean
  canApproveSession: boolean
  canCancelSession: boolean
  canAssignTasks: boolean
  canCancelTasks: boolean
  canValidateTasks: boolean
  canManageCampaigns: boolean
  canManageZones: boolean
}

const EMPTY_PERMISSIONS: InventoryWritePermissions = {
  canCloseSession: false,
  canApproveSession: false,
  canCancelSession: false,
  canAssignTasks: false,
  canCancelTasks: false,
  canValidateTasks: false,
  canManageCampaigns: false,
  canManageZones: false,
}

export async function getActiveCompanyInventoryWritePermissions(): Promise<InventoryWritePermissions> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return EMPTY_PERMISSIONS

  try {
    const db = await createInventariosClient()
    const { data: userData } = await db.auth.getUser()
    const { data, error } = await db.rpc('get_company_permissions', {
      p_user_id: userData.user?.id,
      p_company_id: companyId,
    })
    if (error) {
      console.error('get_company_permissions error:', error.message)
      return EMPTY_PERMISSIONS
    }

    const codes = new Set((data ?? []).map((permission: { permission_code: string }) => permission.permission_code))
    return {
      canCloseSession: codes.has('inventarios.sessions.close'),
      canApproveSession: codes.has('inventarios.sessions.approve'),
      canCancelSession: codes.has('inventarios.sessions.cancel'),
      canAssignTasks: codes.has('inventarios.tasks.assign'),
      canCancelTasks: codes.has('inventarios.tasks.cancel'),
      canValidateTasks: codes.has('inventarios.tasks.validate'),
      canManageCampaigns: codes.has('inventarios.campaigns.manage'),
      canManageZones: codes.has('inventarios.zones.manage'),
    }
  } catch (error) {
    console.error('get_company_permissions exception:', error)
    return EMPTY_PERMISSIONS
  }
}
