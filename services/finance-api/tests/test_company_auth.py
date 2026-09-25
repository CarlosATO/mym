from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.main import app
from app.api.routes import financial
from app.security import auth, company

client = TestClient(app)
COMPANY_ID = "11111111-1111-1111-1111-111111111111"
SERVER_PERMISSION_CODE = "control_finance.read"


class FakeResult:
    def __init__(self, allowed: bool) -> None:
        self.allowed = allowed

    def scalar_one(self) -> bool:
        return self.allowed


class FakeSession:
    def __init__(self, allowed: bool) -> None:
        self.allowed = allowed
        self.statement = None
        self.parameters = None

    def __enter__(self) -> "FakeSession":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        return None

    def execute(self, statement, parameters):
        self.statement = str(statement)
        self.parameters = parameters
        return FakeResult(self.allowed)


class FailingSession(FakeSession):
    def execute(self, statement, parameters):
        raise RuntimeError("simulated database outage")


def _settings() -> Settings:
    return Settings(
        database_runtime_dsn=SecretStr(
            "postgresql://user:password@example.test/database"
        )
    )


def _authenticated_client(monkeypatch, session: FakeSession) -> TestClient:
    monkeypatch.setattr(auth, "get_settings", lambda: _settings())
    monkeypatch.setattr(company, "get_settings", lambda: _settings())
    monkeypatch.setattr(
        auth,
        "validate_access_token",
        lambda access_token, configured_settings: auth.AuthenticatedUser("user-123"),
    )
    monkeypatch.setattr(
        company,
        "get_session_factory",
        lambda dsn: lambda: session,
    )
    return client


def test_context_allows_user_with_company_access(monkeypatch) -> None:
    session = FakeSession(allowed=True)

    response = _authenticated_client(monkeypatch, session).get(
        "/auth/context",
        headers={
            "Authorization": "Bearer valid-token",
            "X-Company-Id": COMPANY_ID,
        },
    )

    assert response.status_code == 200
    assert response.json() == {"user_id": "user-123", "company_id": COMPANY_ID}
    assert session.statement == "SELECT core.has_company_access(:user_id, :company_id)"
    assert session.parameters == {
        "user_id": "user-123",
        "company_id": UUID(COMPANY_ID),
    }


def test_context_denies_user_without_company_access(monkeypatch) -> None:
    response = _authenticated_client(monkeypatch, FakeSession(allowed=False)).get(
        "/auth/context",
        headers={
            "Authorization": "Bearer valid-token",
            "X-Company-Id": COMPANY_ID,
        },
    )

    assert response.status_code == 403


def test_context_returns_503_when_access_check_fails(monkeypatch) -> None:
    response = _authenticated_client(monkeypatch, FailingSession(allowed=True)).get(
        "/auth/context",
        headers={
            "Authorization": "Bearer valid-token",
            "X-Company-Id": COMPANY_ID,
        },
    )

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Company access verification unavailable"
    }


def test_context_rejects_missing_company_header(monkeypatch) -> None:
    response = _authenticated_client(monkeypatch, FakeSession(allowed=True)).get(
        "/auth/context",
        headers={"Authorization": "Bearer valid-token"},
    )

    assert response.status_code == 400


def test_context_rejects_malformed_company_header(monkeypatch) -> None:
    response = _authenticated_client(monkeypatch, FakeSession(allowed=True)).get(
        "/auth/context",
        headers={
            "Authorization": "Bearer valid-token",
            "X-Company-Id": "not-a-uuid",
        },
    )

    assert response.status_code == 400


def test_context_keeps_authentication_401() -> None:
    response = client.get(
        "/auth/context",
        headers={"X-Company-Id": COMPANY_ID},
    )

    assert response.status_code == 401


def _permission_context() -> company.AuthorizedCompanyContext:
    return company.AuthorizedCompanyContext(
        user_id="user-123",
        company_id=UUID(COMPANY_ID),
    )


def _permission_dependency(monkeypatch, session: FakeSession):
    monkeypatch.setattr(company, "get_settings", lambda: _settings())
    monkeypatch.setattr(
        company,
        "get_session_factory",
        lambda dsn: lambda: session,
    )
    return company.require_company_permission(SERVER_PERMISSION_CODE)


def test_company_permission_allows_server_defined_permission(monkeypatch) -> None:
    session = FakeSession(allowed=True)
    dependency = _permission_dependency(monkeypatch, session)

    result = dependency(_permission_context())

    assert result == _permission_context()
    assert session.statement == (
        "SELECT core.has_permission_for_company("
        ":user_id, :company_id, :permission_code)"
    )
    assert session.parameters["permission_code"] == SERVER_PERMISSION_CODE


def test_company_permission_denies_false_result(monkeypatch) -> None:
    dependency = _permission_dependency(monkeypatch, FakeSession(allowed=False))

    with pytest.raises(company.HTTPException) as error:
        dependency(_permission_context())

    assert error.value.status_code == 403


def test_company_permission_returns_503_on_technical_failure(monkeypatch) -> None:
    dependency = _permission_dependency(monkeypatch, FailingSession(allowed=True))

    with pytest.raises(company.HTTPException) as error:
        dependency(_permission_context())

    assert error.value.status_code == 503
    assert error.value.detail == "Company permission verification unavailable"


def test_financial_sales_requires_authentication() -> None:
    response = client.get(
        "/financial/income-statement/sales-net?year=2026",
        headers={"X-Company-Id": COMPANY_ID},
    )

    assert response.status_code == 401


def test_financial_sales_uses_control_finance_permission(monkeypatch) -> None:
    session = FakeSession(allowed=True)
    context = company.AuthorizedCompanyContext(
        user_id="user-123",
        company_id=UUID(COMPANY_ID),
    )
    monkeypatch.setattr(company, "get_settings", lambda: _settings())
    monkeypatch.setattr(company, "get_session_factory", lambda dsn: lambda: session)
    monkeypatch.setattr(
        financial,
        "get_monthly_net_sales",
        lambda company_id, year: {
            "company_id": str(company_id),
            "year": year,
            "currency": "CLP",
            "months": [],
            "total_ytd": "0.00",
        },
    )
    app.dependency_overrides[company.get_authorized_company_context] = lambda: context

    try:
        response = client.get(
            "/financial/income-statement/sales-net?year=2026",
            headers={"X-Company-Id": COMPANY_ID},
        )
    finally:
        app.dependency_overrides.pop(company.get_authorized_company_context, None)

    assert response.status_code == 200
    assert session.parameters["permission_code"] == financial.CONTROL_FINANCE_VIEW
