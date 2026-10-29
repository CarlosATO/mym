-- Rollback exclusivo para
-- 20261029100000_logistica_operator_preparation_board.sql.
-- La migración solo crea la RPC del operador: no modifica tablas, datos,
-- vistas compartidas, políticas RLS, índices ni permisos existentes.
--
-- Antes de aplicar la migración, verificar que esta función NO exista:
--   SELECT pg_get_functiondef('logistica.get_operator_preparation_board_v1(uuid)'::regprocedure);
-- Si existiera, capturar su definición y ACL y no usar este rollback ciego.
--
-- DROP sin CASCADE: si algún objeto dependiera de la función, falla y no
-- elimina dependencias no revisadas. El DROP elimina también GRANT/COMMENT.

BEGIN;

DROP FUNCTION IF EXISTS logistica.get_operator_preparation_board_v1(uuid);

COMMIT;
