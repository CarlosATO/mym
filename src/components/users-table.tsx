'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toggleUserStatus } from '@/app/actions/users'
import * as LucideIcons from 'lucide-react'
import type { Profile, Rol } from '@/lib/types'

interface UsersTableProps {
  users: (Profile & { roles: Pick<Rol, 'name' | 'description'> })[]
  onEdit: (user: Profile & { roles: Pick<Rol, 'name' | 'description'> }) => void
}

export function UsersTable({ users, onEdit }: UsersTableProps) {
  const router = useRouter()
  const [loadingId, setLoadingId] = useState<string | null>(null)

  async function handleToggleStatus(userId: string, currentStatus: boolean) {
    setLoadingId(userId)
    await toggleUserStatus(userId, !currentStatus)
    setLoadingId(null)
    router.refresh()
  }

  return (
    <div className="rounded-2xl border border-theme-border bg-theme-text/5 shadow-xl shadow-black/10 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-theme-border text-xs text-theme-text-muted font-bold uppercase tracking-wider bg-theme-bg/20 hover:bg-transparent">
            <TableHead className="font-bold py-3.5 px-4 text-theme-text-muted">Nombre</TableHead>
            <TableHead className="font-bold py-3.5 px-4 text-theme-text-muted">Email</TableHead>
            <TableHead className="font-bold py-3.5 px-4 text-theme-text-muted">Rol</TableHead>
            <TableHead className="font-bold py-3.5 px-4 text-theme-text-muted">Estado</TableHead>
            <TableHead className="font-bold py-3.5 px-4 text-theme-text-muted">Cambio pass</TableHead>
            <TableHead className="font-bold py-3.5 px-4 text-theme-text-muted text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="divide-y divide-theme-border">
          {users.map((user) => (
            <TableRow key={user.id} className="hover:bg-theme-text/5 border-b border-theme-border transition-colors">
              <TableCell className="font-bold text-theme-text py-4 px-4">{user.nombre} {user.apellido}</TableCell>
              <TableCell className="text-theme-text-accent font-medium text-xs py-4 px-4">{user.email}</TableCell>
              <TableCell className="py-4 px-4">
                <Badge className="bg-theme-accent-hover/10 text-theme-text-muted border border-theme-accent/20 font-bold px-2 py-0.5 text-[9px] uppercase tracking-wider rounded-lg">
                  {user.roles?.name ?? 'Sin rol'}
                </Badge>
              </TableCell>
              <TableCell className="py-4 px-4">
                {user.is_active ? (
                  <Badge className="bg-theme-accent-hover/20 text-theme-accent border border-theme-accent/30 font-bold px-2.5 py-0.5 rounded-lg text-[10px]">
                    Activo
                  </Badge>
                ) : (
                  <Badge className="bg-red-500/10 text-red-500 border border-red-500/30 font-bold px-2.5 py-0.5 rounded-lg text-[10px]">
                    Inactivo
                  </Badge>
                )}
              </TableCell>
              <TableCell className="py-4 px-4">
                {user.must_change_password ? (
                  <Badge className="bg-amber-500/10 text-amber-500 border border-amber-500/30 font-bold px-2.5 py-0.5 rounded-lg text-[10px]">
                    Pendiente
                  </Badge>
                ) : (
                  <Badge className="bg-theme-accent-hover/10 text-theme-text-muted border border-theme-accent/20 font-bold px-2.5 py-0.5 rounded-lg text-[10px]">
                    Completado
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right py-4 px-4">
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="icon" onClick={() => onEdit(user)} className="text-theme-accent hover:text-theme-text-muted hover:bg-theme-text/5 rounded-lg transition-colors h-8 w-8">
                    <LucideIcons.Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={loadingId === user.id}
                    onClick={() => handleToggleStatus(user.id, user.is_active)}
                    className="hover:bg-theme-text/5 rounded-lg transition-colors h-8 w-8"
                  >
                    {user.is_active ? (
                      <LucideIcons.UserX className="h-4 w-4 text-red-400 hover:text-red-300" />
                    ) : (
                      <LucideIcons.UserCheck className="h-4 w-4 text-theme-accent hover:text-theme-text-muted" />
                    )}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {users.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-theme-accent/40 py-8 font-medium">
                No hay usuarios registrados
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

