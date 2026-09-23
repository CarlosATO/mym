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
- tests de ambos health checks.

`/health/ready` ejecuta `SELECT 1` contra PostgreSQL cuando `DATABASE_RUNTIME_DSN` está configurado. Sin ese valor responde `503`; no usa otro DSN como sustituto.

No se implementan todavía autenticación, autorización, `company_id`, Alembic, BSale, bancos, schema `finanzas`, Docker, Railway ni endpoints financieros.

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
```

Los valores pueden sobrescribirse mediante variables de entorno sin añadir secretos al repositorio.

## Health checks

```text
GET /health/live
GET /health/ready
```
