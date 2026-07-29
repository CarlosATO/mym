# Contratos de Helpers - Inventory Engine Fase 4B.0c

## 1. Alcance y decisiones

Este documento define los helpers internos requeridos antes de las RPC de negocio de Inventarios. No crea RPC expuestas, SQL ejecutable, migraciones, funciones, grants, politicas ni cambios remotos.

La implementacion se divide en 4B.0c1 (identidad y autorizacion) y 4B.0c2 (hash e idempotencia). Los helpers solo pueden ser invocados por futuras RPC de negocio `SECURITY DEFINER`; no son una API de PostgREST ni tienen wrappers `public`.

Las tablas de Fases 1-3 y 4B.0b siguen siendo la fuente fisica: `inventarios.operation_idempotency` tiene RLS habilitado, cero politicas y solo `service_role` con DML directo. Los helpers no cambian esa regla.

## 2. Evidencia tecnica remota

La auditoria remota de solo lectura confirma una unica instalacion de `pgcrypto`, version `1.3`, en el esquema `extensions`. No se crea, mueve ni modifica la extension.

| Funcion | Retorno | Volatilidad | Paralelismo | Propietario |
| --- | --- | --- | --- | --- |
| `extensions.digest(bytea, text)` | `bytea` | `IMMUTABLE` | `PARALLEL SAFE` | `postgres` |
| `extensions.digest(text, text)` | `bytea` | `IMMUTABLE` | `PARALLEL SAFE` | `postgres` |
| `pg_catalog.encode(bytea, text)` | `text` | `IMMUTABLE` | `PARALLEL SAFE` | `postgres` |
| `pg_catalog.convert_to(text, name)` | `bytea` | `STABLE` | `PARALLEL SAFE` | `postgres` |

`postgres` puede ejecutar ambas sobrecargas de `extensions.digest`. La ruta canonica del hash usa la sobrecarga `extensions.digest(bytea, text)` y todas las referencias se califican por esquema.

## 3. Identidad operacional canonica

`auth.uid()` entrega el UUID del principal autenticado de Supabase en el contexto de la solicitud. La relacion esta verificada en la definicion aplicada: `portal.users.id` es PK y FK directa a `auth.users(id)`. No existe una columna de enlace alternativa.

Por tanto, el UUID de `auth.uid()` se puede persistir directamente, pero solo despues de resolverlo mediante `inventarios.require_actor()`:

- `operation_idempotency.actor_id` referencia `portal.users(id)` y recibe el UUID retornado por el helper.
- Los futuros `tasks.paused_by` y `tasks.completed_by` tambien reciben ese UUID. Esas columnas aun no existen; pertenecen a 4B.2.
- No se acepta `actor_id` desde cliente ni como parametro de helpers de idempotencia.
- `service_role` no es un actor funcional. Sin JWT de usuario, `auth.uid()` es `NULL` y el resultado es `INV_UNAUTHENTICATED`.

La resolucion unica es: tomar `auth.uid()`, buscar exactamente la fila con el mismo `portal.users.id`, y exigir `is_active = true` y `deleted_at IS NULL`. No crea perfiles ni actualiza `last_login_at`.

| Condicion | Resultado |
| --- | --- |
| `auth.uid()` es `NULL` | `INV_UNAUTHENTICATED` |
| No existe `portal.users.id = auth.uid()` | `INV_ACTOR_NOT_REGISTERED` |
| Perfil con `is_active = false` o `deleted_at IS NOT NULL` | `INV_ACTOR_INACTIVE` |
| Perfil activo | retornar su `portal.users.id`, nunca `NULL` |

## 4. Convencion comun de seguridad

Todos los helpers aprobados se crean con estas propiedades explicitas:

| Propiedad | Contrato |
| --- | --- |
| Propietario | `postgres`; la migracion debe fijarlo y abortar su auditoria si el propietario efectivo difiere. |
| Seguridad | `SECURITY DEFINER`; necesitan leer tablas protegidas y deben conservar el contexto de `auth.uid()`. |
| Ruta | `SET search_path = pg_catalog`; toda referencia fuera de `pg_catalog` va calificada (`auth`, `portal`, `core`, `inventarios`, `extensions` cuando se verifique). |
| Ejecucion directa | revocar de `PUBLIC`, `anon`, `authenticated` y `service_role`. No se otorga `EXECUTE` en 4B.0c. |
| Consumidor | solo RPC de negocio futuras, ejecutadas como `postgres`; `service_role` no tiene consumidor directo justificado aun. |
| Paralelismo | `PARALLEL UNSAFE` explicito para todos los helpers. Es conservador para el hash aunque sus auxiliares auditados sean `PARALLEL SAFE`. |

El propietario puede acceder a las tablas de Inventarios pese a RLS: las tablas dependientes auditadas son propiedad de `postgres` y no fuerzan RLS. Las RPC de negocio futuras, tambien propiedad de `postgres`, pueden invocar los helpers mediante privilegios del propietario aunque `PUBLIC`, `anon`, `authenticated` y `service_role` no reciban `EXECUTE` directo.

`SECURITY DEFINER` nunca sustituye autenticacion, empresa, permiso, estado ni contexto. Toda referencia se califica: `auth.uid()`, `portal.users`, `core.has_company_access`, `portal.has_permission`, `inventarios.sessions`, `inventarios.session_participants`, `inventarios.operation_idempotency`, `extensions.digest`, `pg_catalog.encode` y `pg_catalog.convert_to`.

## 5. Errores y transporte

La representacion contractual unica es:

- `SQLSTATE = P0001`.
- `MESSAGE = codigo INV_*` exacto.
- `DETAIL = JSON controlado` con solo `{"message":"mensaje seguro","retryable":boolean}`.
- No usar `HINT` para datos internos ni incluir constraints, SQL, tablas, payloads o UUID de terceros.

Las acciones actuales de Next.js propagan `error.message`; por ello el codigo en `MESSAGE` es deliberadamente seguro y estable. El cliente o futura capa de transporte traduce el codigo y puede leer solo el JSON controlado de `DETAIL`; nunca expone `DETAIL` crudo si no es JSON valido.

| Codigo | Helper | Condicion | Mensaje seguro | Reintentable |
| --- | --- | --- |
| `INV_UNAUTHENTICATED` | actor y dependientes | `auth.uid()` nulo | Debes iniciar sesion para realizar esta operacion. | no |
| `INV_ACTOR_NOT_REGISTERED` | actor | perfil inexistente | Tu usuario no esta registrado para operar inventarios. | no |
| `INV_ACTOR_INACTIVE` | actor | perfil inactivo o eliminado | Tu usuario no esta activo para operar inventarios. | no |
| `INV_COMPANY_ACCESS_DENIED` | empresa y dependientes | empresa nula, inexistente o sin acceso | No tienes acceso a la empresa solicitada. | no |
| `INV_PERMISSION_REQUIRED` | permiso | permiso valido no concedido | No tienes el permiso requerido para esta operacion. | no |
| `INV_NOT_FOUND` | participante, complete | recurso dentro de empresa autorizada inexistente | El recurso solicitado no existe. | no |
| `INV_SESSION_INVALID_STATE` | participante | jornada cancelada | La jornada no permite operaciones de participantes. | no |
| `INV_PARTICIPANT_INACTIVE` | participante | participacion revocada o aun no activa | No tienes una participacion activa en la jornada. | no |
| `INV_CONCURRENT_MODIFICATION` | participante | cardinalidad vigente inesperada | Se detecto un conflicto en la asignacion del participante. | si |
| `INV_IDEMPOTENCY_CONFLICT` | begin, complete | actor, hash o contexto no coinciden | La clave de idempotencia ya fue usada con una solicitud distinta. | no |
| `INV_IDEMPOTENCY_IN_PROGRESS` | begin | reserva confirmada pendiente | La operacion todavia esta siendo procesada. Intenta nuevamente. | si |
| `INV_OPERATION_ALREADY_APPLIED` | complete | fila ya completada | La operacion ya fue finalizada. | no |
| `INV_INVALID_RESPONSE_ENVELOPE` | complete | envelope ausente, invalido o conversion fallida | La respuesta de la operacion no tiene el formato requerido. | no |
| `INV_INVALID_REQUEST_PAYLOAD` | permiso, hash, begin, participante | parametro invalido o payload JSON nulo | La solicitud no tiene el formato requerido. | no |

`INV_ACTOR_NOT_REGISTERED`, `INV_ACTOR_INACTIVE`, `INV_INVALID_RESPONSE_ENVELOPE` e `INV_INVALID_REQUEST_PAYLOAD` se agregan al catalogo de Fase 4. Los demas ya estan definidos o requeridos por el contrato operativo.

## 6. Matriz de firmas y atributos

| Helper | Firma | Volatilidad | Paralelismo |
| --- | --- | --- | --- |
| actor | `inventarios.require_actor() RETURNS uuid` | `STABLE` | `PARALLEL UNSAFE` |
| empresa | `inventarios.require_company_access(uuid) RETURNS uuid` | `VOLATILE` | `PARALLEL UNSAFE` |
| permiso | `inventarios.require_permission(uuid, text) RETURNS uuid` | `VOLATILE` | `PARALLEL UNSAFE` |
| participante | `inventarios.require_session_participant(uuid, uuid, text) RETURNS uuid` | `VOLATILE` | `PARALLEL UNSAFE` |
| hash | `inventarios.compute_request_hash(jsonb) RETURNS text` | `STABLE` | `PARALLEL UNSAFE` |
| inicio | `inventarios.begin_idempotent_operation(uuid, text, uuid, text) RETURNS jsonb` | `VOLATILE` | `PARALLEL UNSAFE` |
| finalizacion | `inventarios.complete_idempotent_operation(uuid, uuid, uuid, jsonb) RETURNS jsonb` | `VOLATILE` | `PARALLEL UNSAFE` |

`require_company_access` es `VOLATILE` porque depende de `core.has_company_access(uuid, uuid)`, que el remoto define `VOLATILE` y `PARALLEL UNSAFE`. `require_permission` y `require_session_participant` dependen de ese acceso y de estado actual de permisos o participacion, por lo que tambien son `VOLATILE`. `compute_request_hash` es `STABLE`, no `IMMUTABLE`, porque usa `pg_catalog.convert_to(text, name)`, que es `STABLE`. Ningun helper se declara mas inmutable o paralelo que sus dependencias.

## 7. Helpers 4B.0c1: identidad y autorizacion

### 7.1 `inventarios.require_actor`

| Aspecto | Contrato |
| --- | --- |
| Firma | `inventarios.require_actor() RETURNS uuid` |
| Parametros | ninguno |
| Retorno | `uuid NOT NULL` de `portal.users.id` autenticado y operativo |
| Volatilidad y paralelismo | `STABLE`, `PARALLEL UNSAFE` |
| Lecturas | `auth.uid()`, `portal.users(id, is_active, deleted_at)` |
| Escrituras | ninguna |
| Errores | `INV_UNAUTHENTICATED`, `INV_ACTOR_NOT_REGISTERED`, `INV_ACTOR_INACTIVE` |
| Seguridad, propietario, ruta | convencion de la seccion 4 |
| Consumidores | todos los helpers siguientes y toda RPC mutadora futura |

No recibe `actor_id`, no acepta suplantacion, no devuelve `NULL`, no crea perfiles y no considera `service_role` como identidad operacional.

### 7.2 `inventarios.require_company_access`

| Aspecto | Contrato |
| --- | --- |
| Firma | `inventarios.require_company_access(p_company_id uuid) RETURNS uuid` |
| Parametro | `p_company_id uuid NOT NULL`; una entrada nula es acceso denegado |
| Retorno | actor validado `uuid NOT NULL` |
| Volatilidad y paralelismo | `VOLATILE`, `PARALLEL UNSAFE` |
| Lecturas | `inventarios.require_actor()`, `core.companies(id)`, `core.has_company_access(uuid, uuid)` |
| Escrituras | ninguna |
| Errores | los del actor, `INV_COMPANY_ACCESS_DENIED` |
| Seguridad, propietario, ruta | convencion de la seccion 4 |
| Consumidores | permiso, participante, begin/complete y RPC de negocio |

Orden obligatorio: resolver actor y exigir `core.has_company_access(actor_id, p_company_id)`. La firma real es `core.has_company_access(p_user_id uuid, p_company_id uuid) RETURNS boolean`; solo considera una membresia activa y no valida `core.companies.is_active`. El perfil activo se valida antes porque la funcion existente no lo hace.

No se diferencia publicamente entre empresa nula, inexistente o sin acceso: todas retornan `INV_COMPANY_ACCESS_DENIED`. `INV_NOT_FOUND` queda reservado para recursos buscados dentro de una empresa ya autorizada.

### 7.3 `inventarios.require_permission`

| Aspecto | Contrato |
| --- | --- |
| Firma | `inventarios.require_permission(p_company_id uuid, p_permission_code text) RETURNS uuid` |
| Parametros | ambos `NOT NULL`; codigo se normaliza con `btrim`, no puede quedar vacio y debe iniciar `inventarios.` |
| Retorno | actor validado `uuid NOT NULL` |
| Volatilidad y paralelismo | `VOLATILE`, `PARALLEL UNSAFE` |
| Lecturas | `require_company_access`, `portal.modules`, `portal.permissions`, `portal.has_permission(varchar)` |
| Escrituras | ninguna |
| Errores | actor/empresa, `INV_INVALID_REQUEST_PAYLOAD`, `INV_PERMISSION_REQUIRED` |
| Seguridad, propietario, ruta | convencion de la seccion 4 |
| Consumidores | cada RPC de negocio segun su permiso `inventarios.*` |

La secuencia es obligatoria: primero rechaza `p_permission_code` SQL `NULL`, vacio despues de `btrim` o sin prefijo `inventarios.`; luego valida empresa con `inventarios.require_company_access(p_company_id)`; despues valida el catalogo y solo entonces invoca `portal.has_permission`.

El predicado fisico exacto de permiso canonico y utilizable es una fila que cumpla simultaneamente: `portal.permissions.code = btrim(p_permission_code)`, `portal.permissions.is_active = true`, `portal.permissions.module_id = portal.modules.id` y `portal.modules.code = 'inventarios'`. La columna fisica de vigencia existe y se llama `portal.permissions.is_active boolean NOT NULL DEFAULT true`; no se inventa otra columna. El helper lee obligatoriamente `portal.permissions` y `portal.modules` con esa relacion.

Codigo nulo, vacio, sin prefijo, inexistente, asociado a otro modulo o inactivo devuelve `INV_INVALID_REQUEST_PAYLOAD` con detalle seguro `{"message":"El permiso solicitado no es valido para esta operacion.","retryable":false}`. No se delega ninguno de esos casos a `portal.has_permission` ni se revela modulo, IDs o asignaciones. Solo un permiso canonico vigente no concedido devuelve `INV_PERMISSION_REQUIRED`; uno concedido retorna el actor. El helper no crea permisos ni duplica la resolucion de asignaciones directas o por rol de `portal.has_permission`.

La firma real de autorizacion es `portal.has_permission(p_permission_code varchar) RETURNS boolean`; no recibe usuario ni empresa, resuelve `auth.uid()` y mantiene su bypass de `system.admin`. El bypass ocurre solo despues de confirmar catalogo, vigencia y modulo Inventarios; nunca autoriza codigo inexistente, de otro modulo o inactivo. Tampoco omite autenticacion, actividad del actor, acceso empresarial, integridad, estado de jornada, participante, asignacion, ciclo, version ni concurrencia.

### 7.4 `inventarios.require_session_participant`

| Aspecto | Contrato |
| --- | --- |
| Firma | `inventarios.require_session_participant(p_company_id uuid, p_session_id uuid, p_functional_role text) RETURNS uuid` |
| Parametros | empresa y jornada `uuid NOT NULL`; rol `text NOT NULL`, no vacio tras normalizacion |
| Retorno | `session_participants.id` activo `uuid NOT NULL` |
| Volatilidad y paralelismo | `VOLATILE`, `PARALLEL UNSAFE` |
| Lecturas | `require_company_access`, `inventarios.sessions`, `inventarios.session_participants` |
| Escrituras | ninguna |
| Errores | actor/empresa, `INV_INVALID_REQUEST_PAYLOAD`, `INV_NOT_FOUND`, `INV_SESSION_INVALID_STATE`, `INV_PARTICIPANT_INACTIVE`, `INV_CONCURRENT_MODIFICATION` |
| Seguridad, propietario, ruta | convencion de la seccion 4 |
| Consumidores | tareas, asignaciones, conteos, incidencias y reconteos futuros |

El rol es obligatorio. La variable logica canonica es `v_functional_role := pg_catalog.upper(pg_catalog.btrim(p_functional_role))`. Entrada SQL `NULL` o vacia tras `btrim` retorna `INV_INVALID_REQUEST_PAYLOAD`. La entrada es insensible a mayusculas/minusculas y espacios exteriores; la consulta usa el valor canonico exacto en mayusculas. Se aceptan `COUNTER`, `counter`, `Counter` y `  counter  ` como `COUNTER`; solo los valores canonicos `COUNTER`, `SUPERVISOR`, `ADMINISTRATOR` y `MANAGER` son validos. No se usan `ILIKE` ni comparaciones parciales, ni se modifican valores almacenados.

El indice aplicado permite una fila vigente por `(company_id, session_id, user_id, functional_role)`, no una sola fila por usuario/jornada. Un actor puede tener varios roles activos en la misma jornada: las consultas con `COUNTER` y `SUPERVISOR` pueden devolver IDs distintos; el helper nunca elige un participante sin rol.

El helper resuelve internamente el actor con `inventarios.require_actor()` y el acceso con `inventarios.require_company_access(p_company_id)`; nunca recibe UUID de actor. `p_session_id` nulo retorna `INV_INVALID_REQUEST_PAYLOAD`. La jornada se busca por `company_id = p_company_id` e `id = p_session_id`: ausente, incluida una jornada de otra empresa, retorna `INV_NOT_FOUND`; `status = 'CANCELLED'` retorna `INV_SESSION_INVALID_STATE`.

La busqueda contextual usa `company_id = p_company_id`, `session_id = p_session_id`, `user_id = actor_id` y `functional_role = v_functional_role`. La vigencia exacta es `active_from <= pg_catalog.now() AND revoked_at IS NULL`. Sin asociacion historica retorna `INV_NOT_FOUND`; asociacion historica futura o revocada retorna `INV_PARTICIPANT_INACTIVE`; una fila vigente retorna su `session_participants.id`.

La cardinalidad se controla explicitamente, sin `SELECT INTO STRICT` que exponga errores internos. Mas de una fila vigente, aunque el indice parcial lo impide, retorna `INV_CONCURRENT_MODIFICATION` con `P0001` y detalle seguro `{"message":"Se detecto un conflicto en la asignacion del participante.","retryable":true}`. Representa inconsistencia operacional o concurrencia, no error de entrada; no expone conteos, IDs, constraints ni SQL.

## 8. Helpers 4B.0c2: hash e idempotencia

### 8.1 `inventarios.compute_request_hash`

| Aspecto | Contrato |
| --- | --- |
| Firma | `inventarios.compute_request_hash(p_payload jsonb) RETURNS text` |
| Parametro | `p_payload jsonb NOT NULL` |
| Retorno | SHA-256 hexadecimal en minusculas, exactamente 64 caracteres |
| Volatilidad y paralelismo | `STABLE`, `PARALLEL UNSAFE` |
| Lecturas/escrituras | ninguna tabla; usa la funcion `digest` de pgcrypto verificada en implementacion |
| Errores | `INV_INVALID_REQUEST_PAYLOAD` para SQL `NULL` o JSON `null` |
| Seguridad, propietario, ruta | convencion de la seccion 4 |
| Consumidores | cada RPC mutadora antes de `begin_idempotent_operation` |

La implementacion contractual equivalente es:

```text
pg_catalog.encode(
  extensions.digest(
    pg_catalog.convert_to(p_payload::text, 'UTF8'),
    'sha256'
  ),
  'hex'
)
```

`p_payload` no puede ser SQL `NULL` ni `'null'::jsonb`. El resultado debe tener 64 caracteres, minusculas y cumplir `^[0-9a-f]{64}$`. `jsonb::text` normaliza el orden de claves de objetos: objetos con mismas claves y valores producen el mismo texto y hash, aunque el orden de entrada difiera. El orden de arrays se conserva y es semantico. El helper no decide los campos del payload: cada RPC construye antes su payload funcional canonico y excluye timestamps tecnicos generados por servidor, `occurred_at` y resultados.

### 8.2 `inventarios.begin_idempotent_operation`

| Aspecto | Contrato |
| --- | --- |
| Firma | `inventarios.begin_idempotent_operation(p_company_id uuid, p_operation_code text, p_idempotency_key uuid, p_request_hash text) RETURNS jsonb` |
| Parametros | todos `NOT NULL`; operacion no vacia y prefijo `inventarios.`; hash coincide con `^[0-9a-f]{64}$` |
| Retorno | objeto interno `NEW` o `REPLAY` descrito abajo |
| Volatilidad y paralelismo | `VOLATILE`, `PARALLEL UNSAFE` |
| Lecturas | `require_company_access`, `operation_idempotency` |
| Escrituras | inserta solamente una fila `IN_PROGRESS` en `operation_idempotency` |
| Errores | actor/empresa, `INV_INVALID_REQUEST_PAYLOAD`, `INV_IDEMPOTENCY_CONFLICT`, `INV_IDEMPOTENCY_IN_PROGRESS` |
| Seguridad, propietario, ruta | convencion de la seccion 4 |
| Consumidores | toda RPC mutadora futura |

La empresa debe provenir del recurso bloqueado por la RPC. Este helper solo valida el `p_company_id`; no puede probar por si mismo que un UUID de empresa enviado por cliente pertenezca a un recurso todavia desconocido. Operacion vacia, sin prefijo `inventarios.`, clave nula o hash que no cumple el formato se rechazan con `INV_INVALID_REQUEST_PAYLOAD`.

Resultado nuevo:

```json
{"mode":"NEW","operation_id":"uuid","actor_id":"uuid","response_payload":null}
```

Resultado replay:

```json
{"mode":"REPLAY","operation_id":"uuid","actor_id":"uuid","response_payload":{"operation":"inventarios.x","entity_id":"uuid_o_null","state":"estado_o_null","version":1,"cycle_number":1,"assignment_id":"uuid_o_null","event_id":"uuid_o_null","replayed":true,"occurred_at":"timestamptz","data":{}}}
```

Para `REPLAY`, se copia el envelope persistido, se cambia solo la copia devuelta de `replayed: false` a `true`, y nunca se actualiza `response_payload` almacenado.

Concurrencia obligatoria:

1. Resolver actor/acceso y validar operacion, clave y hash.
2. Intentar insertar `IN_PROGRESS` con la unique `(company_id, operation_code, idempotency_key)`.
3. Si no hay conflicto, retornar `NEW` con el id insertado.
4. Ante conflicto unico, PostgreSQL espera la transaccion concurrente que posee la clave; despues se vuelve a leer la fila ya liberada con bloqueo de fila.
5. Si la primera transaccion hizo rollback, no existe fila: se intenta la insercion una vez mas, sin polling, `pg_sleep`, loop indefinido ni advisory lock de reemplazo.
6. Si existe fila del mismo actor y hash en `COMPLETED`, retornar `REPLAY`; si actor o hash difiere, abortar `INV_IDEMPOTENCY_CONFLICT`.
7. Si existe fila confirmada `IN_PROGRESS` con actor/hash iguales, abortar `INV_IDEMPOTENCY_IN_PROGRESS`; con diferencia, `INV_IDEMPOTENCY_CONFLICT`.

### 8.3 `inventarios.complete_idempotent_operation`

| Aspecto | Contrato |
| --- | --- |
| Firma | `inventarios.complete_idempotent_operation(p_company_id uuid, p_operation_id uuid, p_entity_id uuid, p_response_payload jsonb) RETURNS jsonb` |
| Parametros | empresa, operacion y envelope `NOT NULL`; `p_entity_id uuid` puede ser `NULL` solo si `response_payload.entity_id` tambien es `null` |
| Retorno | exactamente el envelope original persistido, con `replayed = false` |
| Volatilidad y paralelismo | `VOLATILE`, `PARALLEL UNSAFE` |
| Lecturas | `require_company_access`, `operation_idempotency` |
| Escrituras | solo `entity_id`, `response_payload`, `status = 'COMPLETED'`, `completed_at = now()` |
| Errores | actor/empresa, `INV_NOT_FOUND`, `INV_COMPANY_ACCESS_DENIED`, `INV_IDEMPOTENCY_CONFLICT`, `INV_OPERATION_ALREADY_APPLIED`, `INV_INVALID_RESPONSE_ENVELOPE` |
| Seguridad, propietario, ruta | convencion de la seccion 4 |
| Consumidores | el cierre de cada RPC mutadora futura |

La lectura bloqueada debe exigir fila de la empresa, `actor_id = require_company_access(p_company_id)` y estado `IN_PROGRESS`. Si el id no existe en la empresa se retorna `INV_NOT_FOUND`; si existe con otra empresa o actor se retorna `INV_COMPANY_ACCESS_DENIED`; si ya esta `COMPLETED`, `INV_OPERATION_ALREADY_APPLIED`.

### 8.4 Envelope tipado de finalizacion

`p_response_payload` debe ser un objeto JSON y contener siempre las diez claves: `operation`, `entity_id`, `state`, `version`, `cycle_number`, `assignment_id`, `event_id`, `replayed`, `occurred_at` y `data`.

La presencia se valida con `p_response_payload ? 'clave'`. No basta `p_response_payload -> 'clave' IS NULL`: debe distinguirse una clave ausente de una clave presente con JSON `null`. Las diez claves son obligatorias aun cuando su valor admita JSON `null`.

| Clave | Tipo y regla |
| --- | --- |
| `operation` | JSON string no vacia e igual a `operation_code` de la fila. |
| `entity_id` | JSON `null`, o JSON string convertible a UUID. Si `p_entity_id` es nulo debe ser JSON `null`; si no, debe ser la representacion textual del mismo UUID. |
| `state` | JSON `null`, o JSON string no vacia. |
| `version` | JSON `null`, o JSON number matematicamente entero en `1..2147483647`; no string, boolean, array ni objeto. |
| `cycle_number` | JSON `null`, o JSON number matematicamente entero en `1..2147483647`; no string, boolean, array ni objeto. |
| `assignment_id` | JSON `null`, o JSON string convertible a UUID. |
| `event_id` | JSON `null`, o JSON string convertible a UUID. |
| `replayed` | JSON boolean exactamente `false`; no `true`, string, `null` ni clave ausente. |
| `occurred_at` | JSON string no vacia convertible a `timestamptz`. |
| `data` | JSON object; no array, string, number, boolean ni `null`. |

Para `version` y `cycle_number`, cuando el valor no es JSON `null`, el helper exige `jsonb_typeof(value) = 'number'`, convierte controladamente `value ->> campo` a `numeric`, y exige `numeric_value > 0`, `numeric_value = trunc(numeric_value)` y `numeric_value <= 2147483647`. Esto corresponde al rango de PostgreSQL `integer` de la estructura fisica. Se acepta un valor matematicamente entero, por lo que `1`, `1.0` y `1.000` son validos; `1.1` y `1.0001` no lo son. No depende de la representacion textual de JSONB.

Los casts de `entity_id`, `assignment_id`, `event_id`, `occurred_at`, `version` y `cycle_number` se ejecutan en bloques controlados. Cualquier valor no convertible, fuera de rango o con tipo no permitido se traduce a `INV_INVALID_RESPONSE_ENVELOPE` con `P0001` y `DETAIL` JSON seguro; no filtra `invalid input syntax`, `numeric field overflow`, SQLSTATE tecnico ni el envelope completo. La validacion usa `jsonb_typeof` y no valida semantica especifica de entidad, estado, version o ciclo mas alla de estas reglas estructurales; esa semantica pertenece a la RPC de negocio.

La finalizacion no modifica `company_id`, `operation_code`, `idempotency_key`, `actor_id`, `request_hash` ni `created_at`. Una vez completada, retorna el valor persistido sin decorarlo.

## 9. Atomizacion transaccional

Cada RPC de negocio debe ejecutar, en la misma transaccion PostgreSQL:

```text
begin_idempotent_operation -> mutacion de negocio -> complete_idempotent_operation
```

No hay commits internos, transacciones autonomas, polling ni reservas duraderas normales. Si la mutacion falla, el rollback elimina la insercion `IN_PROGRESS`. Una fila confirmada `IN_PROGRESS` solo puede provenir de uso tecnico incompleto, escritura/migracion manual externa o futura arquitectura que separe transacciones; su tratamiento es siempre `INV_IDEMPOTENCY_IN_PROGRESS` reintentable.

## 10. Concurrencia idempotente

El inicio mantiene este patron sin cambios:

```text
INSERT ... ON CONFLICT DO NOTHING RETURNING
```

Cuando no retorna fila, localiza por `(company_id, operation_code, idempotency_key)`, adquiere bloqueo de fila y compara actor, hash y estado. `COMPLETED` con mismo actor/hash retorna `REPLAY`; se devuelve una copia logica de `response_payload` con solo `replayed: true`, sin actualizar la fila persistida. Actor o hash distintos retornan `INV_IDEMPOTENCY_CONFLICT`. Una fila confirmada `IN_PROGRESS` retorna `INV_IDEMPOTENCY_IN_PROGRESS` con `{"retryable":true}`. No usa polling, loops, `pg_sleep` ni advisory locks.

## 11. Orden de implementacion y auditoria

### 4B.0c1 - Identidad y autorizacion

1. Crear y auditar `require_actor`.
2. Crear y auditar `require_company_access` contra la firma real de `core.has_company_access(uuid, uuid)`.
3. Crear y auditar `require_permission` contra `portal.has_permission(varchar)` y el bypass existente de `system.admin`.
4. Crear y auditar `require_session_participant` con rol funcional obligatorio.
5. Verificar propietario, `search_path`, ACL de cada firma, ausencia de ejecucion por roles cliente y errores controlados.

### 4B.0c2 - Hash e idempotencia

1. Verificar catalogo remoto de `pgcrypto`, esquema y atributos de `digest` sin crear extensiones.
2. Crear y auditar `compute_request_hash`.
3. Crear y auditar `begin_idempotent_operation`.
4. Crear y auditar `complete_idempotent_operation`.
5. Verificar ACL, RLS efectivo por propietario, concurrencia y rollback.

4B.0c1 y 4B.0c2 son migraciones separadas y requieren checkpoints independientes: auditoria estatica, aplicacion remota, pruebas controladas, verificacion de grants y checkpoint Git. No se crean migraciones en esta fase documental.

## 12. Matriz de pruebas futuras

| Caso | Helper o flujo | Resultado esperado |
| --- | --- | --- |
| Sin sesion | actor, empresa, permiso, begin | `INV_UNAUTHENTICATED` |
| Sin perfil `portal.users` | actor | `INV_ACTOR_NOT_REGISTERED` |
| Perfil con `is_active = false` | actor | `INV_ACTOR_INACTIVE` |
| Perfil con `deleted_at IS NOT NULL` | actor | `INV_ACTOR_INACTIVE` |
| Perfil activo y no eliminado | actor | devuelve `portal.users.id` |
| Empresa nula, inexistente o sin acceso | empresa | `INV_COMPANY_ACCESS_DENIED` |
| Sin membresia activa | empresa | `INV_COMPANY_ACCESS_DENIED` |
| `p_permission_code IS NULL` | permiso | `INV_INVALID_REQUEST_PAYLOAD` |
| Codigo vacio `''` | permiso | `INV_INVALID_REQUEST_PAYLOAD` |
| Codigo compuesto solo por espacios | permiso | `INV_INVALID_REQUEST_PAYLOAD` |
| Codigo sin prefijo `inventarios.` | permiso | `INV_INVALID_REQUEST_PAYLOAD` |
| Codigo inexistente | permiso | `INV_INVALID_REQUEST_PAYLOAD` |
| Codigo existente asociado a otro modulo | permiso | `INV_INVALID_REQUEST_PAYLOAD` |
| Permiso existente con `is_active = false` | permiso | `INV_INVALID_REQUEST_PAYLOAD` |
| Permiso canonico sin asignacion | permiso | `INV_PERMISSION_REQUIRED` |
| Permiso concedido directamente | permiso | devuelve actor |
| Permiso concedido por rol | permiso | devuelve actor |
| Denegacion directa y permiso por rol | permiso | `INV_PERMISSION_REQUIRED` |
| `system.admin` y permiso canonico | permiso | devuelve actor; no omite empresa ni contexto |
| `system.admin` y permiso inexistente | permiso | `INV_INVALID_REQUEST_PAYLOAD` |
| Participante inexistente | participante | `INV_NOT_FOUND` |
| Empresa SQL `NULL` | participante | `INV_COMPANY_ACCESS_DENIED` |
| Sesion SQL `NULL` | participante | `INV_INVALID_REQUEST_PAYLOAD` |
| `p_functional_role IS NULL` | participante | `INV_INVALID_REQUEST_PAYLOAD` |
| Rol vacio `''` | participante | `INV_INVALID_REQUEST_PAYLOAD` |
| Rol compuesto solo por espacios | participante | `INV_INVALID_REQUEST_PAYLOAD` |
| Rol fuera del catalogo | participante | `INV_INVALID_REQUEST_PAYLOAD` |
| Valor `counter` | participante | normaliza a `COUNTER` |
| Valor `Counter` | participante | normaliza a `COUNTER` |
| Valor ` counter ` | participante | normaliza a `COUNTER` |
| Jornada inexistente | participante | `INV_NOT_FOUND` |
| Jornada existente en otra empresa | participante | `INV_NOT_FOUND` |
| Jornada `CANCELLED` | participante | `INV_SESSION_INVALID_STATE` |
| Sin asociacion historica | participante | `INV_NOT_FOUND` |
| `active_from > now()` | participante | `INV_PARTICIPANT_INACTIVE` |
| `revoked_at IS NOT NULL` | participante | `INV_PARTICIPANT_INACTIVE` |
| Una asociacion vigente | participante | devuelve `session_participants.id` |
| Usuario con `COUNTER` y `SUPERVISOR` vigentes | participante | cada rol devuelve su propio ID |
| Mas de una fila vigente para el mismo contexto | participante | `INV_CONCURRENT_MODIFICATION` |
| Hash: SQL `NULL` | `compute_request_hash(NULL::jsonb)` | `INV_INVALID_REQUEST_PAYLOAD` |
| Hash: JSON `null` | `compute_request_hash('null'::jsonb)` | `INV_INVALID_REQUEST_PAYLOAD` |
| Hash malformado | begin: longitud distinta de 64, mayusculas, no hexadecimal, vacio o SQL `NULL` | `INV_INVALID_REQUEST_PAYLOAD` |
| Operacion nueva | begin | `NEW`, una fila `IN_PROGRESS` transitoria |
| Replay mismo actor/hash completado | begin | `REPLAY`, copia con solo `replayed = true` |
| Misma clave con payload distinto | begin | `INV_IDEMPOTENCY_CONFLICT` |
| Misma clave con actor distinto | begin | `INV_IDEMPOTENCY_CONFLICT` |
| Fila confirmada `IN_PROGRESS` | begin | `INV_IDEMPOTENCY_IN_PROGRESS`, reintentable |
| Primera transaccion hace rollback | begin concurrente | segunda reserva nueva sin fila huertana |
| Finalizacion duplicada | complete | `INV_OPERATION_ALREADY_APPLIED` |
| Envelope incompleto, no objeto o replay true | complete | `INV_INVALID_RESPONSE_ENVELOPE` |
| UUID o timestamp de envelope invalido | complete | `INV_INVALID_RESPONSE_ENVELOPE` sin error tecnico |
| `data` no es objeto o clave de envelope ausente | complete | `INV_INVALID_RESPONSE_ENVELOPE` |
| `version`: JSON `null`, `1` o `1.0` | complete | valido |
| `version`: `0`, `-1`, `1.5`, `"1"`, `true`, `[]` u `{}` | complete | `INV_INVALID_RESPONSE_ENVELOPE` |
| `version`: `2147483647` | complete | valido |
| `version`: `2147483648` o clave ausente | complete | `INV_INVALID_RESPONSE_ENVELOPE` |
| `cycle_number`: JSON `null`, `1` o `1.0` | complete | valido |
| `cycle_number`: `0`, `-1`, `2.75`, `"2"`, `true`, `[]` u `{}` | complete | `INV_INVALID_RESPONSE_ENVELOPE` |
| `cycle_number`: `2147483647` | complete | valido |
| `cycle_number`: `2147483648` o clave ausente | complete | `INV_INVALID_RESPONSE_ENVELOPE` |
| Envelope con operacion distinta | complete | `INV_INVALID_RESPONSE_ENVELOPE` |
| Ejecucion directa por `authenticated` | todos | permiso denegado por ACL |
| Ejecucion tecnica autorizada | RPC de negocio futura | solo por grant explicito de la RPC, no del helper |

## 13. Division final y bloqueadores

4B.0c1 contiene, en orden: `require_actor`, `require_company_access`, `require_permission` y `require_session_participant`. 4B.0c2 contiene, en orden: `compute_request_hash`, `begin_idempotent_operation` y `complete_idempotent_operation`. No se combinan en una sola migracion.

No quedan bloqueadores de diseno para crear las dos migraciones. Antes de cada aplicacion se auditan propietario `postgres`, `search_path`, ACL sin `EXECUTE` directo para roles cliente y los casos controlados de error. La identidad esta cerrada: `auth.uid()` y `portal.users.id` comparten el mismo UUID por FK aplicada.
