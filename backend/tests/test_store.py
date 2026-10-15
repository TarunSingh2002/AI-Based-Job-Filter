from datetime import date

from decide import make_verdict
from store import MATCH_COLUMNS, REJECT_COLUMNS

BOM = b"\xef\xbb\xbf"
JOB = {"job_id": "42", "title": "ML Engineer", "company": "Acme", "location": "Pune", "experience_text": "",
       "link": "https://example.com/42"}


def today_folder(store):
    return store.output_dir / date.today().strftime("%Y-%m-%d")


def test_matches_csv_has_bom_and_header_once(store):
    verdict = make_verdict(JOB, "jd", "pass", "match 8/10", 0.8, match_score=8, role_family="ai_ml_engineering",
                           min_years=1, work_mode="remote")
    store.append_match("naukri", JOB, verdict, "mock:keyword-rules")
    store.append_match("naukri", {**JOB, "job_id": "43"}, verdict, "mock:keyword-rules")

    raw = (today_folder(store) / "naukri_matches.csv").read_bytes()
    assert raw.startswith(BOM)
    assert raw.count(BOM) == 1  # the second append must not add another BOM
    lines = raw[len(BOM):].decode("utf-8").splitlines()
    assert lines[0] == ",".join(MATCH_COLUMNS)
    assert len(lines) == 3
    assert ",naukri,42,ML Engineer,Acme,Pune,8,0.8,ai_ml_engineering,1,remote,https://example.com/42," in lines[1]


def test_rejected_csv_header(store):
    verdict = make_verdict(JOB, "title", "reject", "role: teaching_training (0.94)", 0.94)
    store.append_rejected("indeed", JOB, verdict, "mock:keyword-rules")

    raw = (today_folder(store) / "indeed_rejected.csv").read_bytes()
    assert raw.startswith(BOM)
    lines = raw[len(BOM):].decode("utf-8").splitlines()
    assert lines[0] == ",".join(REJECT_COLUMNS)
    assert "role: teaching_training (0.94)" in lines[1]


def test_csv_neutralises_excel_formulas(store):
    evil = {**JOB, "title": "=HYPERLINK(\"http://x\")"}
    store.append_rejected("indeed", evil, make_verdict(evil, "title", "reject", "x", 0.9), "mock")
    text = (today_folder(store) / "indeed_rejected.csv").read_text(encoding="utf-8-sig")
    assert "'=HYPERLINK" in text


def test_jd_verdict_replaces_title_verdict_but_not_the_reverse(store):
    title = make_verdict(JOB, "title", "pass", "title ok", 0.9)
    jd = make_verdict(JOB, "jd", "pass", "match 8/10", 0.8, match_score=8, final=True)

    store.save_verdict("glassdoor", JOB, title, "mock", "keyword-rules")
    cached = store.get_verdict("glassdoor", "42")
    assert (cached["stage"], cached["cached"], cached["final"]) == ("title", True, False)

    store.save_verdict("glassdoor", JOB, jd, "mock", "keyword-rules")
    store.save_verdict("glassdoor", JOB, title, "mock", "keyword-rules")  # must not downgrade
    cached = store.get_verdict("glassdoor", "42")
    assert (cached["stage"], cached["match_score"], cached["final"]) == ("jd", 8, True)

    assert store.get_verdict("linkedin", "42") is None  # the cache key is (site, job_id)


def test_stats_counts_todays_rows(store):
    verdict = make_verdict(JOB, "jd", "pass", "match 8/10", 0.8, match_score=8)
    store.append_match("naukri", JOB, verdict, "mock")
    store.append_rejected("naukri", JOB, make_verdict(JOB, "title", "reject", "x", 0.9), "mock")
    store.append_rejected("naukri", JOB, make_verdict(JOB, "title", "reject", "y", 0.9), "mock")

    stats = store.stats()
    assert stats["date"] == date.today().strftime("%Y-%m-%d")
    assert stats["sites"] == {"naukri": {"matches": 1, "rejected": 2}}
