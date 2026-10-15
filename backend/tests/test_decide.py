import pytest

from decide import decide_jd, decide_title, error_verdict, match_score_from_level
from providers.base import Answer


def choice(option: str, confidence: float = 0.9) -> Answer:
    return Answer("choice", choice=option, confidence=confidence)


def job(**overrides) -> dict:
    base = {"job_id": "1", "title": "ML Engineer", "company": "Acme", "location": "", "experience_text": "",
            "link": "", "jd": ""}
    return {**base, **overrides}


def title_answers(role="ai_ml_engineering", role_conf=0.9, seniority="mid", seniority_conf=0.9):
    return {"role_family": choice(role, role_conf), "seniority": choice(seniority, seniority_conf)}


def jd_answers(role="ai_ml_engineering", role_conf=0.9, level=4.0, skills_conf=0.8, min_years=None):
    answers = {
        "role_family": choice(role, role_conf),
        "skills_match": Answer("score", score=level, confidence=skills_conf),
        "work_mode": choice("remote", 0.7),
    }
    if min_years:
        answers["min_years"] = min_years
    return answers


# ── title stage ──────────────────────────────────────────────────────────────────────────────────

def test_title_rejects_confident_avoided_role(profile):
    v = decide_title(job(), title_answers(role="teaching_training", role_conf=0.94), profile)
    assert (v["decision"], v["reason"], v["stage"], v["final"]) == ("reject", "role: teaching_training (0.94)",
                                                                    "title", False)


def test_title_rejects_at_exactly_reject_confidence(profile):
    v = decide_title(job(), title_answers(role="internship", role_conf=0.6), profile)
    assert v["decision"] == "reject"


def test_title_keeps_unsure_avoided_role(profile):
    v = decide_title(job(), title_answers(role="teaching_training", role_conf=0.59), profile)
    assert v["decision"] == "pass"


def test_title_rejects_senior(profile):
    v = decide_title(job(), title_answers(seniority="lead_plus", seniority_conf=0.8), profile)
    assert (v["decision"], v["reason"]) == ("reject", "seniority: lead_plus (0.80)")


def test_title_rejects_when_card_needs_too_many_years(profile):
    v = decide_title(job(experience_text="3-8 Yrs"), title_answers(), profile)
    assert (v["decision"], v["reason"], v["min_years"], v["max_years"]) == ("reject", "needs 3+ yrs", 3, 8)


def test_title_years_within_tolerance_pass(profile):
    # experience 1 + tolerance 1 = jobs asking for up to 2 years are fine
    v = decide_title(job(experience_text="2-4 Yrs"), title_answers(), profile)
    assert v["decision"] == "pass"


def test_title_pass_confidence_is_the_lowest(profile):
    v = decide_title(job(), title_answers(role_conf=0.9, seniority_conf=0.55), profile)
    assert v["decision"] == "pass"
    assert v["confidence"] == 0.55
    assert v["role_family"] == "ai_ml_engineering"


# ── JD stage ─────────────────────────────────────────────────────────────────────────────────────

def test_jd_pass(profile):
    v = decide_jd(job(), jd_answers(level=4.0, role_conf=0.9, skills_conf=0.7), profile)
    assert (v["decision"], v["reason"], v["match_score"]) == ("pass", "match 8/10", 8)
    assert (v["stage"], v["final"], v["work_mode"], v["confidence"]) == ("jd", True, "remote", 0.7)


def test_jd_rejects_avoided_role_first(profile):
    v = decide_jd(job(experience_text="5-8 Yrs"), jd_answers(role="teaching_training", level=0), profile)
    assert v["reason"] == "role: teaching_training (0.90)"


def test_jd_rejects_years_parsed_from_jd(profile):
    v = decide_jd(job(jd="You need 4+ years of experience with Python."), jd_answers(), profile)
    assert (v["decision"], v["reason"], v["min_years"]) == ("reject", "needs 4+ yrs", 4)


def test_jd_company_years_do_not_reject(profile):
    """A parsed number skips the AI's min_years question, so the company's own years must not be read as one."""
    jd = ("Founded in 2012, Acme Analytics has 12+ years of experience in data solutions for banks. We are hiring "
          "an AI Engineer to build LLM apps. Experience: 1+ years.")
    v = decide_jd(job(jd=jd), jd_answers(), profile)
    assert (v["decision"], v["min_years"]) == ("pass", 1)


def test_jd_uses_confident_ai_years_when_regex_found_nothing(profile):
    v = decide_jd(job(), jd_answers(min_years=choice("y5", 0.8)), profile)
    assert (v["decision"], v["reason"]) == ("reject", "needs 5+ yrs")


def test_jd_ignores_unsure_ai_years(profile):
    v = decide_jd(job(), jd_answers(min_years=choice("y5", 0.4)), profile)
    assert v["decision"] == "pass"


def test_jd_ai_years_not_stated(profile):
    v = decide_jd(job(), jd_answers(min_years=choice("not_stated", 0.95)), profile)
    assert (v["decision"], v["min_years"]) == ("pass", None)


def test_jd_rejects_overqualified(profile):
    senior_profile = profile.model_copy(update={"experience_years": 5})
    v = decide_jd(job(experience_text="0-2 Yrs"), jd_answers(), senior_profile)
    assert (v["decision"], v["reason"]) == ("reject", "overqualified (max 2 yrs)")


def test_jd_rejects_low_skills(profile):
    v = decide_jd(job(), jd_answers(level=2.0), profile)
    assert (v["decision"], v["reason"], v["match_score"]) == ("reject", "skills 5/10", 5)


def test_jd_skills_exactly_at_threshold_pass(profile):
    v = decide_jd(job(), jd_answers(level=3.0), profile)  # 1 + 3 * 9/5 = 6.4 -> 6
    assert (v["decision"], v["match_score"]) == ("pass", 6)


@pytest.mark.parametrize("level, score", [(0, 1), (1, 3), (2, 5), (2.5, 6), (3, 6), (4, 8), (5, 10), (9, 10)])
def test_match_score_from_level(level, score):
    assert match_score_from_level(level) == score


def test_error_verdict_passes_with_zero_confidence():
    v = error_verdict(job(), "jd", "ai_error: timeout")
    assert (v["decision"], v["reason"], v["confidence"], v["final"]) == ("pass", "ai_error: timeout", 0.0, False)
