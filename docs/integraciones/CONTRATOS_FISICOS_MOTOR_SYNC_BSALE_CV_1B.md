# Contratos Físicos del Motor Sync Bsale y Extensión Financiera (Fase CV-1B)

## 1. Resumen ejecutivo
Este documento define los contratos físicos de base de datos para la implementación del Motor Sync Bsale V2 y su extensión de Reconciliación Financiera. Corrige incompatibilidades con el modelo de ejecución heredado, respeta FKs activas (ej. `bsale_stock_current`), y formaliza el uso de RLS explícito, retención segura y dependencias.

## 2. Objetivo
Formalizar el modelo de datos de `integraciones.bsale_sync_v2_*` y `integraciones.bsale_reconciliation_*` bajo convenciones establecidas, delimitando la compatibilidad con el sistema de sincronización heredado y asegurando transición segura sin doble escritura descontrolada.

## 3. Alcance
Aplica al diseño de las tablas del esquema `integraciones` involucradas en CV-1B.
- **Núcleo genérico**: `bsale_sync_v2_runs`, `bsale_sync_v2_steps`, `bsale_sync_v2_cursors`, `bsale_sync_v2_task_config`, `bsale_sync_v2_errors`.
- **Financiero**: `bsale_reconciliation_runs`, `bsale_reconciliation_items`, `bsale_repair_queue`.

## 4. Auditoría de ambos modelos existentes
Se identificó la existencia de dos modelos previos:
- **`integraciones.sync_runs`**:
  - Migración creadora: `20260707173500_create_integraciones_sync_core.sql`.
  - Columnas: `provider`, `entity`, `trigger_type`, `status`, `started_at`, `finished_at`, `duration_ms`, métricas de count, `message`, `metadata`, `requested_by`, `created_at`.
  - PK: `id uuid primary key default gen_random_uuid()`.
  - Estados: `RUNNING`, `SUCCESS`, `FAILED`, `SKIPPED`. (Implementados vía `CHECK(status in (...))`).
  - Constraints: `chk_provider_not_empty`, `chk_entity_not_empty`.
  - Índices: `idx_sync_runs_company`, `idx_sync_runs_provider_entity`, `idx_sync_runs_status`, `idx_sync_runs_started`, `idx_sync_runs_compound`.
  - RLS: Habilitado (`ENABLE ROW LEVEL SECURITY`).
  - Grants: `SELECT, INSERT, UPDATE, DELETE` a `authenticated` y `service_role`. `ALL TABLES` a `service_role`.
  - Propietario: Rol ejecutor original (postgres).
  - FK entrantes: Ninguna conocida en este núcleo genérico.
- **`integraciones.bsale_sync_runs`**:
  - Migración creadora: Específica de una fase de Bsale heredada.
  - Columnas/Estados: Incompatibles con el nuevo estándar (usa `PARTIAL` que fue detectado previamente).
  - FK entrantes: `integraciones.bsale_stock_current` referencia estas ejecuciones históricas.
  - Jobs y crons: Existe un cron activo `syncBsalePayments`, `syncBsaleSales` que escribe y lee de aquí.
  - Diferencias funcionales: No agrupa correctamente por sub-tareas (steps) y el manejo de cursores está acoplado a ventanas fijas en código.
- **Datos remotos**: Miles de ejecuciones y logs operando actualmente en el modelo V1.

## 5. Estrategia de compatibilidad elegida
**CREAR_MODELO_V2_CON_TRANSICION**.
Se crea un modelo con el infijo `_v2_` para evitar colisiones funcionales destructivas en FKs activas (ej. `bsale_stock_current`).
- **Tabla canónica futura:** `integraciones.bsale_sync_v2_runs`.
- **Tablas legacy:** `integraciones.bsale_sync_runs` e `integraciones.sync_runs`.
- **Plan de Transición:**
  1. Las tareas V1 actuales siguen operando en el cron actual sin alteración (`bsale_sync_runs`).
  2. Las nuevas tareas construidas en CV-1B operarán exclusivamente en el modelo V2 (`bsale_sync_v2_runs`).
  3. No habrá dual-write (doble escritura temporal). Cada recurso Bsale (ej. clientes) pertenecerá a V1 o V2 exclusivamente durante la transición.
  4. Los `sync_run_id` históricos se conservan tal cual en las tablas hijas (`bsale_stock_current`). Cuando se porte "stock" a V2, simplemente empezará a inyectar UUIDs provenientes de `v2_runs`.
- **Desactivación:** Cuando todos los recursos (clientes, documentos, pagos, stock) hayan sido reescritos para el motor V2, el cron V1 se eliminará del código.
- **Rollback:** Si V2 falla gravemente en producción, basta con apagar las nuevas tareas V2 y reactivar las V1 en el código. Los datos de Bsale se re-sincronizarán desde el último cursor sano de V1, dado que la fuente de verdad (Bsale) no se modifica.

## 6. Retención corregida
No se establece eliminación automática de runs a 30 días.
- **`RUN_REFERENCIADO`**: Si el UUID del run existe como FK en tablas operacionales (ej. `bsale_stock_current`), está **estrictamente prohibido eliminarlo**.
- **`RUN_NO_REFERENCIADO`**: Archivable lógicamente (mover a tabla de frío) o eliminable físicamente si excede la política.
- **`ERROR_OPERACIONAL`**: Errores crudos (`v2_errors`) se resumen al transcurrir el tiempo definido en su política de log, dejando solo la traza en jsonb.
- **`MÉTRICA_AGREGADA`**: Se conserva a nivel histórico de la empresa.
- **Reglas mínimas:** Los cursores (`v2_cursors`) son un estado vivo indispensable. No se eliminan por ninguna retención ordinaria. La limpieza no usa términos sin fundamento normativo como "retención fiscal"; se basa puramente en optimización de almacenamiento respetando integridad referencial (FK) estricta.

## 7. RLS por tabla
No se afirma que RLS se activa a nivel esquema, sino por tabla:
```sql
ALTER TABLE integraciones.bsale_sync_v2_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_sync_v2_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_sync_v2_cursors ENABLE ROW LEVEL SECURITY;
-- y sucesivas...
```
- **Decisiones:**
  - Sin policies globales para `anon` y `authenticated`, quedando implícitamente denegados por defecto en operaciones de escritura.
  - Policy `SELECT` controlada para usuarios administrativos mediante validación `core.user_company_access`.
  - Escritura y mutación exclusiva del backend vía API/Cron (usando `service_role`).
  - El acceso a multiempresa está delimitado por `company_id`.
  - `FORCE ROW LEVEL SECURITY` se usará si roles intermedios pudiesen saltar las reglas, aunque `service_role` hará bypass natural.

## 8. Grants mínimos
Se elimina expresamente la concesión masiva `GRANT ... ON ALL TABLES`.
Se define grant explícito, tabla por tabla:
```sql
GRANT SELECT ON integraciones.bsale_sync_v2_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_runs TO service_role;
GRANT SELECT ON integraciones.bsale_sync_v2_steps TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_steps TO service_role;
GRANT SELECT ON integraciones.bsale_sync_v2_cursors TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_cursors TO service_role;
```
*(Se aplicará a cada tabla creada, revocando acceso genérico de `PUBLIC` o `anon`).*

## 9. Ownership
- **Propietario de las tablas:** Rol original ejecutor de migraciones (ej. `postgres` o `supabase_admin`). No se establece arbitrariamente `service_role` como owner sin evidencia de dicho uso.
- **Privilegios:** Se aplican grants explícitos para `service_role`. Revocación implícita de `PUBLIC`.

## 10. Idempotencia de runs

### Clave universal y manual
```sql
ALTER TABLE integraciones.bsale_sync_v2_runs
  ADD CONSTRAINT uq_bsale_sync_v2_runs_idempotency UNIQUE (company_id, idempotency_key);
```
- `idempotency_key` (text NOT NULL): En ejecuciones manuales, recibirá un UUID o Timestamp (ej. `"MANUAL_" || gen_random_uuid()`), lo que permite que existan varias el mismo día, pero no se repitan con el mismo token exacto si ocurre un retry HTTP.

### Ejecuciones programadas (Restricción Parcial)
Para garantizar una sola ejecución programada por ciclo:
```sql
CREATE UNIQUE INDEX idx_v2_runs_scheduled_idempotency
ON integraciones.bsale_sync_v2_runs (company_id, run_type, scheduled_for_at)
WHERE trigger_source = 'SCHEDULED';
```

### Steps (Historial por intento)
```sql
ALTER TABLE integraciones.bsale_sync_v2_steps
  ADD CONSTRAINT uq_bsale_sync_v2_steps_attempt UNIQUE (run_id, task_code, attempt_number);
```

## 11. Estados y Mapeo
- **Estados actuales reales (`bsale_sync_runs` V1):** `PARTIAL`, `SUCCESS`, `FAILED`, etc.
- **Estados nuevos (V2):**
  - **Runs:** `PENDING`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_WARNINGS`, `FAILED`, `CANCELLED`.
  - **Steps:** `PENDING`, `WAITING_DEPENDENCY`, `RUNNING`, `COMPLETED`, `SKIPPED`, `FAILED`, `CANCELLED`.
- **Mapeo de transición:** El estado `PARTIAL` es abandonado y reemplazado formalmente por `COMPLETED_WITH_WARNINGS`. Las filas históricas de V1 NO se migran y conservan sus estados V1. La transición ocurre tabla por tabla; cuando el nuevo motor inserta, usa V2 nativo.

## 12. Modelo de actores técnicos
- `requested_by uuid NULL` -> Referencia `portal.users(id)` **solo** para acciones originadas intencionalmente por un humano en la UI.
- `trigger_source text NOT NULL` -> Indica el origen semántico (SCHEDULED, MANUAL, API).
- `worker_id text NULL` -> Identifica qué pod/instancia procesa la fila, sin comprometer integridad. Scheduler, cron y service role no requieren crear un usuario técnico falso en `portal.users`.
- Todo actor humano que llene `requested_by` debe provenir de una sesión Backend debidamente autenticada (`auth.uid()`), jamás inyectado libremente desde el payload de un Frontend.

## 13. Advisory locks
Método determinista para obtener una clave de 64 bits para `pg_try_advisory_xact_lock`:
- `company_id + task_code` -> `hashtext(company_id::text || '_' || task_code::text)`
- `company_id + customer_id` -> `hashtext(company_id::text || '_' || customer_id::text)`
- **Uso:** `SELECT pg_try_advisory_xact_lock(hashtext('...'))`
- **Riesgo de colisión:** Matemáticamente posible por ser de 32/64 bits, pero estadísticamente despreciable para las decenas de tareas en el ecosistema PetGroup.
- **Alcance:** A nivel de transacción (`xact`), el lock se libera automáticamente al ejecutar COMMIT o ROLLBACK.
- **Prohibición estricta:** Está ABSOLUTAMENTE PROHIBIDO mantener este lock durante una llamada HTTP externa hacia Bsale. El patrón es:
  1. HTTP Fetch a Bsale
  2. Inicio Transacción
  3. Adquirir Lock
  4. Modificar DB / Upsert
  5. Commit (liberación lock automática).
- **Si no obtiene el lock:** `pg_try_advisory_xact_lock` retorna `false`. El worker debe abortar pacíficamente o encolarse, asumiendo que otro worker está persistiendo ese mismo alcance concurrentemente.

## 14. Veredicto
**APROBADO_PARA_CV_1B_1**

## 15. Bloqueadores
Ninguno documentado. Resoluciones físicas aprobadas y documentadas listamente para la ejecución de la fase de migraciones.
