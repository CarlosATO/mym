import type { CommissionSeller, CommissionSellerRow } from "./types";
import { sellerTypes } from "./types";

export function mapSeller(row: CommissionSellerRow): CommissionSeller {
  return {
    ...row,
    seller_bsale_id: Number(row.seller_bsale_id),
    docs_count: Number(row.docs_count || 0),
    invoices_count: Number(row.invoices_count || 0),
    paid_invoices_count: Number(row.paid_invoices_count || 0),
    seller_type: sellerTypes.includes(row.seller_type) ? row.seller_type : "OTHER",
    notes: null,
  };
}

export function isIsoDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

export function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
