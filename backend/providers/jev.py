"""
TypeSafe Jev provider. Sends the questions exactly as written in questions.py and gets back
calibrated answers (a choice with probabilities + confidence, a score level, or a noul probability).

    POST <JEV_URL>
    Authorization: Bearer <JEV_API_KEY>
    {"state": {...}, "model": "<JEV_MODEL>", "questions": {...}}
      -> {"model": "...", "answers": {qid: {...}}, "usage": {...}}

JEV_URL and JEV_MODEL are set in config.py (OpenCode or TypeSafe - same wire format); the key comes from .env.
"""

import asyncio
import logging

import httpx

from providers.base import Answer, ProviderError

RETRY_STATUSES = {429, 529}  # rate limited / overloaded: worth waiting and trying again

log = logging.getLogger(__name__)


class JevProvider:
    name = "jev"
    # Seconds to wait before each retry -> at most 4 tries in total.
    retry_waits: tuple[float, ...] = (0.5, 1.0, 2.0)

    def __init__(self, api_key: str, model: str, url: str):
        if not api_key.strip():
            raise ValueError("JEV_API_KEY is empty - put your OpenCode (or TypeSafe) key in backend/.env")
        self.model = model
        self.url = url
        self._client = httpx.AsyncClient(timeout=20, headers={"Authorization": f"Bearer {api_key.strip()}"})
        self._limit = asyncio.Semaphore(16)  # max requests in flight at once

    async def ask(self, state: dict, questions: dict) -> dict[str, Answer]:
        body = {"state": state, "model": self.model, "questions": questions}
        async with self._limit:
            data = await self._post(body)

        answers = data.get("answers") or {}
        missing = set(questions) - set(answers)
        if missing:
            raise ProviderError(f"Jev did not answer {sorted(missing)}")
        return {qid: parse_answer(answers[qid]) for qid in questions}

    async def _post(self, body: dict) -> dict:
        try:
            for wait in (*self.retry_waits, None):
                response = await self._client.post(self.url, json=body)
                if response.status_code not in RETRY_STATUSES or wait is None:
                    break
                log.info("Jev busy (HTTP %s), retrying in %ss", response.status_code, wait)
                await asyncio.sleep(wait)
        except httpx.HTTPError as e:  # timeout, connection refused, ...
            raise ProviderError(f"Jev request failed: {type(e).__name__} {e}") from e

        if response.status_code == 401:
            raise ProviderError(f"bad JEV_API_KEY ({self.url} returned 401)")
        if response.status_code == 422:
            raise ProviderError(f"Jev rejected the request (422): {response.text[:500]}")
        if response.status_code != 200:
            raise ProviderError(f"Jev HTTP {response.status_code}: {response.text[:300]}")
        return response.json()

    async def aclose(self) -> None:
        await self._client.aclose()


def parse_answer(raw: dict) -> Answer:
    """Turn one Jev answer object into our Answer dataclass."""
    kind = raw.get("type")
    if kind == "choice":
        return Answer(
            "choice",
            choice=raw["choice"],
            confidence=float(raw.get("confidence", 0.0)),
            probabilities=raw.get("probabilities"),
        )
    if kind == "score":
        return Answer(
            "score",
            score=float(raw["score"]),
            confidence=float(raw.get("confidence", 0.0)),
            probabilities=raw.get("probabilities"),
        )
    if kind == "noul":
        p = float(raw["noul"])
        # A noul answer has no confidence field: the further from 0.5, the surer the model is.
        return Answer("noul", noul=p, confidence=abs(p - 0.5) * 2)
    raise ProviderError(f"unknown Jev answer type {kind!r}")
