export function RouteGuidesTraySkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-10 bg-theme-text/5 rounded w-1/4 animate-pulse"></div>
      <div className="bg-theme-surface shadow-sm rounded-lg border border-theme-border">
        <div className="h-12 bg-theme-text/5 border-b border-theme-border animate-pulse"></div>
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex gap-4 p-4 border-b border-theme-border">
            <div className="h-4 w-24 bg-theme-text/5 rounded animate-pulse"></div>
            <div className="h-4 w-32 bg-theme-text/5 rounded animate-pulse"></div>
            <div className="flex-1 space-y-2">
              <div className="h-4 w-full max-w-[200px] bg-theme-text/5 rounded animate-pulse"></div>
              <div className="h-3 w-32 bg-theme-text/5 rounded animate-pulse"></div>
            </div>
            <div className="h-4 w-48 bg-theme-text/5 rounded animate-pulse"></div>
            <div className="h-4 w-16 bg-theme-text/5 rounded animate-pulse"></div>
            <div className="h-4 w-24 bg-theme-text/5 rounded animate-pulse"></div>
            <div className="h-6 w-24 bg-theme-text/5 rounded-full animate-pulse"></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RouteGuideDetailSkeleton() {
  return (
    <div className="p-6 space-y-6 animate-pulse">
      <div className="flex justify-between items-center mb-6">
        <div>
          <div className="h-8 w-48 bg-theme-text/5 rounded mb-2 animate-pulse"></div>
          <div className="h-4 w-72 bg-theme-text/5 rounded animate-pulse"></div>
        </div>
        <div className="h-10 w-32 bg-theme-text/5 rounded-xl animate-pulse"></div>
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-3 bg-theme-text/5 rounded w-20"></div>
            <div className="h-5 bg-theme-text/5 rounded w-40"></div>
          </div>
        ))}
      </div>

      <div className="pt-6">
      </div>
    </div>
  );
}
