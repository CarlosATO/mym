import type {
  CommissionSellerProfileInput,
  CommissionSettlementHeader,
  CommissionSettlementLine,
} from "@/app/actions/comercial/commissions";

export type View = "main" | "configuration";
export type ConfigTab = "sellers" | "general" | "groups" | "rules";
export type MainTab = "simulate" | "drafts" | "issued" | "annulled";
export type SellerDraft = Omit<CommissionSellerProfileInput, "seller_bsale_id">;

export type SimulationFilters = {
  invoice: string;
  supplier: string;
  product: string;
  rule: string;
  percent: string;
};

export type SettlementDetail = {
  header: CommissionSettlementHeader;
  lines: CommissionSettlementLine[];
};

export type SettlementListProps = {
  busy: boolean;
  detail: SettlementDetail | null;
  onLoad: () => void;
  onDetail: (id: string) => void;
  onBack: () => void;
  onPdf?: (id: string) => void;
  onExcel?: (id: string) => void;
  busyPdf?: string | null;
  busyExcel?: string | null;
};
