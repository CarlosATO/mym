'use client'

import * as LucideIcons from 'lucide-react'

export function Predictivo() {
  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div>
        <h1 className="text-base font-bold text-theme-text">Predictivo</h1>
        <p className="text-xs text-theme-text-muted/70">
          Analítica predictiva · demanda · sobrestock · quiebres · sugerencia de compra
        </p>
      </div>

      <div className="rounded-xl border border-theme-border/60 bg-theme-surface/40 p-6">
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-theme-accent/10 border border-theme-accent/20 shrink-0">
            <LucideIcons.Sparkles className="h-5 w-5 text-theme-accent" />
          </div>
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-theme-text">
              Fase futura
            </h2>
            <p className="text-xs text-theme-text-muted/80 leading-relaxed">
              Predicción de demanda, sobrestock, riesgo de quiebre y sugerencia de compra.
              Esta funcionalidad se habilitará cuando exista historial suficiente de ventas,
              recepciones y costos.
            </p>

            <div className="pt-2 space-y-1.5">
              <p className="text-[11px] font-semibold text-theme-text-muted/70">Capacidades planificadas:</p>
              <ul className="space-y-1">
                {[
                  'Pronóstico de demanda por producto usando promedio histórico y tendencia',
                  'Alerta temprana de sobrestock basada en cobertura y rotación',
                  'Alerta de riesgo de quiebre (stock por debajo de punto de reorden)',
                  'Sugerencia de cantidad de compra por producto y proveedor',
                  'Detección de anomalías: caídas abruptas o picos inesperados',
                  'Lead time por proveedor y frecuencia de reposición recomendada',
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] text-theme-text-muted/70">
                    <LucideIcons.ArrowRight className="h-3 w-3 text-theme-accent/60 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="pt-2">
              <p className="text-[11px] text-theme-text-muted/50 italic">
                Requisitos: sincronización de recepciones, lead time de proveedores, costos históricos,
                quiebres históricos y ventas perdidas.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
