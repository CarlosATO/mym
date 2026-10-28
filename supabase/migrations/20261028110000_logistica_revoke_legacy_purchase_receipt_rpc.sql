-- The ten-argument receipt RPC predates idempotency and the current BSale flow.
-- Keep its definition for historical compatibility, but make it unreachable.

REVOKE ALL ON FUNCTION logistica.create_purchase_receipt_db(
    uuid, uuid, text, uuid, text, text, text, date, jsonb, uuid
) FROM PUBLIC, anon, authenticated, service_role;
