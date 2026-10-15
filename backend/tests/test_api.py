"""End-to-end tests of the HTTP API with the mock provider (offline, temp folders)."""

import asyncio
import csv
from datetime import date

PASS_JD = (
    "We are hiring a Machine Learning Engineer to build LLM and RAG applications. You will use Python, PyTorch, "
    "TensorFlow, LangChain, LangGraph, Pandas, NumPy and SQL, and ship GenAI features with FastAPI. A background "
    "in Deep Learning, NLP and Data Science is a plus. This is a remote role."
)
TEACHING_JD = (
    "You will teach Python and Machine Learning to college students, prepare course material and slides, run "
    "weekly doubt-clearing sessions and grade assignments. Strong communication skills and patience with "
    "beginners are essential for this classroom role."
)


def csv_rows(tmp_path, site: str, kind: str) -> list[dict]:
    path = tmp_path / "output" / date.today().strftime("%Y-%m-%d") / f"{site}_{kind}.csv"
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def test_health(client):
    body = client.get("/health").json()
    assert body == {"ok": True, "provider": "mock", "model": "keyword-rules", "profile": {"experience_years": 1}}


def test_screen_title_decisions_order_and_cache(client, tmp_path):
    jobs = [
        {"job_id": "1", "title": "AI Engineer", "company": "Acme"},
        {"job_id": "2", "title": "Python Trainer", "company": "EduCorp"},
        {"job_id": "3", "title": "Senior Data Scientist", "company": "BigCo"},
        {"job_id": 4, "title": "GenAI Developer", "company": "X", "experience_text": "5-10 Yrs", "location": None},
    ]
    first = client.post("/screen/title", json={"site": "naukri", "jobs": jobs}).json()["results"]

    assert [r["job_id"] for r in first] == ["1", "2", "3", "4"]  # same order as sent
    assert [r["decision"] for r in first] == ["pass", "reject", "reject", "reject"]
    assert first[1]["reason"] == "role: teaching_training (0.90)"
    assert first[2]["reason"] == "seniority: senior (0.90)"
    assert first[3]["reason"] == "needs 5+ yrs"
    assert all(r["stage"] == "title" and r["cached"] is False and r["final"] is False for r in first)

    second = client.post("/screen/title", json={"site": "naukri", "jobs": jobs}).json()["results"]
    assert [r["decision"] for r in second] == ["pass", "reject", "reject", "reject"]
    assert all(r["cached"] is True and r["final"] is False for r in second)

    # one rejected row per reject, written by the first call only
    assert [row["job_id"] for row in csv_rows(tmp_path, "naukri", "rejected")] == ["2", "3", "4"]
    assert csv_rows(tmp_path, "naukri", "matches") == []  # a title pass is not a match yet


def test_screen_jd_pass_writes_one_match_row(client, tmp_path):
    job = {"job_id": "10", "title": "AI Engineer", "company": "Acme", "link": "https://x/10", "jd": PASS_JD}

    first = client.post("/screen/jd", json={"site": "naukri", "job": job}).json()
    assert first["decision"] == "pass"
    assert first["match_score"] >= 6
    assert (first["stage"], first["final"], first["cached"], first["saved_to_csv"]) == ("jd", True, False, True)
    assert first["work_mode"] == "remote"

    second = client.post("/screen/jd", json={"site": "naukri", "job": job}).json()
    assert (second["decision"], second["cached"], second["saved_to_csv"]) == ("pass", True, False)
    assert second["match_score"] == first["match_score"]

    rows = csv_rows(tmp_path, "naukri", "matches")
    assert len(rows) == 1  # the cached second call must not add a row
    assert (rows[0]["job_id"], rows[0]["link"], rows[0]["provider"]) == ("10", "https://x/10", "mock:keyword-rules")

    # the title endpoint now knows this job is fully done
    title = client.post("/screen/title", json={"site": "naukri", "jobs": [job]}).json()["results"][0]
    assert (title["decision"], title["cached"], title["final"], title["stage"]) == ("pass", True, True, "jd")


def test_screen_jd_reject_writes_rejected_row(client, tmp_path):
    job = {"job_id": "11", "title": "AI Instructor", "company": "EduCorp", "jd": TEACHING_JD}

    first = client.post("/screen/jd", json={"site": "indeed", "job": job}).json()
    assert (first["decision"], first["reason"], first["stage"]) == ("reject", "role: teaching_training (0.90)", "jd")
    assert first["saved_to_csv"] is True

    second = client.post("/screen/jd", json={"site": "indeed", "job": job}).json()
    assert (second["decision"], second["cached"]) == ("reject", True)

    rows = csv_rows(tmp_path, "indeed", "rejected")
    assert len(rows) == 1
    assert (rows[0]["stage"], rows[0]["reason"]) == ("jd", "role: teaching_training (0.90)")
    assert csv_rows(tmp_path, "indeed", "matches") == []


def test_short_jd_falls_back_to_title_and_is_not_final(client, tmp_path):
    job = {"job_id": "12", "title": "AI Engineer", "company": "Acme", "jd": "Apply now"}
    short = client.post("/screen/jd", json={"site": "linkedin", "job": job}).json()
    assert (short["decision"], short["reason"], short["match_score"], short["final"]) == ("pass", "no_jd", None, False)
    assert csv_rows(tmp_path, "linkedin", "matches") == []

    # a later call with a real JD gets a real JD verdict
    full = client.post("/screen/jd", json={"site": "linkedin", "job": {**job, "jd": PASS_JD}}).json()
    assert (full["cached"], full["final"], full["reason"]) == (False, True, f"match {full['match_score']}/10")


def test_short_jd_keeps_a_title_reject(client):
    job = {"job_id": "13", "title": "Python Trainer", "company": "EduCorp", "jd": ""}
    body = client.post("/screen/jd", json={"site": "linkedin", "job": job}).json()
    assert (body["decision"], body["stage"]) == ("reject", "title")


def test_stats(client):
    client.post("/screen/jd", json={"site": "naukri", "job": {"job_id": "20", "title": "AI Engineer",
                                                               "company": "A", "jd": PASS_JD}})
    client.post("/screen/jd", json={"site": "naukri", "job": {"job_id": "21", "title": "AI Instructor",
                                                               "company": "B", "jd": TEACHING_JD}})
    body = client.get("/stats").json()
    assert body["date"] == date.today().strftime("%Y-%m-%d")
    assert body["sites"] == {"naukri": {"matches": 1, "rejected": 1}}


def test_locked_csv_passes_the_job_and_caches_nothing(client, monkeypatch):
    """Excel locks an open CSV on Windows. The job must stay visible and be retried, not lost."""
    from app import app

    def locked(*args, **kwargs):
        raise PermissionError("[Errno 13] Permission denied: 'naukri_matches.csv'")

    monkeypatch.setattr(app.state.store, "append_match", locked)
    job = {"job_id": "30", "title": "AI Engineer", "company": "Acme", "jd": PASS_JD}

    body = client.post("/screen/jd", json={"site": "naukri", "job": job}).json()
    assert body["decision"] == "pass"
    assert body["reason"].startswith("ai_error: PermissionError")
    assert app.state.store.get_verdict("naukri", "30") is None


async def test_same_job_at_the_same_time_is_screened_once(async_client, tmp_path, monkeypatch):
    """Two tabs, a reload during a slow AI call, or the same card twice in one batch: one AI call, one CSV row."""
    from app import app

    asked = []
    real_ask = app.state.provider.ask

    async def slow_ask(state, questions):
        asked.append(state["job_title"])
        await asyncio.sleep(0.05)  # still running when the other request arrives
        return await real_ask(state, questions)

    monkeypatch.setattr(app.state.provider, "ask", slow_ask)

    job = {"job_id": "77", "title": "AI Engineer", "company": "Acme", "jd": PASS_JD}
    replies = await asyncio.gather(
        *(async_client.post("/screen/jd", json={"site": "linkedin", "job": job}) for _ in range(2))
    )
    assert [r.json()["decision"] for r in replies] == ["pass", "pass"]
    assert asked == ["AI Engineer"]
    assert [row["job_id"] for row in csv_rows(tmp_path, "linkedin", "matches")] == ["77"]

    batch = [{"job_id": "88", "title": "Python Trainer", "company": "EduCorp"}] * 2
    reply = await async_client.post("/screen/title", json={"site": "linkedin", "jobs": batch})
    assert [r["decision"] for r in reply.json()["results"]] == ["reject", "reject"]
    assert asked == ["AI Engineer", "Python Trainer"]
    assert [row["job_id"] for row in csv_rows(tmp_path, "linkedin", "rejected")] == ["88"]


def test_unknown_site_is_refused(client):
    response = client.post("/screen/title", json={"site": "../evil", "jobs": []})
    assert response.status_code == 422
