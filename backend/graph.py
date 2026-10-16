"""
The AI flow for ONE job, as a LangGraph graph. Read this file top to bottom to see everything the AI does.

    START ─route─┬─ stage == "title" → check_title ─ok─→ ask_title → decide_title ─┐
                 │                          └─ too many years / too senior* ──────┤
                 └─ stage == "jd"    → ask_jd ───────────────────→ decide_jd ─────┴→ record → END
                                              * only when profile.yaml sets allowed_seniority (off by default)

    route        Which stage? "title" = cheap check of a job card, "jd" = the full job description.
    check_title  Free checks in plain code first: too many years on the card (or, only when profile.yaml
                 sets allowed_seniority, a seniority word in the title) rejects the job whatever its type,
                 so the AI is not asked (decide.py).
    ask_*        Ask the AI provider a few simple questions (questions.py). The AI never decides anything.
    decide_*     Plain code turns the answers into pass / reject using profile.yaml (decide.py).
    record       Append the CSV row (jobs.xlsx follows a moment later) and cache the verdict in SQLite (store.py).

If the AI call fails, ask_* stores the error instead of answers, decide_* PASSES the job with reason
"ai_error: ..." (our own failure must never hide a job), and record writes nothing, so the next run
asks again.

Three things happen before the graph, in app.py: the SQLite cache lookup (a job seen before never reaches
the AI again), the repost check (a copy of a job already screened on the same site group is hidden
without reaching the AI, dedupe.py) and the "JD too short" fallback to the title stage.
"""

import logging
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

import decide
import questions
from config import Profile
from experience import parse_job_years
from providers.base import Answer, Provider
from store import Store

log = logging.getLogger(__name__)


class JobState(TypedDict):
    site: str  # "linkedin" | "glassdoor" | "naukri" | "indeed"
    stage: str  # "title" | "jd"
    job: dict  # job_id, title, company, location, experience_text, link (+ jd for the JD stage)
    answers: dict[str, Answer] | None  # filled by ask_*
    verdict: dict | None  # filled by decide_* (same fields as the API response)
    error: str | None  # set by ask_* when the AI call failed


def build_graph(provider: Provider, profile: Profile, store: Store):
    """Wire the steps together. Provider, profile and store are passed in, built once at startup by app.py."""
    title_questions = questions.title_questions(profile.target_role_families)

    # ── 1. Which stage? ─────────────────────────────────────────────────────────────────────────

    def route(state: JobState) -> str:
        """The caller picks the stage; this just follows it."""
        return state["stage"]

    async def check_title(state: JobState) -> dict:
        """Free checks before paying for the AI: the card asking for more years than profile.yaml allows
        (or "Senior" / "Lead" in the title, if profile.yaml sets allowed_seniority) is a certain reject
        (verdict set -> straight to record)."""
        return {"verdict": decide.check_title_words(state["job"], profile)}

    def after_check(state: JobState) -> str:
        return "record" if state["verdict"] else "ask_title"

    # ── 2. Ask the AI - simple questions only ───────────────────────────────────────────────────

    async def ask_title(state: JobState) -> dict:
        """One question: what type of work does this title describe?"""
        return await ask(questions.title_state(state["job"]), title_questions)

    async def ask_jd(state: JobState) -> dict:
        """What is the real day-to-day work, how well do the skills match, where is the work done?
        The minimum years are only asked when experience.py could not read them: numbers from code
        beat numbers from a model. The JD is cleaned and capped first (questions.clean_jd)."""
        job = state["job"]
        years_known = parse_job_years(job.get("experience_text"), job.get("jd")) is not None
        jd_questions = questions.jd_questions(profile.skills, ask_min_years=not years_known)
        return await ask(questions.jd_state(job), jd_questions)

    async def ask(ai_state: dict, qs: dict) -> dict:
        try:
            return {"answers": await provider.ask(ai_state, qs), "error": None}
        except Exception as e:  # any failure at all: decide_* passes the job and shows the error
            log.warning("AI call failed: %s", e)
            return {"answers": None, "error": str(e) or type(e).__name__}

    # ── 3. Decide in plain code ─────────────────────────────────────────────────────────────────

    async def decide_title(state: JobState) -> dict:
        """Unwanted role type (when the AI is sure)? Otherwise on to the JD stage."""
        if state["error"]:
            return {"verdict": decide.error_verdict(state["job"], "title", f"ai_error: {state['error']}")}
        return {"verdict": decide.decide_title(state["job"], state["answers"], profile)}

    async def decide_jd(state: JobState) -> dict:
        """Unwanted role type? Too many years? Overqualified? Otherwise it's a match, scored
        position (0-5) + skills (0-5). Skills never reject: they can be learned."""
        if state["error"]:
            return {"verdict": decide.error_verdict(state["job"], "jd", f"ai_error: {state['error']}")}
        return {"verdict": decide.decide_jd(state["job"], state["answers"], profile)}

    # ── 4. Remember the result ──────────────────────────────────────────────────────────────────

    async def record(state: JobState) -> dict:
        """CSV row first (rejected.csv for any reject, matches.csv for a JD pass), then the SQLite cache.
        In that order on purpose: if the CSV can't be written (open in Excel), nothing is cached and the
        job is simply screened again next time. A title pass gets no CSV row - it isn't a match yet."""
        if state["error"]:
            return {}  # don't cache a failure; the next run should ask the AI again
        site, job, verdict = state["site"], state["job"], state["verdict"]
        provider_label = f"{provider.name}:{provider.model}"

        saved_to_csv = False
        if verdict["decision"] == "reject":
            store.append_rejected(site, job, verdict, provider_label)
            saved_to_csv = True
        elif verdict["stage"] == "jd":
            store.append_match(site, job, verdict, provider_label)
            saved_to_csv = True
        store.save_verdict(site, job, verdict, provider.name, provider.model)

        log.info("%s %s %-6s %s | %s @ %s", site, verdict["stage"], verdict["decision"], verdict["reason"],
                 job["title"], job["company"])
        return {"verdict": {**verdict, "saved_to_csv": saved_to_csv}}

    # ── Wiring: exactly the diagram at the top of this file ─────────────────────────────────────

    graph = StateGraph(JobState)
    graph.add_node("check_title", check_title)
    graph.add_node("ask_title", ask_title)
    graph.add_node("ask_jd", ask_jd)
    graph.add_node("decide_title", decide_title)
    graph.add_node("decide_jd", decide_jd)
    graph.add_node("record", record)

    graph.add_conditional_edges(START, route, {"title": "check_title", "jd": "ask_jd"})
    
    graph.add_conditional_edges("check_title", after_check, {"ask_title": "ask_title", "record": "record"})
    graph.add_edge("ask_title", "decide_title")
    graph.add_edge("ask_jd", "decide_jd")
    graph.add_edge("decide_title", "record")
    graph.add_edge("decide_jd", "record")
    graph.add_edge("record", END)
    return graph.compile()


async def screen_job(graph, site: str, stage: str, job: dict) -> dict:
    """Run one job through the graph and return its verdict."""
    final_state = await graph.ainvoke(
        {"site": site, "stage": stage, "job": job, "answers": None, "verdict": None, "error": None}
    )
    return final_state["verdict"]
