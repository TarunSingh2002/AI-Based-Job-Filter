"""The graph on its own: AI errors, and which questions get asked."""

from graph import build_graph, screen_job
from providers.base import ProviderError
from mock_provider import MockProvider

JOB = {"job_id": "1", "title": "AI Engineer", "company": "Acme", "location": "", "experience_text": "",
       "link": "", "jd": "x" * 300}


class BrokenProvider:
    name, model = "broken", "none"

    async def ask(self, state, questions):
        raise ProviderError("boom")

    async def aclose(self):
        pass


class RecordingProvider(MockProvider):
    """The mock provider, but it remembers which questions it was asked."""

    def __init__(self):
        self.asked = []

    async def ask(self, state, questions):
        self.asked.append(list(questions))
        return await super().ask(state, questions)


async def test_ai_error_passes_the_job_and_writes_nothing(profile, store):
    graph = build_graph(BrokenProvider(), profile, store)
    for stage in ("title", "jd"):
        verdict = await screen_job(graph, "naukri", stage, JOB)
        assert (verdict["decision"], verdict["reason"], verdict["confidence"]) == ("pass", "ai_error: boom", 0.0)
        assert verdict["stage"] == stage
    assert store.get_verdict("naukri", "1") is None  # not cached, so the next run retries
    assert not store.output_dir.exists()  # no CSV rows


async def test_title_stage_asks_role_and_seniority(profile, store):
    provider = RecordingProvider()
    await screen_job(build_graph(provider, profile, store), "naukri", "title", JOB)
    assert provider.asked == [["role_family", "seniority"]]


async def test_min_years_only_asked_when_regex_finds_nothing(profile, store):
    provider = RecordingProvider()
    graph = build_graph(provider, profile, store)

    await screen_job(graph, "naukri", "jd", {**JOB, "job_id": "a", "experience_text": "0-2 Yrs"})
    await screen_job(graph, "naukri", "jd", {**JOB, "job_id": "b"})

    assert provider.asked == [
        ["role_family", "skills_match", "work_mode"],
        ["role_family", "skills_match", "min_years", "work_mode"],
    ]
