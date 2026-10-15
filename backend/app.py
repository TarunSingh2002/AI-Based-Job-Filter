"""
The HTTP server the Chrome extension talks to.

    GET  /health         is the backend up? which provider / model?
    POST /screen/title   stage 1: a batch of job cards, judged by title
    POST /screen/jd      stage 2: one job, judged by its full description
    GET  /stats          today's CSV row counts per site

Run from backend/:   uvicorn app:app --port 8765
"""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict

import decide
from config import get_settings, load_profile
from graph import build_graph, screen_job
from providers import get_provider
from store import Store

MIN_JD_CHARS = 200  # shorter than this is a failed scrape, not a job description

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("job_filter")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Build everything once at startup (not at import time)."""
    settings = get_settings()
    app.state.profile = load_profile(settings.profile_path())
    app.state.provider = get_provider(settings)
    store = app.state.store = Store(settings.db_path(), settings.output_dir())
    # Catch up on any jobs.xlsx that fell behind while the server was down, then keep them current.
    store.queue_outdated_workbooks()
    store.refresh_workbooks()
    workbooks = asyncio.create_task(store.keep_workbooks_fresh())
    app.state.graph = build_graph(app.state.provider, app.state.profile, store)
    app.state.in_flight = {}  # (site, job_id, stage) -> the screening run in progress (see run_graph)
    log.info("provider=%s model=%s output=%s", app.state.provider.name, app.state.provider.model,
             settings.output_dir())
    yield
    workbooks.cancel()
    with suppress(asyncio.CancelledError):
        await workbooks
    await app.state.provider.aclose()
    store.refresh_workbooks()  # the rows of the last couple of seconds (waits for a rebuild still running)
    store.close()


app = FastAPI(title="Job Filter v2", lifespan=lifespan)
# The extension's background service worker calls us from a chrome-extension:// origin.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ── Request bodies ──────────────────────────────────────────────────────────────────────────────

# Only these four: the site name also becomes part of the CSV file name.
Site = Literal["linkedin", "glassdoor", "naukri", "indeed"]


class JobIn(BaseModel):
    model_config = ConfigDict(coerce_numbers_to_str=True)  # some sites give numeric job ids

    job_id: str
    title: str | None = ""
    company: str | None = ""
    location: str | None = ""
    experience_text: str | None = ""
    link: str | None = ""

    def as_dict(self) -> dict:
        """Plain dict with "" instead of None, so the rest of the code never has to check for None."""
        return {key: value or "" for key, value in self.model_dump().items()}


class JobWithJd(JobIn):
    jd: str | None = ""


class TitleRequest(BaseModel):
    site: Site
    jobs: list[JobIn]


class JdRequest(BaseModel):
    site: Site
    job: JobWithJd


TITLE_RESULT_FIELDS = ("job_id", "decision", "reason", "confidence", "match_score", "stage", "cached", "final")
JD_RESULT_FIELDS = (
    "job_id", "decision", "reason", "match_score", "confidence", "role_family", "min_years", "max_years",
    "work_mode", "cached", "saved_to_csv", "stage", "final",
)


# ── Endpoints ───────────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "ok": True,
        "provider": app.state.provider.name,
        "model": app.state.provider.model,
        "profile": {"experience_years": app.state.profile.experience_years},
    }


@app.post("/screen/title")
async def screen_title(req: TitleRequest):
    """All jobs run at the same time; the provider itself limits how many reach the AI at once.
    A job listed twice is screened once (run_graph)."""
    verdicts = await asyncio.gather(*(title_verdict(req.site, job.as_dict()) for job in req.jobs))
    return {"results": [pick(v, TITLE_RESULT_FIELDS) for v in verdicts]}


@app.post("/screen/jd")
async def screen_jd(req: JdRequest):
    job = req.job.as_dict()

    cached = app.state.store.get_verdict(req.site, job["job_id"])
    if cached and cached["stage"] == "jd":
        return pick(cached, JD_RESULT_FIELDS)  # already done: no AI call, no second CSV row

    if len(job["jd"].strip()) < MIN_JD_CHARS:
        # No usable JD: fall back to the title stage. Its reject stands; a pass becomes "no_jd" and is
        # not final, so a later run with a real JD gets a proper JD verdict.
        verdict = await title_verdict(req.site, job)
        if verdict["decision"] == "pass":
            verdict = {**verdict, "stage": "jd", "reason": "no_jd", "match_score": None, "final": False}
        return pick(verdict, JD_RESULT_FIELDS)

    return pick(await run_graph(req.site, "jd", job), JD_RESULT_FIELDS)


@app.get("/stats")
async def stats():
    return app.state.store.stats()


# ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

async def title_verdict(site: str, job: dict) -> dict:
    """Any cached verdict (title or JD stage) wins; otherwise run the title stage."""
    cached = app.state.store.get_verdict(site, job["job_id"])
    return cached or await run_graph(site, "title", job)


async def run_graph(site: str, stage: str, job: dict) -> dict:
    """Screen one job. The cache is only written when a run ends, so a request for a job that is still
    being screened (a second tab, a page reload, the same card twice in one batch) waits for that run
    instead of starting its own - otherwise each one would ask the AI and append its own CSV row."""
    in_flight = app.state.in_flight
    key = (site, job["job_id"], stage)
    if key not in in_flight:
        in_flight[key] = asyncio.ensure_future(_screen(site, stage, job))
        in_flight[key].add_done_callback(lambda _: in_flight.pop(key, None))
    # shield: if one waiting request goes away, the run the others are waiting for keeps going.
    return await asyncio.shield(in_flight[key])


async def _screen(site: str, stage: str, job: dict) -> dict:
    try:
        return await screen_job(app.state.graph, site, stage, job)
    except Exception as e:  # e.g. a CSV file locked by Excel - never hide a job because of our own failure
        log.exception("screening %s job %s failed", site, job["job_id"])
        # Same "ai_error" prefix as an AI failure: the extension treats it as "pass for now, retry later".
        return decide.error_verdict(job, stage, f"ai_error: {type(e).__name__}: {e}")


def pick(verdict: dict, fields: tuple[str, ...]) -> dict:
    return {field: verdict[field] for field in fields}

# cd backend && .venv/Scripts/python -m uvicorn app:app --port 8765   (from the repo root)