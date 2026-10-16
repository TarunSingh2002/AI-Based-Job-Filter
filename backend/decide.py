"""
Pure-code decisions: AI answers + profile.yaml -> pass / reject. No AI and no I/O in this file.

The AI only answers simple questions (questions.py). Every threshold - confidence, years of experience,
the optional seniority filter - is applied here in plain code, so the behaviour is predictable and you
change it by editing profile.yaml, not by rewording a prompt.

Position first: a job is rejected for being the wrong TYPE of job (role family), never for its skills -
skills can be learned. The skills answer only feeds the match score that sorts jobs.xlsx:
    match_score (0-10) = position_score (0-5, how surely it is a wanted role type)
                       + skills_score   (0-5, the AI's skills level)
"""

import re

from config import Profile
from experience import parse_experience, parse_job_years
from providers.base import Answer
from questions import MIN_YEARS_VALUE, SKILLS_LEVELS

TOP_SKILLS_LEVEL = len(SKILLS_LEVELS) - 1  # 5

# Seniority comes from the title words (no AI question - cheaper, and a word is a word). Only used when
# profile.yaml sets allowed_seniority; without it no job is rejected for its seniority.
# Checked from the top down, so "Senior Associate" is senior and "Associate Director" is lead_plus.


def _title_words(words: str) -> re.Pattern:
    """Whole words, with "not a letter" on both sides instead of \\b: \\b doesn't break at "_", and some
    companies post titles like "IN_Senior Associate_Data Science". (re.I: [a-z] covers capitals too.)"""
    return re.compile(rf"(?<![a-z])({words})(?![a-z])", re.I)


LEAD_PLUS_WORDS = _title_words(
    r"lead|leader|principal|staff|architect|managers?|head|director|vp|avp|svp|evp|vice[\s_-]+president|chief"
)
# Grades III / IV ("Data Scientist III") are senior. Not "L3" / "L4": entry at one company, senior at another.
SENIOR_WORDS = _title_words(r"senior|sr|iii|iv")  # "Sr." too: the dot is not a letter
ENTRY_WORDS = _title_words(r"junior|jr|freshers?|graduate|trainee|associate|entry[\s_-]*level")
SENIORITY_REASON = "seniority: "  # reject reason prefix, e.g. "seniority: senior" (also read back from the cache)


def make_verdict(job: dict, stage: str, decision: str, reason: str, confidence: float = 0.0, **fields) -> dict:
    """Every verdict has the same keys (the API response fields), so nobody has to check for missing ones."""
    verdict = {
        "job_id": job["job_id"], "stage": stage, "decision": decision, "reason": reason,
        "confidence": round(confidence, 3),
        "match_score": None, "position_score": None, "skills_score": None,
        "role_family": None, "min_years": None, "max_years": None, "work_mode": None,
        "cached": False,  # True only when it comes from the SQLite cache (store.py)
        "final": False,  # True = JD stage done, nothing left to ask
        "duplicate": False,  # True = a repost of a job already screened (app.py), never sent to the AI
        "saved_to_csv": False,  # set by the graph's record step
    }
    verdict.update(fields)
    return verdict


def error_verdict(job: dict, stage: str, reason: str) -> dict:
    """Our own failure must never hide a job: pass it, with the error as the reason (and don't cache it)."""
    return make_verdict(job, stage, "pass", reason[:300], 0.0)


def duplicate_verdict(job: dict, original_site: str, original_job_id: str) -> dict:
    """A repost of a job this site group already screened: hide it, final, without asking the AI."""
    return make_verdict(job, "title", "reject", f"repost of {original_site} {original_job_id}", 1.0,
                        cached=True, final=True, duplicate=True)


def title_seniority(title: str) -> str:
    """"Senior Data Scientist" -> senior, "ML Lead" -> lead_plus, "Junior AI Engineer" -> entry, else mid."""
    if LEAD_PLUS_WORDS.search(title):
        return "lead_plus"
    if SENIOR_WORDS.search(title):
        return "senior"
    if ENTRY_WORDS.search(title):
        return "entry"
    return "mid"


def outdated_seniority_reject(verdict: dict, profile: Profile) -> bool:
    """A cached title reject "seniority: <level>" that profile.yaml no longer makes (allowed_seniority removed,
    or that level added to it). app.py screens such a job again instead of serving the old reject, so turning
    the seniority filter off really means no job is hidden for its seniority - also one seen before."""
    reason = verdict["reason"] or ""
    if verdict["stage"] != "title" or verdict["decision"] != "reject" or not reason.startswith(SENIORITY_REASON):
        return False
    level = reason.removeprefix(SENIORITY_REASON)
    return not profile.allowed_seniority or level in profile.allowed_seniority


def role_split(role: Answer, profile: Profile) -> tuple[float, float, str]:
    """Add up the role-family probabilities: (p_wanted, p_unwanted, most likely unwanted family).
    wanted = profile.target_role_families; unwanted = every other family except "unclear", which is
    neither (an unclear title goes on to the JD stage). Summing matters: "backend 0.35 + data analytics
    0.30" is a confident "not a wanted role" even though no single family reaches 0.6."""
    probabilities = role.probabilities or {role.choice: role.confidence}  # no probabilities: trust the choice
    wanted = unwanted = 0.0
    top_unwanted, top_p = role.choice, -1.0
    for family, p in probabilities.items():
        p = float(p)
        if family in profile.target_role_families:
            wanted += p
        elif family != "unclear":
            unwanted += p
            if p > top_p:
                top_unwanted, top_p = family, p
    return wanted, unwanted, top_unwanted


def check_title_words(job: dict, profile: Profile) -> dict | None:
    """Stage 1, part 1 - BEFORE the AI: too many years on the card or, only when profile.yaml sets
    allowed_seniority, a seniority word in the title. Both are read by code, so they are certain and reject
    the job whatever type of work it is: no need to pay the AI to ask. Returns that reject verdict, or
    None = nothing found, ask the AI (decide_title)."""
    seniority = title_seniority(job["title"]) if profile.allowed_seniority else None
    min_years, max_years = parse_experience(job.get("experience_text")) or (None, None)
    if seniority and seniority not in profile.allowed_seniority:
        reason = f"{SENIORITY_REASON}{seniority}"
    elif _needs_too_many_years(min_years, profile):
        reason = f"needs {min_years}+ yrs"
    else:
        return None
    return make_verdict(job, "title", "reject", reason, 1.0, min_years=min_years, max_years=max_years)


def decide_title(job: dict, answers: dict[str, Answer], profile: Profile) -> dict:
    """Stage 1, part 2 - after the AI (check_title_words found nothing): reject an unwanted role type
    when the AI is sure. Otherwise on to the JD stage."""
    role = answers["role_family"]
    wanted, unwanted, top_unwanted = role_split(role, profile)
    min_years, max_years = parse_experience(job.get("experience_text")) or (None, None)
    fields = {"role_family": role.choice, "min_years": min_years, "max_years": max_years}

    if unwanted >= profile.reject_confidence:
        return make_verdict(job, "title", "reject", f"role: {top_unwanted} ({unwanted:.2f})", unwanted, **fields)
    return make_verdict(job, "title", "pass", f"title ok: {role.choice} (wanted {wanted:.2f})", role.confidence,
                        **fields)


def decide_jd(job: dict, answers: dict[str, Answer], profile: Profile) -> dict:
    """Stage 2, checks in this order: unwanted role type -> minimum years -> overqualified.
    No skills check: a wanted position with different skills still passes (with a lower match score)."""
    role, skills = answers["role_family"], answers["skills_match"]
    wanted, unwanted, top_unwanted = role_split(role, profile)
    position_score = min(5, _round_half_up(5 * wanted))  # 0..5 (min: probabilities may add up to 1.0001)
    skills_score = max(0, min(TOP_SKILLS_LEVEL, _round_half_up(skills.score)))  # 0..5 (the level may be fractional)

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
        years_trusted = ai_years is not None and ai_years.confidence >= profile.reject_confidence

    fields = {
        "match_score": position_score + skills_score, "position_score": position_score,
        "skills_score": skills_score, "role_family": role.choice, "min_years": min_years, "max_years": max_years,
        "work_mode": answers["work_mode"].choice, "final": True,
    }
    confidence = min(role.confidence, skills.confidence)

    def verdict(decision: str, reason: str, conf: float = confidence) -> dict:
        return make_verdict(job, "jd", decision, reason, conf, **fields)

    if unwanted >= profile.reject_confidence:
        return verdict("reject", f"role: {top_unwanted} ({unwanted:.2f})", unwanted)
    if years_trusted and _needs_too_many_years(min_years, profile):
        return verdict("reject", f"needs {min_years}+ yrs")
    if max_years is not None and max_years < profile.experience_years - profile.experience_tolerance:
        return verdict("reject", f"overqualified (max {max_years} yrs)")
    return verdict("pass", f"position {position_score}/5, skills {skills_score}/5")


def _round_half_up(x: float) -> int:
    """Python's round() rounds half to even (2.5 -> 2, 3.5 -> 4); a score should not depend on that."""
    return int(x + 0.5)


def _needs_too_many_years(min_years: int | None, profile: Profile) -> bool:
    return min_years is not None and min_years > profile.experience_years + profile.experience_tolerance
