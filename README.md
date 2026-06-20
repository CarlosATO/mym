# Distribuidora MYM — Sistema Interno de Gestión

# Pruebas locales e inicio

** Servidor frontend 
npn run dev

** Servidor backend

npx supabase start

Nota: en desarrollo debemos ejecutar docker para levantar supabase local




Ecosistema digital interno para la operación de Distribuidora MYM.

**No es un SaaS comercial.** Sistema monoinquilino, sin registro público.

---

## Stack Tecnológico

| Capa | Tecnología |
|---|---|
| Frontend | Next.js 16 (App Router), React, Tailwind CSS |
| UI | Shadcn UI |
| Backend/DB | Supabase (PostgreSQL 15) |
| Auth | Supabase Auth |
| Migraciones | SQL en `supabase/migrations/` |

---

## Requisitos Previos

- **Docker Desktop** (para Supabase local)
- **Node.js** 18+
- **npm**

---

## Setup Inicial

```bash
# 1. Clonar el repositorio
git clone <repo-url>
cd "Dist. MyM"

# 2. Instalar dependencias
npm install

# 3. Iniciar Supabase local
npx supabase start

# 4. Copiar credenciales de Supabase a .env.local
#    (usar las que muestra `npx supabase start`)
#    NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
#    NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
#    SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# 5. Aplicar migraciones
npx supabase db reset

# 6. Iniciar Next.js
npm run dev
```

---

## Admin Bootstrap

Después del primer `supabase db reset`, crear el administrador inicial:

```bash
# Opción 1: Usando Supabase Studio
# Abrir http://127.0.0.1:54323 → SQL Editor → ejecutar:
```

```sql
-- Opción 2: Directo en terminal
# Primero crear auth user via admin API:
node -e "
const { createClient } = require('@supabase/supabase-js');
const adm = createClient(
  'http://127.0.0.1:54321',
  'SUPABASE_SERVICE_ROLE_KEY',
  { auth: { autoRefreshToken: false, persistSession: false } }
);
adm.auth.admin.createUser({
  email: 'admin@mym.cl',
  password: 'Admin123!',
  email_confirm: true
}).then(r => {
  if (!r.error) {
    console.log('Auth user created:', r.data.user.id);
    // Sync to portal.users
    const { createClient } = require('@supabase/supabase-js');
    const adm2 = createClient(
      'http://127.0.0.1:54321',
      'SUPABASE_SERVICE_ROLE_KEY',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    adm2.rpc('create_user_profile', {
      p_user_id: r.data.user.id,
      p_email: 'admin@mym.cl',
      p_nombre: 'Admin',
      p_apellido: 'MYM',
      p_role_id: (await adm2.from('roles').select('id').eq('name','SUPER_USUARIO').single()).data.id,
      p_created_by: null
    }).then(console.log('Profile synced'));
  }
});
```

---

## ⚠️ Regla Crítica — Prohibición de `supabase db reset`

**Queda prohibido ejecutar `supabase db reset` durante tareas de mejora, diseño o corrección funcional sin autorización explícita del responsable del proyecto.**

`supabase db reset` destruye la base local completa y recrea solo migraciones/seeds, eliminando usuarios creados manualmente y datos de prueba.

Para aplicar nuevas migraciones usar preferentemente:

```bash
npx supabase migration up
```

Antes de cualquier operación destructiva, informar el riesgo y pedir aprobación.

---

## Comandos Útiles

```bash
# Ver estado de Supabase
npx supabase status

# Abrir Supabase Studio
open http://127.0.0.1:54323

# Iniciar servidor de desarrollo
npm run dev

# Build de producción
npm run build
```

---

## Probar el Sistema

1. Abrir `http://localhost:3000`
2. Login con `admin@mym.cl` / `Admin123!`
3. Se redirigirá a `/change-password` (primer inicio)
4. Cambiar contraseña
5. Dashboard con 6 tarjetas de módulo
6. Navegar a **Usuarios** para ABM
7. Adquisiciones aparece como bloqueado "Próximamente"

---

## Estructura del Proyecto

```
src/
├── app/
│   ├── login/            # Página de login
│   ├── change-password/  # Cambio forzado de contraseña
│   ├── dashboard/        # Layout + páginas del dashboard
│   │   ├── usuarios/     # ABM Usuarios
│   │   ├── roles/        # Placeholder
│   │   ├── auditoria/    # Placeholder
│   │   └── seguridad/    # Placeholder
│   └── actions/          # Server actions (auth, users)
├── components/           # Componentes React
├── lib/
│   ├── supabase/         # Clients (browser, server, admin)
│   └── types.ts          # Interfaces compartidas
└── middleware.ts         # Protección de rutas
supabase/
├── config.toml
└── migrations/           # 12 migraciones SQL
docs/
└── FOUNDATION_CHECKPOINT.md
```

---

## Estado del Proyecto

**Fase actual:** Fundación del Portal — COMPLETADA ✅

- Schema `portal` con 9 tablas
- Autenticación con Supabase Auth
- RBAC con 5 roles y 12 permisos
- RLS activado en todas las tablas
- Auditoría automática via triggers
- Login, Dashboard, ABM Usuarios funcionales
- 17/17 pruebas de validación aprobadas

**Próxima fase:** Módulos de Negocio (pendiente de autorización)
