import type {
  CommissionSeller,
  CommissionSellerType,
} from "@/app/actions/comercial/commissions";
import type { SellerDraft } from "./commissions-panel-types";

export const sellerTypes: Array<{
  value: CommissionSellerType;
  label: string;
}> = [
  { value: "FIELD", label: "Terreno" },
  { value: "ADMIN", label: "Administración" },
  { value: "MANAGEMENT", label: "Gerencia" },
  { value: "DISPATCH", label: "Despacho" },
  { value: "OTHER", label: "Otro" },
];

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function money(value: number) {
  return `$${value.toLocaleString("es-CL", { maximumFractionDigits: 0 })}`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No se pudo completar la operación";
}

export function sellerDraft(seller: CommissionSeller): SellerDraft {
  return {
    seller_name: seller.seller_name || "",
    is_commissionable: seller.is_commissionable,
    seller_type: seller.seller_type,
    active: seller.profile_active ?? true,
    notes: seller.notes || "",
  };
}
