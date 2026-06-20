'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  getRolesWithDetails, updateRoleDescription, getAllPermissions,
  assignPermissionToRole, removePermissionFromRole,
  createRole, updateRole, deactivateRole,
  type RoleWithDetails,
} from '@/app/actions/roles'

interface PermWithModule {
  id: string; code: string; name: string
  modules: { code: string | null; name: string | null } | null
}

const permLabels: Record<string, string> = {
  'system.admin': 'Administrador global',
  'usuarios.view': 'Ver usuarios', 'usuarios.create': 'Crear usuarios',
  'usuarios.update': 'Actualizar usuarios', 'usuarios.deactivate': 'Desactivar usuarios',
  'roles.view': 'Ver roles', 'roles.assign': 'Asignar roles',
  'modules.view': 'Ver módulos', 'modules.manage': 'Gestionar módulos',
  'audit.view': 'Ver auditoría', 'security.view': 'Ver seguridad',
  'module.adquisiciones.view': 'Ver Adquisiciones',
}

const adminPermCodes = [
  'usuarios.view', 'usuarios.create', 'usuarios.update', 'usuarios.deactivate',
  'roles.view', 'roles.assign', 'audit.view', 'security.view',
]
const hiddenPermCodes = ['dashboard.view', 'system.admin', 'modules.view', 'modules.manage']

interface RolesViewProps {
  userPermissions: string[]
}

export function RolesView({ userPermissions }: RolesViewProps) {
  const canAssign = userPermissions.includes('roles.assign') || userPermissions.includes('system.admin')

  const [roles, setRoles] = useState<RoleWithDetails[]>([])
  const [allPerms, setAllPerms] = useState<PermWithModule[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedRole, setSelectedRole] = useState<RoleWithDetails | null>(null)
  const [message, setMessage] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editing, setEditing] = useState(false)
  const [confirmDeactivate, setConfirmDeactivate] = useState<RoleWithDetails | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [r, p] = await Promise.all([getRolesWithDetails(), getAllPermissions()])
    setRoles(r)
    setAllPerms(p as PermWithModule[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function msg(text: string) { setMessage(text); setTimeout(() => setMessage(''), 3500) }

  // Función para obtener la cantidad real de permisos visibles en el frontend
  const getVisiblePermsCount = useCallback((permissions: { code: string }[]) => {
    return permissions.filter(p => !hiddenPermCodes.includes(p.code)).length
  }, [])

  function localAddPerm(permId: string) {
    if (!selectedRole) return
    const perm = allPerms.find(p => p.id === permId)
    if (!perm) return
    const newPerms = [...selectedRole.permissions, { id: perm.id, code: perm.code, name: perm.name }]
    const updated = { ...selectedRole, permissions: newPerms }
    setSelectedRole(updated)
    setRoles(prev => prev.map(r => r.id === updated.id ? { ...r, permissions: newPerms } : r))
  }

  function localRemovePerm(permId: string) {
    if (!selectedRole) return
    const newPerms = selectedRole.permissions.filter(p => p.id !== permId)
    const updated = { ...selectedRole, permissions: newPerms }
    setSelectedRole(updated)
    setRoles(prev => prev.map(r => r.id === updated.id ? { ...r, permissions: newPerms } : r))
  }

  async function handleAddPerm(permId: string) {
    if (!selectedRole || selectedRole.permissions.some(p => p.id === permId)) return
    localAddPerm(permId)
    const res = await assignPermissionToRole(selectedRole.id, permId)
    if (res.error) { localRemovePerm(permId); msg(res.error) }
  }

  async function handleRemovePerm(permId: string) {
    if (!selectedRole || !selectedRole.permissions.some(p => p.id === permId)) return
    localRemovePerm(permId)
    const res = await removePermissionFromRole(selectedRole.id, permId)
    if (res.error) { localAddPerm(permId); msg(res.error) }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const fd = new FormData()
    fd.set('name', createName)
    fd.set('description', createDesc)
    const res = await createRole(fd)
    if (res.error) { msg(res.error); return }
    setShowCreate(false); setCreateName(''); setCreateDesc('')
    msg('Rol creado')
    load()
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedRole) return
    const fd = new FormData()
    fd.set('name', editName)
    fd.set('description', editDesc)
    const res = await updateRole(selectedRole.id, fd)
    if (res.error) { msg(res.error); return }
    setEditing(false); msg('Rol actualizado')
    load()
  }

  function requestDeactivate(role: RoleWithDetails) {
    setConfirmDeactivate(role)
  }

  async function confirmToggleActive() {
    if (!confirmDeactivate) return
    const res = await deactivateRole(confirmDeactivate.id)
    setConfirmDeactivate(null)
    if (res.error) { msg(res.error); return }
    msg(res.newStatus ? 'Rol activado' : 'Rol desactivado')
    load()
  }

  function selectRole(role: RoleWithDetails) {
    setSelectedRole(role)
    setEditing(false)
    setEditName(role.name)
    setEditDesc(role.description ?? '')
  }

  const operationalPerms = allPerms.filter(p => p.code.startsWith('module.') && !hiddenPermCodes.includes(p.code))
  const moduleGroups: { label: string; perms: PermWithModule[] }[] = []
  for (const p of operationalPerms) {
    const moduleName = p.code.replace(/^module\./, '').replace(/\.view$/, '')
    const label = moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
    let group = moduleGroups.find(g => g.label === label)
    if (!group) { group = { label, perms: [] }; moduleGroups.push(group) }
    group.perms.push(p)
  }

  const visibleRoles = roles.filter(r => showInactive || r.is_active)

  function renderSection(title: string, perms: PermWithModule[], assigned: boolean) {
    const rp = selectedRole?.permissions ?? []
    const visible = perms.filter(p => assigned ? rp.some(r => r.id === p.id) : !rp.some(r => r.id === p.id))
    if (visible.length === 0) return null
    return (
      <div className="space-y-2.5">
        <h5 className="text-[11px] font-bold text-theme-accent uppercase tracking-widest">{title}</h5>
        <div className="flex flex-wrap gap-2">
          {visible.map(p => {
            const isAssigned = rp.some(r => r.id === p.id)
            const isProtected = selectedRole?.name === 'SUPER_USUARIO' && isAssigned
            const label = permLabels[p.code] || p.name || p.code
            if (isAssigned) {
              return (
                <button key={p.id} onClick={() => handleRemovePerm(p.id)} disabled={isProtected}
                  className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg border bg-theme-accent-hover/20 text-theme-text-accent border-theme-accent/30 hover:bg-red-500/20 hover:text-red-500 hover:border-red-500/30 transition-all duration-200 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Quitar permiso">{label}<span className="text-theme-text-muted font-bold ml-1">&times;</span></button>
              )
            }
            return (
              <button key={p.id} onClick={() => handleAddPerm(p.id)}
                className="inline-flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-lg border border-dashed border-theme-accent/30 bg-theme-accent-hover/5 text-theme-text-accent/80 hover:bg-theme-accent-hover/20 hover:text-theme-text hover:border-theme-accent-hover transition-all duration-200"
                title="Asignar permiso">+ {label}</button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {message && (
        <div className="bg-theme-accent-hover/10 border border-theme-accent/35 rounded-xl px-4 py-3 text-sm text-theme-text-accent font-medium shadow-lg shadow-theme-bg/20">{message}</div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-white/8 bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Cargando...</p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Panel Izquierdo: Lista de Roles */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-theme-text-muted uppercase tracking-widest">Roles del Sistema</h2>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-theme-text-muted/80 cursor-pointer select-none font-medium">
                  <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="accent-theme-accent rounded border-theme-border" />
                  Mostrar Inactivos
                </label>
                {canAssign && (
                  <button onClick={() => setShowCreate(true)}
                    className="text-xs font-bold px-3.5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white transition-all duration-200 shadow-md shadow-theme-bg/20 hover:shadow-theme-accent/30">
                    + Nuevo rol
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-theme-border bg-theme-text/5 shadow-xl shadow-black/10 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-theme-border text-xs text-theme-text-muted font-bold uppercase tracking-wider bg-theme-bg/20">
                    <th className="text-left py-3.5 px-4 font-bold">Rol</th>
                    <th className="text-left py-3.5 px-4 font-bold">Usuarios</th>
                    <th className="text-left py-3.5 px-4 font-bold">Permisos visibles</th>
                    <th className="text-right py-3.5 px-4 font-bold w-12"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {visibleRoles.map(role => {
                    const isSelected = selectedRole?.id === role.id;
                    const visiblePermsCount = getVisiblePermsCount(role.permissions);
                    return (
                      <tr key={role.id}
                        className={`hover:bg-theme-text/5 transition-colors cursor-pointer ${isSelected ? 'bg-theme-text/10 border-l-2 border-theme-accent-hover' : ''}`}
                        onClick={() => selectRole(role)}>
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-bold ${role.is_active ? 'text-theme-text' : 'text-theme-accent/40'}`}>
                              {role.name}
                            </span>
                            {role.is_system && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-theme-accent-hover/10 text-theme-accent uppercase tracking-wider">
                                Sistema
                              </span>
                            )}
                            {!role.is_active && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 uppercase tracking-wider">
                                Inactivo
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-4 px-4 text-theme-text-accent font-medium text-xs">{role.user_count}</td>
                        <td className="py-4 px-4 text-theme-text-accent font-medium text-xs">
                          {visiblePermsCount}
                        </td>
                        <td className="py-4 px-4 text-right text-xs text-theme-accent font-bold">
                          {isSelected ? '◀' : '▶'}
                        </td>
                      </tr>
                    )
                  })}
                  {visibleRoles.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-xs text-theme-accent/40 font-medium">
                        No hay roles visibles
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Panel Derecho: Detalle del Rol Seleccionado */}
          {selectedRole && (
            <div className="space-y-5">
              {/* Tarjeta de Información General */}
              <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 shadow-xl shadow-black/10 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-theme-text tracking-tight">{selectedRole.name}</h3>
                  <div className="flex items-center gap-2">
                    {selectedRole.is_system && (
                      <span className="text-[10px] font-bold text-theme-text-muted uppercase tracking-wider border border-theme-accent/30 px-2.5 py-1 rounded-lg bg-theme-bg/20">Sistema</span>
                    )}
                    {!selectedRole.is_active && (
                      <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider border border-red-500/30 px-2.5 py-1 rounded-lg bg-red-950/20">Inactivo</span>
                    )}
                  </div>
                </div>

                {editing && canAssign ? (
                  <form onSubmit={handleEditSave} className="space-y-4">
                    <div>
                      <label className="block text-xs font-bold text-theme-text-muted uppercase tracking-wider mb-1.5">Nombre del rol</label>
                      <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                        disabled={selectedRole.is_system || ['SUPER_USUARIO','GERENCIA','FINANZAS','BODEGA','VENDEDOR'].includes(selectedRole.name)}
                        className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3.5 text-xs text-theme-text disabled:text-theme-accent/30 focus:outline-none focus:ring-1 focus:ring-theme-border-accent focus:bg-theme-text/10 transition-all duration-200"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-theme-text-muted uppercase tracking-wider mb-1.5">Descripción</label>
                      <input type="text" value={editDesc} onChange={e => setEditDesc(e.target.value)}
                        className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3.5 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent focus:bg-theme-text/10 transition-all duration-200"
                      />
                    </div>
                    <div className="flex gap-2.5 pt-1">
                      <button type="submit" className="px-4 py-2 rounded-xl bg-theme-accent text-white text-xs font-bold hover:bg-theme-accent-hover transition-colors shadow-md">Guardar</button>
                      <button type="button" onClick={() => setEditing(false)} className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted hover:text-theme-text text-xs font-medium hover:bg-theme-text/5 transition-colors">Cancelar</button>
                    </div>
                  </form>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-bold text-theme-accent uppercase tracking-wider">Descripción</label>
                      <p className="text-sm text-theme-text-accent font-medium mt-0.5">{selectedRole.description || 'Sin descripción'}</p>
                    </div>
                    {canAssign && (
                      <div className="flex gap-4 pt-2 border-t border-theme-border">
                        <button onClick={() => { setEditing(true); setEditName(selectedRole.name); setEditDesc(selectedRole.description ?? '') }}
                          className="text-xs font-bold text-theme-accent hover:text-theme-text-muted transition-colors flex items-center gap-1">
                          Editar rol
                        </button>
                        {selectedRole.name !== 'SUPER_USUARIO' && (
                          <button onClick={() => requestDeactivate(selectedRole)}
                            className={`text-xs font-bold transition-colors ${selectedRole.is_active ? 'text-red-500 hover:text-red-500' : 'text-theme-accent hover:text-theme-text-muted'}`}>
                            {selectedRole.is_active ? 'Desactivar rol' : 'Activar rol'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Tarjeta de Permisos */}
              <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 shadow-xl shadow-black/10 space-y-6">
                <h4 className="text-xs font-bold text-theme-text uppercase tracking-widest border-b border-theme-border pb-2">Permisos Asignados</h4>
                <div className="space-y-5">
                  {renderSection('Administración', allPerms.filter(p => adminPermCodes.includes(p.code)), true)}
                  {moduleGroups.map(g => renderSection(g.label, g.perms, true))}
                  {selectedRole.permissions.filter(p => {
                    const pc = allPerms.find(a => a.id === p.id)
                    return pc && (adminPermCodes.includes(pc.code) || pc.code.startsWith('module.')) && !hiddenPermCodes.includes(pc.code)
                  }).length === 0 && <p className="text-[11px] text-theme-accent/40 font-medium">Sin permisos asignados</p>}
                </div>

                {canAssign && (
                  <div className="border-t border-theme-border pt-6 space-y-5">
                    <h4 className="text-xs font-bold text-theme-text uppercase tracking-widest border-b border-theme-border pb-2">Permisos Disponibles</h4>
                    {renderSection('Administración', allPerms.filter(p => adminPermCodes.includes(p.code)), false)}
                    {moduleGroups.map(g => renderSection(g.label, g.perms, false))}
                    {allPerms.filter(p =>
                      (adminPermCodes.includes(p.code) || p.code.startsWith('module.')) &&
                      !hiddenPermCodes.includes(p.code) &&
                      !selectedRole.permissions.some(rp => rp.id === p.id)
                    ).length === 0 && <p className="text-[11px] text-theme-accent/40 font-medium">Todos los permisos han sido asignados</p>}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal de Confirmar Desactivación */}
      {confirmDeactivate && (
        <>
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmDeactivate(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-theme-bg rounded-2xl border border-theme-border shadow-2xl p-6 space-y-4">
              <h3 className="text-base font-bold text-theme-text tracking-tight">
                {confirmDeactivate.active_user_count > 0 
                  ? 'No se puede desactivar' 
                  : confirmDeactivate.is_active 
                    ? 'Desactivar rol' 
                    : 'Activar rol'}
              </h3>
              <p className="text-sm text-theme-text-accent/90 leading-relaxed">
                {confirmDeactivate.active_user_count > 0 
                  ? `No se puede desactivar este rol porque tiene ${confirmDeactivate.active_user_count} usuario(s) activo(s) asociado(s).`
                  : confirmDeactivate.is_active
                    ? `Este rol no tiene usuarios activos asociados. Al desactivarlo, no podrá asignarse a nuevos usuarios, pero se conservará para auditoría e historial del sistema.`
                    : `¿Estás seguro de activar el rol "${confirmDeactivate.name}"?`}
              </p>
              <div className="flex gap-2.5 justify-end pt-2">
                {confirmDeactivate.active_user_count > 0 ? (
                  <button onClick={() => setConfirmDeactivate(null)}
                    className="px-4 py-2 rounded-xl bg-theme-accent hover:bg-theme-surface text-white text-sm font-semibold transition-colors shadow-md">
                    Entendido
                  </button>
                ) : (
                  <>
                    <button onClick={() => setConfirmDeactivate(null)}
                      className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted/90 text-sm font-semibold hover:text-theme-text hover:bg-theme-text/5 transition-colors">
                      Cancelar
                    </button>
                    <button onClick={confirmToggleActive}
                      className={`px-4 py-2 rounded-xl text-white text-sm font-bold transition-colors shadow-md ${confirmDeactivate.is_active ? 'bg-red-600 hover:bg-red-500' : 'bg-theme-accent hover:bg-theme-accent-hover'}`}>
                      {confirmDeactivate.is_active ? 'Sí, desactivar rol' : 'Sí, activar'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Modal de Crear Rol */}
      {showCreate && canAssign && (
        <>
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setShowCreate(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <form onSubmit={handleCreate} className="w-full max-w-md bg-theme-bg rounded-2xl border border-theme-border shadow-2xl p-6 space-y-4">
              <h3 className="text-base font-bold text-theme-text tracking-tight">Nuevo Rol</h3>
              <div>
                <label className="block text-xs font-bold text-theme-text-muted uppercase tracking-wider mb-1.5">Nombre del rol</label>
                <input type="text" value={createName} onChange={e => setCreateName(e.target.value)}
                  placeholder="Ej: JEFE_BODEGA"
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3.5 text-sm text-theme-text placeholder:text-theme-accent-hover/50 focus:outline-none focus:ring-1 focus:ring-theme-border-accent focus:bg-theme-text/10 transition-all duration-200"
                  required />
                <p className="text-[10px] text-theme-accent/40 mt-1.5 font-medium">Se guardará en mayúsculas con guion bajo.</p>
              </div>
              <div>
                <label className="block text-xs font-bold text-theme-text-muted uppercase tracking-wider mb-1.5">Descripción</label>
                <input type="text" value={createDesc} onChange={e => setCreateDesc(e.target.value)}
                  placeholder="Descripción opcional"
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3.5 text-sm text-theme-text placeholder:text-theme-accent-hover/50 focus:outline-none focus:ring-1 focus:ring-theme-border-accent focus:bg-theme-text/10 transition-all duration-200"
                />
              </div>
              <div className="flex gap-2.5 justify-end pt-2">
                <button type="button" onClick={() => setShowCreate(false)}
                  className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted/90 text-sm font-semibold hover:text-theme-text hover:bg-theme-text/5 transition-colors">Cancelar</button>
                <button type="submit"
                  className="px-4 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-colors shadow-md shadow-theme-bg/20">Crear rol</button>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  )
}
