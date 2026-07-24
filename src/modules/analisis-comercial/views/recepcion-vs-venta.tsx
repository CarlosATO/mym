'use client'

import * as LucideIcons from 'lucide-react'

export function RecepcionVsVenta() {
  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div>
        <h1 className="text-base font-bold text-theme-text">Recepción vs Venta</h1>
        <p className="text-xs text-theme-text-muted/70">
          Comparación de ingresos/recepciones versus ventas por proveedor y producto
        </p>
      </div>

      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-6">
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 shrink-0">
            <LucideIcons.Clock className="h-5 w-5 text-amber-500" />
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-bold text-theme-text">
              Pendiente de sincronización de recepciones Bsale
            </h2>
            <p className="text-xs text-theme-text-muted/80 leading-relaxed">
              Bsale registra recepciones básicas con tipo de documento, número, producto, cantidad y costo unitario.
              Actualmente las tablas de recepción (<code className="text-[10px] bg-theme-text/5 px-1 py-0.5 rounded font-mono">bsale_receptions</code> y{' '}
              <code className="text-[10px] bg-theme-text/5 px-1 py-0.5 rounded font-mono">bsale_reception_details</code>) están vacías
              porque el proceso de sincronización aún no se ha ejecutado.
            </p>
            <div className="pt-2 space-y-1.5">
              <p className="text-[11px] font-semibold text-theme-text-muted/70">Cuando esté disponible, esta vista permitirá:</p>
              <ul className="space-y-1">
                {[
                  'Comparar cantidad recepcionada vs cantidad vendida por producto',
                  'Analizar evolución semanal/mensual de ingresos vs ventas',
                  'Calcular rotación de inventario por proveedor',
                  'Detectar sobrestock o riesgo de quiebre',
                  'Valorizar inventario con costo real de recepción',
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] text-theme-text-muted/70">
                    <LucideIcons.ArrowRight className="h-3 w-3 text-theme-accent/60 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-theme-border/60 bg-theme-surface/40 p-4">
        <div className="flex items-center gap-2 text-xs text-theme-text-muted/60">
          <LucideIcons.Info className="h-3.5 w-3.5" />
          <span>
            Dato operacional: Las recepciones en Bsale se registran con documento (factura de compra, guía),
            producto (SKU), cantidad y costo unitario. El proveedor se asocia indirectamente a través del
            pseudoproveedor/tipo de producto del artículo. PetGroup resuelve el proveedor real mediante la
            jerarquía <strong className="text-theme-text">proveedor real → pseudoproveedor → producto</strong>.
          </span>
        </div>
      </div>
    </div>
  )
}
