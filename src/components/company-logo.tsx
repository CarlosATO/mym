import Image from 'next/image'

interface CompanyLogoProps {
  /** Size in pixels. Default: 120 */
  size?: number
  className?: string
  logoUrl?: string | null
}

export function CompanyLogo({ size = 120, className = '', logoUrl }: CompanyLogoProps) {
  return (
    <div style={{ width: size }} className={`relative shrink-0 flex items-center justify-center ${className}`}>
      <Image
        src={logoUrl || "/logo-transparent.png"}
        alt="Logo"
        width={size}
        height={size}
        priority
        unoptimized={!!logoUrl}
        className="object-contain w-full h-auto select-none"
      />
    </div>
  )
}
