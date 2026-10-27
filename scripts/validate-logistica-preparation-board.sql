-- Validación preparada para una base aislada.
--
-- Antes de aplicar la optimización en el clon, guardar la definición vigente
-- con el nombre logistica.vw_sales_order_preparation_board_before. Después de
-- aplicar la migración, ejecutar este archivo con psql y:
--   psql ... -v company_id='UUID_DE_LA_EMPRESA' -f scripts/validate-logistica-preparation-board.sql
--
-- No ejecutar contra producción. Las comparaciones usan EXCEPT ALL y jsonb
-- para conservar filas duplicadas y distinguir valores NULL.

\set ON_ERROR_STOP on

-- Plan anterior.
EXPLAIN (COSTS, VERBOSE, FORMAT JSON)
SELECT *
FROM logistica.vw_sales_order_preparation_board_before
WHERE company_id = :'company_id'::uuid;

-- Plan optimizado.
EXPLAIN (COSTS, VERBOSE, FORMAT JSON)
SELECT *
FROM logistica.vw_sales_order_preparation_board
WHERE company_id = :'company_id'::uuid;

WITH before_rows AS (
  SELECT to_jsonb(row) AS value
  FROM (
    SELECT *
    FROM logistica.vw_sales_order_preparation_board_before
    WHERE company_id = :'company_id'::uuid
  ) AS row
), after_rows AS (
  SELECT to_jsonb(row) AS value
  FROM (
    SELECT *
    FROM logistica.vw_sales_order_preparation_board
    WHERE company_id = :'company_id'::uuid
  ) AS row
), missing AS (
  SELECT value FROM before_rows EXCEPT ALL SELECT value FROM after_rows
), unexpected AS (
  SELECT value FROM after_rows EXCEPT ALL SELECT value FROM before_rows
)
SELECT
  (SELECT count(*) FROM before_rows) AS before_count,
  (SELECT count(*) FROM after_rows) AS after_count,
  (SELECT count(*) FROM missing) AS missing_count,
  (SELECT count(*) FROM unexpected) AS unexpected_count;

WITH board AS (
  SELECT 'before' AS version, card_id, status, count(*) AS row_count
  FROM logistica.vw_sales_order_preparation_board_before
  WHERE company_id = :'company_id'::uuid
  GROUP BY card_id, status
  UNION ALL
  SELECT 'after', card_id, status, count(*)
  FROM logistica.vw_sales_order_preparation_board
  WHERE company_id = :'company_id'::uuid
  GROUP BY card_id, status
)
SELECT *
FROM board
ORDER BY card_id, version;
