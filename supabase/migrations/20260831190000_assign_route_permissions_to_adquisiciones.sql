-- Associate route settlement and fund closure permissions with Adquisiciones.
-- Global permissions intentionally remain without a module.
UPDATE portal.permissions AS p
SET module_id = m.id
FROM portal.modules AS m
WHERE m.code = 'adquisiciones'
  AND p.is_active = true
  AND p.module_id IS NULL
  AND (
    p.code LIKE 'adquisiciones.route_settlements.%'
    OR p.code LIKE 'adquisiciones.route_fund_closures.%'
  );
