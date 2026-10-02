-- The registered module code is analisis-comercial (hyphenated).
insert into portal.permissions(code, name, description, module_id)
select 'analisis_comercial.control_financiero.manage_expenses',
       'Gestionar Gastos Reconocidos',
       'Permite crear, reconocer y anular gastos financieros.',
       id
from portal.modules
where code = 'analisis-comercial'
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  module_id = excluded.module_id,
  is_active = true;

insert into portal.role_permissions(role_id, permission_id)
select roles.id, permissions.id
from portal.roles roles
cross join portal.permissions permissions
where roles.name in ('FINANZAS', 'GERENCIA', 'SUPER_USUARIO')
  and permissions.code = 'analisis_comercial.control_financiero.manage_expenses'
on conflict do nothing;
