# Contratos Operativos - Inventory Engine Fase 04

## 1. Objetivo y alcance

Este documento define contratos de RPC, idempotencia, transiciones de tarea, autorizacion y seguridad para operar las estructuras inmutables de Fases 1-3. No contiene SQL ejecutable ni altera consolidacion, valorizacion, versiones oficiales, exportaciones, conciliacion, UI o Android.

Las RPC canonicas se ubicaran en `inventarios`. El esquema no se expone aun en `api.schemas`; 4E decidira exposicion o wrappers `public` minimos, despues de grants y RLS. Ningun wrapper existe para evadir RLS.

## 2. Principios transaccionales

- Toda mutacion usa `SECURITY DEFINER`, `SET search_path` fijo, objetos calificados, `auth.uid()` y validacion interna de empresa, actor y permiso.
- El cliente nunca es fuente confiable de empresa, actor, estado, ciclo o contexto. La empresa se deriva del recurso bloqueado.
- La RPC bloquea la raiz relevante con `FOR UPDATE`: sesion, tarea, conteo efectivo, incidencia, solicitud o decision vigente.
- Conteos, correcciones, eventos, resoluciones y decisiones se preservan; las sustituciones cierran vigencia mediante RPC.
- Los errores abortan con SQLSTATE controlado, codigo `INV_*`, mensaje publico seguro, `retryable` y metadata no sensible. No exponen SQL, constraints ni datos de otra empresa.

### Respuesta canonica unica

Toda RPC mutadora devuelve exclusivamente un objeto `jsonb` plano con esta estructura:

```json
{
  "operation": "inventarios.nombre_operacion",
  "entity_id": "uuid_o_null",
  "state": "estado_o_null",
  "version": 1,
  "cycle_number": 1,
  "assignment_id": "uuid_o_null",
  "event_id": "uuid_o_null",
  "replayed": false,
  "occurred_at": "timestamptz",
  "data": {}
}
```

Todos los campos principales estan presentes. Los no aplicables son `null`. `data` contiene solo datos adicionales propios de la RPC. `replayed` indica que la operacion ya se proceso. Un replay no cambia version, ciclo, estado, timestamps operacionales, asignaciones ni eventos. `occurred_at` es el instante original y el resultado persistido se reutiliza; logicamente solo se devuelve `replayed: true` sin alterar el resultado almacenado.

### Parametros comunes de tarea

| Parametro | Tipo | Nulo | Regla |
| --- | --- | --- | --- |
| `p_task_id` | uuid | no | tarea objetivo |
| `p_expected_version` | integer | no | debe igualar `tasks.version` |
| `p_expected_cycle` | integer | no | debe igualar el ciclo actual |
| `p_idempotency_key` | uuid | no | clave persistida de la mutacion |
| `p_reason` | text | depende | obligatorio en reasignacion, reapertura, cancelacion e invalidacion |

Ninguna RPC acepta `p_actor_id`, `p_validated_by` o `p_completed_by`: el actor es `auth.uid()`.

## 3. Cambios fisicos obligatorios

### 3.1 Fase 4B.0: idempotencia persistida

**CAMBIO FISICO REQUERIDO EN FASE 4B.0:** crear `inventarios.operation_idempotency` para garantizar ejecucion exactamente una vez desde la perspectiva del cliente, replay del resultado original, deteccion de payload distinto, concurrencia segura y trazabilidad de empresa, actor y operacion.

| Columna | Tipo | Nulo | Regla |
| --- | --- | --- | --- |
| `id` | uuid | no | PK, `gen_random_uuid()` |
| `company_id` | uuid | no | empresa derivada del recurso |
| `operation_code` | text | no | nombre estable de la operacion |
| `idempotency_key` | uuid | no | clave enviada por cliente |
| `actor_id` | uuid | no | usuario de `auth.uid()` |
| `request_hash` | text | no | SHA-256 hexadecimal de 64 caracteres en minusculas del payload canonico |
| `status` | text | no | `DEFAULT 'IN_PROGRESS'`; `IN_PROGRESS` o `COMPLETED` |
| `entity_id` | uuid | si | entidad principal afectada |
| `response_payload` | jsonb | si | envelope original persistido |
| `created_at` | timestamptz | no | `now()` |
| `completed_at` | timestamptz | si | finalizacion de la operacion |

La definicion fisica exacta es `status text NOT NULL DEFAULT 'IN_PROGRESS'`. Constraints requeridos: `status IN ('IN_PROGRESS', 'COMPLETED')`, `request_hash ~ '^[0-9a-f]{64}$'`, y cuando `status = 'COMPLETED'`, `response_payload` y `completed_at` no son nulos. La unicidad es `(company_id, operation_code, idempotency_key)`. La normalizacion del payload produce y guarda el hash en minusculas; no se aceptan hashes en mayusculas.

La identidad, empresa, operacion, clave, actor y hash son inmutables. Solo se permite `IN_PROGRESS -> COMPLETED`; `response_payload` se escribe una vez y nunca se reescribe. La proteccion definitiva se implementa con trigger en 4E.

### 3.2 Fase 4B.2: ciclo, actores y transiciones

**CAMBIO FISICO REQUERIDO EN FASE 4B.2:**

- Cambiar `tasks.validation_cycle DEFAULT 0` por `DEFAULT 1`, exigir `validation_cycle > 0` y normalizar las filas existentes con valor `0` a `1` mediante nueva migracion.
- Cambiar `task_events.cycle DEFAULT 0` por `DEFAULT 1` y exigir `cycle > 0`.
- Agregar `tasks.paused_by uuid NULL REFERENCES portal.users(id) ON DELETE RESTRICT`.
- Agregar `tasks.completed_by uuid NULL REFERENCES portal.users(id) ON DELETE RESTRICT`.
- Agregar checks de coherencia: ambos campos de cada par `paused_at`/`paused_by` y `completed_at`/`completed_by` son nulos o ambos informados.

Los campos `paused_at`, `paused_by`, `completed_at` y `completed_by` son la proyeccion actual o mas reciente. Al reanudar se limpian los campos de pausa; al reabrir se limpian los de finalizacion. Ninguna limpieza borra historia.

**CAMBIO FISICO REQUERIDO EN FASE 4B.2:** crear `inventarios.task_state_transitions` para conservar append-only cada cambio real del estado persistente de una tarea.

| Columna | Tipo | Nulo | Regla |
| --- | --- | --- | --- |
| `id` | uuid | no | PK, `gen_random_uuid()` |
| `company_id`, `session_id`, `session_zone_id`, `task_id` | uuid | no | contexto y FK compuestas de tarea |
| `assignment_id` | uuid | si | asignacion aplicable |
| `operation_idempotency_id` | uuid | no | FK contextual a `operation_idempotency` |
| `transition_type` | text | no | catalogo cerrado |
| `previous_status`, `next_status` | text | no | estados persistentes |
| `previous_version`, `next_version` | integer | no | version antes/despues |
| `previous_cycle`, `next_cycle` | integer | no | ciclo antes/despues |
| `actor_id` | uuid | no | actor autenticado |
| `reason` | text | si | obligatorio al reabrir |
| `occurred_at` | timestamptz | no | `now()` |
| `metadata` | jsonb | no | `'{}'::jsonb` |

`transition_type` admite exclusivamente `STARTED`, `PAUSED`, `RESUMED`, `COMPLETED` y `REOPENED`. Los estados admitidos son `ASSIGNED`, `IN_PROGRESS`, `PAUSED` y `COMPLETED`. La tabla es append-only: no permite `UPDATE` ni `DELETE`.

Reglas: `previous_status <> next_status`; versiones y ciclos son mayores que cero; `next_version = previous_version + 1`; el ciclo solo cambia en `REOPENED`; alli `next_cycle = previous_cycle + 1`; en las demas transiciones `next_cycle = previous_cycle`; `reason` es obligatorio para `REOPENED`; y una operacion idempotente solo crea una transicion.

### 3.3 Fase 4D: vinculo de ejecucion de reconteo

**CAMBIO FISICO REQUERIDO EN FASE 4D:** agregar `recount_requests.execution_task_id uuid NULL`. Identifica inequivocamente la tarea `RECOUNT` que ejecuta la solicitud y es nullable mientras la solicitud este `REQUESTED`.

Debe tener FK contextual con `company_id`, `session_id`, `session_zone_id` y `execution_task_id` hacia la candidate key correspondiente de `inventarios.tasks`, mas unicidad parcial `UNIQUE (company_id, execution_task_id) WHERE execution_task_id IS NOT NULL`. Una tarea RECOUNT no puede ejecutar dos solicitudes.

La RPC valida que la tarea sea `RECOUNT`, comparta empresa, jornada y zona, sea creada para esa solicitud, no este cancelada, invalidada o supersedida, tenga producto y contexto de la solicitud, y no exista otra tarea ejecutora vigente. No basta una FK simple por `id`.

### 3.4 Correccion documental pendiente

`docs/inventarios/MODELO_DATOS_FISICO.md` debe dejar de declarar `PAUSED` y `COMPLETED` como valores de `task_events.event_type`. No se modifica en esta fase documental. El catalogo aplicado y oficial de `task_events` es exclusivamente `STARTED`, `RESUMED`, `REOPENED`, `REASSIGNED`, `VALIDATED`, `INVALIDATED` y `CANCELLED`. `PAUSED` y `COMPLETED` solo son estados de `tasks` y tipos de `task_state_transitions`.

## 4. Idempotencia y concurrencia

Todas las RPC mutadoras de 4B requieren `p_idempotency_key uuid NOT NULL` y usan idempotencia persistida: `prepare_inventory_session`, `start_inventory_session`, `create_session_zone`, `assign_inventory_task`, `reassign_inventory_task`, `start_inventory_task`, `pause_inventory_task`, `resume_inventory_task`, `complete_inventory_task`, `validate_inventory_task`, `invalidate_inventory_task`, `reopen_inventory_task` y `cancel_inventory_task`. No usan `STATE_BASED_REPLAY`.

La primera ejecucion ocurre en una unica transaccion: deriva empresa y actor, construye payload, calcula `request_hash`, inserta `IN_PROGRESS`, ejecuta la operacion, guarda el envelope original en `response_payload`, cambia a `COMPLETED` y confirma. Si falla, toda la transaccion hace rollback y no deja fila confirmada.

Una ejecucion concurrente con igual `(company_id, operation_code, idempotency_key)` espera la resolucion del bloqueo de unicidad. Si la primera confirma, vuelve a consultar la fila con bloqueo: mismo actor, hash y `COMPLETED` devuelve el envelope original con solo `replayed: true`; actor o hash distintos devuelven `INV_IDEMPOTENCY_CONFLICT`. Si la primera hace rollback, no existe fila y la segunda inserta su propia operacion.

Una fila confirmada `IN_PROGRESS` no es resultado normal, pero tiene conducta defensiva: tras adquirir el bloqueo, mismo actor y hash abortan con `INV_IDEMPOTENCY_IN_PROGRESS`, reintentable, mensaje seguro `La operacion todavia esta siendo procesada. Intenta nuevamente.`; actor o hash distintos devuelven `INV_IDEMPOTENCY_CONFLICT`. No hay polling interno, ciclos de espera, `pg_sleep`, envelope incompleto ni reutilizacion de una fila `IN_PROGRESS`.

El payload canonico incluye operacion, recurso objetivo, empresa derivada, actor autenticado, version y ciclo esperados, participante o usuario objetivo cuando corresponda, motivo normalizado y parametros funcionales especificos. Antes del hash se ordenan claves JSON, UUID se convierten a minusculas, textos reciben `trim`, cadenas opcionales vacias se vuelven `null`, se conserva la diferencia entre `null`, cero y `false`, y las fechas recibidas usan ISO 8601 UTC. Excluye timestamps generados por servidor, `occurred_at` y el resultado. El SHA-256 resultante se representa y guarda exclusivamente como hexadecimal de 64 caracteres en minusculas.

Para conteos de 4C, `offline_id` conserva su unicidad por `(company_id, offline_id)`. Su payload canonico incluye empresa derivada, sesion, snapshot, zona, tarea, ciclo, participante, producto, ubicacion, solicitud de reconteo opcional, cantidades, origen, dispositivo y captura local; excluye orden JSON, valores generados y timestamps posteriores.

Las transiciones bloquean la tarea y comparan version/ciclo. Inicio, reanudacion y reapertura adquieren primero un `pg_advisory_xact_lock` determinista y namespaced por empresa y usuario, luego bloquean tarea y asignacion vigente y verifican otra tarea activa. La violacion residual de `uq_inventarios_tasks_active_user` se traduce a `INV_CONCURRENT_MODIFICATION`.

## 5. Roles y autorizacion

Los roles funcionales son `COUNTER`, `SUPERVISOR`, `ADMINISTRATOR` y `MANAGER`. Su mapeo a roles globales y permisos `inventarios.*` pertenece a 4B.0 y 4E.

| Rol | Puede operar | Nunca directamente |
| --- | --- | --- |
| `ADMINISTRATOR` | preparar jornada, zonas, participantes, asignar y cancelar | consolidar, aprobar, exportar o cambiar stock |
| `SUPERVISOR` | reasignar, validacion estructural, reapertura, incidencias y reconteos | editar cantidades historicas o aprobar resultado oficial |
| `COUNTER` | tarea asignada, conteos e incidencias de contexto | validar, reasignar, decidir reconteos, stock o costos |
| `MANAGER` | lectura autorizada | escritura operativa |
| `service_role` | mantenimiento tecnico controlado | suplantar `auth.uid()` o auditoria funcional |

El seed 4B.0a usa las estructuras existentes `portal.modules(code, name, description, icon, route, is_active, sort_order)` y `portal.permissions(code, name, description, module_id, is_active)`. Las claves naturales unicas aplicadas son `portal.modules.code` y `portal.permissions.code`.

El modulo usa `code = 'inventarios'` y `name = 'Inventarios'`. Su upsert es `ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`: crea o reutiliza una unica fila, corrige solo el nombre visible y no modifica otras columnas ni genera duplicados.

| Codigo | Nombre visible |
| --- | --- |
| `inventarios.read` | Ver Inventarios |
| `inventarios.sessions.prepare` | Preparar jornadas de inventario |
| `inventarios.sessions.start` | Iniciar jornadas de inventario |
| `inventarios.zones.manage` | Administrar zonas de inventario |
| `inventarios.tasks.assign` | Asignar tareas de inventario |
| `inventarios.tasks.execute` | Ejecutar tareas de inventario |
| `inventarios.tasks.validate` | Validar tareas de inventario |
| `inventarios.tasks.reopen` | Reabrir tareas de inventario |
| `inventarios.tasks.cancel` | Cancelar tareas de inventario |
| `inventarios.counts.record` | Registrar conteos de inventario |
| `inventarios.counts.correct` | Corregir conteos de inventario |
| `inventarios.incidents.manage` | Gestionar incidencias de inventario |
| `inventarios.recounts.manage` | Gestionar reconteos de inventario |
| `inventarios.recounts.decide` | Decidir resultados de reconteo |
| `inventarios.recounts.override_assignee` | Autorizar excepción de asignación de reconteo |

Cada permiso resuelve `module_id` mediante `portal.modules.code = 'inventarios'` sin UUID fijo. Su upsert es `ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, module_id = EXCLUDED.module_id`: conserva el `id`, corrige solo nombre y modulo, no borra asignaciones ni modifica otras columnas.

4B.0a no inserta ni actualiza `portal.role_permissions` o `portal.user_permissions`, no amplia roles ni asigna usuarios, no crea roles, no elimina asignaciones y no modifica `portal.has_permission`. El bypass existente de `portal.has_permission('system.admin')` se conserva; la asignacion futura a roles de Inventarios sera explicita y controlada.

Toda RPC deriva empresa del recurso, valida `core.has_company_access(auth.uid(), company_id)` y luego `portal.has_permission(...)`. `system.admin` puede omitir permiso funcional, nunca estado de jornada, aislamiento multiempresa, contexto de tarea, ciclos, asignaciones ni concurrencia. Ejecutar tareas exige adicionalmente participante activo asociado a `auth.uid()` y asignacion vigente. `service_role` es tecnico, no actor operativo. Un `company_id` recibido solo se compara contra el recurso; no se confia en el.

## 6. Catalogo de RPC 4B

| RPC | Proposito | Actor | Precondicion principal |
| --- | --- | --- | --- |
| `prepare_inventory_session` | preparar alcance, snapshot, zonas y participantes | administrador | jornada DRAFT/PREPARED |
| `start_inventory_session` | confirmar snapshot e iniciar | administrador | jornada PREPARED |
| `create_session_zone` | crear zona y membresia V1 atomica | administrador | scope INCLUDED |
| `assign_inventory_task` | crear/asignar PRIMARY o RECOUNT | administrador/supervisor | participante activo |
| `reassign_inventory_task` | cerrar asignacion vigente y abrir otra sin cambiar estado | supervisor | ASSIGNED, IN_PROGRESS o PAUSED |
| `start_inventory_task` | ASSIGNED a IN_PROGRESS | contador asignado | zona confirmada |
| `pause_inventory_task` | IN_PROGRESS a PAUSED | contador asignado/supervisor | tarea activa |
| `resume_inventory_task` | PAUSED a IN_PROGRESS | contador asignado/supervisor | asignacion vigente |
| `complete_inventory_task` | IN_PROGRESS a COMPLETED | contador asignado | tarea activa |
| `validate_inventory_task` | validacion acumulativa, sin consolidar | supervisor | capa aplicable completada |
| `invalidate_inventory_task` | invalidar validacion vigente, sin reabrir | supervisor | COMPLETED validada |
| `reopen_inventory_task` | reabrir e iniciar un nuevo ciclo | supervisor | COMPLETED |
| `cancel_inventory_task` | cancelar conservando historia | administrador/supervisor | ASSIGNED o PAUSED |

Firmas de tarea: reasignar, pausar, reanudar, completar, validar, invalidar, reabrir y cancelar incluyen `p_task_id`, `p_expected_version`, `p_expected_cycle` y `p_idempotency_key`. Reasignar incluye `p_new_user_id` y motivo; invalidar, reabrir y cancelar incluyen motivo. El inicio usa la firma especifica de la seccion 6.1. Toda firma retorna el envelope canonico.

### 6.1 Inicio de tarea asignada

La primera RPC operacional es `inventarios.start_inventory_task(p_company_id uuid, p_task_id uuid, p_expected_version integer, p_idempotency_key uuid) RETURNS jsonb`. Los cuatro parametros son obligatorios; la empresa se contrasta contra la tarea bloqueada. No acepta actor, asignacion, estado ni ciclo desde cliente. Su codigo de idempotencia es `inventarios.task.start` y su payload funcional exacto es `{"operation":"inventarios.task.start","company_id":"uuid","task_id":"uuid","expected_version":1}`.

La RPC valida `inventarios.tasks.execute`, adquiere `pg_advisory_xact_lock(hashtext('inventarios.start_inventory_task'), hashtext(company_id::text || ':' || actor_id::text))`, y solo permite una tarea `ASSIGNED` con version esperada. El actor debe ser el participante `COUNTER` vigente de la jornada y coincidir con la asignacion vigente de la tarea. Tarea ausente retorna `INV_NOT_FOUND`, estado distinto retorna `INV_TASK_INVALID_STATE`, version distinta retorna `INV_CONCURRENT_MODIFICATION`, y asignacion de otro actor retorna `INV_ASSIGNMENT_REQUIRED`.

Con un unico `occurred_at`, inicio actualiza exclusivamente `status = 'IN_PROGRESS'`, `version = version + 1`, `opened_at`, `active_user_id`, `updated_at` y `updated_by`; conserva ciclo, pausa y finalizacion. Inserta un evento `STARTED` y una transicion `ASSIGNED -> IN_PROGRESS`, ambos con el ciclo vigente. `task_events` no tiene `assignment_id` ni lo serializa en metadata tecnica; la asignacion queda estructurada en `task_state_transitions` y el envelope. La funcion se crea como `SECURITY DEFINER`, propietaria `postgres`, con `search_path = pg_catalog`, sin `EXECUTE` para `PUBLIC`, `anon`, `authenticated` ni `service_role`; la exposicion autenticada queda para 4E.

### 6.2 Finalizacion de tarea

`inventarios.complete_inventory_task(p_company_id uuid, p_task_id uuid, p_expected_version integer, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.task.complete` y el payload funcional `{"operation":"inventarios.task.complete","company_id":"uuid","task_id":"uuid","expected_version":4}`. Exige `inventarios.tasks.execute`, participante `COUNTER`, asignacion vigente y tarea `IN_PROGRESS` con version esperada; no agrega prerrequisitos de conteos, incidencias, reconteos, validacion ni consolidacion.

Con un unico instante actualiza exclusivamente `status = 'COMPLETED'`, `version = version + 1`, `completed_at`, `completed_by`, limpia `active_user_id`, e informa `updated_at` y `updated_by`. Conserva `opened_at`, ciclo y pausa. Inserta solo la transicion `IN_PROGRESS -> COMPLETED`; no crea `task_events` y el envelope tiene `event_id: null`. Usa el lock `pg_advisory_xact_lock(hashtext('inventarios.complete_inventory_task'), hashtext(company_id::text || ':' || actor_id::text))` y mantiene la ACL operacional aplazada a 4E.

### 6.3 Validacion de tarea completada

`inventarios.validate_inventory_task(p_company_id uuid, p_task_id uuid, p_expected_version integer, p_expected_cycle integer, p_idempotency_key uuid) RETURNS jsonb` usa `inventarios.task.validate`, permiso `inventarios.tasks.validate` y participante `SUPERVISOR`. Exige tarea `COMPLETED`, version y ciclo esperados. Su lock es por empresa/tarea: `pg_advisory_xact_lock(hashtext('inventarios.validate_inventory_task'), hashtext(company_id::text || ':' || task_id::text))`.

La validacion vigente existe solo si `current_validation_event_id` apunta a un `task_events` `VALIDATED` de la misma empresa, jornada, tarea y ciclo. Un puntero nulo permite validar; uno valido retorna `INV_OPERATION_ALREADY_APPLIED`; uno inconsistente retorna `INV_CONCURRENT_MODIFICATION`. La validacion inserta un unico `VALIDATED`, actualiza el puntero, `validated_at`, `validated_by`, version y auditoria, y no cambia estado, ciclo, asignacion ni crea transicion. Futuras operaciones `INVALIDATED` y `REOPENED` limpian el puntero y proyecciones de validacion sin borrar historia.

### 6.4 Invalidacion de validacion vigente

`inventarios.invalidate_inventory_task(p_company_id uuid, p_task_id uuid, p_expected_version integer, p_expected_cycle integer, p_reason text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.task.invalidate`, permiso `inventarios.tasks.validate` y participante `SUPERVISOR`. Exige tarea `COMPLETED`, version y ciclo esperados, y serializa por empresa/tarea con `pg_advisory_xact_lock(hashtext('inventarios.invalidate_inventory_task'), hashtext(company_id::text || ':' || task_id::text))`.

`p_reason` se normaliza con `btrim`, es obligatorio y debe tener entre 5 y 500 caracteres; entradas invalidas retornan `INV_INVALID_REQUEST_PAYLOAD`. El payload idempotente contiene solo operacion, empresa, tarea, version esperada, ciclo esperado y motivo normalizado. Un replay retorna el envelope persistido con solo `replayed: true`; la misma clave con un payload distinto retorna `INV_IDEMPOTENCY_CONFLICT`.

La fuente de verdad es `current_validation_event_id`. Un puntero nulo retorna `INV_TASK_NOT_VALIDATED`; un puntero o proyeccion incoherente retorna `INV_CONCURRENT_MODIFICATION` reintentable. La RPC conserva `COMPLETED` y el mismo ciclo, inserta un unico evento `INVALIDATED` con metadata `{"invalidated_validation_event_id":"uuid","reason":"texto"}`, limpia `current_validation_event_id`, `validated_at` y `validated_by`, incrementa `version` y actualiza auditoria. No elimina el evento `VALIDATED`, no crea `task_state_transitions` y deja la tarea fuera de consolidaciones que exijan validacion vigente. Puede validarse nuevamente en el mismo ciclo.

### 6.5 Reapertura e inicio de nuevo ciclo

`inventarios.reopen_inventory_task(p_company_id uuid, p_task_id uuid, p_expected_version integer, p_expected_cycle integer, p_reason text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.task.reopen`, permiso `inventarios.tasks.validate` y participante `SUPERVISOR`. Exige tarea `COMPLETED`, version y ciclo esperados, y serializa por empresa/tarea con `pg_advisory_xact_lock(hashtext('inventarios.reopen_inventory_task'), hashtext(company_id::text || ':' || task_id::text))`.

El motivo se normaliza con `btrim`, es obligatorio y debe tener entre 5 y 500 caracteres. La RPC conserva exactamente una asignacion vigente, obtiene su usuario y lo establece como `active_user_id`; el supervisor es el actor del evento, de la transicion y de la auditoria, sin necesidad de ser el contador asignado. El payload idempotente contiene solo operacion, empresa, tarea, version esperada, ciclo esperado y motivo normalizado; el replay retorna el envelope persistido con solo `replayed: true`.

La validacion vigente es opcional. Si existe, su puntero y proyeccion deben ser coherentes con un evento `VALIDATED` contextual; si no, retorna `INV_CONCURRENT_MODIFICATION`. La reapertura incrementa `validation_cycle`, inserta un unico evento `REOPENED` y una transicion `COMPLETED -> IN_PROGRESS` en el nuevo ciclo, y no inserta `STARTED`. Limpia validacion, pausa y finalizacion anteriores; establece `opened_at` al instante de reapertura y deja la tarea en `IN_PROGRESS`. El metadata del evento contiene solo `previous_cycle`, `previous_validation_event_id` y `reason`; no se modifica la asignacion ni se elimina historia.

### 6.6 Reasignacion operativa

`inventarios.reassign_inventory_task(p_company_id uuid, p_task_id uuid, p_expected_version integer, p_expected_cycle integer, p_new_user_id uuid, p_reason text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.task.reassign`, permiso `inventarios.tasks.assign` y participante `SUPERVISOR`. Exige tarea `ASSIGNED`, `IN_PROGRESS` o `PAUSED`, version y ciclo esperados, y serializa por empresa/tarea con `pg_advisory_xact_lock(hashtext('inventarios.reassign_inventory_task'), hashtext(company_id::text || ':' || task_id::text))`.

El nuevo responsable debe ser un usuario activo, no eliminado, con acceso activo a la empresa y participante `COUNTER` vigente de la misma jornada. La RPC bloquea y cierra la asignacion vigente, crea una nueva asignacion vigente y actualiza `current_assignment_id`. Reasignar al mismo usuario retorna `INV_TASK_ALREADY_ASSIGNED`; el motivo se normaliza con `btrim` y debe tener entre 5 y 500 caracteres.

La reasignacion conserva estado y ciclo. Si la tarea esta `IN_PROGRESS`, `active_user_id` cambia al nuevo contador; en `ASSIGNED` y `PAUSED` queda `null`. Inserta un unico evento `REASSIGNED` con metadata `{"previous_assignment_id":"uuid","previous_user_id":"uuid","new_assignment_id":"uuid","new_user_id":"uuid","reason":"texto"}` y no inserta `task_state_transitions`: `REASSIGNED` es un evento operativo, no una transicion de estado.

### 6.7 Cancelacion terminal de tarea

`inventarios.cancel_inventory_task(p_company_id uuid, p_task_id uuid, p_expected_version integer, p_expected_cycle integer, p_reason text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.task.cancel`, permiso `inventarios.tasks.cancel` y participante vigente `SUPERVISOR` o `ADMINISTRATOR` de la jornada. Exige tarea `ASSIGNED` o `PAUSED`, version y ciclo esperados, jornada `DRAFT`, `PREPARED`, `COUNTING` o `UNDER_REVIEW`, y una asignacion vigente coherente con `current_assignment_id`. No admite `IN_PROGRESS`, `COMPLETED`, jornadas aprobadas o posteriores, ni jornadas canceladas.

El motivo se normaliza con `btrim`, es obligatorio y debe tener entre 5 y 500 caracteres. El payload idempotente contiene solo operacion, empresa, tarea, version esperada, ciclo esperado y motivo normalizado. Un replay retorna el envelope persistido con solo `replayed: true`; una clave reutilizada con payload distinto retorna `INV_IDEMPOTENCY_CONFLICT`.

`CANCELLED` es un evento y una proyeccion terminal mediante `tasks.cancelled_at` y `tasks.cancelled_by`; no es un estado persistente de `tasks`. La operacion conserva estado y ciclo, libera la asignacion vigente con el motivo, limpia `current_assignment_id` y `active_user_id`, incrementa version e inserta un unico evento `CANCELLED` con `reason` y metadata `{"previous_assignment_id":"uuid","previous_user_id":"uuid"}`. No crea `task_state_transitions`. Una tarea ya cancelada con una nueva clave retorna `INV_TASK_ALREADY_CANCELLED`; una proyeccion de cancelacion incoherente retorna `INV_CONCURRENT_MODIFICATION`.

Las consultas y operaciones de tareas activas deben exigir `cancelled_at IS NULL`. Aunque conserva su estado historico, una tarea cancelada no puede volver a operar: inicio, reanudacion y reasignacion requieren asignacion vigente y `current_assignment_id` coherente, que la cancelacion elimina. Cualquier operacion futura de asignacion tambien debe exigir `tasks.cancelled_at IS NULL`. La cancelacion no se confunde con `INVALIDATED`, `REOPENED` ni `REASSIGNED`; `REOPENED` sigue exigiendo `COMPLETED`.

### 6.8 Registro append-only de conteo

`inventarios.record_inventory_count(p_company_id uuid, p_task_id uuid, p_expected_cycle integer, p_snapshot_product_id uuid, p_snapshot_location_id uuid, p_quantities jsonb, p_identification_method text, p_scanned_code text, p_capture_source text, p_offline_id uuid, p_device_id text, p_captured_at timestamptz, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.count.record`, permiso `inventarios.counts.record` y participante `COUNTER` vigente. Exige tarea `IN_PROGRESS`, ciclo esperado, tarea no cancelada, asignacion vigente coherente y `active_user_id` igual al actor autenticado.

`p_quantities` debe ser un objeto JSON con exactamente cinco claves numericas: `available_quantity`, `damaged_quantity`, `expired_quantity`, `blocked_quantity` y `other_unavailable_quantity`. La funcion calcula `physical_quantity` como la suma de las cinco categorias. No se acepta `physical_quantity` desde el cliente. Todas las cantidades son `numeric(14,3)` no negativas.

`p_capture_source` admite `MOBILE` o `WEB`. Para `MOBILE`, `p_offline_id` y `p_device_id` son obligatorios, `p_captured_at` debe ser informado, y `p_idempotency_key` debe ser igual a `p_offline_id`. Para `WEB`, `p_captured_at` puede ser nulo (se usa el timestamp del servidor).

La RPC bloquea la tarea y la asignacion vigente con `FOR SHARE`, no `FOR UPDATE`. Usa advisory lock namespaced por empresa y `p_idempotency_key` para concurrencia fina. No incrementa `tasks.version`, no modifica la tarea, no crea `task_events` ni `task_state_transitions`. Inserta una unica fila append-only en `count_entries`. Un mismo `offline_id` no puede reutilizarse; una repeticion tecnica con la misma `p_idempotency_key` devuelve replay.

### 6.9 Correccion append-only de conteo

`inventarios.correct_inventory_count(p_company_id uuid, p_root_count_entry_id uuid, p_expected_current_count_entry_id uuid, p_quantities jsonb, p_reason text, p_capture_source text, p_offline_id uuid, p_device_id text, p_captured_at timestamptz, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.count.correct`, permiso `inventarios.counts.correct` y dos modalidades:

Modalidad COUNTER: `task.status = IN_PROGRESS` y `session.status = COUNTING`. El actor debe ser participante `COUNTER` vigente y responsable asignado de la tarea. Modalidad SUPERVISOR: `task.status = COMPLETED` y `session.status = UNDER_REVIEW`, sin validacion vigente (`current_validation_event_id IS NULL`). El actor debe ser participante `SUPERVISOR` vigente. No se admite tarea cancelada, ciclo historico, raiz invalidada ni sesion posterior a `COUNTING`/`UNDER_REVIEW`.

Crea un nuevo `count_entry` de reemplazo con cantidades corregidas, contexto heredado de la raiz e identificacion heredada del aporte efectivo. La correccion activa anterior (si existe) se supersede. Cada correccion genera una `count_entry_correction` con `revision_number` secuencial. No actualiza ninguna fila de `count_entries` existente, no modifica `tasks.version`, no invalida la raiz ni el aporte previo, y no crea eventos ni transiciones. Para cada raiz existe como maximo una correccion activa (`superseded_at IS NULL`).

### 6.10 Invalidacion terminal de aporte

`inventarios.invalidate_inventory_count(p_company_id uuid, p_root_count_entry_id uuid, p_expected_current_count_entry_id uuid, p_reason text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.count.invalidate`, permiso `inventarios.counts.correct` y dos modalidades. No crea reemplazo, no modifica la correccion activa, no crea `count_entry_correction`.

Modalidad COUNTER: `task.status = IN_PROGRESS` y `session.status = COUNTING`. El actor debe ser participante `COUNTER` vigente y responsable asignado. Modalidad SUPERVISOR: `task.status = COMPLETED` y `session.status = UNDER_REVIEW`, sin validacion vigente. El actor debe ser participante `SUPERVISOR` vigente.

Invalida exclusivamente el aporte efectivo actual de la raiz. La correccion activa permanece vigente apuntando al aporte invalidado, lo que evita que reaparezcan la raiz o reemplazos intermedios. La futura consolidacion debe excluir el candidate si `invalidated_at IS NOT NULL`. No se permite correccion posterior sobre la misma raiz. `INV_COUNT_ALREADY_INVALIDATED` si el aporte ya fue invalidado.

### 6.11 Reporte WEB de incidentes de inventario

`inventarios.report_inventory_incident(p_company_id uuid, p_task_id uuid, p_expected_cycle integer, p_category_code text, p_severity text, p_description text, p_affected_quantity numeric, p_snapshot_product_id uuid, p_count_entry_id uuid, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.incident.report`, permiso `inventarios.incidents.manage` y dos modalidades.

Modalidad COUNTER: `task.status = IN_PROGRESS`, `session.status = COUNTING`, actor `COUNTER` vigente y asignado. Modalidad SUPERVISOR: `task.status = COMPLETED`, `session.status = UNDER_REVIEW`, sin validacion vigente, actor `SUPERVISOR` vigente.

`p_category_code` admite `UNKNOWN_PRODUCT_CODE`, `EXPECTED_PRODUCT_NOT_FOUND`, `PRODUCT_LOCATION_MISMATCH`, `UNKNOWN_LOCATION`, `DAMAGED_PRODUCT`, `EXPIRED_PRODUCT`, `BLOCKED_PRODUCT`, `QUANTITY_DISCREPANCY`, `LABEL_OR_BARCODE_ISSUE` y `OPERATIONAL_ISSUE`. `p_severity` admite `INFORMATIONAL`, `OPERATIONAL`, `CRITICAL` y `BLOCKING`; la RPC deriva `is_blocking` automaticamente desde `BLOCKING`. `p_snapshot_product_id` y `p_count_entry_id` son opcionales y mutuamente excluyentes como entrada; ciertas categorias exigen producto. La RPC no acepta parametros MOBILE, no modifica tareas ni conteos, y establece `status = OPEN`. Incidentes con `is_blocking = true` deberan impedir completar, validar o aprobar la tarea en fases posteriores.

### 6.12 Resolucion de incidentes (revision, resolucion y cierre)

`inventarios.resolve_inventory_incident(p_company_id uuid, p_incident_id uuid, p_next_status text, p_expected_current_status text, p_expected_current_resolution_id uuid, p_resolution_type text, p_description text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.incident.resolve`, permiso `inventarios.incidents.manage` y rol `SUPERVISOR`. Requiere `task.status = COMPLETED`, `session.status = UNDER_REVIEW` y ausencia de validacion vigente.

Matriz contractual: OPEN→UNDER_REVIEW, OPEN→RESOLVED, UNDER_REVIEW→RESOLVED, RESOLVED→CLOSED. Prohibidas: OPEN→CLOSED, UNDER_REVIEW→CLOSED, reapertura y transiciones al mismo estado.

`p_resolution_type` es obligatorio para RESOLVED con catalogo fijo (`COUNT_CORRECTED`, `COUNT_INVALIDATED`, `RECOUNT_REQUESTED`, `PRODUCT_IDENTIFIED`, `LOCATION_CONFIRMED`, `DISMISSED`, `NO_ACTION_REQUIRED`, `OTHER`). UNDER_REVIEW usa `REVIEW_STARTED` y CLOSED usa `CLOSURE_CONFIRMED`, ambos derivados automaticamente. `p_expected_current_resolution_id` debe ser NULL para OPEN y no nulo para UNDER_REVIEW o RESOLVED.

La RPC bloquea el incidente y la resolucion vigente con `FOR UPDATE`, inserta una nueva `incident_resolution`, supersede la anterior, actualiza `incidents.status` y asigna `responsible_user_id` solo en la primera transicion desde OPEN. No modifica `is_blocking`, `severity`, tareas ni conteos. `CLOSED` es terminal.

### 6.13 Solicitud de recuento por producto

`inventarios.request_inventory_recount(p_company_id uuid, p_task_id uuid, p_expected_cycle integer, p_snapshot_product_id uuid, p_source_count_entry_id uuid, p_reason text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.recount.request`, permiso `inventarios.recounts.manage` y dos modalidades.

Modalidad COUNTER: `task.status = IN_PROGRESS`, `session.status = COUNTING`, actor `COUNTER` vigente y asignado. Modalidad SUPERVISOR: `task.status = COMPLETED`, `session.status = UNDER_REVIEW`, sin validacion vigente, actor `SUPERVISOR` vigente.

`snapshot_product_id` es obligatorio y debe pertenecer al snapshot de la jornada. `source_count_entry_id` es opcional y debe coincidir contextualmente. El motivo es obligatorio (5-1000 caracteres). La RPC asigna ordinal correlativo por producto y zona y rechaza solicitudes activas duplicadas mediante `INV_RECOUNT_ALREADY_REQUESTED`. No modifica la tarea, no incrementa `validation_cycle` ni ejecuta el recuento. La ejecucion queda para Fase 4D.

### 6.14 Asignacion de solicitud de recuento

`inventarios.assign_inventory_recount(p_company_id uuid, p_recount_request_id uuid, p_expected_status text, p_counter_user_id uuid, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.recount.assign`, permiso `inventarios.recounts.manage` y rol `SUPERVISOR`. Requiere `task.status = COMPLETED`, `session.status = UNDER_REVIEW`, ausencia de validacion vigente y `expected_status = REQUESTED`.

Asigna un `COUNTER` vigente de la misma jornada. La solicitud pasa a `ASSIGNED`. No reasigna: cambiar de contador requiere cancelar y crear una nueva solicitud. No modifica `task_assignments`, tarea, ciclo ni jornada. `assignment_id` superior del envelope es `null`.

### 6.15 Inicio de solicitud de recuento

`inventarios.start_inventory_recount(p_company_id uuid, p_recount_request_id uuid, p_expected_status text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.recount.start`, permiso `inventarios.recounts.manage` y `expected_status = ASSIGNED`. El actor debe ser `assigned_user_id` de la solicitud y el participante asignado debe continuar vigente como `COUNTER`. Requiere `task.status = COMPLETED`, `session.status = UNDER_REVIEW`, tarea no cancelada y sin validacion vigente. La solicitud pasa de `ASSIGNED` a `IN_PROGRESS`. No modifica la tarea, el ciclo, la jornada ni la asignacion. No registra capturas.

### 6.16 Captura de recuento

`inventarios.record_inventory_recount(p_company_id uuid, p_recount_request_id uuid, p_expected_status text, p_quantities jsonb, p_identification_method text, p_scanned_code text, p_capture_source text, p_offline_id uuid, p_device_id text, p_captured_at timestamptz, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.recount.record`, permiso `inventarios.recounts.manage` y `expected_status = IN_PROGRESS`. El actor debe ser `assigned_user_id` de la solicitud y `COUNTER` vigente. Requiere `task.status = COMPLETED`, `session.status = UNDER_REVIEW`.

El contexto (sesion, snapshot, zona, producto, tarea, ciclo) se hereda de la solicitud. `snapshot_location_id` se deriva de la zona. `bsale_variant_id` se deriva del producto snapshot. Captura append-only con las mismas cinco cantidades y reglas WEB/MOBILE de `record_inventory_count`. `captured_at` no puede ser anterior a `started_at` de la solicitud. No modifica `recount_requests`, tarea ni ciclo. Multiples capturas permitidas.

### 6.17 Finalizacion de solicitud de recuento

`inventarios.complete_inventory_recount(p_company_id uuid, p_recount_request_id uuid, p_expected_status text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.recount.complete`, permiso `inventarios.recounts.manage` y `expected_status = IN_PROGRESS`. El actor debe ser `assigned_user_id` y `COUNTER` vigente. Requiere `task.status = COMPLETED`, `session.status = UNDER_REVIEW`.

Valida que todas las capturas vinculadas compartan contexto coherente, aplica la cadena de correcciones para derivar el candidate efectivo de cada raiz, y exige al menos un candidate no invalidado (`INV_RECOUNT_NO_COUNTS` en caso contrario). `completed_at` se registra con timestamp servidor. La solicitud pasa a `COMPLETED`. No modifica capturas, tarea, ciclo ni jornada. No crea `recount_decision`. `COMPLETED` es terminal para la ejecucion; la decision definitiva corresponde a 4C.5B.

### 6.18 Cancelacion de solicitud de recuento

`inventarios.cancel_inventory_recount(p_company_id uuid, p_recount_request_id uuid, p_expected_status text, p_reason text, p_idempotency_key uuid) RETURNS jsonb` usa el codigo `inventarios.recount.cancel`, permiso `inventarios.recounts.manage` y rol `SUPERVISOR` vigente. Acepta `expected_status = REQUESTED`, `ASSIGNED` o `IN_PROGRESS`. Requiere `session.status = COUNTING` o `UNDER_REVIEW`. `source_task` se valida solo contextualmente, sin exigir estado ni ciclo actual.

`cancellation_reason` obligatorio (5-1000 caracteres). Conserva asignacion, `started_at` y capturas vinculadas. No invalida capturas ni crea decisiones. `CANCELLED` es terminal. Una nueva solicitud para el mismo producto y zona queda permitida. `COMPLETED` no puede cancelarse.

## 7. Maquina de estados y auditoria

La tarea sigue `ASSIGNED -> IN_PROGRESS -> PAUSED -> IN_PROGRESS -> COMPLETED`. La reapertura inicia inmediatamente el nuevo ciclo con `COMPLETED -> IN_PROGRESS`; no crea un estado `REOPENED` ni un evento `STARTED` adicional. La reasignacion se permite en `ASSIGNED`, `IN_PROGRESS` y `PAUSED` sin cambiar estado; no se cancela desde `IN_PROGRESS`: primero se pausa. Cada mutacion exitosa de asignacion, reasignacion, inicio, pausa, reanudacion, finalizacion, validacion, reapertura o cancelacion incrementa `tasks.version` exactamente una vez. Solo reapertura incrementa ciclo.

| Transicion | `task_state_transitions` | `task_events` |
| --- | --- | --- |
| Inicio | `STARTED` | `STARTED` |
| Pausa | `PAUSED` | ninguno |
| Reanudacion | `RESUMED` | `RESUMED` |
| Finalizacion | `COMPLETED` | ninguno |
| Reapertura | `REOPENED` | `REOPENED` |
| Reasignacion | ninguno | `REASSIGNED` |
| Invalidacion | ninguno | `INVALIDATED` |
| Cancelacion | ninguno | `CANCELLED` |

`task_state_transitions` audita el estado persistente. `task_events` conserva los hechos funcionales aprobados en Fase 2. No son estructuras intercambiables y no se agregan `PAUSED` ni `COMPLETED` a `task_events.event_type`.

La reapertura exige tarea `COMPLETED`, permiso `inventarios.tasks.validate`, participante `SUPERVISOR`, version y ciclo coincidentes, y exactamente una asignacion vigente. La validacion vigente puede estar ausente; si existe, su puntero y proyeccion deben ser coherentes. Conserva la asignacion, incrementa ciclo, crea un evento `REOPENED` y una transicion `COMPLETED -> IN_PROGRESS`, limpia validacion, pausa y finalizacion, establece el usuario asignado como activo y deja la tarea `IN_PROGRESS`. No crea asignacion, no elimina historia y no inserta `STARTED`.

## 8. Validacion acumulativa de tarea

### Fase 4B.2: validacion estructural interna

`validate_inventory_task` comprueba exclusivamente actor autenticado, acceso empresarial, `inventarios.tasks.validate`, tarea existente, version/ciclo esperados, estado `COMPLETED`, ausencia de cancelacion, invalidacion o supersesion, `active_user_id IS NULL`, ausencia de asignacion vigente, ausencia de otra validacion vigente, coherencia de timestamps/ciclo y ausencia de transicion concurrente.

La funcion puede existir internamente en 4B.2, pero no recibe exposicion operacional definitiva antes de 4C y 4D: sin `EXECUTE` operacional a `authenticated` ni wrapper publico. La autorizacion operacional definitiva pertenece a 4E.

### Fase 4C: endurecimiento por conteos e incidencias

Se agregan existencia de conteos efectivos del ciclo, ausencia de ramas de correccion inconsistentes, ausencia de conteos efectivos invalidados, cantidades estructuralmente validas, incidencias `BLOCKING` no resueltas, incidencias `CRITICAL` no tratadas segun contrato y ausencia de modificaciones concurrentes de conteos o incidencias.

### Fase 4D: endurecimiento por reconteos

Se agregan reconteos obligatorios completados, ausencia de solicitudes vigentes `REQUESTED`, `ASSIGNED` o `IN_PROGRESS`, decision supervisora vigente cuando corresponda, conteo seleccionado valido y ausencia de decision concurrente.

## 9. Conteos, incidencias y reconteos

`record_inventory_count` exige tarea `IN_PROGRESS`, participante y asignacion vigente, ciclo positivo, snapshot, zona, producto, ubicacion y scope `INCLUDED` coherentes. Las correcciones crean reemplazo y relacion append-only; nunca actualizan cantidades. Incidencias cambian estado mediante resolucion append-only y actualizacion atomica de su proyeccion.

El reconteo sigue `REQUESTED -> ASSIGNED -> IN_PROGRESS -> COMPLETED`, con cancelacion desde los tres primeros estados. Una persona distinta del contador original es obligatoria salvo que no exista participante apto, el actor tenga `inventarios.recounts.override_assignee` y persista justificacion. Antes de completar, el ejecutor no ve stock, aporte original, correcciones, otros reconteos, diferencias ni decisiones. El supervisor compara solo despues de completar. No hay promedio automatico.

## 10. Triggers, RLS y errores

4E implementa triggers defensivos para inmutabilidad de snapshots, `task_events`, `task_state_transitions`, conteos, correcciones, resoluciones y decisiones; mutabilidad controlada de `operation_idempotency`; y escritura directa denegada. Los triggers no deciden autorizacion compleja ni consolidacion.

En 4B.0b, `operation_idempotency` habilita RLS y termina con cero politicas funcionales. Se revoca todo acceso directo de `PUBLIC`, `anon` y `authenticated`; solo `service_role` recibe `SELECT`, `INSERT` y `UPDATE`, nunca `DELETE`, `TRUNCATE`, `REFERENCES` ni `TRIGGER`. No hay lectura directa de `authenticated`, no se agrega `inventarios` a `api.schemas`, no hay wrappers `public` ni grants `EXECUTE`. Las RPC futuras `SECURITY DEFINER` acceden mediante propietario controlado, `search_path` fijo, objetos calificados, `auth.uid()`, empresa derivada, `REVOKE EXECUTE FROM PUBLIC` y grants explicitos por firma.

Codigos minimos: `INV_UNAUTHENTICATED`, `INV_COMPANY_ACCESS_DENIED`, `INV_PERMISSION_REQUIRED`, `INV_ROLE_NOT_ALLOWED`, `INV_SESSION_INVALID_STATE`, `INV_SESSION_NOT_PREPARED`, `INV_SCOPE_NOT_INCLUDED`, `INV_TASK_NOT_ASSIGNED`, `INV_TASK_ALREADY_ASSIGNED`, `INV_TASK_ALREADY_CANCELLED`, `INV_TASK_INVALID_STATE`, `INV_TASK_NOT_VALIDATED`, `INV_TASK_CYCLE_CONFLICT`, `INV_VERSION_CONFLICT`, `INV_PARTICIPANT_INACTIVE`, `INV_USER_ALREADY_ACTIVE`, `INV_IDEMPOTENCY_CONFLICT`, `INV_IDEMPOTENCY_IN_PROGRESS`, `INV_OPERATION_ALREADY_APPLIED`, `INV_COUNT_IDEMPOTENCY_CONFLICT`, `INV_COUNT_CONTEXT_MISMATCH`, `INV_COUNT_QUANTITY_MISMATCH`, `INV_OFFLINE_CAPTURE_CONFLICT`, `INV_INCIDENT_BLOCKING`, `INV_RECOUNT_INVALID_STATE`, `INV_RECOUNT_INCOMPLETE`, `INV_DECISION_CONTEXT_MISMATCH`, `INV_DECISION_NOT_FOUND`, `INV_CONCURRENT_MODIFICATION` e `INV_NOT_FOUND`. `INV_IDEMPOTENCY_IN_PROGRESS` es reintentable y usa el mensaje seguro definido en idempotencia.

## 11. Matriz de cambios fisicos requeridos

| Fase | Objeto | Cambio |
| --- | --- | --- |
| 4B.0 | `operation_idempotency` | nueva tabla de idempotencia persistida |
| 4B.2 | `tasks.validation_cycle` | default y check desde 1 |
| 4B.2 | `task_events.cycle` | default y check desde 1 |
| 4B.2 | `tasks.paused_by` | nueva columna y FK |
| 4B.2 | `tasks.completed_by` | nueva columna y FK |
| 4B.2 | `task_state_transitions` | nueva tabla append-only |
| 4D | `recount_requests.execution_task_id` | nueva columna, FK contextual y unicidad parcial |
| Documentacion | `task_events.event_type` | corregir catalogo en modelo fisico |

## 12. Plan de implementacion

| Subfase | Entrega | Criterio de aceptacion |
| --- | --- | --- |
| 4B.0a - Permisos | seed idempotente de modulo `inventarios` y quince permisos; sin asignaciones, tablas, RLS, grants ni RPC | modulo/permisos unicos y sin acceso otorgado accidentalmente |
| 4B.0b - Idempotencia estructural | `operation_idempotency`, PK, FKs, candidate key, checks, unique, indices, RLS habilitado, cero politicas y grants exactos | tabla inaccesible a clientes y apta para helpers posteriores |
| 4B.0c - Helpers internos | helpers de autorizacion e idempotencia despues de aplicar/verificar 4B.0a y 4B.0b | sin RPC de negocio ni exposicion API |
| 4B.1 - Jornadas y zonas | preparacion, inicio, zona-membresia atomica e idempotencia persistida | snapshot completo, PREPARED/COUNTING y una ubicacion por zona V1 |
| 4B.2 - Tareas y auditoria | ciclo inicial, actores, `task_state_transitions`, asignacion, transiciones, cancelacion, validacion estructural interna, reapertura, eventos y locks | version/ciclo, historia persistente y usuario activo consistentes |
| 4C - Conteos e incidencias | payload canonico, conteos, correcciones, incidencias, resoluciones, evidencias y endurecimiento de validacion | contexto, cantidades, historia e incidencias comprobables |
| 4D - Reconteos | `execution_task_id`, tarea RECOUNT, lectura ciega, excepcion supervisora, decisiones y endurecimiento final | solicitud/tarea vinculadas, ordinal, ceguera y decision vigente sin promedio |
| 4E - Seguridad y exposicion | triggers, RLS, grants, ownership, wrappers/exposicion y habilitacion operacional de validacion | escritura directa denegada, RPC autorizadas y auditoria protegida |

Cada subfase se divide en migraciones pequenas: primero contratos y objetos de datos, luego funciones, despues triggers/RLS y pruebas de concurrencia/permisos. No se modifica ninguna migracion de Fases 1-3.
