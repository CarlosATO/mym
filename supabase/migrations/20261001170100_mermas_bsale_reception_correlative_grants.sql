-- Keep the internal reception counter auditable by the server role.

GRANT SELECT, INSERT, UPDATE ON mermas.bsale_reception_correlatives TO service_role;
