-- Elimina el overload previo de list_inventory_campaign_variances (7 args) para
-- evitar ambigüedad con la nueva firma de 9 args (20260812161300) que soporta
-- ordenamiento global.
--
-- El único caller era el Informe Global del Inventario (frontend), que se
-- actualiza en esta misma iteración. La firma de 9 args conserva DEFAULT en los
-- parámetros nuevos, por lo que las llamadas con 7 args siguen resolviendo sin
-- ambigüedad.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

DROP FUNCTION IF EXISTS inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer);

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) TO authenticated, service_role;

COMMIT;
