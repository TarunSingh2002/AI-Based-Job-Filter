"""
THE PROMPT. Every question the AI is asked lives in this file.

The dicts below are already in the Jev wire format, so the Jev provider sends them unchanged:
    {question_id: {"type": "choice" | "score" | "noul", "instructions": str | object, "criteria": ...}}
(The offline test stand-in, tests/mock_provider.py, reads only the ids.)

Jev best practices followed here:
1. Literal instructions. Each question says exactly what to judge and which state field to read
   (`job_title`, `job_description`, ...). No role-play, no "you are an expert recruiter".
2. One judgment per question. Role family, seniority, skills, years and work mode are separate
   questions, so one fuzzy judgment never contaminates another.
3. Numbers are compared in code, never by the model. The model only reads the minimum years off the
   page (and only when experience.py could not); decide.py compares it with the candidate's years.
   The skills level is turned into a 1-10 match score by code too.
4. Short state. Only the fields the questions need. The JD is cleaned and capped at 12,000 chars.
5. Boundary cases live in the criteria. "Teaches ML to students" is teaching_training, an "AI trainer"
   who rates model answers is ai_data_annotation, and so on - written into the option descriptions.
6. An honest way out. "unclear" / "not_stated" options mean the model never has to guess. Option order
   matters to Jev, so "unclear" is kept last.
"""

import re

# ── Shared: what kind of work is this? (order matters - keep "unclear" last) ────────────────────

ROLE_FAMILY_CRITERIA = {
    "ai_ml_engineering": (
        "Builds or improves AI, machine-learning, deep-learning, GenAI/LLM, NLP or computer-vision systems "
        "as an engineer or scientist (AI Engineer, ML Engineer, GenAI/LLM Engineer, Data Scientist, MLOps, "
        "Applied Scientist)."
    ),
    "software_engineering": (
        "Builds software as a developer where AI/ML is not the main work (backend, full-stack, Python developer, "
        "data engineer, DevOps, QA automation)."
    ),
    "data_analytics": (
        "Analyses data or builds reports and dashboards (data analyst, BI analyst) without building ML models."
    ),
    "teaching_training": (
        "Teaches, trains, tutors, mentors or creates course content for students or learners - trainer, instructor, "
        "faculty, lecturer, professor, tutor, teaching assistant, curriculum or content developer - even when the "
        "subject is AI, ML or Python."
    ),
    "ai_data_annotation": (
        "Labels data, or writes, rates or reviews prompts and model answers to train AI models (AI trainer, AI tutor, "
        "data annotator, RLHF or LLM evaluator, prompt rater), usually freelance or contract task work."
    ),
    "internship": "An internship, apprenticeship, trainee or student programme.",
    "research_academic": (
        "Academic or university research position (PhD, postdoc, research fellow, research associate at a university)."
    ),
    "non_technical": (
        "Sales, marketing, business development, HR, recruiting, customer support, operations or other "
        "non-engineering work."
    ),
    "unclear": "The information given does not make the main type of work clear.",
}

SENIORITY_CRITERIA = {
    "entry": "Fresher, junior, associate, graduate, trainee or level I",
    "mid": "No seniority word, or level II",
    "senior": "Senior, Sr. or level III",
    "lead_plus": "Lead, staff, principal, architect, manager, head, director or VP",
}

# Score levels go from worst (index 0) to best (index 5). decide.py maps the level to a 1-10 match score.
SKILLS_LEVELS = [
    "Almost none of the required core skills are in the candidate's list",
    "One or two minor skills overlap, but the core skills are missing",
    "Some overlap, but most core skills are missing",
    "About half of the core skills are in the candidate's list",
    "Most core skills are in the candidate's list; one or two important ones are missing",
    "Nearly all core skills are in the candidate's list",
]

MIN_YEARS_CRITERIA = {
    "y0": "Freshers welcome, or 0 years",
    "y1": "1 year",
    "y2": "2 years",
    "y3": "3 years",
    "y4": "4 years",
    "y5": "5 years",
    "y6": "6 years",
    "y7": "7 years",
    "y8_plus": "8 or more years",
    "not_stated": "No number of years is stated",
}

# The number behind each min_years option (None = the JD gives no number).
MIN_YEARS_VALUE = {
    "y0": 0, "y1": 1, "y2": 2, "y3": 3, "y4": 4, "y5": 5, "y6": 6, "y7": 7, "y8_plus": 8, "not_stated": None,
}

WORK_MODE_CRITERIA = {
    "remote": "Fully remote or work from home.",
    "hybrid": "A mix of office days and remote days.",
    "onsite": "Work at an office or client site, with no remote option.",
    "not_stated": "The job description does not say where the work is done.",
}


# ── Stage 1: title (cheap - runs on every card) ─────────────────────────────────────────────────

TITLE_QUESTIONS = {
    "role_family": {
        "type": "choice",
        "instructions": (
            "Judging only from `job_title` and `company`, what is the main type of work in this job? "
            "If the title could reasonably fit two types, choose unclear."
        ),
        "criteria": ROLE_FAMILY_CRITERIA,
    },
    "seniority": {
        "type": "choice",
        "instructions": (
            "Which seniority level does `job_title` state? If the title has two seniority words, choose the higher "
            "level (Senior Associate is senior, Associate Director is lead_plus)."
        ),
        "criteria": SENIORITY_CRITERIA,
    },
}


def title_state(job: dict) -> dict:
    """The facts the title questions are about. The card's experience text is NOT sent: code reads it."""
    state = {"job_title": job["title"], "company": job["company"]}
    if job.get("location"):
        state["location"] = job["location"]
    return state


# ── Stage 2: full job description (only for jobs that passed the title stage) ──────────────────

JD_MAX_CHARS = 12000


def jd_questions(candidate_skills: list[str], ask_min_years: bool) -> dict:
    """JD-stage questions. min_years is only asked when experience.py could not read the years itself."""
    qs = {
        "role_family": {
            "type": "choice",
            "instructions": (
                "According to the responsibilities in `job_description`, what is the main day-to-day work in this "
                "job? Judge by what the person will actually do, not by the keywords listed: a job that teaches "
                "Python or ML to students is teaching_training even though it mentions Python and ML."
            ),
            "criteria": ROLE_FAMILY_CRITERIA,
        },
        "skills_match": {
            "type": "score",
            "instructions": {
                "question": (
                    "How well do the skills in `candidate_skills` cover the core technical skills that "
                    "`job_description` requires?"
                ),
                "candidate_skills": candidate_skills,
            },
            "criteria": SKILLS_LEVELS,
        },
    }
    if ask_min_years:
        # The boundary cases spelled out here are the texts experience.py hands over because it can't read
        # them: company years next to the real requirement, several numbers, months, "preferred".
        qs["min_years"] = {
            "type": "choice",
            "instructions": (
                "What is the minimum number of years of work experience that `job_description` requires? "
                "For a range like 2-5 years, choose the lower number. "
                "Count only experience the candidate must have; ignore years that describe the company "
                "(such as \"we have 12 years of experience\"). If several numbers are given (such as 4+ years "
                "overall and 2+ years in ML), choose the years of total work experience. Years marked as "
                "preferred still count. Round fractional years down, and choose y0 for less than 1 year."
            ),
            "criteria": MIN_YEARS_CRITERIA,
        }
    qs["work_mode"] = {
        "type": "choice",
        "instructions": "Where does `job_description` say the work is done?",
        "criteria": WORK_MODE_CRITERIA,
    }
    return qs


def jd_state(job: dict) -> dict:
    return {"job_title": job["title"], "company": job["company"], "job_description": clean_jd(job["jd"])}


def clean_jd(text: str) -> str:
    """Collapse the whitespace pages are full of, then cap the length (shorter state = sharper answers)."""
    text = re.sub(r"[^\S\n]+", " ", text)  # runs of spaces / tabs / nbsp -> one space
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:JD_MAX_CHARS]
