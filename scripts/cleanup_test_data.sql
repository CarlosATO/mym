-- ============================================================================
-- CLEANUP TEST DATA — MYM Distribuidora / PetGrup
-- ============================================================================
-- Este script elimina datos transaccionales de prueba para empezar pruebas reales.
-- Conserva: catálogos, usuarios, empresas, roles, productos, bodegas, ubicaciones.
--
-- MODO ACTUAL: ROLLBACK (seguro para revisión)
--   Correr tal cual para ver conteos sin borrar nada.
--   Cambiar ROLLBACK; por COMMIT; para ejecutar realmente.
--
-- ATENCIÓN Storage (archivos PDF):
--   Este script NO borra archivos de Storage. Deben eliminarse manualmente
--   desde el Dashboard de Supabase después del COMMIT.
-- ============================================================================

BEGIN;

-- ============================================================================
-- CONTEO ANTES
-- ============================================================================
SELECT 'ANTES' as fase,
  (SELECT count(*) FROM logistica.route_guide_items) as route_guide_items,
  (SELECT count(*) FROM logistica.route_guides) as route_guides,
  (SELECT count(*) FROM adquisiciones.route_settlement_items) as settlement_items,
  (SELECT count(*) FROM adquisiciones.route_settlements) as settlements,
  (SELECT count(*) FROM adquisiciones.route_settlement_item_attachments) as attachments,
  (SELECT count(*) FROM adquisiciones.route_fund_closure_items) as fund_closure_items,
  (SELECT count(*) FROM adquisiciones.route_fund_closure_expenses) as fund_closure_expenses,
  (SELECT count(*) FROM adquisiciones.route_fund_closure_deposits) as fund_closure_deposits,
  (SELECT count(*) FROM adquisiciones.route_fund_closures) as fund_closures,
  (SELECT count(*) FROM logistica.purchase_receipt_items) as receipt_items,
  (SELECT count(*) FROM logistica.receipt_documents) as receipt_documents,
  (SELECT count(*) FROM logistica.purchase_receipts) as receipts,
  (SELECT count(*) FROM logistica.kardex_movements) as kardex_movements,
  (SELECT count(*) FROM logistica.stock_adjustment_items) as adjustment_items,
  (SELECT count(*) FROM logistica.stock_adjustments) as adjustments,
  (SELECT count(*) FROM logistica.stock_transfer_items) as transfer_items,
  (SELECT count(*) FROM logistica.stock_transfers) as transfers,
  (SELECT count(*) FROM adquisiciones.purchase_order_items) as po_items,
  (SELECT count(*) FROM adquisiciones.purchase_orders) as pos,
  (SELECT count(*) FROM adquisiciones.suppliers) as suppliers,
  (SELECT count(*) FROM adquisiciones.supplier_contacts) as supplier_contacts,
  (SELECT count(*) FROM adquisiciones.supplier_products) as supplier_products;

-- ============================================================================
-- 1. FUND CLOSURES (hojas → raíz)
-- ============================================================================
DELETE FROM adquisiciones.route_fund_closure_deposits;
DELETE FROM adquisiciones.route_fund_closure_expenses;
DELETE FROM adquisiciones.route_fund_closure_items;
DELETE FROM adquisiciones.route_fund_closures;

-- ============================================================================
-- 2. ROUTE SETTLEMENTS (hojas → raíz)
-- ============================================================================
DELETE FROM adquisiciones.route_settlement_item_attachments;
DELETE FROM adquisiciones.route_settlement_items;
DELETE FROM adquisiciones.route_settlements;

-- ============================================================================
-- 3. ROUTE GUIDES (items → guías)
-- ============================================================================
DELETE FROM logistica.route_guide_items;
DELETE FROM logistica.route_guides;

-- ============================================================================
-- 4. KARDEX MOVEMENTS
-- ============================================================================
DELETE FROM logistica.kardex_movements;

-- ============================================================================
-- 5. TABLAS DE STOCK (vacías — se incluyen por seguridad)
-- ============================================================================
DELETE FROM logistica.stock_balances;
DELETE FROM logistica.inventory_balances;
DELETE FROM logistica.product_locations;
DELETE FROM logistica.warehouse_stock;
DELETE FROM logistica.current_stock;
DELETE FROM logistica.stock_current;

-- ============================================================================
-- 6. STOCK ADJUSTMENTS (items → ajustes)
-- ============================================================================
DELETE FROM logistica.stock_adjustment_items;
DELETE FROM logistica.stock_adjustments;

-- ============================================================================
-- 7. STOCK TRANSFERS (items → transferencias)
-- ============================================================================
DELETE FROM logistica.stock_transfer_items;
DELETE FROM logistica.stock_transfers;

-- ============================================================================
-- 8. PURCHASE RECEIPTS (documentos → items → recepciones)
-- ============================================================================
DELETE FROM logistica.receipt_documents;
DELETE FROM logistica.purchase_receipt_items;
DELETE FROM logistica.purchase_receipts;

-- ============================================================================
-- 9. PURCHASE ORDERS (items → órdenes)
-- ============================================================================
DELETE FROM adquisiciones.purchase_order_items;
DELETE FROM adquisiciones.purchase_orders;

-- ============================================================================
-- 10. SUPPLIERS (dependencias → proveedor)
-- ============================================================================
DELETE FROM adquisiciones.supplier_contacts;
DELETE FROM adquisiciones.supplier_products;
DELETE FROM adquisiciones.suppliers;

-- ============================================================================
-- CONTEO DESPUÉS
-- ============================================================================
SELECT 'DESPUES' as fase,
  (SELECT count(*) FROM logistica.route_guide_items) as route_guide_items,
  (SELECT count(*) FROM logistica.route_guides) as route_guides,
  (SELECT count(*) FROM adquisiciones.route_settlement_items) as settlement_items,
  (SELECT count(*) FROM adquisiciones.route_settlements) as settlements,
  (SELECT count(*) FROM adquisiciones.route_fund_closure_items) as fund_closure_items,
  (SELECT count(*) FROM adquisiciones.route_fund_closures) as fund_closures,
  (SELECT count(*) FROM logistica.purchase_receipt_items) as receipt_items,
  (SELECT count(*) FROM logistica.purchase_receipts) as receipts,
  (SELECT count(*) FROM logistica.kardex_movements) as kardex_movements,
  (SELECT count(*) FROM logistica.stock_adjustments) as adjustments,
  (SELECT count(*) FROM logistica.stock_transfers) as transfers,
  (SELECT count(*) FROM adquisiciones.purchase_orders) as pos,
  (SELECT count(*) FROM adquisiciones.suppliers) as suppliers,
  (SELECT count(*) FROM adquisiciones.supplier_contacts) as supplier_contacts,
  (SELECT count(*) FROM adquisiciones.supplier_products) as supplier_products,

  -- Protegidos — deben permanecer intactos
  (SELECT count(*) FROM adquisiciones.products) as products,
  (SELECT count(*) FROM adquisiciones.product_classifiers) as product_classifiers,
  (SELECT count(*) FROM adquisiciones.warehouses) as warehouses,
  (SELECT count(*) FROM adquisiciones.authorized_personnel) as authorized_personnel;

-- ============================================================================
-- ARCHIVOS STORAGE A ELIMINAR MANUALMENTE (después del COMMIT):
-- ============================================================================
-- Bucket "recepciones": d1000000-.../purchase-receipts/ (6 subcarpetas, 10 PDFs)
-- Bucket "rendicion-rutas": d1000000-.../fund-closures/ y rendicion-rutas/ (5 archivos)

-- ============================================================================
-- CAMBIAR A COMMIT; PARA EJECUTAR
-- ============================================================================
ROLLBACK;
-- COMMIT;
