import { ChangePasswordForm } from '@/components/change-password-form'

export default function ChangePasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-gradient-to-br from-theme-bg-gradient-start via-theme-bg-gradient-mid to-theme-bg-gradient-end">
      <div className="absolute inset-0 opacity-[0.04]" style={{
        backgroundImage: `radial-gradient(circle at 25% 25%, white 1px, transparent 1px), radial-gradient(circle at 75% 75%, white 1px, transparent 1px)`,
        backgroundSize: '60px 60px',
      }} />
      <div className="w-full max-w-md px-4">
        <ChangePasswordForm />
      </div>
    </div>
  )
}
