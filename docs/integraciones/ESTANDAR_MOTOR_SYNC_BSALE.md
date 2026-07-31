# Estándar del Motor Extensible de Sincronización Bsale (Fase BSYNC-0)

## 1. Resumen ejecutivo
Este documento define la arquitectura y contratos para un motor genérico, extensible y robusto de sincronización con Bsale. El objetivo es centralizar orquestación, rate limiting, cursores y manejo de errores (el "Núcleo Genérico"), separándolo de la lógica específica de negocio como clientes, pagos o stock (las "Extensiones de Dominio"). Esta base será la fundación para CV-1B y futuros desarrollos integrados.

## 2. Objetivo
Crear una arquitectura donde la incorporación de nuevos recursos (ej. listas de precio, sucursales) o lógicas complejas (ej. reparación financiera) no requiera rediseñar la paginación, reintentos o control de concurrencia, garantizando una ejecución segura, observable y escalable.

## 3. Alcance
- Diseño teórico de los componentes del motor genérico.
- Definición de contratos y registro de tareas.
- Estrategias para dependencias, rate limiting, cursores y transaccionalidad.
- Diseño de la transición desde la orquestación monolítica actual.

## 4. Arquitectura actual
Actualmente (en `src/app/actions/integraciones/bsale-sync.ts`), la orquestación es monolítica. Operaciones como `syncBsalePayments`, `syncBsaleSales`, `syncBsaleCatalog` o `syncBsaleCosts` repiten lógicas de `fetch`, paginación, manejo rudimentario de rate limits y lógica de upserts.

## 5. Problemas actuales
- Tablas de control duplicadas o inexistentes por recurso.
- Manejo de rate limiting inconsistente (no global).
- Falta de coordinación entre crons.
- Dependencias implícitas o inexistentes.
- Cursores locales acoplados a la función (ej. ventanas fijas de 14 días).
- Difícil de extender.

## 6. Principios
- **Separación de responsabilidades**: Núcleo orquesta y protege; Extensiones procesan y persisten.
- **Bsale es soberano**: El motor refleja fielmente el origen.
- **Idempotencia obligatoria**: Toda tarea debe ser repetible sin corromper datos.
- **Tolerancia a fallos**: Backoff automático y reanudación desde cursores exactos.

## 7. Núcleo genérico
Responsable exclusivo de:
- **Task Registry & Dependency Resolver**: Inscribe tareas y calcula el grafo de ejecución.
- **Run Orchestrator & Task Runner**: Ejecuta tareas en orden.
- **Bsale API Client & Rate Limiter**: Cliente HTTP único con Token Bucket compartido.
- **Cursor Manager**: Persiste y avanza cursores con seguridad.
- **Error Handler & Metrics**: Atrapa excepciones y genera métricas estándar.
*Restricción: El núcleo jamás conoce reglas de cobranza o estructura de tablas destino.*

## 8. Extensiones
Responsables de:
- Parsear y validar el payload de un recurso específico.
- Definir su lógica de Upsert atómica o reemplazo relacional.
- Transformar `state` o referencias.
- (Ejemplos: `clientes`, `pagos`, `stock`, `reparacion_deuda`).

## 9. Registro de tareas
Un registro central en memoria que asocia un `task_code` con su definición de extensión.
Conceptualmente permite:
- `bsale.clients`
- `bsale.documents`
- `bsale.payments`
- `bsale.receivables_reconciliation`

## 10. Contrato de tarea
Toda extensión debe exportar una definición que contenga:
- `task_code`, `version`, `description`, `resource_type`, `endpoint`, `supported_modes`.
- `dependencies` (array de task_codes).
- `cursor_strategy`, `pagination_strategy`, `idempotency_strategy`, `lock_scope`, `transaction_scope`.
- `rate_limit_group`, `retry_policy`.
Y métodos obligatorios (Hooks):
- `build_request(cursor, mode)`
- `normalize(payload)`
- `persist(batch)`

## 11. Tipos de tarea
- **CATALOG**: Datos maestros, mutación lenta (`clientes`, `productos`).
- **TRANSACTIONAL**: Operaciones incrementales (`documentos`, `pagos`).
- **SNAPSHOT**: Estados point-in-time (`stock actual`).
- **RELATIONAL**: Vínculos destructivos (`aplicaciones de pago`).
- **RECONCILIATION**: Cruce lógico, solo lectura.
- **REPAIR**: Intervención profunda dirigida.
- **BACKFILL**: Llenado histórico masivo.

## 12. Modos
- **INCREMENTAL**: Trae deltas (desde último cursor). Repetible.
- **FULL**: Trae todo (generalmente ignora cursor previo).
- **BACKFILL**: Ejecución segmentada por fecha.
- **REPAIR**: Acción correctiva puntual.
- **RECONCILIATION**: Ejecución de contrastes.
- **MANUAL**: Lanzado por usuario, ignora schedules.

## 13. Dependencias
Grafo explícito evaluado por `Dependency Resolver`.
Ejemplo: `documents -> document_details`, `clients -> documents`.
- Detecta ciclos al inicio.
- Si una dependencia falla, las dependientes se marcan como `WAITING_DEPENDENCY` o `SKIPPED`.

## 14. Estados
- **Run**: `PENDING`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_WARNINGS`, `FAILED`, `CANCELLED`.
- **Step**: `PENDING`, `WAITING_DEPENDENCY`, `RUNNING`, `COMPLETED`, `SKIPPED`, `FAILED`, `CANCELLED`.
- **Task Item/Batch**: `PENDING`, `PROCESSING`, `SUCCEEDED`, `RETRY_PENDING`, `FAILED`, `REQUIRES_REVIEW`.

## 15. Idempotencia
- **Run programado:** `company_id + run_type + scheduled_for_at`
- **Step:** `run_id + task_code + attempt_number`
- **Recurso Bsale:** `company_id + task_code + source_id + source_hash`
- **Backfill:** `company_id + task_code + range_start + range_end`
- **Reparación:** `company_id + task_code + scope_id + mismatch_fingerprint`

## 16. Cursores
Estrategias soportadas:
- `OFFSET`: Paginación numérica simple.
- `SOURCE_DATE`: Filtro por fecha (`recorddate` o similar).
- `SOURCE_ID`: Secuencial basado en ID.
- `COMPOSITE`, `SNAPSHOT`, `NONE`.
*Regla de oro:* El cursor avanza solo si la capa de persistencia confirma el éxito del lote.

## 17. Paginación
- Límite por página configurable (común: 50 o 100).
- Abstracción de parámetros (`limit`, `offset`).
- Mecanismo genérico de reanudación si un batch falla.

## 18. Rate limiting
- Shared **Rate Limiter** a nivel de `Bsale API Client`.
- `max_concurrency` (llamadas concurrentes) vs `request_rate_per_second`.
- Implementación vía Token Bucket con `Retry-After` parseado.
- Evita starvation (backfill vs incremental) con priorización de colas.

## 19. Prioridades
- **CRITICAL**: `pagos recientes`, `reparación`
- **HIGH**: `documentos recientes`
- **NORMAL**: `clientes`, `reconciliación nocturna`
- **LOW / BACKGROUND**: `backfill histórico`

## 20. Concurrencia
- Ámbitos de Lock: `GLOBAL_BSALE`, `COMPANY`, `TASK`, `RESOURCE`, `CUSTOMER`.
- **Regla obligatoria:** `fetch remoto → validar → tomar lock → tx corta → liberar lock`.
Nunca HTTP dentro de TX.

## 21. Transacciones
Definidas por la extensión (Contrato `transaction_scope`):
- Por recurso (pago).
- Por cliente.
- Por lote/cursor.
El núcleo provee un wrapper, la extensión ejecuta la SQL.

## 22. Errores
- `RATE_LIMIT`, `NETWORK_ERROR`, `TIMEOUT`, `BSALE_5XX`: Transitorios, reintentables.
- `AUTH_ERROR`, `CONFIG_ERROR`, `INVALID_PAYLOAD`, `CONSTRAINT_ERROR`: Fatales, `REQUIRES_REVIEW`.

## 23. Reintentos
- Reintentos por request HTTP (ej: 429).
- Reintentos por batch lógico (ej: deadlock en BD).
- Backoff exponencial con jitter. Controlados por `attempt_number`.

## 24. Observabilidad
Métricas obligatorias: `runs_started`, `steps_completed`, `rate_limits`, `retries`, `records_created`, `records_invalid`.
Debe exponer estados globales: `HEALTHY`, `RUNNING`, `DEGRADED`, `STALE`, `FAILED`.

## 25. Configuración
Configurable vía BD persistida o variables de entorno (separado por `company_id`): `enabled`, `schedule`, `window_days`, `page_size`, `max_concurrency`, `timeout`, `max_retries`.

## 26. Seguridad
- Ejecución exclusiva Server-Side.
- Token Bsale seguro.
- Auditable: RLS en vistas de observabilidad.
- Los logs no deben incluir datos personales sensibles (ej. redacción de rut o correo en el error `INVALID_PAYLOAD`).

## 27. Incorporación de tareas
Procedimiento:
1. Definir `task_code` y `task_type`.
2. Declarar endpoint y dependencias.
3. Elegir cursor y normalizador.
4. Definir persistencia (SQL/RPC) y clave única.
5. Inscribir en `Task Registry`.
6. Habilitar configuración.

## 28. Versionado
Contrato con versión (ej. `bsale.payments@1`).
Al cambiar payload de forma rompedora, se crea `@2` manteniendo backward compatibility para historicos si es necesario.

## 29. Compatibilidad
Transición (estranger pattern):
- **Fase 1**: Motor y observabilidad desplegados.
- **Fase 2-5**: Adaptar clientes, luego documentos, luego pagos a tareas del nuevo motor.
- **Fase 6**: Retirar scripts monolíticos antiguos.

## 30. Objetos futuros
Indispensables:
- `integraciones.bsale_sync_runs`
- `integraciones.bsale_sync_steps`
- `integraciones.bsale_sync_cursors`
- `integraciones.bsale_sync_task_config`
- `integraciones.bsale_sync_errors`
Los objetos financieros (reconciliación) son separados.

## 31. Límites
El motor **NO** debe: calcular deuda, aplicar reglas comerciales, modificar Bsale, ni solucionar errores de data relacional silenciosamente sin contrato de reparación.

## 32. Arquitectura de carpetas
```text
src/lib/integraciones/bsale/
├── core/         (client, orchestrator, registry, runner, limiter...)
├── tasks/        (clients, documents, payments, stock...)
├── reconciliation/(receivables)
└── repositories/
```

## 33. Plan de transición
1. CV-1B construirá el `core` y los objetos de estado.
2. Migrar `clientes` y `pagos` hacia la estructura `tasks/`.
3. Activar en paralelo (Shadow mode) o sustituir progresivamente los crons.

## 34. Criterios de aceptación
- Contratos abstractos listos.
- Paginación y rate-limit unificados.
- Agregar tarea = solo agregar extensión.
- Módulo CV operable como extensión.

## 35. Riesgos
- Overhead inicial de orquestación.

## 36. Bloqueadores
- Ninguno técnico. Depende del avance a CV-1B.

## 37. Conclusión
Este estándar asegura que PetGroup posea un middleware robusto de nivel Enterprise capaz de absorber cualquier requerimiento futuro de Bsale (operativo o analítico) sin duplicar deuda técnica.

## 38. Archivos revisados
- `src/app/actions/integraciones/bsale-sync.ts`
