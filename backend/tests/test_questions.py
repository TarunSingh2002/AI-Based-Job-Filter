"""The prompt must stay inside Jev's wire-format limits, and the real profile.yaml must load."""

import pytest
from pydantic import ValidationError

import questions
from config import BACKEND_DIR, Profile, load_profile

ALL_QUESTIONS = {**questions.TITLE_QUESTIONS, **questions.jd_questions(["Python"], ask_min_years=True)}


@pytest.mark.parametrize("qid", list(ALL_QUESTIONS))
def test_questions_fit_jev_limits(qid):
    q = ALL_QUESTIONS[qid]
    assert q["type"] in ("choice", "score", "noul")
    if q["type"] == "choice":
        assert all(len(text) <= 255 for text in q["criteria"].values())
    if q["type"] == "score":
        assert 2 <= len(q["criteria"]) <= 10


def test_unclear_is_the_last_role_family():
    assert list(questions.ROLE_FAMILY_CRITERIA)[-1] == "unclear"


def test_every_min_years_option_has_a_value():
    assert set(questions.MIN_YEARS_CRITERIA) == set(questions.MIN_YEARS_VALUE)


def test_jd_questions_order():
    assert list(questions.jd_questions([], ask_min_years=True)) == ["role_family", "skills_match", "min_years",
                                                                     "work_mode"]
    assert "min_years" not in questions.jd_questions([], ask_min_years=False)


def test_states_are_short():
    job = {"title": "AI Engineer", "company": "Acme", "location": "", "experience_text": "3-8 Yrs",
           "jd": "Line one   with   spaces\n\n\n\nLine two " + "x" * 20000}
    assert questions.title_state(job) == {"job_title": "AI Engineer", "company": "Acme"}  # no empty location
    jd = questions.jd_state(job)["job_description"]
    assert jd.startswith("Line one with spaces\n\nLine two")
    assert len(jd) == questions.JD_MAX_CHARS


def test_real_profile_yaml_loads():
    profile = load_profile(BACKEND_DIR / "profile.yaml")
    assert profile.skills and profile.experience_years >= 0


def test_profile_rejects_unknown_role_family(profile):
    with pytest.raises(ValidationError, match="teaching"):
        Profile(**{**profile.model_dump(), "avoid_role_families": ["teaching"]})


def test_profile_rejects_misspelt_key(profile):
    with pytest.raises(ValidationError, match="min_match_scor"):
        Profile(**{**profile.model_dump(), "min_match_scor": 4})


def test_min_years_and_seniority_spell_out_their_boundary_cases():
    min_years = questions.jd_questions([], ask_min_years=True)["min_years"]["instructions"]
    assert "ignore years that describe the company" in min_years
    assert "y0 for less than 1 year" in min_years
    assert "Associate Director is lead_plus" in questions.TITLE_QUESTIONS["seniority"]["instructions"]
    # the option keys and their order stay as in DESIGN.md
    assert list(questions.SENIORITY_CRITERIA) == ["entry", "mid", "senior", "lead_plus"]
    assert list(questions.MIN_YEARS_CRITERIA)[-1] == "not_stated"
