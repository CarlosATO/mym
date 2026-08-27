-- Release ACTIVE expenses stranded on historical CANCELLED closures.
-- Idempotent: already released expenses no longer match this update.

UPDATE adquisiciones.route_fund_closure_expenses e
SET fund_closure_id = NULL
FROM adquisiciones.route_fund_closures f
WHERE f.id = e.fund_closure_id
  AND f.status = 'CANCELLED'
  AND e.status = 'ACTIVE';
