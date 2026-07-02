'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createUser, updateUser, getUserCompanyIds, getAllActiveCompanies } from '@/app/actions/users'
import type { Profile, Rol } from '@/lib/types'

interface CompanyOption {
  id: string
  business_name: string
  trade_name: string | null
  rut: string | null
}

interface UserFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  roles: Rol[]
  userToEdit?: (Profile & { roles: Pick<Rol, 'name' | 'description'> }) | null
}

export function UserFormDialog({ open, onOpenChange, roles, userToEdit }: UserFormDialogProps) {
  const router = useRouter()
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [companies, setCompanies] = useState<CompanyOption[]>([])
  const [selectedCompanies, setSelectedCompanies] = useState<string[]>([])
  const [loadingCompanies, setLoadingCompanies] = useState(true)

  useEffect(() => {
    if (open) {
      setLoadingCompanies(true)
      setSelectedCompanies([])
      getAllActiveCompanies().then(list => {
        setCompanies(list as unknown as CompanyOption[])
        setLoadingCompanies(false)
      })

      if (userToEdit) {
        getUserCompanyIds(userToEdit.id).then(ids => {
          setSelectedCompanies(ids)
        })
      }
    }
  }, [open, userToEdit])

  function toggleCompany(companyId: string) {
    setSelectedCompanies(prev =>
      prev.includes(companyId)
        ? prev.filter(id => id !== companyId)
        : [...prev, companyId]
    )
  }

  async function handleSubmit(formData: FormData) {
    if (selectedCompanies.length === 0) {
      setError('Debe seleccionar al menos una empresa.')
      return
    }

    formData.append('companyIds', JSON.stringify(selectedCompanies))
    setPending(true)
    setError('')
    setTempPassword(null)

    if (userToEdit) {
      const result = await updateUser(userToEdit.id, formData)
      if (result.error) {
        setError(result.error)
        setPending(false)
        return
      }
      router.refresh()
      onOpenChange(false)
    } else {
      const result = await createUser(formData)
      if (result.error) {
        setError(result.error)
        setPending(false)
        return
      }
      setTempPassword(result.tempPassword!)
      router.refresh()
    }

    setPending(false)
  }

  async function handleCopyPassword() {
    if (tempPassword) {
      await navigator.clipboard.writeText(tempPassword)
    }
  }

  function handleClose() {
    setTempPassword(null)
    setError('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{userToEdit ? 'Editar Usuario' : 'Crear Usuario'}</DialogTitle>
          <DialogDescription>
            {userToEdit ? 'Modifica los datos del usuario' : 'Completa los datos para crear un nuevo usuario'}
          </DialogDescription>
        </DialogHeader>

        {tempPassword ? (
          <div className="space-y-4">
            <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3">
              <p className="text-sm font-medium">Usuario creado exitosamente</p>
              <div>
                <Label>Contraseña temporal</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={tempPassword} readOnly className="font-mono" />
                  <Button variant="outline" size="icon" onClick={handleCopyPassword}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                El usuario deberá cambiar esta contraseña en su primer inicio de sesión.
              </p>
            </div>
            <Button className="w-full" onClick={handleClose}>Cerrar</Button>
          </div>
        ) : (
          <form action={handleSubmit} className="space-y-4">
            <input type="hidden" name="is_active" value="true" />
            <div className="space-y-2">
              <Label htmlFor="nombre">Nombre</Label>
              <Input id="nombre" name="nombre" defaultValue={userToEdit?.nombre} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apellido">Apellido</Label>
              <Input id="apellido" name="apellido" defaultValue={userToEdit?.apellido} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Correo electrónico</Label>
              <Input
                id="email"
                name="email"
                type="email"
                defaultValue={userToEdit?.email}
                required={!userToEdit}
                readOnly={!!userToEdit}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roleId">Rol</Label>
              <select
                id="roleId"
                name="roleId"
                defaultValue={userToEdit?.role_id || ''}
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="" disabled>Seleccionar rol</option>
                {roles.map((rol) => (
                  <option key={rol.id} value={rol.id}>{rol.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Empresa(s) asignadas</Label>
              {loadingCompanies ? (
                <p className="text-sm text-muted-foreground">Cargando empresas...</p>
              ) : companies.length === 0 ? (
                <p className="text-sm text-red-500">No hay empresas activas disponibles.</p>
              ) : (
                <div className="max-h-48 overflow-y-auto border border-input rounded-md p-2 space-y-1">
                  {companies.map((company) => (
                    <label
                      key={company.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent/50 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedCompanies.includes(company.id)}
                        onChange={() => toggleCompany(company.id)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{company.trade_name || company.business_name}</p>
                        {company.rut && <p className="text-xs text-muted-foreground truncate">{company.rut}</p>}
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {selectedCompanies.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {selectedCompanies.length} empresa(s) seleccionada(s). La primera será la predeterminada.
                </p>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={handleClose}>Cancelar</Button>
              <Button type="submit" disabled={pending || loadingCompanies || companies.length === 0}>
                {pending ? 'Guardando...' : userToEdit ? 'Guardar cambios' : 'Crear usuario'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
