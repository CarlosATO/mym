SELECT column_name, column_default
FROM information_schema.columns
WHERE table_schema = 'logistica'
  AND table_name = 'sales_order_preparation_cards'
  AND column_name = 'priority';
