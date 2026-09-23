from fastapi.testclient import TestClient

from app.api.routes import health
from app.main import app

client = TestClient(app)


def test_live_health_check() -> None:
    response = client.get("/health/live")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_health_check_without_database() -> None:
    response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "reason": "database_unavailable"}


def test_ready_health_check_with_database(monkeypatch) -> None:
    monkeypatch.setattr(health, "check_database", lambda settings: True)

    response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "environment": "development",
        "version": "0.1.0",
    }
