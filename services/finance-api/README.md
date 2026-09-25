# PetGroup Finance API

Esqueleto mínimo del servicio futuro de Control Financiero.

## Alcance actual

Este bloque solo proporciona:

- FastAPI;
- configuración `APP_ENV`, `APP_VERSION` y `LOG_LEVEL`;
- configuración opcional y no hardcodeada `DATABASE_RUNTIME_DSN`;
- conectividad PostgreSQL síncrona mediante SQLAlchemy 2 y Psycopg 3;
- engine y `sessionmaker` con pool pequeño, `pool_pre_ping` y timeouts;
- `GET /health/live`;
- `GET /health/ready`;
- `GET /auth/me` protegido por Supabase Auth;
- `GET /auth/context` protegido por Supabase Auth y acceso a empresa;
- tests de health checks y autenticación.

`/health/ready` ejecuta `SELECT 1` contra PostgreSQL cuando `DATABASE_RUNTIME_DSN` está configurado. Sin ese valor responde `503`; no usa otro DSN como sustituto.

La autenticación de identidad valida el access token contra Supabase Auth usando `SUPABASE_URL` y `SUPABASE_ANON_KEY`. El contexto de empresa valida `X-Company-Id` mediante `core.has_company_access`, y el helper `require_company_permission` deja preparada la autorización funcional server-side. No se implementan todavía Alembic, BSale, bancos, schema `finanzas`, Docker, Railway ni endpoints financieros.

## Desarrollo local

Con `uv`:

```bash
uv sync --dev
uv run pytest
uv run uvicorn app.main:app --reload
```

Por defecto, la aplicación usa:

```text
APP_ENV=development
APP_VERSION=0.1.0
LOG_LEVEL=INFO
# DATABASE_RUNTIME_DSN se requiere solamente para comprobar PostgreSQL.
# SUPABASE_URL=https://<project>.supabase.co
# SUPABASE_ANON_KEY=<public-anon-key>
```

Los valores pueden sobrescribirse mediante variables de entorno sin añadir secretos al repositorio.

## Integración con PetGroup

El servidor Next.js consume el endpoint financiero mediante la variable server-side:

```text
FINANCE_API_BASE_URL=https://<finance-api-host>
```

No debe utilizarse el prefijo `NEXT_PUBLIC_`: la URL se resuelve en el servidor y la sesión Supabase existente se reenvía como Bearer token.

## Health checks

```text
GET /health/live
GET /health/ready
GET /auth/me
GET /auth/context
```

`/auth/me` requiere `Authorization: Bearer <access_token>` de la sesión existente de PetGroup. Un token ausente, inválido, expirado o rechazado por Supabase responde `401`.

`/auth/context` requiere además `X-Company-Id` con un UUID. El acceso se valida mediante `core.has_company_access`; un header ausente o inválido responde `400`, una empresa no autorizada responde `403` y un fallo técnico de verificación responde `503`.
