'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { UsersTable } from '@/components/users-table'
import { UserFormDialog } from '@/components/user-form-dialog'
import * as LucideIcons from 'lucide-react'
import type { Profile, Rol } from '@/lib/types'

interface UsersManagementProps {
  users: (Profile & { roles: Pick<Rol, 'name' | 'description'> })[]
  roles: Rol[]
}

export function UsersManagement({ users, roles }: UsersManagementProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [userToEdit, setUserToEdit] = useState<Profile & { roles: Pick<Rol, 'name' | 'description'> } | null>(null)

  function handleEdit(user: Profile & { roles: Pick<Rol, 'name' | 'description'> }) {
    setUserToEdit(user)
    setDialogOpen(true)
  }

  function handleNew() {
    setUserToEdit(null)
    setDialogOpen(true)
  }

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={handleNew}>
          <LucideIcons.Plus className="h-4 w-4 mr-2" />
          Nuevo Usuario
        </Button>
      </div>
      <UsersTable users={users} onEdit={handleEdit} />
      <UserFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        roles={roles}
        userToEdit={userToEdit}
      />
    </>
  )
}
