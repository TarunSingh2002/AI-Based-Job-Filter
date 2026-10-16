"""
THE PROMPT. Every question the AI is asked lives in this file.

The dicts below are already in the Jev wire format, so the Jev provider sends them unchanged:
    {question_id: {"type": "choice" | "score" | "noul", "instructions": str | object, "criteria": ...}}

Jev best practices followed here:
1. Literal instructions. Each question says exactly what to judge and which state field to read
   (`job_title`, `job_description`, ...). No role-play, no "you are an expert recruiter".
2. One judgment per question. Role family, skills, years and work mode are separate questions, so one
   fuzzy judgment never contaminates another.
3. Numbers are compared in code, never by the model. The model only reads the minimum years off the
   page (and only when experience.py could not); decide.py compares it with the candidate's years.
   Seniority is not asked at all: by default it rejects nothing, and when profile.yaml sets
   allowed_seniority, decide.py reads it from the title words with a regex before any AI call.
4. Short state (Jev is paid per input token). Only the fields the questions need; the JD is cleaned
   (whitespace, boilerplate sentences) and capped at 6,000 chars - see clean_jd().
5. Boundary cases live in the criteria. "Teaches ML to students" is teaching_training, a backend app that
   only calls an AI API is backend_software, a "data scientist" who mostly builds dashboards is
   data_analytics, and so on - written into the option descriptions (each <= 255 chars, Jev's limit).
6. An honest way out. "unclear" / "not_stated" options mean the model never has to guess. Option order
   matters to Jev, so "unclear" is kept last.
"""

import re

from dedupe import company_name

# ── Shared: what kind of work is this? (order matters - keep "unclear" last) ────────────────────
# profile.yaml's target_role_families names the wanted ones (ai_ml_engineering, data_science,
# data_engineering); every other family except "unclear" is unwanted. decide.py adds up the probabilities.

# Kept short on purpose: this list is sent with EVERY title call (every job card), so each word is paid
# for many times. The longer boundary rules for the JD stage are in its instructions (jd_questions).
ROLE_FAMILY_CRITERIA = {
    "ai_ml_engineering": (
        "Builds, trains, fine-tunes or deploys AI/ML models or LLM apps (RAG, AI agents) as the core work: AI, ML, "
        "GenAI, LLM, NLP or computer-vision engineer, MLOps."
    ),
    "data_science": (
        "Data scientist who builds statistical or ML models (prediction, forecasting, experiments), not mainly reports."
    ),
    "data_engineering": "Data pipelines, ETL, data warehouses, big-data platforms (Spark, Airflow, Kafka): data engineer.",
    "backend_software": (
        "Software, backend, full-stack, web or mobile development (Node.js, PHP, Java, .NET, Python web, React), "
        "even if it calls an AI API."
    ),
    "data_analytics": (
        "Data, business or BI analyst, SQL developer or SQL engineer, MIS: reports, dashboards, Excel, Power BI, "
        "SQL queries."
    ),
    "qa_testing": "Software testing, QA, SDET, test automation.",
    "devops_cloud_it": (
        "DevOps, cloud, SRE, infrastructure, networking, sysadmin, DBA, IT support, cybersecurity "
        "(MLOps is ai_ml_engineering)."
    ),
    "other_engineering": "Other engineering: embedded, hardware, VLSI, mechanical, civil, electrical, ERP/SAP.",
    "teaching_training": (
        "Teaches, trains or tutors students or learners, or writes course content (trainer, faculty, lecturer), "
        "even about AI or Python."
    ),
    "ai_data_annotation": (
        "Labels data or writes/rates prompts and model answers to train AI (AI trainer, AI tutor, annotator, "
        "RLHF/LLM evaluator)."
    ),
    "internship": "Internship, apprenticeship, trainee or student programme.",
    "research_academic": "University research post (PhD, postdoc, research fellow).",
    "non_technical": (
        "Sales, marketing, HR, recruiting, support, operations, product or project management, other "
        "non-engineering work."
    ),
    "unclear": "The information given does not make the main type of work clear.",
}

# Seniority levels decide.py's title regex can produce (profile.yaml's optional allowed_seniority uses these names).
SENIORITY_LEVELS = ("entry", "mid", "senior", "lead_plus")

# Score levels go from worst (index 0) to best (index 5) = the skills_score (0-5) in decide.py.
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


# ── Stage 1: title (cheap - runs on every card, so ONE question) ───────────────────────────────

def title_questions(target_families: list[str]) -> dict:
    """The one title question. Its "choose unclear" rule names the wanted types (profile.yaml), so it only
    covers a title that mixes a wanted type with another one - those go on to the JD stage. A title between
    two UNWANTED types ("QA / DevOps Engineer") still gets real answers, and decide.py's summed
    probabilities reject it here instead of paying for a JD call. (The two examples fit the default targets.)"""
    return {
        "role_family": {
            "type": "choice",
            "instructions": (
                "Judging only from `job_title` and `company`, what is the main type of work in this job? "
                f"If the title could reasonably fit one of {', '.join(target_families)} and also another type "
                "(such as \"Backend AI Engineer\" or \"Data Scientist/Analyst\"), choose unclear."
            ),
            "criteria": ROLE_FAMILY_CRITERIA,
        },
    }


def title_state(job: dict) -> dict:
    """The facts the title question is about. Location and the card's experience text are NOT sent:
    they say nothing about the type of work (code reads the experience text), and every token is paid."""
    return {"job_title": job["title"], "company": job["company"]}


# ── Stage 2: full job description (only for jobs that passed the title stage) ──────────────────

JD_MAX_CHARS = 6000


def jd_questions(candidate_skills: list[str], ask_min_years: bool) -> dict:
    """JD-stage questions. min_years is only asked when experience.py could not read the years itself."""
    qs = {
        "role_family": {
            "type": "choice",
            "instructions": (
                "According to the responsibilities in `job_description`, what is the main day-to-day work in this "
                "job? Judge by what the person will actually do, not by the job title or the keywords listed: "
                "teaching Python or ML to students is teaching_training; building LLM apps, RAG pipelines or AI "
                "agents is ai_ml_engineering, but a web or backend app that only calls an AI API is "
                "backend_software; a \"data scientist\" job that is mostly reports, dashboards and SQL queries is "
                "data_analytics."
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
    return {"job_title": job["title"], "company": job["company"],
            "job_description": clean_jd(job["jd"], job["company"])}


# ── JD cleaning: fewer paid tokens, same facts ──────────────────────────────────────────────────

# A SENTENCE that is one of these is site / legal boilerplate. Matched sentence by sentence, so a job
# sentence on the same line ("... own the feature store. We are an equal opportunity employer.") stays.
# Cookie / privacy / terms patterns match the NOTICE wording, not the topic: a data job may well "join
# cookie data" or "follow our privacy policy".
BOILERPLATE = re.compile(
    "|".join([
        # equal-opportunity / EEO statements
        r"equal (employment )?opportunit", r"\beeo\b", r"affirmative action", r"without regard to",
        r"(does not|do not|doesn't|don't) discriminate", r"reasonable accommodation", r"protected veteran",
        r"\be-verify\b",
        # site buttons and links copied along with the text (the whole sentence is the button)
        r"^\W*(apply( now| here)?|easy apply|apply on company (site|website)|click (here )?to apply|"
        r"share( this job)?|save( this)? job|report( this)? job|show (more|less)|read more|"
        r"privacy (policy|notice)|terms (of use|of service|and conditions))\W*$",
        # cookie / privacy notices
        r"\b(use|uses|accept|allow|reject|manage) (all )?cookies\b",
        r"\bcookie (policy|settings|preferences|consent)\b",
        r"\b(read|see|view|review|agree to|accept|consent to|refer to) (our |the )?"
        r"(privacy (policy|notice|statement)|terms (of use|of service|and conditions))",
        # recruitment-fraud warnings
        r"recruitment fraud", r"never (ask|asks|charge|charges) (for )?(any )?(fee|money|payment)",
    ]),
    re.I,
)
# ...but a sentence that also says one of these is about the job itself, so it always stays.
# (Not a bare "experience": cookie banners say "to improve your experience".)
JOB_CONTENT = re.compile(
    r"responsibilit|requirement|qualification|must have|nice to have|\bskills?\b|\d+\s*\+?\s*(years?|yrs)\b|"
    r"experience (in|with|of)\b|\bdegree\b|you will|you'll|duties",
    re.I,
)
SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")  # ". " "! " "? " - not the "." in "1.5": a space must follow
BOILERPLATE_MAX_SENTENCE = 500  # longer than this is text without full stops (glued bullets), never boilerplate

# Headings of the employer's own blurb. "About <the company's name>" counts too (_is_about_us), but not
# any other "About ...": "About the role / your work / the project" describe the job.
ABOUT_US_HEADING = re.compile(
    r"^(about (us|the company|our company|the organi[sz]ation)|who we are|company (overview|profile|description)|"
    r"our company)\s*:?$",
    re.I,
)
ABOUT_NAME_HEADING = re.compile(r"^about\s+(.{1,60}?)\s*:?$", re.I)


def clean_jd(text: str, company: str = "") -> str:
    """Make the JD shorter without losing anything the questions need:
    1. collapse the whitespace pages are full of;
    2. drop sentences that are pure boilerplate (EEO statements, "Apply now", cookie / privacy notices);
    3. drop the "About us" / "About <company>" employer blurb when it is the LAST section (nothing about
       the job after it);
    4. cap at JD_MAX_CHARS.
    Safety first: a sentence that mentions responsibilities, requirements, skills or years of experience
    is never dropped, and if dropping would leave almost nothing the text is kept as it was."""
    text = re.sub(r"[^\S\n]+", " ", text)  # runs of spaces / tabs / nbsp -> one space
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    lines = [_drop_boilerplate_sentences(line) for line in text.split("\n")]
    lines = _drop_trailing_about_us(lines, company)
    cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    if len(cleaned) < 200:  # the "JD too short" limit in app.py: never make a usable JD unusable
        cleaned = text
    return cleaned[:JD_MAX_CHARS]


def _drop_boilerplate_sentences(line: str) -> str:
    """The line without its boilerplate sentences ("" when that was all of it). The text is already one
    space between words, so joining the kept sentences with " " gives back the line unchanged."""
    return " ".join(s for s in SENTENCE_BREAK.split(line) if not _is_boilerplate(s))


def _is_boilerplate(sentence: str) -> bool:
    return (len(sentence) <= BOILERPLATE_MAX_SENTENCE and BOILERPLATE.search(sentence) is not None
            and not JOB_CONTENT.search(sentence))


def _drop_trailing_about_us(lines: list[str], company: str) -> list[str]:
    """Cut from an "About us" heading to the end, but only when the heading is in the second half of the
    JD and no line after it talks about the job (requirements, skills, ...). Otherwise keep everything."""
    for i in range(len(lines) - 1, len(lines) // 2 - 1, -1):
        if _is_about_us(lines[i].strip(), company):
            if not any(JOB_CONTENT.search(line) for line in lines[i + 1:]):
                return lines[:i]
            break  # job content after the blurb: it isn't the closing employer blurb
    return lines


def _is_about_us(line: str, company: str) -> bool:
    """"About us", "Who we are", ... or "About Acme" when the job's company is Acme (Pvt Ltd)."""
    if ABOUT_US_HEADING.match(line):
        return True
    name = ABOUT_NAME_HEADING.match(line)
    return bool(name) and company_name(name.group(1)) == company_name(company) != ""
