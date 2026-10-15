"""
Pure-code decisions: AI answers + profile.yaml -> pass / reject. No AI and no I/O in this file.

The AI only answers simple questions (questions.py). Every threshold - confidence, years of experience,
match score - is applied here in plain code, so the behaviour is predictable and you change it by
editing profile.yaml, not by rewording a prompt.
"""

from config import Profile
from experience import parse_experience, parse_job_years
from providers.base import Answer
from questions import MIN_YEARS_VALUE, SKILLS_LEVELS

TOP_SKILLS_LEVEL = len(SKILLS_LEVELS) - 1  # 5


def make_verdict(job: dict, stage: str, decision: str, reason: str, confidence: float = 0.0, **fields) -> dict:
    """Every verdict has the same keys (the API response fields), so nobody has to check for missing ones."""
    verdict = {
        "job_id": job["job_id"], "stage": stage, "decision": decision, "reason": reason,
        "confidence": round(confidence, 3),
        "match_score": None, "role_family": None, "min_years": None, "max_years": None, "work_mode": None,
        "cached": False,  # True only when it comes from the SQLite cache (store.py)
        "final": False,  # True = JD stage done, nothing left to ask
        "saved_to_csv": False,  # set by the graph's record step
    }
    verdict.update(fields)
    return verdict


def error_verdict(job: dict, stage: str, reason: str) -> dict:
    """Our own failure must never hide a job: pass it, with the error as the reason (and don't cache it)."""
    return make_verdict(job, stage, "pass", reason[:300], 0.0)


def match_score_from_level(level: float) -> int:
    """Skills level 0..5 -> match score 1..10, i.e. round(1 + level * 9 / 5).
    Rounds half up (Python's round() would turn 5.5 into 6 but 6.5 into 6)."""
    score = int(1 + level * 9 / TOP_SKILLS_LEVEL + 0.5)
    return max(1, min(10, score))


def decide_title(job: dict, answers: dict[str, Answer], profile: Profile) -> dict:
    """Stage 1. Reject only on a confident AI answer or a number read by code; otherwise go on to the JD."""
    role, seniority = answers["role_family"], answers["seniority"]
    min_years, max_years = parse_experience(job.get("experience_text")) or (None, None)
    confidence = min(role.confidence, seniority.confidence)
    fields = {"role_family": role.choice, "min_years": min_years, "max_years": max_years}

    def verdict(decision: str, reason: str) -> dict:
        return make_verdict(job, "title", decision, reason, confidence, **fields)

    if role.choice in profile.avoid_role_families and _confident(role, profile):
        return verdict("reject", f"role: {role.choice} ({role.confidence:.2f})")
    if seniority.choice not in profile.allowed_seniority and _confident(seniority, profile):
        return verdict("reject", f"seniority: {seniority.choice} ({seniority.confidence:.2f})")
    if _needs_too_many_years(min_years, profile):
        return verdict("reject", f"needs {min_years}+ yrs")
    return verdict("pass", f"title ok: {role.choice} ({role.confidence:.2f})")


def decide_jd(job: dict, answers: dict[str, Answer], profile: Profile) -> dict:
    """Stage 2, checks in this order: role -> minimum years -> overqualified -> skills match."""
    role, skills = answers["role_family"], answers["skills_match"]
    match_score = match_score_from_level(skills.score)
    confidence = min(role.confidence, skills.confidence)

    # Years: a number read by experience.py (card text first, then JD) beats the AI's reading of it.
    # The AI's min_years answer only exists when the regex found nothing (see graph.ask_jd).
    years = parse_job_years(job.get("experience_text"), job.get("jd"))
    if years:
        min_years, max_years = years
        years_trusted = True
    else:
        ai_years = answers.get("min_years")
        min_years = MIN_YEARS_VALUE.get(ai_years.choice) if ai_years else None
        max_years = None
        years_trusted = ai_years is not None and _confident(ai_years, profile)

    fields = {
        "match_score": match_score, "role_family": role.choice, "min_years": min_years, "max_years": max_years,
        "work_mode": answers["work_mode"].choice, "final": True,
    }

    def verdict(decision: str, reason: str) -> dict:
        return make_verdict(job, "jd", decision, reason, confidence, **fields)

    if role.choice in profile.avoid_role_families and _confident(role, profile):
        return verdict("reject", f"role: {role.choice} ({role.confidence:.2f})")
    if years_trusted and _needs_too_many_years(min_years, profile):
        return verdict("reject", f"needs {min_years}+ yrs")
    if max_years is not None and max_years < profile.experience_years - profile.experience_tolerance:
        return verdict("reject", f"overqualified (max {max_years} yrs)")
    if match_score < profile.min_match_score:
        return verdict("reject", f"skills {match_score}/10")
    return verdict("pass", f"match {match_score}/10")


def _confident(answer: Answer, profile: Profile) -> bool:
    """Only reject on an AI answer the model is sure about; when in doubt the job stays visible."""
    return answer.confidence >= profile.reject_confidence


def _needs_too_many_years(min_years: int | None, profile: Profile) -> bool:
    return min_years is not None and min_years > profile.experience_years + profile.experience_tolerance
