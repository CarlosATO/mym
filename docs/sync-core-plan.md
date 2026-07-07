# Sync Core Plan (Infraestructura)

El módulo **Sync Core** provee una infraestructura unificada y segura en el schema `integraciones` para sincronizar datos bidireccionales de manera controlada y resiliente.

## Componentes

### 1. Tablas en schema `integraciones`
- `sync_runs`: Almacena el registro histórico de cada ejecución (estado, triggers, contadores, timestamps).
- `sync_locks`: Garantiza que solo un proceso a la vez interactúe con el proveedor y entidad para evitar duplicaciones o race conditions.
- `sync_errors`: Registro de errores a nivel fila/item para mejor trazabilidad, sin exponer `raw_payload`.
- `sync_job_configs`: Tabla de configuración de cron jobs (habilitado/deshabilitado, frecuencia esperada).

### 2. Librería Core (`src/lib/integraciones/sync-core.ts`)
- Funciones modulares (`createSyncRun`, `finishSyncRun`, `tryAcquireSyncLock`, etc) para abstraer la interacción de BD hacia un flujo controlado con `try/finally`.

### 3. Rutas y Endpoints
- **CLI**: Mantenemos los scripts en `/scripts` para triggers manuales y validación en CI/CD.
- **Server Actions**: Disponibles para gatillar por UI (ej. botón "Forzar Sincronización").
- **API Cron**: Endpoints en `/api/integraciones/.../sync` con validación estricta de `CRON_SECRET` para que plataformas externas lancen sincronizaciones programadas (ej. 30 min).

## Alcance
Actualmente solo se encuentra configurado e integrado el puente `BSALE` / `clients`.
Productos, proveedores y documentos se añadirán iterativamente a este mismo ecosistema.
