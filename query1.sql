SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'integraciones'
  AND (table_name LIKE '%client%' OR table_name = 'vw_bsale_sales_orders_for_preparation')
ORDER BY table_name, ordinal_position;
