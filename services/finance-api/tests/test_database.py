from pydantic import SecretStr

from app.core.config import Settings
from app.db import connection


class FakeConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        return None

    def execute(self, statement) -> None:
        self.statements.append(str(statement))


class FakeEngine:
    def __init__(self, database_connection: FakeConnection) -> None:
        self.database_connection = database_connection

    def connect(self) -> FakeConnection:
        return self.database_connection


def test_check_database_uses_only_select_one(monkeypatch) -> None:
    database_connection = FakeConnection()
    monkeypatch.setattr(
        connection,
        "get_engine",
        lambda dsn: FakeEngine(database_connection),
    )
    settings = Settings(
        database_runtime_dsn=SecretStr("postgresql://user:password@example.test/db")
    )

    assert connection.check_database(settings) is True
    assert database_connection.statements == ["SELECT 1"]


def test_check_database_without_dsn_does_not_create_engine(monkeypatch) -> None:
    def fail_if_called(dsn):
        raise AssertionError("engine must not be created without a DSN")

    monkeypatch.setattr(connection, "get_engine", fail_if_called)

    assert connection.check_database(Settings()) is False
