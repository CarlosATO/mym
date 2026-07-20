-- 5. Validar counts
SELECT count(*) AS total_cards
FROM logistica.sales_order_preparation_cards;

SELECT status, count(*)
FROM logistica.sales_order_preparation_cards
GROUP BY status
ORDER BY status;

SELECT count(*) AS total_movements
FROM logistica.sales_order_preparation_movements;

SELECT count(*) AS total_exceptions
FROM logistica.sales_order_route_exceptions;
