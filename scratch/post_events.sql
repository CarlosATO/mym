SELECT event_type, count(*)
FROM logistica.sales_order_preparation_route_events
WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
GROUP BY event_type
ORDER BY event_type;
