# Matriz de Seguridad y Exposicion - Inventory Engine Fase 4E

## 1. Arquitectura de seguridad

- Deny-by-default sobre tablas base (RLS sin policies, cero grants directos)
- Acceso exclusivo mediante RPCs SECURITY DEFINER
- Require_permission + require_session_participant en cada operacion
- Validacion de company_id y rol funcional contextual

## 2. RPCs operativas expuestas a authenticated

| RPC | Firma | Operacion | Permiso | Roles contextuales |
|-----|-------|-----------|---------|-------------------|
| reassign_inventory_task | (uuid,uuid,integer,integer,uuid,text,uuid) | inventarios.task.reassign | inventarios.tasks.assign | SUPERVISOR |
| start_inventory_task | (uuid,uuid,integer,uuid) | inventarios.task.start | inventarios.tasks.execute | COUNTER |
| pause_inventory_task | (uuid,uuid,integer,uuid) | inventarios.task.pause | inventarios.tasks.execute | COUNTER,SUPERVISOR |
| resume_inventory_task | (uuid,uuid,integer,uuid) | inventarios.task.resume | inventarios.tasks.execute | COUNTER,SUPERVISOR |
| complete_inventory_task | (uuid,uuid,integer,uuid) | inventarios.task.complete | inventarios.tasks.execute | COUNTER |
| validate_inventory_task | (uuid,uuid,integer,integer,uuid) | inventarios.task.validate | inventarios.tasks.validate | SUPERVISOR |
| invalidate_inventory_task | (uuid,uuid,integer,integer,text,uuid) | inventarios.task.invalidate | inventarios.tasks.validate | SUPERVISOR |
| reopen_inventory_task | (uuid,uuid,integer,integer,text,uuid) | inventarios.task.reopen | inventarios.tasks.validate | SUPERVISOR |
| cancel_inventory_task | (uuid,uuid,integer,integer,text,uuid) | inventarios.task.cancel | inventarios.tasks.cancel | SUPERVISOR,ADMINISTRATOR |
| record_inventory_count | (uuid,uuid,integer,uuid,uuid,jsonb,text,text,text,uuid,text,timestamptz,uuid) | inventarios.count.record | inventarios.counts.record | COUNTER |
| correct_inventory_count | (uuid,uuid,uuid,jsonb,text,text,uuid,text,timestamptz,uuid) | inventarios.count.correct | inventarios.counts.correct | COUNTER,SUPERVISOR |
| invalidate_inventory_count | (uuid,uuid,uuid,text,uuid) | inventarios.count.invalidate | inventarios.counts.correct | COUNTER,SUPERVISOR |
| report_inventory_incident | (uuid,uuid,integer,text,text,text,numeric,uuid,uuid,uuid) | inventarios.incident.report | inventarios.incidents.manage | COUNTER,SUPERVISOR |
| resolve_inventory_incident | (uuid,uuid,text,text,uuid,text,text,uuid) | inventarios.incident.resolve | inventarios.incidents.manage | SUPERVISOR |
| request_inventory_recount | (uuid,uuid,integer,uuid,uuid,text,uuid) | inventarios.recount.request | inventarios.recounts.manage | COUNTER,SUPERVISOR |
| assign_inventory_recount | (uuid,uuid,text,uuid,uuid) | inventarios.recount.assign | inventarios.recounts.manage | SUPERVISOR |
| start_inventory_recount | (uuid,uuid,text,uuid) | inventarios.recount.start | inventarios.recounts.manage | COUNTER |
| record_inventory_recount | (uuid,uuid,text,jsonb,text,text,text,uuid,text,timestamptz,uuid) | inventarios.recount.record | inventarios.recounts.manage | COUNTER |
| complete_inventory_recount | (uuid,uuid,text,uuid) | inventarios.recount.complete | inventarios.recounts.manage | COUNTER |
| cancel_inventory_recount | (uuid,uuid,text,text,uuid) | inventarios.recount.cancel | inventarios.recounts.manage | SUPERVISOR |
| decide_inventory_recount | (uuid,uuid,text,uuid,text,numeric,uuid,uuid) | inventarios.recount.decide | inventarios.recounts.decide | SUPERVISOR |
| approve_inventory_session | (uuid,uuid,uuid) | inventarios.session.approve | inventarios.sessions.approve | MANAGER |

## 3. Helpers internos (sin grants)

require_actor, require_company_access, require_permission, require_session_participant, compute_request_hash, begin_idempotent_operation, complete_idempotent_operation, get_effective_count_entries, get_applicable_recount_decisions, get_effective_task_contributions

## 4. Permisos funcionales existentes

inventarios.counts.record, inventarios.counts.correct, inventarios.incidents.manage, inventarios.recounts.manage, inventarios.recounts.decide, inventarios.recounts.override_assignee, inventarios.sessions.prepare, inventarios.sessions.start, inventarios.sessions.approve, inventarios.zones.manage, inventarios.tasks.assign, inventarios.tasks.execute, inventarios.tasks.validate, inventarios.tasks.reopen, inventarios.tasks.cancel, inventarios.read

## 5. Estado de seguridad

- Tablas: RLS habilitado, cero policies, grants directos revocados
- Secuencias: todos los privilegios revocados
- Esquema: USAGE a authenticated, CREATE revocado
- Default privileges: tablas, secuencias y funciones futuras protegidas
- Anon: sin acceso al esquema ni funciones
- Service_role: sin grants operativos
- RPCs: 23 funciones con GRANT EXECUTE TO authenticated
- Helpers: 10 funciones sin grants

## 6. Asignacion de permisos a portal roles

Pendiente de completar segun mapeo de roles funcionales (session_participants.functional_role) a portal.roles.
