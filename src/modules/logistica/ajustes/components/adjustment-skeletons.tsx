export function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-4 p-6">
      <div className="h-3 bg-theme-text/10 rounded w-1/3" />
      <div className="space-y-2">
        {[1, 2, 3].map(i => <div key={i} className="h-8 bg-theme-text/6 rounded" />)}
      </div>
      <div className="h-3 bg-theme-text/10 rounded w-1/4 mt-4" />
      <div className="space-y-2">
        {[1, 2].map(i => <div key={i} className="h-8 bg-theme-text/6 rounded" />)}
      </div>
    </div>
  )
}
