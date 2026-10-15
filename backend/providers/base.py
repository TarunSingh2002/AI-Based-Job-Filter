"""
What every AI provider looks like. The rest of the backend only ever talks to this interface.

`questions` is always in the Jev wire format (see questions.py):
    {qid: {"type": "choice" | "score" | "noul", "instructions": str | obj, "criteria": ...}}
      choice criteria: {option: description}
      score criteria:  [level0, level1, ...]          (worst -> best)
      noul criteria:   {"true": ..., "false": ...}
"""

from dataclasses import dataclass
from typing import Protocol


@dataclass
class Answer:
    type: str  # "choice" | "score" | "noul"
    choice: str | None = None
    score: float | None = None  # level index, may be fractional (e.g. 3.4)
    noul: float | None = None  # probability that the statement is true, 0..1
    confidence: float = 0.0
    probabilities: dict | None = None


class Provider(Protocol):
    name: str
    model: str

    async def ask(self, state: dict, questions: dict) -> dict[str, Answer]:
        """Answer every question in `questions` about `state`. Raises ProviderError on failure."""
        ...

    async def aclose(self) -> None:
        """Release network connections (called once when the server stops)."""
        ...


class ProviderError(Exception):
    """The AI could not answer. The graph turns this into a 'pass' with reason 'ai_error: ...'."""
