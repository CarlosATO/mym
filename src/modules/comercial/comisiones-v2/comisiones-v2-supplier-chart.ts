import type {
  ComisionesV2SettlementDetail,
  ComisionesV2SimulationLine,
} from "@/app/actions/comisiones-v2";

export type SupplierChartRow = {
  key: string;
  supplierName: string;
  net: number;
  commission: number;
  effectivePercent: number;
};

function compareSupplierRows(a: SupplierChartRow, b: SupplierChartRow) {
  return (
    b.net - a.net ||
    a.supplierName.localeCompare(b.supplierName, "es-CL") ||
    a.key.localeCompare(b.key)
  );
}

export function buildSupplierChartRows(
  rows: ComisionesV2SimulationLine[],
): SupplierChartRow[] {
  const grouped = new Map<string, SupplierChartRow>();
  for (const row of rows) {
    const key = row.real_supplier_id != null
      ? `id:${row.real_supplier_id}`
      : `name:${row.real_supplier_business_name ?? "Sin proveedor"}`;
    const current = grouped.get(key) ?? {
      key,
      supplierName: row.real_supplier_business_name ?? "Proveedor sin nombre",
      net: 0,
      commission: 0,
      effectivePercent: 0,
    };
    current.net += Number(row.net_amount ?? 0);
    current.commission += Number(row.commission_amount ?? 0);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((row) => ({
      ...row,
      effectivePercent: row.net ? (row.commission / row.net) * 100 : 0,
    }))
    .sort(compareSupplierRows);
}

export function buildSnapshotSupplierChartRows(
  detail: ComisionesV2SettlementDetail,
): SupplierChartRow[] {
  return buildSupplierChartRows(
    detail.lines.map((line) => ({
      real_supplier_id: line.real_supplier_id ?? null,
      real_supplier_business_name: line.real_supplier_name_snapshot,
      net_amount: line.net_amount,
      commission_amount: line.commission_amount,
    }) as ComisionesV2SimulationLine),
  );
}

export function topSupplierChartRows(rows: SupplierChartRow[]) {
  if (rows.length <= 10) return rows;
  const top = rows.slice(0, 10);
  const others = rows.slice(10).reduce(
    (result, row) => ({
      ...result,
      net: result.net + row.net,
      commission: result.commission + row.commission,
    }),
    { net: 0, commission: 0 },
  );
  return [
    ...top,
    {
      key: "others",
      supplierName: "Otros",
      ...others,
      effectivePercent: others.net ? (others.commission / others.net) * 100 : 0,
    },
  ];
}
