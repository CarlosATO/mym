from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.db.connection import check_database

router = APIRouter(tags=["health"])


@router.get("/health/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready", response_model=None)
def ready() -> dict[str, str] | JSONResponse:
    settings = get_settings()
    if not check_database(settings):
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "reason": "database_unavailable"},
        )

    return {
        "status": "ok",
        "environment": settings.app_env,
        "version": settings.app_version,
    }
