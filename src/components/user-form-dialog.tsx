'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createUser, updateUser } from '@/app/actions/users'
import type { Profile, Rol } from '@/lib/types'

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

  async function handleSubmit(formData: FormData) {
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
      <DialogContent>
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
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={handleClose}>Cancelar</Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Guardando...' : userToEdit ? 'Guardar cambios' : 'Crear usuario'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
