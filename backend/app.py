"""
The HTTP server the Chrome extension talks to.

    GET  /health         is the backend up? which provider / model?
    POST /screen/title   stage 1: a batch of job cards, judged by title (reposts hidden without the AI)
    POST /screen/jd      stage 2: one job, judged by its full description
    GET  /stats          today's CSV row counts per site
    POST /dedupe/clear   empty one repost list ("naukri" or "glassdoor_indeed")
    POST /automation/started    the popup's "Start automation" began a run   -> automation-started.json
    POST /automation/finished   that run ended (summary + one item per search) -> automation-finished.json
    GET  /automation/last       the newest finished marker (the popup's "last run")

Run from backend/:   uvicorn app:app --port 8765
"""

import asyncio
import logging
import socket
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict

import automation
import decide
from config import get_settings, load_profile
from dedupe import dedupe_group, repost_key
from graph import build_graph, screen_job
from providers import get_provider
from store import Store

MIN_JD_CHARS = 200  # shorter than this is a failed scrape, not a job description
PORT = 8765  # the port of the run command above (and of the extension's default backendUrl)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("job_filter")


def backend_already_running() -> bool:
    """Is something already listening on PORT (a backend started earlier)?

    Uvicorn runs the startup below BEFORE it binds the port, so a second `uvicorn app:app` started by mistake gets
    this far and only then fails with "address already in use". It must not touch the running backend's markers.
    """
    try:
        socket.create_connection(("127.0.0.1", PORT), timeout=0.5).close()  # a listening port answers at once
        return True
    except OSError:  # refused or timed out (Windows lets a closed port time out): the port is free
        return False


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
    app.state.automation_folder = None  # day folder of the automation run in progress (automation_finished)
    # A new backend = a new session: today's markers of an earlier run must not look like this session's
    # (a Power Automate flow starts the backend, then the browser, then waits for automation-finished.json).
    # Not when a backend already serves: then this copy is a second start by mistake and is about to exit.
    if backend_already_running():
        log.warning("a backend is already running on port %d: today's automation markers are left alone "
                    "(this copy can't take that port)", PORT)
    else:
        try:
            automation.set_aside(store.output_dir, datetime.now())
        except OSError as e:  # a marker locked by another program must never stop the backend from starting
            log.warning("could not set aside today's automation markers: %s: %s", type(e).__name__, e)
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


class DedupeClearRequest(BaseModel):
    group: Literal["naukri", "glassdoor_indeed"]


class AutomationItem(BaseModel):
    """One saved search of the run, as the extension reports it. Everything is optional and extra keys
    (e.g. counts) are kept: a picky check here would lose the "finished" signal Power Automate waits for."""
    model_config = ConfigDict(extra="allow")

    site: str = ""
    url: str = ""
    status: str = ""  # done | paused | stalled | error | skipped | ...
    matched: int | None = None
    reason: str | None = None


class AutomationFinishedRequest(BaseModel):
    summary: str = ""
    items: list[AutomationItem] = []


TITLE_RESULT_FIELDS = (
    "job_id", "decision", "reason", "confidence", "match_score", "stage", "cached", "final", "duplicate",
)
JD_RESULT_FIELDS = (
    "job_id", "decision", "reason", "match_score", "position_score", "skills_score", "confidence", "role_family",
    "min_years", "max_years", "work_mode", "cached", "saved_to_csv", "stage", "final",
)


# ── Endpoints ───────────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "ok": True,
        "provider": app.state.provider.name,
        "model": app.state.provider.model,
        "profile": {
            "experience_years": app.state.profile.experience_years,
            "target_role_families": app.state.profile.target_role_families,
        },
    }


@app.post("/screen/title")
async def screen_title(req: TitleRequest):
    """All jobs run at the same time; the provider itself limits how many reach the AI at once.
    A job listed twice is screened once (run_graph); a repost of another job is not screened (title_verdict)."""
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


@app.post("/dedupe/clear")
async def dedupe_clear(req: DedupeClearRequest):
    """The popup's "Clear repost list": every (title, company) of that group may be screened once more."""
    return {"cleared": app.state.store.clear_repost_keys(req.group)}


# The marker writes run in a worker thread: a rename Windows refuses for a moment is retried with short
# sleeps (automation._retry), and those must not hold up the screening requests.

@app.post("/automation/started")
async def automation_started():
    """The extension began an automation run (any request body is ignored)."""
    path = await asyncio.to_thread(automation.mark_started, app.state.store.output_dir, datetime.now())
    app.state.automation_folder = path.parent  # a run that ends after midnight also marks this day (2.2)
    return {"ok": True, "path": str(path)}


@app.post("/automation/finished")
async def automation_finished(req: AutomationFinishedRequest):
    """The run ended (finished, or stopped by the user): the signal Power Automate waits for."""
    items = [item.model_dump() for item in req.items]
    path = await asyncio.to_thread(automation.mark_finished, app.state.store.output_dir, datetime.now(),
                                   req.summary, items, app.state.automation_folder)
    app.state.automation_folder = None
    return {"ok": True, "path": str(path)}


@app.get("/automation/last")
async def automation_last():
    return automation.last_finished(app.state.store.output_dir)


# ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

async def title_verdict(site: str, job: dict) -> dict:
    """1. a cached verdict (title or JD stage) wins - except an old "seniority: ..." reject that profile.yaml
       no longer makes (decide.outdated_seniority_reject): that job is screened again;
    2. else a repost of a job already screened in this site group is hidden without asking the AI
       (no CSV row, not cached, so clearing the repost list brings it back);
    3. else this job claims its (title, company) and the title stage runs.
    Steps 1-3 have no await in between, so of two copies in one batch the first claims, the second is a repost."""
    cached = app.state.store.get_verdict(site, job["job_id"])
    if cached and not decide.outdated_seniority_reject(cached, app.state.profile):
        return cached
    original = claim_or_find_original(site, job)
    if original:
        log.info("%s title reject repost of %s %s | %s @ %s", site, *original, job["title"], job["company"])
        return decide.duplicate_verdict(job, *original)
    return await run_graph(site, "title", job)


def claim_or_find_original(site: str, job: dict) -> tuple[str, str] | None:
    """Claim this job's (title, company) in its site group. Returns the (site, job_id) of the job that
    claimed it first when that is another job, else None (not a repost, or a site without a group)."""
    group = dedupe_group(site)
    key = repost_key(job["title"], job["company"]) if group else None
    if key is None:
        return None
    holder = app.state.store.claim_repost_key(group, key, site, job["job_id"])
    return holder if holder != (site, job["job_id"]) else None


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