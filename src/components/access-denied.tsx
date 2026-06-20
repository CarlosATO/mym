import Link from 'next/link'
import { Lock } from 'lucide-react'

export function AccessDenied() {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-4 text-center">
      <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center mb-6">
        <Lock className="h-8 w-8 text-red-400" />
      </div>
      <h1 className="text-xl font-bold text-theme-text mb-2">Acceso Denegado</h1>
      <p className="text-sm text-theme-text-muted/60 mb-8 max-w-sm">
        No tienes los permisos necesarios para acceder a esta sección.
      </p>
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-theme-text/10 text-white text-sm font-medium hover:bg-theme-text/10 transition-colors"
      >
        Volver al Dashboard
      </Link>
    </div>
  )
}
