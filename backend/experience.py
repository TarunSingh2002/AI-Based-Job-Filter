"""
Reads "years of experience" out of text with plain regexes - no AI.

    "3-8 Yrs"                        -> (3, 8)
    "2+ years of experience"         -> (2, None)    None = no upper limit stated
    "minimum 3 years of experience"  -> (3, None)
    "up to 3 years of experience"    -> (0, 3)       a ceiling, not a minimum
    "Freshers"                       -> (0, None)
    "Python 3.10", "team of 50"      -> None         nothing about experience

A parsed number is trusted more than the AI's reading of it (decide.py), so the patterns are strict on
purpose: a number only counts when "years"/"yrs" follows it AND the wording makes it an experience
requirement (a range, "minimum ... experience", "of experience", ...). A mention whose sentence shows it
is about something else - the company ("we have 12+ years of experience"), a service bond, a contract,
a degree - is skipped. Skipping is the safe side: when nothing is left, the AI is asked instead, and its
answer only rejects when it is confident. When the text names two different requirements we can't tell
which one is real, so we return None and the AI is asked as well.
"""

import math
import re

# 1-2 digit number, optionally decimal. The look-behind stops "2026" matching as "26" and "2.5" as "5".
NUM = r"(?<![\d.])(\d{1,2}(?:\.\d+)?)"
# year, years, yr, yrs, year(s) - but not "yearly", and not "10 years old" (an age).
UNIT = r"(?:years?|yrs?)(?:\(s\))?(?![a-z])(?!\s+old\b)"
DASH = r"(?:-|–|—|to)"
# "experience" / "exp" soon after the unit, in the same sentence. Needed for loose wordings like "10+ years"
# or "over 12 years", which also describe other things ("a bond of at least 2 years").
EXPERIENCE_FOLLOWS = r"(?=[^.\n]{0,40}?\b(?:experience|exp)\b)"

PATTERNS = [
    # "3-8 Yrs", "5 to 7 years", "1.5 - 3 years"
    re.compile(rf"{NUM}\s*{DASH}\s*{NUM}\s*\+?\s*{UNIT}", re.I),
    # "between 2 and 4 years"
    re.compile(rf"\bbetween\s+{NUM}\s+and\s+{NUM}\s*{UNIT}", re.I),
    # "minimum 3 years of experience", "at least 2 yrs exp", "min. 4 years of relevant experience"
    re.compile(rf"\b(?:minimum|min\.?|at\s*least)\s*(?:of\s+)?{NUM}\s*{UNIT}{EXPERIENCE_FOLLOWS}", re.I),
    # "2+ years of experience", "10+ yrs exp", "3 plus years of relevant experience"
    re.compile(rf"{NUM}\s*(?:\+|plus)\s*{UNIT}{EXPERIENCE_FOLLOWS}", re.I),
    # "over 5 years of experience", "more than 3 years in a similar role with Python experience"
    re.compile(rf"\b(?:over|more\s+than)\s*{NUM}\s*{UNIT}{EXPERIENCE_FOLLOWS}", re.I),
    # "3 years of experience", "4 yrs exp", "5 years of hands-on industry experience"
    re.compile(rf"{NUM}\s*{UNIT}\s+(?:of\s+)?(?:[\w-]+\s+){{0,3}}?(?:experience|exp)\b", re.I),
    # "Experience: 3 years", "Experience Required: 3+ Years", "Exp: 2 yrs"
    re.compile(rf"\b(?:experience|exp)\b[^.\d\n]{{0,25}}?{NUM}\s*(?:\+|plus)?\s*{UNIT}", re.I),
    # the whole text is just "3 Yrs", "2+ yrs" or "minimum 3 years" (a short card field)
    re.compile(rf"^\s*(?:(?:minimum|min\.?|at\s*least)\s*)?{NUM}\s*(?:\+|plus)?\s*{UNIT}\s*\+?\s*$", re.I),
]
# Words right before the number that make it a ceiling: "up to 3 years", "max 3 yrs", "6 months to 3 years".
# "not less than 3 years" / "no less than" is a minimum, so "less than" right after not / no doesn't count.
CEILING_BEFORE = re.compile(
    rf"\b(?:up\s*to|max(?:imum)?|(?<!\bnot\s)(?<!\bno\s)less\s+than|under|below|within|till|months?\s*{DASH})\W*$",
    re.I,
)
FRESHER = re.compile(r"\bfreshers?\b", re.I)
# "Not for freshers", "no freshers", "freshers need not apply" say nothing about how many years are needed.
NOT_FOR_FRESHERS = re.compile(r"\b(?:not|no)\b[^.\n]{0,20}\bfreshers?\b|\bfreshers?\b[^.\n]{0,15}\bnot\b", re.I)

# A sentence that mentions one of these uses "years" for something else:
# "a service agreement for a minimum 3 years", "this 2 year contract role", "4 years bachelors degree".
NOT_EXPERIENCE = re.compile(r"\b(?:bond|agreement|contract|commitment|service\s+period|degree)", re.I)
# Words just before the mention that show it describes the company, not the candidate:
# "we have 12+ years of experience", "Acme has 12+ years of ...", "our experience spanning 14 years".
# (Not a bare "we": "we are looking for 2-4 years of experience" is a requirement.)
COMPANY_BEFORE = re.compile(
    r"\b(?:we\s+have|we've|we\s+bring|our|has|boasts|company|firm|founded|established|since)\b", re.I
)
# A sentence that opens "With over 12 years of experience, Acme ..." is a company intro too.
COMPANY_OPENER = re.compile(r"^\s*with\b", re.I)
# Where a sentence ends: . ! ? ; or a line break (but not the "." in "1.5").
SENTENCE_END = re.compile(r"[.!?;\n](?!\d)")

# Above this it is almost never an experience requirement ("a company with 25 years of experience",
# "age 18-25 years"), so ignore it and let the AI read the JD instead.
MAX_SANE_YEARS = 15


# Job posts pasted from Word/Docs use look-alike dashes ("8‐11", "8‑11", "8−11"); the patterns only know "-", "–", "—".
# Without this, "Experience: 8‑11 Years" was not read and the job slipped through on a low-confidence AI guess.
DASH_LOOKALIKES = re.compile("[‐‑‒―−﹘﹣－]")


def parse_experience(text: str | None) -> tuple[int, int | None] | None:
    """Return (min_years, max_years or None), or None when the text states no clear experience requirement."""
    if not text:
        return None
    text = DASH_LOOKALIKES.sub("-", text)

    requirements = set(_find_requirements(text))
    if len(requirements) == 1:
        return requirements.pop()
    if requirements:
        return None  # two different requirements: let the AI read it (see the module docstring)
    # "Fresher" is only a fallback, used when no number is found.
    if FRESHER.search(text) and not NOT_FOR_FRESHERS.search(text):
        return 0, None
    return None


def parse_job_years(experience_text: str | None, jd: str | None = None) -> tuple[int, int | None] | None:
    """The site's own experience field (e.g. Naukri's "3-8 Yrs") is the most reliable; the JD is next."""
    return parse_experience(experience_text) or parse_experience(jd)


def _find_requirements(text: str) -> list[tuple[int, int | None]]:
    """Every experience mention in the text as (min, max). One mention can match several patterns
    ("3-8 years of experience" also contains "8 years of experience"), so overlapping matches count once:
    the one that starts first (and is longest) wins."""
    matches = sorted(
        (m for pattern in PATTERNS for m in pattern.finditer(text)),
        key=lambda m: (m.start(), -m.end()),
    )
    requirements, covered_until = [], -1
    for m in matches:
        if m.start() < covered_until:
            continue  # part of a mention we already read
        covered_until = m.end()

        low = float(m.group(1))
        high = float(m.group(2)) if m.re.groups == 2 else None  # only the range patterns have two numbers
        if high is not None and high < low:
            low, high = high, low
        if low > MAX_SANE_YEARS or not _about_the_candidate(text, m):
            continue
        if CEILING_BEFORE.search(text[max(0, m.start(1) - 20):m.start(1)]):
            low, high = 0, high or low  # "up to 3 years" allows 0..3, it doesn't demand 3
        # Round the minimum down and the maximum up: be lenient.
        requirements.append((int(low), math.ceil(high) if high is not None else None))
    return requirements


def _about_the_candidate(text: str, m: re.Match) -> bool:
    """False when the sentence around the mention shows the years are not the candidate's experience."""
    start = max((end.end() for end in SENTENCE_END.finditer(text, 0, m.start())), default=0)
    next_end = SENTENCE_END.search(text, m.end())
    sentence = text[start:next_end.start() if next_end else len(text)]
    lead_in = text[start:m.start()]  # the same sentence, up to the mention
    if NOT_EXPERIENCE.search(sentence):
        return False
    return not (COMPANY_BEFORE.search(lead_in[-40:]) or COMPANY_OPENER.search(lead_in))
