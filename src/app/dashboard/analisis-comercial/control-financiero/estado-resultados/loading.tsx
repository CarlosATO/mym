export default function Loading() {
  return (
    <main className="min-h-[430px] bg-[#EFE9E1] px-5 py-5 sm:px-7 sm:py-6">
      <div className="border border-[#D1C7BD] bg-white/35 p-5">
        <div className="h-3 w-40 animate-pulse bg-[#D1C7BD]" />
        <div className="mt-6 h-12 animate-pulse bg-[#D1C7BD]/60" />
        <div className="mt-2 h-12 animate-pulse bg-[#D1C7BD]/45" />
      </div>
    </main>
  )
}
