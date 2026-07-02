import Image from 'next/image'
import { LoginForm } from '@/components/login-form'
import { CompanyLogo } from '@/components/company-logo'

export default function LoginPage() {
  return (
    <div className="min-h-screen flex relative overflow-hidden">
      {/* Fondo degradado */}
      <div className="absolute inset-0 bg-gradient-to-br from-theme-bg-gradient-start via-theme-bg-gradient-mid to-theme-bg-gradient-end" />

      {/* Patrón sutil de puntos */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: `radial-gradient(circle at 25% 25%, white 1px, transparent 1px), radial-gradient(circle at 75% 75%, white 1px, transparent 1px)`,
        backgroundSize: '60px 60px',
      }} />

      {/* Orbes de luz decorativas */}
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-theme-accent-hover/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4" />
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-theme-accent-hover/10 rounded-full blur-3xl translate-y-1/3 -translate-x-1/4" />

      {/* Panel izquierdo – solo visible en desktop */}
      <div className="hidden lg:flex flex-1 items-center justify-center relative">
        <div className="text-center space-y-10 max-w-md px-12">

          {/* Logos corporativos lado a lado */}
          <div className="flex items-center justify-center gap-8">
            <div className="relative">
              <div className="absolute inset-0 scale-[1.4] rounded-full bg-amber-400/10 blur-2xl" />
              <CompanyLogo size={140} />
            </div>
            <div className="relative">
              <div className="absolute inset-0 scale-[1.4] rounded-full bg-amber-400/10 blur-2xl" />
              <Image
                src="/logos/Logo_AmiMascota.jpeg"
                alt="amiMascota"
                width={140}
                height={140}
                priority
                unoptimized
                style={{ width: 140, height: 'auto' }}
                className="select-none"
              />
            </div>
          </div>

          {/* Divisor elegante */}
          <div className="flex items-center gap-4">
            <div className="flex-1 h-px bg-gradient-to-r from-transparent via-theme-accent/30 to-transparent" />
            <span className="text-theme-accent/40 text-xs font-bold tracking-widest uppercase">PetGrup</span>
            <div className="flex-1 h-px bg-gradient-to-l from-transparent via-theme-accent/30 to-transparent" />
          </div>

          {/* Texto descriptivo */}
          <div className="space-y-3">
            <p className="text-base text-theme-text-accent/70 leading-relaxed">
              Sistema Unificado de Gestión Corporativa
            </p>
          </div>

          {/* Badges */}
          <div className="flex items-center justify-center gap-4 text-theme-text-accent/50 text-sm">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-theme-accent-hover/60" />
              Plataforma segura
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-theme-accent-hover/60" />
              Acceso restringido
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-theme-accent-hover/60" />
              Auditoría total
            </span>
          </div>
        </div>
      </div>

      {/* Divisor vertical elegante entre paneles */}
      <div className="hidden lg:block w-px bg-gradient-to-b from-transparent via-white/10 to-transparent self-stretch" />

      {/* Panel derecho – formulario */}
      <div className="flex-1 flex items-center justify-center relative p-8 pb-24">
        <div className="w-full max-w-md">
          {/* Logos móvil (solo en pantallas pequeñas) */}
          <div className="lg:hidden flex flex-col items-center gap-4 mb-10">
            <div className="flex items-center justify-center gap-4">
              <CompanyLogo size={80} />
              <Image
                src="/logos/Logo_AmiMascota.jpeg"
                alt="amiMascota"
                width={80}
                height={80}
                priority
                unoptimized
                style={{ width: 80, height: 'auto' }}
                className="select-none"
              />
            </div>
            <span className="text-lg font-bold text-theme-text/80 tracking-widest uppercase">PetGrup</span>
          </div>

          <LoginForm />
        </div>
      </div>

      {/* Footer corporativo y firma elegante */}
      <div className="absolute bottom-6 left-0 right-0 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 text-[10px] tracking-widest text-theme-text-accent/30 uppercase font-semibold text-center px-4">
        <span>Realizado por</span>
        <span className="text-theme-text-accent/50 font-bold">"Datix S.A."</span>
        <span className="hidden sm:inline text-theme-text-accent/20">•</span>
        <span className="text-theme-text-accent/40">Carlos Alegría</span>
        <span className="hidden sm:inline text-theme-text-accent/20">•</span>
        <span>2026</span>
      </div>
    </div>
  )
}
