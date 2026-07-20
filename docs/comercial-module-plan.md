# Plan Módulo Comercial (Clientes y Ventas)

## FASE 1 — Esqueleto del módulo Comercial
- Se agregó el módulo Comercial en el portal (`src/app/dashboard/page.tsx`).
- Se creó la ruta base `src/app/dashboard/comercial/` (con layout global, submenú y ribbon).
- Se definieron los menús: Inicio, Maestros, Transacciones, Consultas, Reportes.
- El Ribbon inicial de Maestros tiene activa solo la opción "Clientes".
- Se configuraron los permisos siguiendo el estándar (`comercial.customers.*`).

## FASE 2 — Schema comercial y tabla customers
- Se creó la migración `supabase/migrations/20260706201500_create_comercial_customers.sql`.
- Genera esquema `comercial` y la tabla `comercial.customers`.
- Contiene los campos requeridos (company_id, source, bsale_client_id, rut, business_name, etc.).
- Políticas RLS creadas basadas en `company_id`.

## FASE 3 — Actions de clientes
- Archivo `src/app/actions/comercial/customers.ts`.
- Métodos CRUD creados: `getCustomers`, `createCustomer`, `updateCustomer`, `deactivateCustomer`.
- Se valida obligatoriedad de Razón Social y que el origen sea `MANUAL` al crear.
- Lógica de desactivación lógica (soft-delete) implementada.

## FASE 4 — UI: Creación y mantención de clientes
- Creado `src/modules/comercial/customers-panel.tsx`.
- Listado tipo DataGrid con columnas de estado, RUT, Nombre, Info Contacto, Origen y Acciones.
- Formulario de pantalla para nuevo cliente con 5 secciones: Identificación, Contacto, Dirección, Comercial, Observaciones, Integración Bsale (solo lectura si aplica).

## FASE 5 — Auditoría segura de clientes Bsale
- Se documentaron los hallazgos en `docs/bsale-customers-audit.md`.
- El script `scripts/audit_bsale_clients.ts` extrae de Bsale y enmascara los datos correctamente.
- Bsale provee 471 clientes activos listos para su futura ingesta controlada.

## FASE 6 — Importación Inicial (Sincronización manual)
- Se ejecutó el script `scripts/sync_bsale_clients.ts` volcando 482 clientes Bsale hacia PetGroup.
- La tabla de operaciones de UI es `comercial.customers`.
- La tabla espejo técnico de retención (raw data) es `integraciones.bsale_clients`.
- **Nota estricta:** Bsale no fue modificado (sólo operaciones GET).

## FASE 7 — UX y Reglas de Edición (Master-Detail y Bloqueo BSALE)
- Se implementó un panel lateral fijo (Global Drawer) para el detalle de cliente.
- **Regla estricta:** Para los clientes con `source = BSALE`, los campos nativos (rut, razón social, contactos, etc.) son **SÓLO LECTURA** tanto visualmente como a nivel de backend.
- Solo se permite editar el campo `notes` (Notas internas) como dato administrativo de PetGroup.
- El sistema informa claramente al usuario que cualquier cambio origen se debe realizar en Bsale.

## FASE 8 — Sincronización Automática (Sync Core Integrado)
- Se desarrolló e integró la infraestructura general `Sync Core` en el schema `integraciones`.
- Bsale Clients es el primer puente conectado a esta infraestructura.
- **UI:** Se incluyó un banner con el estado dinámico en la lista de Clientes y un botón "Forzar sincronización".
- **Backend:** Se creó el endpoint `POST /api/integraciones/bsale/clients/sync` preparado para un servicio Cron externo (cada 30 mins) validando la variable `CRON_SECRET`.
- **Protección de Datos:** Se protegen las `notes` en PetGroup; `Sync Core` cuenta con manejo de bloqueos por entidad (`sync_locks`), contadores e historial en `sync_runs`.
- (La escritura o actualización desde PetGroup hacia Bsale queda aplazada y documentada en `docs/bsale-customer-writeback-plan.md`).
