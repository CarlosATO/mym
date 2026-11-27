import ExcelJS from "exceljs";
import type { WorkerAccountDetailV2, WorkerAccountChargeV2 } from "@/app/actions/logistica/mermas";

const CLP = '"$" #,##0;[Red]-"$" #,##0';
const DATE = "dd/mm/yyyy hh:mm";
const priority = { CHARGE: 0, ADJUSTMENT: 1, PAYMENT: 2 };
type Movement = WorkerAccountDetailV2["movements"][number];

function localDate(value: string | null): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d\d-\d\d$/.test(value)) return new Date(`${value}T00:00:00Z`);
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}

function documentName(charge?: WorkerAccountChargeV2) {
  if (!charge) return "Sin documento";
  return charge.document_number || (charge.source_id && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(charge.source_id) ? charge.source_id : "Sin número");
}

function products(charge?: WorkerAccountChargeV2) {
  return (charge?.items ?? []).map((item) => `${item.product_name || item.variant_description || "Producto sin nombre"}${item.quantity == null ? "" : ` (x${Number(item.quantity)})`}`).join("; ") || "Sin detalle de productos";
}

function units(charge?: WorkerAccountChargeV2) {
  const quantities = (charge?.items ?? []).filter((item) => item.quantity != null);
  return quantities.length ? quantities.reduce((sum, item) => sum + Number(item.quantity), 0) : null;
}

function sourceLabel(source: string | null) {
  return ({ MERMA: "Merma", BSALE_BOLETA: "Boleta Bsale", BSALE_NOTA_CREDITO: "Nota de crédito" } as Record<string, string>)[source ?? ""] ?? "Movimiento";
}

function createSheet(book: ExcelJS.Workbook, name: string, title: string, subtitle: string, headers: string[], widths: number[]) {
  const sheet = book.addWorksheet(name, { views: [{ state: "frozen", ySplit: 4 }] });
  sheet.columns = widths.map((width) => ({ width }));
  sheet.mergeCells(1, 1, 1, headers.length);
  sheet.mergeCells(2, 1, 2, headers.length);
  sheet.getCell("A1").value = title;
  sheet.getCell("A2").value = subtitle;
  sheet.getRow(1).height = 30;
  sheet.getRow(2).height = 25;
  for (const [row, color, size] of [[1, "FF17365D", 15], [2, "FFE7EFF7", 10]] as const) {
    const cells = sheet.getRow(row);
    cells.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
      cell.font = { name: "Calibri", size, bold: row === 1, color: { argb: row === 1 ? "FFFFFFFF" : "FF38516B" } };
      cell.alignment = { vertical: "middle", indent: 1 };
    });
  }
  sheet.getRow(4).values = headers;
  sheet.getRow(4).height = 26;
  sheet.getRow(4).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF24496B" } };
    cell.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  return sheet;
}

function finishSheet(sheet: ExcelJS.Worksheet, money: number[], dates: number[], total?: { columns: number[]; values: number[] }) {
  const last = sheet.rowCount;
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, last), column: sheet.columnCount } };
  for (let r = 5; r <= last; r++) {
    const row = sheet.getRow(r);
    row.height = 30;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { name: "Calibri", size: 10, color: { argb: "FF243447" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r % 2 ? "FFFFFFFF" : "FFF2F6FA" } };
      cell.alignment = { vertical: "middle", wrapText: true, horizontal: money.includes(col) ? "right" : "left" };
      if (money.includes(col)) cell.numFmt = CLP;
      if (dates.includes(col)) cell.numFmt = DATE;
    });
  }
  if (total) {
    const row = sheet.addRow(["TOTAL"]);
    total.columns.forEach((column, index) => {
      const letter = sheet.getColumn(column).letter;
      row.getCell(column).value = { formula: last >= 5 ? `SUM(${letter}5:${letter}${last})` : "0", result: total.values[index] };
      if (money.includes(column)) row.getCell(column).numFmt = CLP;
    });
    row.height = 24;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF24496B" } };
      cell.alignment = { vertical: "middle" };
    });
  }
}

function number(value: number | null | undefined) { return Number(value ?? 0); }

export function createWorkerAccountWorkbook(detail: WorkerAccountDetailV2) {
  const book = new ExcelJS.Workbook();
  book.creator = "Distribuidora MyM";
  book.calcProperties.fullCalcOnLoad = true;
  const charges = new Map(detail.charges.map((charge) => [charge.charge_id, charge]));
  const movements = [...detail.movements].filter((m) => !(m.movement_type === "CHARGE" && m.status === "REVERSED")).sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime() || priority[a.movement_type] - priority[b.movement_type] || (a.reference_number ?? "").localeCompare(b.reference_number ?? "") || (a.charge_id ?? a.payment_id ?? "").localeCompare(b.charge_id ?? b.payment_id ?? ""));
  const pending = detail.charges.filter((c) => c.status === "ACTIVE" && number(c.outstanding_amount) > 0).sort((a, b) => (a.document_date ?? "").localeCompare(b.document_date ?? ""));
  const duplicates = new Set<Movement>();
  const chargeMovements = movements.filter((m) => m.movement_type === "CHARGE" && m.charge_id && charges.has(m.charge_id));
  for (let i = 0; i < chargeMovements.length; i++) for (let j = i + 1; j < chargeMovements.length; j++) {
    const a = chargeMovements[i], b = chargeMovements[j];
    const delta = new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
    if (delta > 5 * 60 * 1000) break;
    const ac = charges.get(a.charge_id!), bc = charges.get(b.charge_id!);
    if (ac && bc && ac.items.length && bc.items.length && a.source_type === b.source_type && number(a.amount) === number(b.amount) && products(ac) === products(bc)) { duplicates.add(a); duplicates.add(b); }
  }

  const summary = createSheet(book, "Resumen", `AUDITORÍA DE CONSUMOS | ${detail.employee.name.toLocaleUpperCase("es-CL")}`, "Cuenta corriente individual • importes en CLP • horario de Santiago", ["Indicador", "Valor", "Detalle"], [33, 24, 55]);
  const summaryRows: Array<[string, string | number | Date | null, string]> = [
    ["Trabajador", detail.employee.name, ""], ["RUT", detail.employee.rut, ""], ["Estado", detail.employee.status === "ACTIVO" ? "Activo" : "Inactivo", ""], ["Fecha de generación", localDate(new Date().toISOString()), "Horario de Santiago"],
    ["Compras originales", number(detail.summary.total_original_charges), "Importe oficial de cargos"], ["Pagos vigentes", number(detail.summary.approved_payments), "Pagos registrados"], ["Pagos en revisión", number(detail.summary.pending_review_payments), "No descontados del saldo oficial"], ["Saldo oficial", number(detail.summary.official_balance), "Saldo de la cuenta corriente"], ["Saldo proyectado", number(detail.summary.projected_balance), "Saldo proyectado del sistema"], ["Saldo mermas", number(detail.summary.merma_balance), ""], ["Saldo boletas Bsale", number(detail.summary.bsale_boleta_balance), ""], ["Documentos pendientes", pending.length, "Cargos activos con saldo pendiente"],
  ];
  summaryRows.forEach((row) => summary.addRow(row));
  finishSheet(summary, [], []);
  for (let r = 9; r <= 15; r++) summary.getCell(r, 2).numFmt = CLP;
  summary.getCell("B8").numFmt = DATE;

  const kardex = createSheet(book, "Kardex", `KARDEX DE DEUDA | ${detail.employee.name.toLocaleUpperCase("es-CL")}`, "Historial completo • importes en CLP • horario de Santiago", ["Fecha y hora", "Documento", "Concepto", "Producto(s) / detalle", "Unidades", "Cargo", "Abono", "Saldo acumulado", "Observación"], [23, 23, 20, 52, 12, 17, 17, 20, 38]);
  let balance = 0, totalCharges = 0, totalCredits = 0, totalUnits = 0;
  for (const m of movements) {
    const charge = m.charge_id ? charges.get(m.charge_id) : undefined;
    const cargo = m.movement_type === "CHARGE" ? number(m.amount) : 0;
    const abono = m.movement_type === "PAYMENT" && m.status === "ACTIVE" ? number(m.amount) : m.movement_type === "ADJUSTMENT" && m.source_type === "BSALE_NOTA_CREDITO" ? Math.abs(number(m.amount)) : 0;
    const count = m.movement_type === "CHARGE" ? units(charge) : null;
    balance += cargo - abono; totalCharges += cargo; totalCredits += abono; totalUnits += count ?? 0;
    const concept = m.movement_type === "PAYMENT" ? (m.status === "ACTIVE" ? "Pago" : "Pago anulado") : m.movement_type === "ADJUSTMENT" ? sourceLabel(m.source_type) : sourceLabel(m.source_type);
    const row = kardex.addRow([localDate(m.occurred_at), m.reference_number || (charge ? documentName(charge) : "Sin número"), concept, m.movement_type === "CHARGE" ? products(charge) : concept, count, cargo, abono, null, duplicates.has(m) ? "Revisar posible duplicidad" : ""]);
    row.getCell(8).value = { formula: row.number === 5 ? `F${row.number}-G${row.number}` : `H${row.number - 1}+F${row.number}-G${row.number}`, result: balance };
  }
  finishSheet(kardex, [6, 7, 8], [1], { columns: [5, 6, 7], values: [totalUnits, totalCharges, totalCredits] });
  kardex.getRow(kardex.rowCount).getCell(8).value = { formula: movements.length ? `H${kardex.rowCount - 1}` : "0", result: balance };
  kardex.getRow(kardex.rowCount).getCell(8).numFmt = CLP;

  const purchases = createSheet(book, "Compras pendientes", "COMPRAS PENDIENTES DE PAGO", `${pending.length} documentos con saldo vigente • según asignaciones registradas`, ["Fecha", "Documento", "Producto(s)", "Cantidad", "Compra original", "Nota de crédito", "Abono aplicado", "Saldo pendiente", "Estado"], [23, 23, 54, 12, 19, 18, 18, 20, 20]);
  for (const c of pending) purchases.addRow([localDate(c.document_date), documentName(c), products(c), units(c), number(c.original_amount), number(c.credit_note_amount), number(c.approved_paid_amount), number(c.outstanding_amount), number(c.approved_paid_amount) > 0 ? "Pago parcial" : "Pendiente"]);
  finishSheet(purchases, [5, 6, 7, 8], [1], { columns: [4, 5, 6, 7, 8], values: [pending.reduce((s, c) => s + (units(c) ?? 0), 0), ...(["original_amount", "credit_note_amount", "approved_paid_amount", "outstanding_amount"] as const).map((key) => pending.reduce((s, c) => s + number(c[key]), 0))] });

  const allocations = createSheet(book, "Imputación pagos", "IMPUTACIÓN DE PAGOS", "Asignaciones registradas • pagos vigentes • no se presume imputación por producto", ["Fecha de pago", "Pago", "Documento abonado", "Monto aplicado"], [24, 25, 25, 20]);
  let allocated = 0;
  for (const p of [...detail.payments].filter((p) => p.status === "ACTIVE").sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))) for (const a of p.allocations) {
    allocated += number(a.amount);
    allocations.addRow([localDate(p.submitted_at), p.payment_number || "Pago sin correlativo", a.document_number || documentName(charges.get(a.charge_id)), number(a.amount)]);
  }
  finishSheet(allocations, [4], [1], { columns: [4], values: [allocated] });

  const productSheet = createSheet(book, "Detalle productos", "DETALLE DE PRODUCTOS", "Líneas registradas por documento • importes informados por el sistema", ["Fecha", "Documento", "Origen", "SKU", "Producto", "Cantidad", "Precio unitario", "Total línea"], [23, 23, 20, 20, 54, 12, 18, 18]);
  let quantity = 0, lineTotal = 0;
  for (const c of detail.charges) for (const item of c.items) {
    quantity += number(item.quantity); lineTotal += number(item.line_total);
    productSheet.addRow([localDate(c.document_date), documentName(c), sourceLabel(c.source_type), item.sku ?? item.variant_code ?? "", item.product_name ?? item.variant_description ?? "", item.quantity == null ? null : number(item.quantity), item.unit_price == null ? null : number(item.unit_price), item.line_total == null ? null : number(item.line_total)]);
  }
  finishSheet(productSheet, [7, 8], [1], { columns: [6, 8], values: [quantity, lineTotal] });
  return book;
}

export async function downloadWorkerAccountExcel(detail: WorkerAccountDetailV2) {
  const name = detail.employee.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Trabajador";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");
  const bytes = await createWorkerAccountWorkbook(detail).xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `Auditoria_Consumos_${name}_${date}.xlsx`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
