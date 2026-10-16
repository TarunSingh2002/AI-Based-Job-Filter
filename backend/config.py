"""
Configuration. backend/.env holds only JEV_API_KEY; the candidate profile lives in profile.yaml.

Relative paths (OUTPUT_DIR, DB_PATH, PROFILE_PATH) are resolved against the backend/ folder,
so the server behaves the same no matter which folder you start it from. They have fixed defaults
and are not meant to be set in .env.
"""

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

import questions

BACKEND_DIR = Path(__file__).resolve().parent

# Where Jev runs. OpenCode and TypeSafe serve the exact same API, so switching = changing these two lines
# (and using a key from that site in .env):
#   OpenCode free  : https://opencode.ai/inference/v1/systemone   jev-1.13-free   (free for a limited time)
#   OpenCode paid  : https://opencode.ai/inference/v1/systemone   jev-1.13
#   TypeSafe direct: https://api.typesafe.ai/v1/systemone         jev-latest
JEV_URL = "https://opencode.ai/inference/v1/systemone"
JEV_MODEL = "jev-1.13"  # paid ($0.042 / 1M input tokens, output free) - billed to your OpenCode balance


class Settings(BaseSettings):
    # Real environment variables win over values in .env.
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    JEV_API_KEY: str = ""  # the only thing that belongs in backend/.env
    OUTPUT_DIR: str = "output"  # backend/output/YYYY-MM-DD/: <site>_matches.csv, <site>_rejected.csv, jobs.xlsx
    DB_PATH: str = "data/jobs.db"  # verdict cache: a job is never sent to Jev twice
    PROFILE_PATH: str = "profile.yaml"

    def output_dir(self) -> Path:
        return _resolve(self.OUTPUT_DIR)

    def db_path(self) -> Path:
        return _resolve(self.DB_PATH)

    def profile_path(self) -> Path:
        return _resolve(self.PROFILE_PATH)


def _resolve(path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else (BACKEND_DIR / p).resolve()


@lru_cache
def get_settings() -> Settings:
    return Settings()


class Profile(BaseModel):
    """The candidate profile (profile.yaml). Every threshold used by decide.py lives here."""

    # A misspelt key ("reject_confidense: 0.7") would otherwise be dropped silently and the default used,
    # so unknown keys fail at startup with the key's name.
    model_config = ConfigDict(extra="forbid")

    experience_years: int | float  # whole or fractional years, e.g. 1 or 1.5
    experience_tolerance: int | float = 1
    target_role_families: list[str]  # the ONLY wanted role types; every other family except "unclear" is unwanted
    # Optional seniority filter (decide.check_title_words). Absent or [] = off: a "Senior" / "Lead" title is
    # never rejected for its seniority (the user skips those when applying); years of experience still count.
    allowed_seniority: list[str] = []
    reject_confidence: float = 0.6
    skills: list[str]

    @model_validator(mode="before")
    @classmethod
    def _removed_keys(cls, data):
        """An old profile.yaml would fail with a bare "extra fields not permitted"; say what changed instead."""
        if isinstance(data, dict):
            if "avoid_role_families" in data:
                raise ValueError("avoid_role_families was replaced by target_role_families "
                                 "(the role types you WANT, e.g. [ai_ml_engineering, data_science, data_engineering])")
            if "min_match_score" in data:
                raise ValueError("min_match_score was removed: skills never reject a job any more - delete that line")
        return data

    # A typo like "data_scientist" instead of "data_science" would silently never match,
    # so unknown names fail loudly at startup instead.
    @field_validator("target_role_families")
    @classmethod
    def _known_families(cls, value: list[str]) -> list[str]:
        families = [f for f in questions.ROLE_FAMILY_CRITERIA if f != "unclear"]
        unknown = set(value) - set(families)
        if unknown:
            raise ValueError(f"unknown target role families {sorted(unknown)}; use some of {families} "
                             "(\"unclear\" is never a target: it means \"let the next stage decide\")")
        if not value:
            raise ValueError("target_role_families is empty: every job would be unwanted")
        return value

    @field_validator("allowed_seniority")
    @classmethod
    def _known_levels(cls, value: list[str]) -> list[str]:
        unknown = set(value) - set(questions.SENIORITY_LEVELS)
        if unknown:
            raise ValueError(f"unknown seniority levels {sorted(unknown)}; use {list(questions.SENIORITY_LEVELS)}")
        return value


def load_profile(path: Path) -> Profile:
    with open(path, encoding="utf-8") as f:
        return Profile(**yaml.safe_load(f))
