-- COMV2-05C: SECURITY INVOKER eligibility reads its own V2 active locks.
-- RLS remains the company boundary; this grant does not grant seller access.

GRANT SELECT ON comisiones.line_locks TO authenticated;
