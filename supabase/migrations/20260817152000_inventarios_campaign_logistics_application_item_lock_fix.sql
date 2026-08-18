-- Un item puede tener varias lineas exitosas dentro de una misma aplicacion.
-- La unicidad de una segunda aplicacion exitosa se garantiza bajo el lock del
-- reconciliation item y por su estado APPLIED, no por una unicidad por linea.
DROP INDEX IF EXISTS inventarios.uq_inventarios_campaign_logistics_successful_item;
