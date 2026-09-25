from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes.auth import router as auth_router
from app.api.routes.financial import router as financial_router
from app.api.routes.health import router as health_router
from app.core.config import get_settings
from app.observability.logging import configure_logging


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    return FastAPI(
        title="PetGroup Finance API",
        version=settings.app_version,
        lifespan=lifespan,
    )


app = create_app()
app.include_router(health_router)
app.include_router(auth_router)
app.include_router(financial_router)
