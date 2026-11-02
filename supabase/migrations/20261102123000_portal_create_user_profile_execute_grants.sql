-- Bloque 01 (Caylo Asistencia / PetGroup): restringir el alta de perfiles.
-- Solo el backend administrativo (service_role) puede invocar esta RPC.
-- No cambia la autenticacion, los usuarios existentes ni los roles asignados.
-- Esta migracion NO debe aplicarse sin pruebas previas y autorizacion.

BEGIN;

REVOKE ALL ON FUNCTION portal.create_user_profile(
  uuid, character varying, character varying, character varying, uuid, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION portal.create_user_profile(
  uuid, character varying, character varying, character varying, uuid, uuid
) TO service_role;

-- Verificacion fail-closed: abortar si un rol cliente conserva EXECUTE
-- o si el backend administrativo lo pierde.
DO $verification$
DECLARE
  v_function regprocedure :=
    'portal.create_user_profile(uuid, character varying, character varying, character varying, uuid, uuid)'::regprocedure;
BEGIN
  IF has_function_privilege('anon', v_function, 'EXECUTE')
     OR has_function_privilege('authenticated', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'La RPC de alta de perfiles sigue accesible a roles cliente';
  END IF;
  IF NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'El backend administrativo perdio acceso a la RPC de alta de perfiles';
  END IF;
END;
$verification$;

COMMIT;
