export type AnalysisSupplierOption = {
  id: string
  business_name: string
}

export type SupplierWeeklyPoint = {
  label: string
  weekStart: string
  weekEnd: string
  purchases: number
  sales: number
  margin?: number
}

export type SupplierPurchaseRow = {
  date: string
  document: string
  documentNumber?: string
  productsSummary: string
  productSkusPreview: string[]
  productCount: number
  units: number
  amount: number
}

export type SupplierCatalogRow = {
  product_id: string
  sku: string
  product_name: string
  pseudo_supplier: string
  stock_current: number
  average_cost: number
  sales_amount: number
  units_sold: number
  last_sale: string | null
}

export type SupplierPurchaseSales360 = {
  supplier: {
    id: string
    business_name: string
    supplier_kind: string
  }
  source: {
    sales: string
    purchases: string
    stock: string
    supplier_resolution: string
  }
  period: {
    from: string
    to: string
  }
  kpis: {
    purchases_amount: number | null
    sales_amount: number
    estimated_margin: number
    stock_value: number
    last_purchase_date: string | null
  }
  hasReceptionData: boolean
  weekly: SupplierWeeklyPoint[]
  lastPurchases: SupplierPurchaseRow[]
  catalog: SupplierCatalogRow[]
}

export type SupplierWeeklyDocumentDetail = {
  id: string
  date: string
  document: string
  documentNumber: string
  amount: number
  units: number
  productsSummary: string
  kind: 'PURCHASE' | 'SALE' | 'CREDIT_NOTE'
  customerName?: string | null
}

export type SupplierWeeklyProductDetail = {
  sku: string
  description: string
  units: number
  amount: number
}

export type SupplierWeeklyDetail = {
  weekStart: string
  weekEnd: string
  label: string
  purchases: number
  sales: number
  difference: number
  purchaseDocuments: SupplierWeeklyDocumentDetail[]
  saleDocuments: SupplierWeeklyDocumentDetail[]
  topProducts: SupplierWeeklyProductDetail[]
}

export type SupplierDocumentLineDetail = {
  sku: string
  description: string
  quantity: number
  unitAmount: number
  totalAmount: number
  kind: 'SALE' | 'CREDIT_NOTE' | 'PURCHASE'
}

export type SupplierDocumentDetail = {
  id: string
  date: string
  document: string
  documentNumber: string
  customerName?: string
  supplierName?: string
  totalAmount: number
  units: number
  lines: SupplierDocumentLineDetail[]
}
