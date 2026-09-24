import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings, get_settings
from app.main import app
from app.security import auth

client = TestClient(app)


def settings() -> Settings:
    return Settings(
        supabase_url="https://example.supabase.co",
        supabase_anon_key=SecretStr("public-anon-key"),
    )


def test_validate_access_token_extracts_user_id(monkeypatch) -> None:
    class FakeResponse:
        status_code = 200

        def json(self):
            return {"id": "user-123", "email": "not-exposed@example.test"}

    class FakeClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            return None

        def get(self, url, headers):
            assert url == "https://example.supabase.co/auth/v1/user"
            assert headers == {
                "apikey": "public-anon-key",
                "Authorization": "Bearer valid-token",
            }
            return FakeResponse()

    monkeypatch.setattr(auth.httpx, "Client", lambda **kwargs: FakeClient())

    user = auth.validate_access_token("valid-token", settings())

    assert user.user_id == "user-123"


def test_validate_access_token_rejects_invalid_token(monkeypatch) -> None:
    class FakeResponse:
        status_code = 401

        def json(self):
            return {"message": "invalid token"}

    class FakeClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            return None

        def get(self, url, headers):
            return FakeResponse()

    monkeypatch.setattr(auth.httpx, "Client", lambda **kwargs: FakeClient())

    with pytest.raises(auth.HTTPException) as error:
        auth.validate_access_token("invalid-token", settings())

    assert error.value.status_code == 401


def test_auth_me_rejects_missing_token() -> None:
    response = client.get("/auth/me")

    assert response.status_code == 401


def test_auth_me_returns_authenticated_user(monkeypatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setattr(auth, "get_settings", settings)
    monkeypatch.setattr(
        auth,
        "validate_access_token",
        lambda access_token, configured_settings: auth.AuthenticatedUser("user-456"),
    )

    response = client.get(
        "/auth/me",
        headers={"Authorization": "Bearer valid-token"},
    )

    assert response.status_code == 200
    assert response.json() == {"user_id": "user-456"}


def test_auth_me_rejects_external_validation_failure(monkeypatch) -> None:
    monkeypatch.setattr(
        auth,
        "validate_access_token",
        lambda access_token, configured_settings: (_ for _ in ()).throw(
            auth.HTTPException(status_code=401)
        ),
    )

    response = client.get(
        "/auth/me",
        headers={"Authorization": "Bearer rejected-token"},
    )

    assert response.status_code == 401
