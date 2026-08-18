-- =========================================================================================
-- MIGRATION: M1.5F.3 - Nombre de zona unico en el mismo ambito operativo (seccion/bodega)
-- =========================================================================================
-- Objetivo:
--   Impedir crear una nueva zona cuyo nombre (display_name) ya exista en la misma
--   seccion/bodega (misma session del inventario). La comparacion normaliza al menos
--   espacios al inicio/final y mayusculas/minusculas, de modo que 'Zona 1', ' zona 1 '
--   y 'ZONA 1' se consideran el mismo nombre.
--
-- Implementacion:
--   Trigger BEFORE INSERT OR UPDATE OF display_name, session_id sobre
--   inventarios.session_zones. Cubre TODOS los contratos reales que crean zonas
--   (create_inventory_session_zone y assign_inventory_counting_zone) en un unico punto,
--   sin reescribir sus cuerpos. Si existe renombrado/cambio de ambito (UPDATE de
--   display_name o session_id), la misma proteccion se aplica excluyendo la fila propia.
--
--   No modifica ninguna zona existente: solo valida escrituras nuevas. Las zonas
--   duplicadas historicas permanecen intactas.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios._inventarios_guard_zone_name_unique()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_name text := pg_catalog.lower(pg_catalog.btrim(NEW.display_name));
BEGIN
    IF v_name = '' THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM inventarios.session_zones sz
        WHERE sz.company_id = NEW.company_id
          AND sz.session_id = NEW.session_id
          AND pg_catalog.lower(pg_catalog.btrim(sz.display_name)) = v_name
          AND sz.id IS DISTINCT FROM NEW.id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ZONE_NAME_ALREADY_EXISTS',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','Ya existe una zona con este nombre en esta sección del inventario.',
                'retryable',false)::text;
    END IF;

    RETURN NEW;
END;
$function$;

ALTER FUNCTION inventarios._inventarios_guard_zone_name_unique() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._inventarios_guard_zone_name_unique()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_inventarios_session_zones_zone_name_unique ON inventarios.session_zones;
CREATE TRIGGER trg_inventarios_session_zones_zone_name_unique
    BEFORE INSERT OR UPDATE OF display_name, session_id
    ON inventarios.session_zones
    FOR EACH ROW
    EXECUTE FUNCTION inventarios._inventarios_guard_zone_name_unique();

COMMIT;
