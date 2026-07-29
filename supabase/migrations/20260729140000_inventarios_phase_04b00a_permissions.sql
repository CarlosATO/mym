-- Inventory Engine phase 04B.0a: idempotent module and permission seed only.

INSERT INTO portal.modules (code, name)
VALUES ('inventarios', 'Inventarios')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name;

INSERT INTO portal.permissions (code, name, module_id)
SELECT permission.code, permission.name, module.id
FROM (
    VALUES
        ('inventarios.read', 'Ver Inventarios'),
        ('inventarios.sessions.prepare', 'Preparar jornadas de inventario'),
        ('inventarios.sessions.start', 'Iniciar jornadas de inventario'),
        ('inventarios.zones.manage', 'Administrar zonas de inventario'),
        ('inventarios.tasks.assign', 'Asignar tareas de inventario'),
        ('inventarios.tasks.execute', 'Ejecutar tareas de inventario'),
        ('inventarios.tasks.validate', 'Validar tareas de inventario'),
        ('inventarios.tasks.reopen', 'Reabrir tareas de inventario'),
        ('inventarios.tasks.cancel', 'Cancelar tareas de inventario'),
        ('inventarios.counts.record', 'Registrar conteos de inventario'),
        ('inventarios.counts.correct', 'Corregir conteos de inventario'),
        ('inventarios.incidents.manage', 'Gestionar incidencias de inventario'),
        ('inventarios.recounts.manage', 'Gestionar reconteos de inventario'),
        ('inventarios.recounts.decide', 'Decidir resultados de reconteo'),
        ('inventarios.recounts.override_assignee', 'Autorizar excepcion de asignacion de reconteo')
) AS permission(code, name)
CROSS JOIN (
    SELECT id
    FROM portal.modules
    WHERE code = 'inventarios'
) AS module
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    module_id = EXCLUDED.module_id;
