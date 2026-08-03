-- Migration: 20260803092000_inventarios_enable_module.sql
-- Description: Habilita el modulo Inventarios en portal.modules con ruta, icono
--              y orden. No modifica otros modulos.
-- Author: Assistant

INSERT INTO portal.modules (code, name, description, icon, route, sort_order, is_active)
VALUES (
    'inventarios',
    'Inventarios',
    'Jornadas de inventario: creacion, conteo, revision y resultados.',
    'Boxes',
    '/dashboard/inventarios',
    8,
    true
)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    icon = EXCLUDED.icon,
    route = EXCLUDED.route,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active,
    updated_at = pg_catalog.now();
