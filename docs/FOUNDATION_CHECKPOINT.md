# CHECKPOINT TÉCNICO — Fundación del Portal MYM

> **Versión:** 1.0.0
> **Fecha:** 2026-06-04
> **Estado:** ✅ COMPLETADO Y VALIDADO

---

## Resumen de Migraciones

12 archivos SQL en `supabase/migrations/`:

| # | Archivo | Descripción |
|---|---|---|
| 01 | `00001_create_schema_portal.sql` | Schema `portal`, extensiones `pgcrypto`, `uuid-ossp` |
| 02 | `00002_create_tables_core.sql` | Tablas `roles`, `modules`, `permissions` |
| 03 | `00003_create_table_users.sql` | Tabla `users` (FK `auth.users` + `portal.roles`) |
| 04 | `00004_create_tables_junction.sql` | Tablas `role_permissions`, `user_permissions`, `user_modules` |
| 05 | `00005_create_tables_audit.sql` | Tablas `audit_logs`, `security_logs` |
| 06 | `00006_create_functions.sql` | Funciones `has_permission`, `get_user_permissions`, `create_user_profile`, `log_security_event`, `get_visible_modules` |
| 07 | `00007_create_triggers.sql` | Triggers `updated_at`, `updated_by`, auditoría (7 tablas) |
| 08 | `00008_seed_data.sql` | Seed: 5 roles, 6 módulos, 12 permisos, 21 role_permissions |
| 09 | `00009_create_rls.sql` | RLS en 9 tablas + policies + grants |
| 10 | `00010_add_foreign_keys.sql` | FKs `created_by`/`updated_by` |
| 11 | `00011_create_user_has_permission.sql` | `user_has_permission`, refactor `get_visible_modules` |
| 12 | `00012_public_wrappers.sql` | Wrapper `public.get_visible_modules` |

---

## Schema `portal` — 9 Tablas

### `users`
| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | `uuid` | PK → `auth.users.id` CASCADE |
| `email` | `varchar(255)` | NOT NULL, UNIQUE |
| `nombre` | `varchar(100)` | NOT NULL |
| `apellido` | `varchar(100)` | NOT NULL |
| `telefono` | `varchar(20)` | NULL |
| `avatar_url` | `text` | NULL |
| `role_id` | `uuid` | NOT NULL → `roles.id` |
| `is_active` | `boolean` | DEFAULT `true` |
| `must_change_password` | `boolean` | DEFAULT `true` |
| `last_login_at` | `timestamptz` | NULL |
| `created_by` | `uuid` | FK → `users.id` |
| `updated_by` | `uuid` | FK → `users.id` |
| `deleted_at` | `timestamptz` | NULL (soft delete) |

### `roles`
| Columna | Destacado |
|---|---|
| `name` | UNIQUE, valores: SUPER_USUARIO, GERENCIA, FINANZAS, BODEGA, VENDEDOR |
| `is_system` | Protege roles del sistema contra eliminación |

### `permissions`
| Columna | Destacado |
|---|---|
| `code` | UNIQUE, ej: `system.admin`, `usuarios.view`, `dashboard.view` |
| `module_id` | NULLABLE (permisos globales) |

### `modules`
| Columna | Destacado |
|---|---|
| `code` | UNIQUE, ej: `dashboard`, `usuarios`, `adquisiciones` |
| `icon` | Nombre del icono Lucide |
| `route` | Ruta frontend |

### `role_permissions`
- **UK:** `(role_id, permission_id)`
- **Cascade** en ambos FKs

### `user_permissions`
- **UK:** `(user_id, permission_id)`
- `granted = true` → concede permiso directo
- `granted = false` → revoca permiso (override sobre el rol)

### `user_modules`
- **UK:** `(user_id, module_id)`
- `is_active` → control de visibilidad por usuario

### `audit_logs`
- Poblada automáticamente por triggers en 7 tablas
- Almacena `old_data`/`new_data` como `jsonb`
- `action`: INSERT, UPDATE, DELETE

### `security_logs`
- Eventos: LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT, PASSWORD_CHANGE, PASSWORD_CHANGE_FORCED, ACCOUNT_CREATED, ACCOUNT_DEACTIVATED

---

## Funciones del Sistema (6)

### `portal.has_permission(p_permission_code varchar) → boolean`
- Usa `auth.uid()` internamente
- Verifica: system.admin bypass → revoke directo → grant directo → rol
- **Uso:** RLS policies, validaciones del usuario autenticado

### `portal.user_has_permission(p_user_id uuid, p_permission_code varchar) → boolean`
- Verifica permisos de un usuario específico
- Misma lógica que `has_permission` pero con `user_id` explícito
- **Uso:** validaciones server-side sobre otros usuarios

### `portal.get_user_permissions(p_user_id uuid) → table`
- Retorna todos los permisos efectivos de un usuario

### `portal.create_user_profile(p_user_id, p_email, p_nombre, p_apellido, p_role_id, p_created_by)`
- Sincroniza perfil en `portal.users` después de crear auth user
- **Uso:** server actions con service role

### `portal.log_security_event(p_event_type, p_success, ...)`
- Registra evento en `security_logs`

### `portal.get_visible_modules(p_user_id uuid) → table`
- Retorna módulos activos según permisos
- Usa `has_permission` o `user_has_permission` según el contexto (`auth.uid()` presente o no)

---

## RLS — Políticas por Tabla

| Tabla | Operaciones | Control |
|---|---|---|
| `roles` | SELECT | `roles.view` o `system.admin` |
| `roles` | INSERT/UPDATE/DELETE | Solo `system.admin` |
| `modules` | SELECT | `modules.view` o `system.admin` |
| `modules` | INSERT/UPDATE | `modules.manage` o `system.admin` |
| `permissions` | SELECT | `roles.view` o `system.admin` |
| `permissions` | INSERT/UPDATE | Solo `system.admin` |
| `users` | SELECT | Propio registro, `usuarios.view` o `system.admin` |
| `users` | INSERT | `usuarios.create` o `system.admin` |
| `users` | UPDATE | Propio registro, `usuarios.update`, `usuarios.deactivate` o `system.admin` |
| `role_permissions` | SELECT | `roles.view` o `system.admin` |
| `role_permissions` | INSERT/DELETE | `roles.assign` o `system.admin` |
| `user_permissions` | SELECT | `roles.view` o `system.admin` |
| `user_permissions` | INSERT/UPDATE/DELETE | `roles.assign` o `system.admin` |
| `user_modules` | SELECT | `modules.view` o `system.admin` |
| `user_modules` | INSERT/UPDATE/DELETE | `modules.manage` o `system.admin` |
| `audit_logs` | SELECT | `audit.view` o `system.admin` |
| `audit_logs` | INSERT | `true` (todos autenticados) |
| `security_logs` | SELECT | `security.view` o `system.admin` |
| `security_logs` | INSERT | `true` (todos autenticados) |

---

## Triggers (15)

### Auditoría (7)
- `trg_audit_users` → `users`
- `trg_audit_roles` → `roles`
- `trg_audit_permissions` → `permissions`
- `trg_audit_role_permissions` → `role_permissions`
- `trg_audit_user_permissions` → `user_permissions`
- `trg_audit_modules` → `modules`
- `trg_audit_user_modules` → `user_modules`

### Updated At (4)
- `trg_users_set_updated_at` → `users`
- `trg_roles_set_updated_at` → `roles`
- `trg_permissions_set_updated_at` → `permissions`
- `trg_modules_set_updated_at` → `modules`

### Updated By (4)
- `trg_users_set_updated_by` → `users`
- `trg_roles_set_updated_by` → `roles`
- `trg_permissions_set_updated_by` → `permissions`
- `trg_modules_set_updated_by` → `modules`

---

## Seed Data

```
Roles:
  SUPER_USUARIO, GERENCIA, FINANZAS, BODEGA, VENDEDOR

Módulos:
  dashboard    → /dashboard
  usuarios     → /dashboard/usuarios
  roles        → /dashboard/roles
  adquisiciones → /dashboard/adquisiciones (bloqueado)
  auditoria    → /dashboard/auditoria
  seguridad    → /dashboard/seguridad

Permisos (12):
  system.admin, dashboard.view,
  usuarios.view, usuarios.create, usuarios.update, usuarios.deactivate,
  roles.view, roles.assign,
  modules.view, modules.manage,
  audit.view, security.view

Role-Permissions (21):
  SUPER_USUARIO → todos (12)
  GERENCIA      → dashboard.view, usuarios.view, roles.view, modules.view, audit.view, security.view (6)
  FINANZAS      → dashboard.view (1)
  BODEGA        → dashboard.view (1)
  VENDEDOR      → dashboard.view (1)
```

---

## Frontend — Rutas y Componentes

| Ruta | Componente | Acceso |
|---|---|---|
| `/login` | `LoginForm` | Público |
| `/change-password` | `ChangePasswordForm` | Usuarios con `must_change_password=true` |
| `/dashboard` | `ModuleCard[]` | Usuarios autenticados |
| `/dashboard/usuarios` | `UsersTable` + `UserFormDialog` | Permiso `usuarios.view` |
| `/dashboard/roles` | Placeholder | Placeholder |
| `/dashboard/auditoria` | Placeholder | Placeholder |
| `/dashboard/seguridad` | Placeholder | Placeholder |

### Middleware (`src/middleware.ts`)
- Redirige a `/login` si no hay sesión
- Redirige a `/change-password` si `must_change_password=true`
- Redirige a `/dashboard` desde `/` si autenticado

---

## Pruebas de Validación

```
=== RESULTADO FINAL: 17 ✅, 0 ❌ ===

 1. ✅ Login exitoso: admin@mym.cl
 2. ✅ must_change_password = true → redirige a /change-password
 3. ✅ Contraseña cambiada, must_change_password = false
 4. ✅ Re-login exitoso con nueva contraseña
 5. ✅ security_logs registrados
 6. ✅ LOGOUT registrado en security_logs
 7. ✅ Módulos visibles: 6 → dashboard, usuarios, roles, adquisiciones, auditoria, seguridad
 8. ✅ SUPER_USUARIO ve los 6 módulos
 9. ✅ Adquisiciones presente: true
10. ✅ Usuario CREADO con contraseña temporal
11. ✅ Usuario LEÍDO en portal.users
12. ✅ Usuario EDITADO
13. ✅ Usuario DESACTIVADO (is_active=false)
14. ✅ Usuario REACTIVADO (is_active=true)
15. ✅ audit_logs para users registrados
16. ✅ Acciones: INSERT, UPDATE
17. ✅ No existen tablas de negocio fuera de portal
```

---

## Restricciones Vigentes

| Prohibición | Estado |
|---|---|
| Tablas de negocio (adquisiciones, inventario, ventas, etc.) | ❌ No existen |
| Lógica de negocio operacional | ❌ No existe |
| Módulos funcionales (Adquisiciones, etc.) | ❌ No implementados |
| Registro público (`/register`) | ❌ No existe |
| Tablas en schema `public` como contenedor principal | ❌ No se usa |

| Permiso | Estado |
|---|---|
| Schema `portal` como núcleo | ✅ Implementado |
| Migraciones SQL en `supabase/migrations/` | ✅ 12 archivos |
| RLS en todas las tablas | ✅ 9/9 |
| Auditoría automática via triggers | ✅ 7 tablas |
| Login + cambio forzado de contraseña | ✅ Funcional |
| Dashboard con módulos dinámicos | ✅ Funcional |
| ABM Usuarios (crear, editar, activar/desactivar) | ✅ Funcional |
| Contraseña temporal con copia al portapapeles | ✅ Funcional |
| 17/17 pruebas de validación | ✅ Aprobadas |
| Build de Next.js | ✅ Sin errores |

---

## Próximos Pasos (Fase 2)

Cuando se autorice:
- Schema `adquisiciones`
- Órdenes de compra, productos, proveedores
- Flujo de aprobaciones
- Integración con módulo de inventario

**La fundación del portal debe permanecer estable como base de todos los módulos futuros.**

---

## Auditoría Transversal

### `portal.audit_logs` — Tabla central de auditoría

`portal.audit_logs` es la tabla única y central de auditoría del sistema. No se crearán tablas `audit_logs` separadas por módulo.

### Columnas (versión evolucionada)

| Columna | Tipo | Descripción |
|---|---|---|
| `schema_name` | `varchar(50)` | Schema donde ocurrió la operación. DEFAULT `'portal'` |
| `module_code` | `varchar(50)` | Código del módulo. Ej: `PORTAL`, `ADQUISICIONES`. DEFAULT `'PORTAL'` |
| `event_type` | `varchar(100)` | Tipo de evento: `{tabla}_{OPERACION}`. Ej: `users_INSERT` |
| `severity` | `varchar(20)` | Severidad: `CRITICAL` (users, roles, permissions) o `INFO` |
| `metadata` | `jsonb` | Metadatos adicionales. DEFAULT `'{}'` |
| `diff_data` | `jsonb` | Diferencial calculado (futuro). NULL por ahora |

Las columnas originales (`table_name`, `record_id`, `action`, `old_data`, `new_data`, `performed_by`, `performed_at`, `ip_address`) se conservan sin cambios.

### Reglas para módulos futuros

- Todo módulo nuevo debe escribir en `portal.audit_logs`
- Debe informar `schema_name` (su propio schema) y `module_code` (código del módulo)
- No crear tablas de auditoría separadas
- La función `portal.audit_trigger()` se actualizará cuando un módulo registre sus tablas
- Si el volumen crece, se evaluará particionamiento por fecha

### Índices nuevos

| Índice | Columnas |
|---|---|
| `idx_audit_logs_module_date` | `(module_code, performed_at DESC)` |
| `idx_audit_logs_schema_table` | `(schema_name, table_name)` |
| `idx_audit_logs_event_type` | `(event_type)` |
| `idx_audit_logs_severity` | `(severity)` |

---

## Regla Global de UX para Módulos Operativos

**Fecha de adopción:** 2026-06-05
**Referencia:** Implementación del Catálogo de Productos

### Patrón obligatorio para todo mantenedor operativo

Todo nuevo módulo del sistema que maneje datos maestros (proveedores, productos, clientes, etc.) debe implementar el siguiente patrón de UX, basado en lo construido para el Catálogo de Productos:

#### 1. Búsqueda principal
- Input de texto libre que busque en los campos más relevantes (código, nombre, descripción, etc.).

#### 2. Filtros por campos relevantes
- Selectores desplegables con valores reales desde la base de datos o clasificadores maestros.
- No se deben hardcodear valores para filtros (marcas, categorías, estados, etc.).
- Incluir botón "Limpiar filtros" que resetee todos los filtros y la selección.

#### 3. Selección individual
- Checkbox por fila en vista tabla.
- Click en tarjeta en vista tarjetas.

#### 4. Selección masiva visible
- Checkbox en encabezado de tabla para seleccionar/deseleccionar todos los registros visibles en la página actual.
- Contador: "X registros seleccionados".

#### 5. Vista tabla
- Tabla ejecutiva con columnas relevantes, ordenamiento y paginación.
- Imagen del registro si aplica (thumbnail).

#### 6. Vista tarjetas
- Obligatoria cuando el registro tenga valor visual (imágenes, fotos, gráficos).
- Opcional para datos puramente textuales.
- La selección debe mantenerse al cambiar entre tabla y tarjetas.

#### 7. Exportación Excel
- Botón "Exportar Excel" con menú desplegable de tres opciones:
  1. **Exportar todos** — exporta todos los registros del módulo.
  2. **Exportar filtrados** — exporta solo los registros que cumplen los filtros activos.
  3. **Exportar seleccionados** — disponible solo si hay registros seleccionados.
- Archivo nombrado como: `{modulo}_mym_YYYYMMDD.xlsx`.
- Columnas exactamente iguales a la plantilla de importación.
- Imagen exportada como `image_url` (texto), no como archivo.

#### 8. Importación Excel
- Plantilla oficial descargable con encabezados y fila de ejemplo.
- Validación previa: todas las filas se validan antes de insertar.
- Si existe al menos un error, se bloquea la importación completa.
- SKU/códigos duplicados en el archivo se detectan antes de consultar la BD.
- SKU/códigos existentes en BD se detectan antes de insertar.
- El contador de importados debe ser siempre `insert().select().data.length`, no filas leídas ni filas "válidas".
- Sin datos mock.

#### 9. Alineación formulario ↔ plantilla
- No puede existir una columna en la plantilla Excel que no tenga un campo correspondiente en el formulario manual.
- Las excepciones deben ser campos técnicos claramente justificados (ej: `image_url` se asigna automáticamente al subir archivo).
- El orden y nombre de columnas debe ser coherente entre formulario y plantilla.

#### 10. Paginación
- 50 registros por página por defecto.
- Selector de cantidad: 25 / 50 / 100.
- Controles Anterior / Siguiente.
- Contador: "X de Y registros".

#### 11. Seguridad
- Los permisos de CRUD, importación y exportación deben ser independientes y asignables por rol.
- El botón exportar solo debe mostrarse si el usuario tiene el permiso correspondiente.

#### 12. Validación de inserción
- Siempre usar `.insert(payload).select()` para confirmar la escritura real en la base de datos.
- Si `data` es null o `data.length === 0`, reportar error: "No se insertó el registro".
- No contar como importado algo que no fue confirmado por `insert().select().data.length`.
