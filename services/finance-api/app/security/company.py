import logging
from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import text

from app.core.config import get_settings
from app.db.connection import get_session_factory
from app.security.auth import AuthenticatedUser, get_current_user

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AuthorizedCompanyContext:
    user_id: str
    company_id: UUID


def _company_header_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="X-Company-Id must be a valid UUID",
    )


def _company_access_denied() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="User does not have access to this company",
    )


def _company_access_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Company access verification unavailable",
    )


def _company_permission_denied() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="User does not have the required company permission",
    )


def _company_permission_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Company permission verification unavailable",
    )


def _parse_company_header(company_header: str | None) -> UUID:
    if company_header is None:
        raise _company_header_error()
    try:
        return UUID(company_header)
    except ValueError:
        raise _company_header_error() from None


def _company_authorization_statement() -> str:
    return (
        "SELECT "
        "core.has_company_access(:user_id, :company_id) AS has_access, "
        "core.has_permission_for_company(:user_id, :company_id, :permission_code) "
        "AS has_permission"
    )


def get_authorized_company_context(
    user: AuthenticatedUser = Depends(get_current_user),
    company_header: str | None = Header(default=None, alias="X-Company-Id"),
) -> AuthorizedCompanyContext:
    company_id = _parse_company_header(company_header)

    statement = text("SELECT core.has_company_access(:user_id, :company_id)")
    try:
        settings = get_settings()
        if settings.database_runtime_dsn is None:
            raise RuntimeError("database runtime DSN is not configured")

        with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
            has_access = session.execute(
                statement,
                {"user_id": user.user_id, "company_id": company_id},
            ).scalar_one()
    except Exception:
        logger.exception(
            "company access check failed",
            extra={
                "user_id": user.user_id,
                "company_id": str(company_id),
                "statement": str(statement),
                "database_role": "petgroup_backend_runtime",
            },
        )
        raise _company_access_unavailable() from None

    if has_access is not True:
        raise _company_access_denied()

    return AuthorizedCompanyContext(user_id=user.user_id, company_id=company_id)


def require_company_permission(permission_code: str):
    """Create a dependency for a server-defined company permission."""
    if not permission_code:
        raise ValueError("permission_code must be defined by the server")

    def permission_dependency(
        user: AuthenticatedUser = Depends(get_current_user),
        company_header: str | None = Header(default=None, alias="X-Company-Id"),
    ) -> AuthorizedCompanyContext:
        company_id = _parse_company_header(company_header)
        statement = text(_company_authorization_statement())
        try:
            settings = get_settings()
            if settings.database_runtime_dsn is None:
                raise RuntimeError("database runtime DSN is not configured")

            with get_session_factory(
                settings.database_runtime_dsn.get_secret_value()
            )() as session:
                has_permission = session.execute(
                    statement,
                    {
                        "user_id": user.user_id,
                        "company_id": company_id,
                        "permission_code": permission_code,
                    },
                ).mappings().one()
        except Exception:
            logger.exception(
                "company authorization check failed",
                extra={
                    "user_id": user.user_id,
                    "company_id": str(company_id),
                    "permission_code": permission_code,
                    "statement": str(statement),
                    "database_role": "petgroup_backend_runtime",
                },
            )
            raise _company_permission_unavailable() from None

        has_access = has_permission["has_access"]
        has_permission = has_permission["has_permission"]
        if has_access is not True:
            raise _company_access_denied()
        if has_permission is not True:
            raise _company_permission_denied()

        return AuthorizedCompanyContext(user_id=user.user_id, company_id=company_id)

    return permission_dependency
