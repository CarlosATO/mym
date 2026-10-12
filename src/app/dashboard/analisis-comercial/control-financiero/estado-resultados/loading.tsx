export default function Loading() {
  return (
    <main className="min-h-[430px] w-full min-w-0 bg-[#EFE9E1] px-5 py-4 sm:px-7 sm:py-5" aria-busy="true">
      <div className="border border-[#D1C7BD] bg-[#FCFBF9] p-3 sm:p-4">
        <p role="status" className="mb-4 text-sm text-[#72383D]">Cargando Estado de Resultados · ventas y proveedores completos…</p>
        <div className="h-3 w-40 animate-pulse bg-[#D1C7BD]" />
        <div className="mt-6 h-12 animate-pulse bg-[#D1C7BD]/60" />
        <div className="mt-2 h-12 animate-pulse bg-[#D1C7BD]/45" />
      </div>
    </main>
  )
}
