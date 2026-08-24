-- COMV2-07: SECURITY INVOKER RPCs need their underlying read grants.

GRANT SELECT ON comisiones.settings TO authenticated;
GRANT SELECT ON comisiones.vw_sales_line_resolution TO service_role;
