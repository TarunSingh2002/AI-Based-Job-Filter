"""
TEST-ONLY stand-in for Jev: deterministic keyword rules - no network, no API key.
The tests use it so they run offline and give the same answers every time. It is deliberately dumb;
the real app always uses Jev (providers/jev.py).
"""

import re

from providers.base import Answer, ProviderError

HIT, MISS = 0.9, 0.5  # confidence with / without a keyword hit

# First matching rule wins, so "AI Trainer" is annotation, not teaching.
ROLE_RULES = [
    ("ai_data_annotation", r"annotat|\bai\s+trainer"),
    ("teaching_training", r"teach|\btrainer|\btutor|faculty"),
    ("internship", r"\bintern(ship)?s?\b"),
    ("ai_ml_engineering", r"\bai\b|\bml\b|genai|\bllm|data scien"),
]
SENIORITY_RULES = [
    ("lead_plus", r"\blead\b|principal|manager|\bhead\b|director"),
    ("senior", r"\bsenior\b|\bsr\b"),
]
WORK_MODE_RULES = [
    ("hybrid", r"hybrid"),  # before remote: hybrid posts also mention remote days
    ("remote", r"remote|work from home|\bwfh\b"),
    ("onsite", r"on-?site|in-office|work from office"),
]


class MockProvider:
    name = "mock"
    model = "keyword-rules"

    async def ask(self, state: dict, questions: dict) -> dict[str, Answer]:
        title = state.get("job_title", "")
        text = f"{title}\n{state.get('job_description', '')}"
        answers = {}
        for qid, question in questions.items():
            if qid == "role_family":
                answers[qid] = _first_rule(ROLE_RULES, text, default="unclear")
            elif qid == "seniority":
                answers[qid] = _first_rule(SENIORITY_RULES, title, default="mid")
            elif qid == "work_mode":
                answers[qid] = _first_rule(WORK_MODE_RULES, text, default="not_stated")
            elif qid == "min_years":
                answers[qid] = Answer("choice", choice="not_stated", confidence=MISS)
            elif qid == "skills_match":
                answers[qid] = _skills_match(question, text)
            else:
                raise ProviderError(f"mock provider has no rule for question {qid!r}")
        return answers

    async def aclose(self) -> None:
        pass


def _first_rule(rules: list[tuple[str, str]], text: str, default: str) -> Answer:
    for choice, pattern in rules:
        if re.search(pattern, text, re.I):
            return Answer("choice", choice=choice, confidence=HIT)
    return Answer("choice", choice=default, confidence=MISS)


def _skills_match(question: dict, text: str) -> Answer:
    """Level = share of the candidate's skills that appear in the JD, mapped onto the 0..5 levels."""
    skills = question["instructions"]["candidate_skills"]
    text = text.lower()
    hits = sum(1 for s in skills if re.search(rf"(?<![a-z0-9]){re.escape(s.lower())}s?(?![a-z0-9])", text))
    top = len(question["criteria"]) - 1
    level = int(hits / len(skills) * top + 0.5) if skills else 0
    return Answer("score", score=float(level), confidence=HIT if hits else MISS)
