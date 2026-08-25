-- COMV2-29B-FIX: the invoker credit-note resolver reads issued history and
-- reversals. RLS already scopes these reads by company and permission; expose
-- the tables to authenticated so the simulation can invoke the resolver.

GRANT SELECT ON comisiones.settlements, comisiones.settlement_lines TO authenticated;
