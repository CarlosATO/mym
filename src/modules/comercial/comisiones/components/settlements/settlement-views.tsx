import { ArrowLeft, Ban, Check, FileText, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import type {
  CommissionSettlementHeader,
  CommissionSettlementLine,
} from "@/app/actions/comercial/commissions";
import type {
  SettlementDetail,
  SettlementListProps,
} from "../../commissions-panel-types";
import { money } from "../../commissions-panel-utils";
import { formatPercent } from "@/lib/utils";

export function DraftsTab({
  drafts,
  busy,
  detail,
  onLoad,
  onDetail,
  onCancel,
  onIssue,
  onBack,
  onPdf,
  onExcel,
  busyPdf,
  busyExcel,
}: SettlementListProps & {
  drafts: CommissionSettlementHeader[];
  onCancel: (id: string) => void;
  onIssue: (id: string) => void;
}) {
  useEffect(() => {
    void onLoad();
  }, []);
  if (detail)
    return (
      <SettlementDetailView
        detail={detail}
        onBack={onBack}
        onPdf={onPdf}
        onExcel={onExcel}
        busyPdf={busyPdf}
        busyExcel={busyExcel}
      />
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Borradores de liquidación</h3>
        <button disabled={busy} onClick={onLoad} className="btn-secondary">
          <RefreshCw className="h-3.5 w-3.5" />
          Actualizar
        </button>
      </div>
      {drafts.length === 0 ? (
        <div className="rounded-xl border border-theme-border p-8 text-center text-sm text-theme-text-muted">
          No hay borradores activos. Simula un vendedor y crea un borrador desde
          la pestaña Simulación.
        </div>
      ) : (
        <div className="overflow-auto rounded-xl border border-theme-border">
          <table className="min-w-[900px] w-full text-xs">
            <thead>
              <tr>
                <th>Vendedor</th>
                <th>Período</th>
                <th>Líneas</th>
                <th className="text-right">Neto</th>
                <th className="text-right">Comisión</th>
                <th>Creado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => (
                <tr key={d.id}>
                  <td>
                    <b>{d.seller_name}</b>
                  </td>
                  <td>{d.period_label}</td>
                  <td>{d.lines_count || 0}</td>
                  <td className="text-right">{money(d.total_net_amount)}</td>
                  <td className="text-right font-semibold">
                    {money(d.total_commission_amount)}
                  </td>
                  <td>{d.created_at?.slice(0, 10)}</td>
                  <td>
                    <div className="flex gap-1 flex-wrap">
                      <button
                        onClick={() => onDetail(d.id)}
                        className="btn-secondary"
                      >
                        <FileText className="h-3 w-3" />
                        Ver
                      </button>
                      {onPdf && (
                        <button
                          disabled={busyPdf === d.id}
                          onClick={() => onPdf(d.id)}
                          className="btn-secondary"
                          title="PDF resumen ejecutivo"
                        >
                          {busyPdf === d.id ? (
                            "Generando PDF..."
                          ) : (
                            <>
                              <FileText className="h-3 w-3" />
                              PDF
                            </>
                          )}
                        </button>
                      )}
                      {onExcel && (
                        <button
                          disabled={busyExcel === d.id}
                          onClick={() => onExcel(d.id)}
                          className="btn-secondary"
                          title="Excel detalle por línea"
                        >
                          {busyExcel === d.id ? (
                            "Descargando Excel..."
                          ) : (
                            <>
                              <FileText className="h-3 w-3" />
                              Excel
                            </>
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => onCancel(d.id)}
                        className="btn-secondary border-red-500/30 text-red-600"
                      >
                        <Ban className="h-3 w-3" />
                        Cancelar
                      </button>
                      <button
                        onClick={() => onIssue(d.id)}
                        className="btn-primary bg-emerald-600"
                      >
                        <Check className="h-3 w-3" />
                        Emitir
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AnnulledTab({
  annulled,
  busy,
  detail,
  onLoad,
  onDetail,
  onBack,
  onPdf,
  onExcel,
  busyPdf,
  busyExcel,
}: SettlementListProps & { annulled: CommissionSettlementHeader[] }) {
  useEffect(() => {
    void onLoad();
  }, []);
  if (detail)
    return (
      <SettlementDetailView
        detail={detail}
        onBack={onBack}
        onPdf={onPdf}
        onExcel={onExcel}
        busyPdf={busyPdf}
        busyExcel={busyExcel}
      />
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Liquidaciones anuladas</h3>
        <button disabled={busy} onClick={onLoad} className="btn-secondary">
          <RefreshCw className="h-3.5 w-3.5" />
          Actualizar
        </button>
      </div>
      {annulled.length === 0 ? (
        <div className="rounded-xl border border-theme-border p-8 text-center text-sm text-theme-text-muted">
          No hay liquidaciones anuladas.
        </div>
      ) : (
        <div className="overflow-auto rounded-xl border border-theme-border">
          <table className="min-w-[1000px] w-full text-xs">
            <thead>
              <tr>
                <th>Código</th>
                <th>Vendedor</th>
                <th>Período</th>
                <th className="text-right">Neto</th>
                <th className="text-right">Comisión</th>
                <th>Emisión</th>
                <th>Anulación</th>
                <th>Motivo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {annulled.map((d) => (
                <tr key={d.id}>
                  <td className="font-semibold">
                    {d.settlement_code || d.settlement_number}
                  </td>
                  <td>{d.seller_name}</td>
                  <td>{d.period_label}</td>
                  <td className="text-right">{money(d.total_net_amount)}</td>
                  <td className="text-right font-semibold">
                    {money(d.total_commission_amount)}
                  </td>
                  <td>{d.issued_at?.slice(0, 10)}</td>
                  <td>
                    {(d as Record<string, unknown>).cancelled_at
                      ? String(
                          (d as Record<string, unknown>).cancelled_at,
                        ).slice(0, 10)
                      : "-"}
                  </td>
                  <td className="max-w-[200px] truncate">
                    {((d as Record<string, unknown>)
                      .cancellation_reason as string) || "-"}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      <button
                        onClick={() => onDetail(d.id)}
                        className="btn-secondary"
                      >
                        <FileText className="h-3 w-3" />
                        Ver
                      </button>
                      {onPdf && (
                        <button
                          disabled={busyPdf === d.id}
                          onClick={() => onPdf(d.id)}
                          className="btn-secondary"
                        >
                          {busyPdf === d.id ? (
                            "Generando PDF..."
                          ) : (
                            <>
                              <FileText className="h-3 w-3" />
                              PDF
                            </>
                          )}
                        </button>
                      )}
                      {onExcel && (
                        <button
                          disabled={busyExcel === d.id}
                          onClick={() => onExcel(d.id)}
                          className="btn-secondary"
                        >
                          {busyExcel === d.id ? (
                            "Descargando Excel..."
                          ) : (
                            <>
                              <FileText className="h-3 w-3" />
                              Excel
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function IssuedTab({
  issued,
  busy,
  detail,
  onLoad,
  onDetail,
  onBack,
  onPdf,
  onExcel,
  busyPdf,
  busyExcel,
  onAnnul,
}: SettlementListProps & {
  issued: CommissionSettlementHeader[];
  onAnnul?: (id: string) => void;
}) {
  useEffect(() => {
    void onLoad();
  }, []);
  if (detail)
    return (
      <SettlementDetailView
        detail={detail}
        onBack={onBack}
        onPdf={onPdf}
        onExcel={onExcel}
        busyPdf={busyPdf}
        busyExcel={busyExcel}
        onAnnul={onAnnul}
      />
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Liquidaciones emitidas</h3>
        <button disabled={busy} onClick={onLoad} className="btn-secondary">
          <RefreshCw className="h-3.5 w-3.5" />
          Actualizar
        </button>
      </div>
      {issued.length === 0 ? (
        <div className="rounded-xl border border-theme-border p-8 text-center text-sm text-theme-text-muted">
          No hay liquidaciones emitidas.
        </div>
      ) : (
        <div className="overflow-auto rounded-xl border border-theme-border">
          <table className="min-w-[900px] w-full text-xs">
            <thead>
              <tr>
                <th>#</th>
                <th>Vendedor</th>
                <th>Período</th>
                <th>Líneas</th>
                <th className="text-right">Neto</th>
                <th className="text-right">Comisión</th>
                <th>Emisión</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {issued.map((d) => (
                <tr key={d.id}>
                  <td className="font-semibold">
                    {d.settlement_code || d.settlement_number}
                  </td>
                  <td>{d.seller_name}</td>
                  <td>{d.period_label}</td>
                  <td>{d.lines_count || 0}</td>
                  <td className="text-right">{money(d.total_net_amount)}</td>
                  <td className="text-right font-semibold">
                    {money(d.total_commission_amount)}
                  </td>
                  <td>{d.issued_at?.slice(0, 10)}</td>
                  <td>
                    <div className="flex gap-1">
                      <button
                        onClick={() => onDetail(d.id)}
                        className="btn-secondary"
                      >
                        <FileText className="h-3 w-3" />
                        Ver
                      </button>
                      {onPdf && (
                        <button
                          disabled={busyPdf === d.id}
                          onClick={() => onPdf(d.id)}
                          className="btn-secondary"
                          title="PDF resumen ejecutivo por factura"
                        >
                          {busyPdf === d.id ? (
                            "Generando PDF..."
                          ) : (
                            <>
                              <FileText className="h-3 w-3" />
                              PDF
                            </>
                          )}
                        </button>
                      )}
                      {onExcel && (
                        <button
                          disabled={busyExcel === d.id}
                          onClick={() => onExcel(d.id)}
                          className="btn-secondary"
                          title="Excel detalle por línea"
                        >
                          {busyExcel === d.id ? (
                            "Descargando Excel..."
                          ) : (
                            <>
                              <FileText className="h-3 w-3" />
                              Excel
                            </>
                          )}
                        </button>
                      )}
                      {onAnnul && (
                        <button
                          onClick={() => onAnnul(d.id)}
                          className="btn-secondary border-red-500/30 text-red-600"
                        >
                          <Ban className="h-3 w-3" />
                          Anular
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SettlementDetailView({
  detail,
  onBack,
  onPdf,
  onExcel,
  busyPdf,
  busyExcel,
  onAnnul,
}: {
  detail: SettlementDetail;
  onBack: () => void;
  onPdf?: (id: string) => void;
  onExcel?: (id: string) => void;
  busyPdf?: string | null;
  busyExcel?: string | null;
  onAnnul?: (id: string) => void;
}) {
  const { header, lines } = detail;
  const sid = header.id;
  const isDraft = header.status === "DRAFT";
  const isIssued = header.status === "ISSUED";
  const statusLabel = isDraft ? "Borrador" : isIssued ? "Emitida" : "Anulada";
  const invoicesCount = new Set(
    lines.map((l) => l.original_invoice_bsale_id || l.invoice_bsale_id),
  ).size;
  const linesCount = lines.length;
  const ncLinesCount = lines.filter((l) => l.line_type === "CREDIT_NOTE").length;
  const netoPositivo = lines.reduce(
    (s, l) => s + (l.net_amount > 0 ? l.net_amount : 0),
    0,
  );
  const netoNc = lines.reduce(
    (s, l) => s + (l.line_type === "CREDIT_NOTE" ? l.net_amount : 0),
    0,
  );
  const netoFinal = lines.reduce((s, l) => s + l.net_amount, 0);
  const comisionFinal = lines.reduce(
    (s, l) => s + (l.commission_amount || 0),
    0,
  );
  const fmt = (iso: string | null | undefined) =>
    iso ? iso.slice(0, 10).split("-").reverse().join("/") : "-";

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-4 border-b border-theme-border bg-theme-surface/95 px-4 pb-2 pt-0 backdrop-blur-sm md:-mx-6 md:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button onClick={onBack} className="btn-secondary shrink-0">
            <ArrowLeft className="h-3.5 w-3.5" />
            Volver
          </button>
          <span className="font-semibold">
            {header.settlement_code || "Borrador"}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${isDraft ? "bg-amber-500/20 text-amber-700" : isIssued ? "bg-emerald-500/20 text-emerald-700" : "bg-red-500/20 text-red-700"}`}
          >
            {statusLabel}
          </span>
          <span className="text-xs text-theme-text-muted">{header.seller_name}</span>
          <span className="text-xs text-theme-text-muted">{header.period_label}</span>
          <div className="ml-auto flex gap-1">
            {onPdf && (
              <button
                disabled={busyPdf === sid}
                onClick={() => onPdf(sid)}
                className="btn-secondary"
              >
                {busyPdf === sid ? (
                  "Generando PDF..."
                ) : (
                  <>
                    <FileText className="h-3 w-3" />
                    PDF
                  </>
                )}
              </button>
            )}
            {onExcel && (
              <button
                disabled={busyExcel === sid}
                onClick={() => onExcel(sid)}
                className="btn-secondary"
              >
                {busyExcel === sid ? (
                  "Descargando Excel..."
                ) : (
                  <>
                    <FileText className="h-3 w-3" />
                    Excel
                  </>
                )}
              </button>
            )}
            {onAnnul && isIssued && (
              <button
                onClick={() => onAnnul(sid)}
                className="btn-secondary border-red-500/30 text-red-600"
              >
                <Ban className="h-3 w-3" />
                Anular
              </button>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
          <span><b>Facturas:</b> {invoicesCount}</span>
          <span><b>Líneas:</b> {linesCount}</span>
          <span><b>Líneas NC:</b> {ncLinesCount}</span>
          <span><b>Neto +:</b> {money(netoPositivo)}</span>
          <span className="text-amber-700"><b>Neto NC:</b> {money(netoNc)}</span>
          <span><b>Neto final:</b> {money(netoFinal)}</span>
          <span><b>Comisión:</b> {money(comisionFinal)}</span>
          <span>
            <b>% efectivo:</b>{" "}
            {netoFinal ? `${((comisionFinal / netoFinal) * 100).toFixed(2)}%` : "0.00%"}
          </span>
          <span className="text-theme-text-muted">Creado {fmt(header.created_at || null)}</span>
        </div>
      </div>

      <div className="mt-3 overflow-auto rounded-xl border border-theme-border">
        <table className="min-w-[1200px] w-full text-xs">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Factura</th>
              <th>SKU / Producto</th>
              <th className="text-right">Cant.</th>
              <th className="text-right">Neto</th>
              <th className="text-right">%</th>
              <th className="text-right">Comisión</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line: CommissionSettlementLine) => {
              const isNC = line.line_type === "CREDIT_NOTE";
              return (
                <tr key={line.id} className={isNC ? "opacity-85" : ""}>
                  <td>{isNC ? `NC ${line.source_document_number || ""}` : "Factura"}</td>
                  <td>
                    {isNC
                      ? `${line.original_invoice_number || ""} (NC ${line.source_document_number || ""})`
                      : line.invoice_number || line.invoice_bsale_id}
                  </td>
                  <td>
                    <b>{line.sku}</b>
                    <div>
                      {line.product_name}
                      {isNC &&
                      line.metadata &&
                      (line.metadata as Record<string, unknown>)?.adjustment_reason ? (
                        <div className="mt-0.5 text-[10px] text-amber-600">
                          {
                            (line.metadata as Record<string, unknown>)
                              ?.adjustment_reason as string
                          }
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td className="text-right">
                    {isNC ? `(${Math.abs(line.quantity)})` : line.quantity}
                  </td>
                  <td className={`text-right ${isNC ? "text-amber-700" : ""}`}>
                    {isNC
                      ? `(${money(Math.abs(line.net_amount))})`
                      : money(line.net_amount)}
                  </td>
                  <td className="text-right">
                    {line.commission_percent != null
                      ? formatPercent(Number(line.commission_percent))
                      : "-"}
                  </td>
                  <td
                    className={`text-right font-semibold ${isNC ? "text-amber-700" : ""}`}
                  >
                    {line.commission_amount != null
                      ? isNC
                        ? `(${money(Math.abs(line.commission_amount))})`
                        : money(line.commission_amount)
                      : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
