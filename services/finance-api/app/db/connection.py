import logging
from functools import lru_cache

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings

logger = logging.getLogger(__name__)


def _sqlalchemy_dsn(dsn: str) -> str:
    if dsn.startswith("postgres://"):
        return "postgresql+psycopg://" + dsn.removeprefix("postgres://")
    if dsn.startswith("postgresql://"):
        return "postgresql+psycopg://" + dsn.removeprefix("postgresql://")
    return dsn


@lru_cache(maxsize=1)
def get_engine(dsn: str) -> Engine:
    return create_engine(
        _sqlalchemy_dsn(dsn),
        pool_size=2,
        max_overflow=0,
        pool_timeout=5,
        pool_recycle=1800,
        pool_pre_ping=True,
        connect_args={
            "connect_timeout": 5,
            "options": "-c statement_timeout=5000",
        },
    )


@lru_cache(maxsize=1)
def get_session_factory(dsn: str) -> sessionmaker[Session]:
    return sessionmaker(
        bind=get_engine(dsn),
        autoflush=False,
        expire_on_commit=False,
    )


def check_database(settings: Settings) -> bool:
    if settings.database_runtime_dsn is None:
        return False

    try:
        with get_engine(settings.database_runtime_dsn.get_secret_value()).connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except (SQLAlchemyError, OSError):
        logger.warning("database readiness check failed")
        return False
