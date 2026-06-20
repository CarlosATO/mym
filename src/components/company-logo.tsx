import Image from 'next/image'

interface CompanyLogoProps {
  /** Size in pixels. Default: 120 */
  size?: number
  className?: string
  logoUrl?: string | null
}

export function CompanyLogo({ size = 120, className = '', logoUrl }: CompanyLogoProps) {
  return (
    <Image
      src={logoUrl || "/logo-transparent.png"}
      alt="Logo"
      width={size}
      height={size}
      priority
      unoptimized={!!logoUrl}
      style={{ width: size, height: 'auto' }}
      className={`select-none ${className}`}
    />
  )
}
