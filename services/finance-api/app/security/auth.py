import logging
from dataclasses import dataclass

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)
bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthenticatedUser:
    user_id: str


def _invalid_credentials() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def validate_access_token(access_token: str, settings: Settings) -> AuthenticatedUser:
    """Validate the token with Supabase Auth and return only its identity."""
    if settings.supabase_url is None or settings.supabase_anon_key is None:
        raise _invalid_credentials()

    endpoint = f"{settings.supabase_url.rstrip('/')}/auth/v1/user"
    headers = {
        "apikey": settings.supabase_anon_key.get_secret_value(),
        "Authorization": f"Bearer {access_token}",
    }

    try:
        with httpx.Client(timeout=5.0, follow_redirects=False) as client:
            response = client.get(endpoint, headers=headers)
        if response.status_code != status.HTTP_200_OK:
            raise _invalid_credentials()

        payload = response.json()
        user_id = payload.get("id") if isinstance(payload, dict) else None
        if not isinstance(user_id, str) or not user_id:
            raise _invalid_credentials()
        return AuthenticatedUser(user_id=user_id)
    except HTTPException:
        raise
    except (httpx.HTTPError, ValueError, TypeError):
        logger.warning("Supabase Auth token validation failed")
        raise _invalid_credentials() from None


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> AuthenticatedUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _invalid_credentials()

    return validate_access_token(credentials.credentials, get_settings())
