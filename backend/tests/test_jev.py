"""Jev provider against a fake HTTP server (httpx.MockTransport) - no network."""

import json

import httpx
import pytest

from providers.base import Answer, ProviderError
from config import JEV_MODEL, JEV_URL
from providers.jev import JevProvider
from questions import TITLE_QUESTIONS

STATE = {"job_title": "Python Trainer", "company": "EduCorp"}
QUESTIONS = {
    "role_family": TITLE_QUESTIONS["role_family"],
    "skills_match": {"type": "score", "instructions": "How good?", "criteria": ["bad", "ok", "good", "great"]},
    "remote": {"type": "noul", "instructions": "Is the job remote?", "criteria": {"true": "Remote", "false": "Not"}},
}
ANSWERS = {
    "role_family": {"type": "choice", "choice": "teaching_training",
                    "probabilities": {"teaching_training": 0.94, "unclear": 0.06}, "confidence": 0.94},
    "skills_match": {"type": "score", "score": 2.4, "legend": {"0": "bad", "1": "ok", "2": "good", "3": "great"},
                     "probabilities": {"2": 0.6, "3": 0.4}, "confidence": 0.6},
    "remote": {"type": "noul", "noul": 0.9},
}


def ok_response() -> httpx.Response:
    return httpx.Response(200, json={"model": "jev-latest", "answers": ANSWERS, "usage": {"tokens": 123}})


def make_provider(handler) -> JevProvider:
    provider = JevProvider("test-key", JEV_MODEL, JEV_URL, transport=httpx.MockTransport(handler))
    provider.retry_waits = (0, 0, 0)  # don't actually sleep in tests
    return provider


async def test_request_format_and_answer_parsing():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok_response()

    provider = make_provider(handler)
    answers = await provider.ask(STATE, QUESTIONS)
    await provider.aclose()

    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == JEV_URL == "https://opencode.ai/inference/v1/systemone"
    assert request.headers["authorization"] == "Bearer test-key"
    assert json.loads(request.content) == {"state": STATE, "model": "jev-1.13-free", "questions": QUESTIONS}

    assert answers["role_family"] == Answer(
        "choice", choice="teaching_training", confidence=0.94,
        probabilities={"teaching_training": 0.94, "unclear": 0.06},
    )
    assert (answers["skills_match"].type, answers["skills_match"].score) == ("score", 2.4)
    assert answers["skills_match"].confidence == 0.6
    assert answers["remote"].noul == 0.9
    assert answers["remote"].confidence == pytest.approx(0.8)  # abs(0.9 - 0.5) * 2


async def test_retries_after_429_then_succeeds():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(429, text="slow down") if len(calls) == 1 else ok_response()

    provider = make_provider(handler)
    answers = await provider.ask(STATE, QUESTIONS)
    assert len(calls) == 2
    assert answers["role_family"].choice == "teaching_training"


async def test_gives_up_after_four_tries():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(529, text="overloaded")

    provider = make_provider(handler)
    with pytest.raises(ProviderError, match="529"):
        await provider.ask(STATE, QUESTIONS)
    assert len(calls) == 4


async def test_401_names_the_key():
    provider = make_provider(lambda request: httpx.Response(401, json={"error": "unauthorized"}))
    with pytest.raises(ProviderError, match="bad JEV_API_KEY"):
        await provider.ask(STATE, QUESTIONS)


async def test_typesafe_url_uses_the_same_wire_format():
    seen = []

    def handler(request):
        seen.append(request)
        return ok_response()

    url = "https://api.typesafe.ai/v1/systemone"
    provider = JevProvider("ts-key", "jev-latest", url, transport=httpx.MockTransport(handler))
    answers = await provider.ask(STATE, QUESTIONS)

    assert str(seen[0].url) == url
    assert seen[0].headers["authorization"] == "Bearer ts-key"
    assert json.loads(seen[0].content)["model"] == "jev-latest"
    assert answers["role_family"].choice == "teaching_training"


async def test_422_includes_the_body():
    provider = make_provider(lambda request: httpx.Response(422, json={"detail": "criteria too long"}))
    with pytest.raises(ProviderError, match="criteria too long"):
        await provider.ask(STATE, QUESTIONS)


async def test_missing_answer_is_an_error():
    body = {"model": "jev-latest", "answers": {"role_family": ANSWERS["role_family"]}}
    provider = make_provider(lambda request: httpx.Response(200, json=body))
    with pytest.raises(ProviderError, match="did not answer"):
        await provider.ask(STATE, QUESTIONS)


async def test_network_error_becomes_provider_error():
    def handler(request):
        raise httpx.ConnectError("connection refused")

    provider = make_provider(handler)
    with pytest.raises(ProviderError, match="ConnectError"):
        await provider.ask(STATE, QUESTIONS)


def test_empty_key_fails_at_startup():
    with pytest.raises(ValueError, match="JEV_API_KEY"):
        JevProvider("  ", JEV_MODEL, JEV_URL)
