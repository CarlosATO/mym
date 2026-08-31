import { Building2, CalendarDays, CheckCircle2, CircleUserRound, ShieldCheck, UserRound, XCircle } from 'lucide-react'
import { getUserCompanies, type UserCompany } from '@/app/actions/companies'
import { getCurrentProfile } from '@/app/actions/users'
import { ProfilePersonalInfo } from './profile-personal-info'
import { ProfileSecurity } from './profile-security'

function displayValue(value: string | null | undefined) {
  return value?.trim() || 'No registrado'
}

function displayPersonName(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, ' ').toUpperCase() || 'No registrado'
}

function displayRole(value: string | null | undefined) {
  return value?.trim().replace(/_/g, ' ') || 'Sin rol asignado'
}

function initials(nombre: string | null | undefined, apellido: string | null | undefined) {
  const first = nombre?.trim().charAt(0) ?? ''
  const last = apellido?.trim().charAt(0) ?? ''
  return `${first}${last}`.toUpperCase() || 'U'
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'No registrado'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'No registrado'
  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'long',
  }).format(date)
}

function InfoItem({ icon: Icon, label, value }: { icon: typeof UserRound; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-theme-border/60 bg-theme-bg/20 p-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-theme-accent/10 text-theme-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70">{label}</p>
        <p className="mt-0.5 truncate text-sm font-medium text-theme-text" title={value}>{value}</p>
      </div>
    </div>
  )
}

function CompanyAccessItem({ access }: { access: UserCompany }) {
  const company = access.company
  const companyName = company?.trade_name || company?.business_name || 'Empresa no registrada'
  const isActive = access.is_active

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-theme-border/60 bg-theme-bg/20 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-theme-accent/10 text-theme-accent">
          <Building2 className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-theme-text">{companyName}</p>
          <p className="truncate text-xs text-theme-text-muted/70">
            {displayValue(company?.rut)}
            {access.role ? ` · ${displayRole(access.role)}` : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-[47px] sm:justify-end sm:pl-0">
        <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] font-semibold ${isActive ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500' : 'border-red-500/20 bg-red-500/10 text-red-400'}`}>
          {isActive ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {isActive ? 'Acceso activo' : 'Acceso inactivo'}
        </span>
        {access.is_default && (
          <span className="inline-flex items-center rounded-lg border border-theme-accent/25 bg-theme-accent/10 px-2 py-1 text-[10px] font-semibold text-theme-accent">
            Predeterminada
          </span>
        )}
      </div>
    </div>
  )
}

export default async function PerfilPage() {
  const profile = await getCurrentProfile()

  if (!profile) {
    return (
      <div className="rounded-2xl border border-dashed border-theme-border bg-theme-surface/60 p-10 text-center">
        <CircleUserRound className="mx-auto h-10 w-10 text-theme-text-muted/50" />
        <h1 className="mt-4 text-xl font-semibold text-theme-text">Perfil no disponible</h1>
        <p className="mt-2 text-sm text-theme-text-muted/70">No se encontró información para el usuario autenticado.</p>
      </div>
    )
  }

  const companies = await getUserCompanies(true)
  const fullName = `${displayPersonName(profile.nombre)} ${displayPersonName(profile.apellido)}`
  const roleName = displayRole(profile.roles?.name)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-theme-text">Mi perfil</h1>
        <p className="mt-0.5 text-sm text-theme-text-muted/70">Información de tu cuenta y acceso al ERP</p>
      </div>

      <section className="overflow-hidden rounded-2xl border border-theme-accent/20 bg-theme-surface/70 shadow-xl shadow-black/10 backdrop-blur-md">
        <div className="h-16 bg-gradient-to-r from-theme-accent/20 via-theme-accent/5 to-transparent" />
        <div className="-mt-9 flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-end sm:px-6">
          {profile.avatar_url ? (
            <div
              className="h-[72px] w-[72px] shrink-0 rounded-2xl border-4 border-theme-surface bg-cover bg-center shadow-lg"
              style={{ backgroundImage: `url(${profile.avatar_url})` }}
              role="img"
              aria-label={`Avatar de ${fullName}`}
            />
          ) : (
            <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-2xl border-4 border-theme-surface bg-theme-accent text-xl font-bold text-white shadow-lg">
              {initials(profile.nombre, profile.apellido)}
            </div>
          )}
          <div className="min-w-0 flex-1 pb-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="text-xl font-semibold tracking-tight text-theme-text">{fullName}</h2>
              <span className={`inline-flex items-center rounded-lg border px-2 py-0.5 text-[10px] font-semibold ${profile.is_active ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500' : 'border-red-500/20 bg-red-500/10 text-red-400'}`}>
                {profile.is_active ? 'Activo' : 'Inactivo'}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-theme-text-muted/70">{displayValue(profile.email)}</p>
          </div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-theme-accent/25 bg-theme-accent/10 px-2.5 py-1 text-xs font-semibold text-theme-accent">
            <ShieldCheck className="h-3.5 w-3.5" />
            {roleName}
          </span>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
         <ProfilePersonalInfo
           nombre={profile.nombre}
           apellido={profile.apellido}
           email={profile.email}
           telefono={profile.telefono}
         />

        <section className="rounded-2xl border border-theme-border bg-theme-surface/60 p-4 shadow-xl shadow-black/10 sm:p-5">
          <div className="mb-3.5 flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-theme-accent/10 text-theme-accent">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-theme-text">Información de cuenta</h2>
              <p className="text-xs text-theme-text-muted/60">Estado y pertenencia dentro del ERP</p>
            </div>
          </div>
          <div className="space-y-2">
            <InfoItem icon={ShieldCheck} label="Rol actual" value={roleName} />
            <InfoItem icon={CheckCircle2} label="Estado de la cuenta" value={profile.is_active ? 'Activa' : 'Inactiva'} />
            <InfoItem icon={CalendarDays} label="Fecha de creación" value={formatDate(profile.created_at)} />
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-theme-border bg-theme-surface/60 p-4 shadow-xl shadow-black/10 sm:p-5">
          <div className="mb-3.5 flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-theme-accent/10 text-theme-accent">
              <Building2 className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-theme-text">Acceso empresarial</h2>
              <p className="text-xs text-theme-text-muted/60">Empresas asociadas a tu cuenta</p>
            </div>
          </div>
          {companies.length > 0 ? (
            <div className="space-y-2">
              {companies.map(access => <CompanyAccessItem key={access.company_id} access={access} />)}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-theme-border p-6 text-center">
              <Building2 className="mx-auto h-8 w-8 text-theme-text-muted/40" />
              <p className="mt-3 text-sm font-medium text-theme-text-muted">Sin empresas asignadas</p>
              <p className="mt-1 text-xs text-theme-text-muted/60">No tienes accesos empresariales registrados.</p>
            </div>
          )}
        </section>

        <ProfileSecurity />
      </div>
    </div>
  )
}
