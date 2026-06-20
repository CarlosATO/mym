export function PawLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="12" cy="10" r="3.5" fill="currentColor" opacity="0.85" />
      <circle cx="28" cy="10" r="3.5" fill="currentColor" opacity="0.85" />
      <circle cx="8" cy="22" r="3.5" fill="currentColor" opacity="0.85" />
      <circle cx="32" cy="22" r="3.5" fill="currentColor" opacity="0.85" />
      <ellipse cx="20" cy="30" rx="7" ry="6" fill="currentColor" opacity="0.95" />
      <ellipse cx="20" cy="28" rx="3" ry="2.5" fill="var(--background, white)" opacity="0.4" />
    </svg>
  )
}
