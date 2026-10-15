"""Shared test fixtures. Everything runs offline with the mock provider and temp folders."""

import httpx
import pytest
import yaml
from fastapi.testclient import TestClient

import config
from config import Profile
from mock_provider import MockProvider
from store import Store

# A fixed profile, so the tests don't change when you edit the real profile.yaml.
PROFILE_DATA = {
    "experience_years": 1,
    "experience_tolerance": 1,
    "avoid_role_families": ["teaching_training", "ai_data_annotation", "internship", "research_academic",
                            "non_technical"],
    "allowed_seniority": ["entry", "mid"],
    "min_match_score": 6,
    "reject_confidence": 0.6,
    "skills": ["Python", "Machine Learning", "Deep Learning", "NLP", "LLM", "RAG", "LangChain", "LangGraph", "GenAI",
               "Data Science", "TensorFlow", "PyTorch", "Pandas", "NumPy", "SQL", "Data Analysis", "Generative AI",
               "FastAPI"],
}


@pytest.fixture
def profile() -> Profile:
    return Profile(**PROFILE_DATA)


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "jobs.db", tmp_path / "output")
    yield s
    s.close()


def _point_app_at(tmp_path, monkeypatch) -> None:
    """Offline mock instead of Jev, and the DB, CSVs and profile in a temp folder."""
    import app

    profile_file = tmp_path / "profile.yaml"
    profile_file.write_text(yaml.safe_dump(PROFILE_DATA), encoding="utf-8")
    monkeypatch.setattr(app, "get_provider", lambda settings: MockProvider())
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "data" / "jobs.db"))
    monkeypatch.setenv("PROFILE_PATH", str(profile_file))
    config.get_settings.cache_clear()


@pytest.fixture
def app_env(tmp_path, monkeypatch):
    """Only the setup part of `client`, for a test that starts and stops the app itself."""
    _point_app_at(tmp_path, monkeypatch)
    yield
    config.get_settings.cache_clear()


@pytest.fixture
def client(tmp_path, monkeypatch):
    """The real FastAPI app with the mock provider, writing its DB and CSVs into a temp folder."""
    _point_app_at(tmp_path, monkeypatch)
    from app import app

    with TestClient(app) as test_client:  # "with" runs the startup code (lifespan)
        yield test_client
    config.get_settings.cache_clear()


@pytest.fixture
async def async_client(tmp_path, monkeypatch):
    """The same app, for tests that send requests at the same time (TestClient sends them one by one)."""
    _point_app_at(tmp_path, monkeypatch)
    from app import app

    async with app.router.lifespan_context(app):  # the startup code, as TestClient's "with" does
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as test_client:
            yield test_client
    config.get_settings.cache_clear()
