export function MascotIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 280 260"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <ellipse cx="140" cy="230" rx="90" ry="15" fill="currentColor" opacity="0.08" />
      <ellipse cx="140" cy="170" rx="65" ry="55" fill="currentColor" opacity="0.12" />
      <ellipse cx="140" cy="130" rx="50" ry="45" fill="currentColor" opacity="0.15" />
      <circle cx="120" cy="112" r="6" fill="currentColor" opacity="0.25" />
      <circle cx="160" cy="112" r="6" fill="currentColor" opacity="0.25" />
      <ellipse cx="140" cy="130" rx="14" ry="10" fill="currentColor" opacity="0.2" />
      <circle cx="140" cy="148" r="5" fill="currentColor" opacity="0.18" />
      <circle cx="105" cy="145" r="4" fill="currentColor" opacity="0.15" />
      <circle cx="175" cy="145" r="4" fill="currentColor" opacity="0.15" />
      <circle cx="85" cy="105" r="5" fill="currentColor" opacity="0.12" />
      <circle cx="195" cy="105" r="5" fill="currentColor" opacity="0.12" />
    </svg>
  )
}
