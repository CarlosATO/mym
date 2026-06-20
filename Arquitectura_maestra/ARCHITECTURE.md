# ARQUITECTURA MAESTRA DEL PROYECTO MYM

## 1. Visión General

MYM es un ecosistema digital interno desarrollado exclusivamente para la operación de Distribuidora MYM.

No es un SaaS comercial.

No existen:

* registros públicos
* planes de suscripción
* multiempresa
* Stripe
* marketplace
* acceso externo

Todo usuario pertenece a una única organización.

El objetivo es centralizar, controlar y digitalizar los procesos internos de la empresa mediante una plataforma modular, segura y auditable.

---

# 2. Principios Arquitectónicos

## Fuente Única de Verdad

La base de datos PostgreSQL es la única fuente de verdad.

El frontend jamás debe contener lógica crítica de negocio.

Toda validación importante debe ejecutarse en backend o base de datos.

---

## Seguridad Primero

La seguridad no depende del frontend.

Toda autorización debe validarse mediante:

* PostgreSQL
* RLS (Row Level Security)
* Roles
* Permisos

---

## Auditoría Total

Toda acción crítica debe quedar registrada.

El sistema debe permitir conocer:

* quién realizó una acción
* cuándo la realizó
* qué cambió
* cuál era el valor anterior
* cuál es el valor nuevo

---

## Modularidad

Cada módulo de negocio debe ser independiente.

Los módulos compartirán:

* autenticación
* usuarios
* roles
* permisos
* auditoría

pero mantendrán su propia estructura funcional.

---

# 3. Stack Tecnológico Oficial

## Frontend

* Next.js App Router
* React
* Tailwind CSS
* Shadcn UI

## Backend

* Supabase
* PostgreSQL
* Supabase Auth

## Desarrollo

* Supabase Local
* Migraciones SQL
* Git

---

# 4. Estructura de Base de Datos

La base de datos estará organizada mediante schemas.

Cada dominio funcional tendrá su propio schema.

Ejemplo:

portal
adquisiciones
inventario
ventas
finanzas
rrhh

No se utilizará el schema public como contenedor principal de tablas de negocio.

public quedará reservado para elementos compartidos y funciones auxiliares globales.

---

# 5. Gestión de Migraciones

Existe una única carpeta Supabase para todo el ecosistema.

Estructura oficial:

supabase/
├── config.toml
├── seed.sql
└── migrations/

Está prohibido crear carpetas Supabase independientes para cada módulo.

Incorrecto:

adquisiciones/supabase/
inventario/supabase/

Correcto:

supabase/migrations/

Todas las migraciones del sistema deberán almacenarse en dicha carpeta.

### ⚠️ Regla Crítica — `supabase db reset`

**Queda prohibido ejecutar `supabase db reset` durante tareas de mejora, diseño o corrección funcional sin autorización explícita del responsable del proyecto.**

`supabase db reset` destruye la base local completa y recrea solo migraciones/seeds, eliminando usuarios creados manualmente y datos de prueba.

Para aplicar nuevas migraciones usar preferentemente:

```bash
npx supabase migration up
```

Antes de cualquier operación destructiva, informar el riesgo y pedir aprobación.

---

# 6. Fase Actual del Proyecto

Actualmente NO se desarrollarán módulos de negocio.

No se implementarán todavía:

* adquisiciones
* inventario
* ventas
* proveedores
* órdenes de compra
* logística
* finanzas
* recursos humanos

La prioridad absoluta es construir la fundación del sistema.

---

# 7. Alcance de la Fundación (Portal)

El schema portal será el núcleo del sistema.

Contendrá:

## Usuarios

* creación
* edición
* activación
* desactivación
* reinicio de contraseña

## Roles

Roles generales del sistema.

Inicialmente:

* SUPER_USUARIO
* GERENCIA
* FINANZAS
* BODEGA
* VENDEDOR

## Permisos

Permisos granulares independientes de los roles.

Ejemplos:

* usuarios.view
* usuarios.create
* usuarios.update
* usuarios.deactivate
* roles.view
* roles.assign
* modules.view
* modules.manage
* audit.view

## Módulos

Registro central de los módulos disponibles dentro del portal.

Inicialmente solo existirán como tarjetas visuales.

No tendrán lógica de negocio.

## Auditoría

Registro completo de acciones operacionales.

## Seguridad

Registro completo de eventos de autenticación y acceso.

---

# 8. Gestión de Usuarios

No existirá registro público.

Flujo oficial:

1. SUPER_USUARIO crea usuario.
2. El sistema genera contraseña temporal.
3. Se entrega la contraseña al empleado.
4. El usuario inicia sesión.
5. Se fuerza cambio de contraseña.
6. Recién después obtiene acceso al portal.

---

# 9. Convenciones de Desarrollo

## Tablas

Siempre en plural.

Ejemplos:

portal.users
portal.roles
portal.permissions

---

## Funciones

Nombradas según su acción.

Ejemplos:

portal.create_user()
portal.reset_password()

---

## Vistas

Prefijo:

v_

Ejemplos:

portal.v_users

---

## Triggers

Prefijo:

trg_

Ejemplos:

trg_audit_users

---

## Índices

Prefijo:

idx_

Ejemplos:

idx_users_email

---

# 10. Regla de Oro

Antes de desarrollar cualquier módulo de negocio, la fundación del portal debe estar completamente terminada, probada y auditada.

No se autoriza avanzar a módulos operacionales hasta finalizar:

* autenticación
* usuarios
* roles
* permisos
* módulos
* auditoría
* seguridad
* dashboard principal
* protección de rutas

La estabilidad de esta fundación tiene prioridad sobre cualquier funcionalidad futura.

---

# 11. Estado Validado de la Fundación (CHECKPOINT)

## Versión: 1.0.0 — Fundación Completada

Fecha de cierre: 2026-06-04

## Migraciones Aplicadas (12 archivos)

| Migración | Contenido |
|---|---|
| `00001_create_schema_portal.sql` | Schema `portal`, extensiones `pgcrypto`, `uuid-ossp` |
| `00002_create_tables_core.sql` | `roles`, `modules`, `permissions` |
| `00003_create_table_users.sql` | `users` (FK → `auth.users` + `portal.roles`) |
| `00004_create_tables_junction.sql` | `role_permissions`, `user_permissions`, `user_modules` |
| `00005_create_tables_audit.sql` | `audit_logs`, `security_logs` |
| `00006_create_functions.sql` | `has_permission`, `get_user_permissions`, `create_user_profile`, `log_security_event`, `get_visible_modules` |
| `00007_create_triggers.sql` | Triggers `updated_at`, `updated_by`, auditoría (7 tablas) |
| `00008_seed_data.sql` | 5 roles, 6 módulos, 12 permisos, 21 role_permissions |
| `00009_create_rls.sql` | RLS + políticas en 9 tablas, grants |
| `00010_add_foreign_keys.sql` | FKs para `created_by`/`updated_by` |
| `00011_create_user_has_permission.sql` | `user_has_permission(p_user_id, p_permission_code)`, refactor `get_visible_modules` |
| `00012_public_wrappers.sql` | Wrapper `public.get_visible_modules` (REST API) |

## Tablas del Schema `portal` (9)

| Tabla | Propósito | RLS |
|---|---|---|
| `users` | Perfiles de usuario vinculados a `auth.users` | ✅ |
| `roles` | Roles del sistema (SUPER_USUARIO, GERENCIA, etc.) | ✅ |
| `permissions` | Permisos granulares (`usuarios.view`, `system.admin`, etc.) | ✅ |
| `modules` | Registro de módulos disponibles en el portal | ✅ |
| `role_permissions` | Asignación de permisos a roles | ✅ |
| `user_permissions` | Overrides directos de permisos por usuario | ✅ |
| `user_modules` | Acceso a módulos por usuario | ✅ |
| `audit_logs` | Auditoría operacional (triggers automáticos) | ✅ |
| `security_logs` | Eventos de autenticación y seguridad | ✅ |

## Funciones (6)

| Función | Descripción |
|---|---|
| `portal.has_permission(p_permission_code)` | Verifica permiso del usuario autenticado vía `auth.uid()` |
| `portal.user_has_permission(p_user_id, p_permission_code)` | Verifica permiso de un usuario específico |
| `portal.get_user_permissions(p_user_id)` | Retorna todos los permisos de un usuario |
| `portal.create_user_profile(...)` | Sincroniza perfil en `portal.users` (usado desde server action) |
| `portal.log_security_event(...)` | Registra evento de seguridad |
| `portal.get_visible_modules(p_user_id)` | Retorna módulos visibles según permisos y asignaciones |

## Triggers (15)

- 7 triggers de auditoría (`trg_audit_users`, `trg_audit_roles`, `trg_audit_permissions`, `trg_audit_role_permissions`, `trg_audit_user_permissions`, `trg_audit_modules`, `trg_audit_user_modules`)
- 4 triggers de `updated_at`
- 4 triggers de `updated_by`

## Seed Data

| Entidad | Cantidad |
|---|---|
| Roles | 5 (SUPER_USUARIO, GERENCIA, FINANZAS, BODEGA, VENDEDOR) |
| Módulos | 6 (dashboard, usuarios, roles, adquisiciones, auditoria, seguridad) |
| Permisos | 12 (system.admin, dashboard.view, usuarios.*, roles.*, modules.*, audit.view, security.view) |
| Role-Permissions | 21 asignaciones |

## Pruebas de Validación (17/17)

| # | Prueba | Resultado |
|---|---|---|
| 1 | Login con credenciales | ✅ |
| 2 | Forzado de cambio de contraseña (`must_change_password`) | ✅ |
| 3 | Cambio de contraseña exitoso | ✅ |
| 4 | Re-login con nueva contraseña | ✅ |
| 5 | `security_logs` registra LOGIN_SUCCESS | ✅ |
| 6 | `security_logs` registra LOGOUT | ✅ |
| 7 | `get_visible_modules` retorna módulos | ✅ |
| 8 | SUPER_USUARIO ve 6 módulos | ✅ |
| 9 | Adquisiciones presente en lista | ✅ |
| 10 | Creación de usuario + contraseña temporal | ✅ |
| 11 | Persistencia en `portal.users` | ✅ |
| 12 | Edición de usuario | ✅ |
| 13 | Desactivación de usuario | ✅ |
| 14 | Reactivación de usuario | ✅ |
| 15 | `audit_logs` registra cambios en `users` | ✅ |
| 16 | Build de Next.js sin errores | ✅ |
| 17 | Sin tablas de negocio fuera de `portal` | ✅ |

## Restricciones Vigentes

- ❌ No existen tablas de negocio (adquisiciones, inventario, ventas, finanzas, proveedores, productos, órdenes de compra, RRHH)
- ❌ No existe lógica de negocio operacional
- ✅ Solo la fundación del portal está construida y probada
