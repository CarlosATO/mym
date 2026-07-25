export type AnalysisSupplierOption = {
  id: string
  business_name: string
}

export type SupplierMonthlyPoint = {
  month: string
  purchases: number
  sales: number
}

export type SupplierPurchaseRow = {
  date: string
  document: string
  products: number
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
  monthly: SupplierMonthlyPoint[]
  lastPurchases: SupplierPurchaseRow[]
  catalog: SupplierCatalogRow[]
}
