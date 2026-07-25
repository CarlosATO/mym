import type { CommissionRuleProductCandidate } from "@/app/actions/comercial/commissions";

export type Supplier = {
  id: string;
  name: string;
  rut: string | null;
  type_label?: string;
};

export type Product = {
  id: string;
  sku: string;
  description: string;
  supplier_name: string | null;
};

export type RuleProductCandidate = CommissionRuleProductCandidate;

export type TargetMode =
  | "GENERAL"
  | "SUPPLIER_ALL_PRODUCTS"
  | "SUPPLIER_SELECTED_PRODUCTS"
  | "EXISTING_GROUP"
  | "SELECTED_PRODUCTS";
