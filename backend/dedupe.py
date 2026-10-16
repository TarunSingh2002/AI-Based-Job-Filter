"""
Reposts: companies post the same job again and again (new job id, same title, same company).
Each site group screens a (title, company) once; later copies are hidden as "repost of <site> <job_id>"
without asking the AI (app.py), so they cost nothing and add no CSV row.

    naukri               -> its own list
    glassdoor + indeed   -> ONE shared list: Glassdoor merged into Indeed (2026-07-01) and a third of
                            Glassdoor's jobs show up on Indeed too
    linkedin             -> none here (the extension keeps LinkedIn's own partial-hide list)

The lists live in SQLite (store.py, table seen_keys); the popup's "Clear repost list" empties one.
"""

import re

DEDUPE_GROUPS = {"naukri": "naukri", "glassdoor": "glassdoor_indeed", "indeed": "glassdoor_indeed"}

# Legal-form and filler words at the END of a company name: "Acme Technologies Pvt. Ltd." == "ACME".
COMPANY_SUFFIXES = {
    "pvt", "private", "ltd", "limited", "inc", "llp", "llc", "corp", "corporation", "co", "company",
    "technologies", "technology", "solutions", "india", "plc", "pte", "gmbh", "opc",
}


def dedupe_group(site: str) -> str | None:
    return DEDUPE_GROUPS.get(site)


def repost_key(title: str, company: str) -> str | None:
    """"Data Scientist" + "Acme Technologies Pvt. Ltd." -> "data scientist|acme".
    None when the title or company is missing: "title|" would make every company-less card a repost."""
    title_part = _normalize(title)
    company_part = company_name(company)
    if not title_part or not company_part:
        return None
    return f"{title_part}|{company_part}"


def company_name(company: str | None) -> str:
    """"Acme Technologies Pvt. Ltd." -> "acme" ("" when there is none). Also used by questions.clean_jd
    to recognise the "About Acme" employer blurb."""
    words = _normalize(company).split()
    while len(words) > 1 and words[-1] in COMPANY_SUFFIXES:  # keep at least one word ("Solutions" alone stays)
        words.pop()
    return " ".join(words)


def _normalize(text: str | None) -> str:
    """Lowercase, punctuation -> space, one space between words."""
    return " ".join(re.sub(r"[\W_]+", " ", (text or "").lower()).split())
