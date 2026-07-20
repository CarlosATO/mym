SELECT route_date, status, count(*)
FROM logistica.sales_order_preparation_cards
WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
GROUP BY route_date, status
ORDER BY route_date, status;
