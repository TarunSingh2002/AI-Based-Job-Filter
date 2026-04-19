from pydantic_settings import BaseSettings
from functools import lru_cache
from typing import List
import os


class Settings(BaseSettings):
    # MongoDB
    MONGO_URI: str = "mongodb://localhost:27017"
    DB_NAME: str = "job_scraper"
    COLLECTION_NAME: str = "Jobs"

    # Free LLM keys (comma-separated strings in .env)
    GROQ_API_KEYS: str = ""
    GEMINI_API_KEYS: str = ""

    # Paid model — xAI Grok
    XAI_API_KEY: str = ""

    # LangSmith tracing
    LANGCHAIN_API_KEY: str = ""
    LANGCHAIN_TRACING_V2: str = "false"
    LANGCHAIN_PROJECT: str = "job-scraper"

    # Candidate skills for LLM scoring
    MY_SKILLS: str = (
        "Python, Machine Learning, Deep Learning, NLP, LLM, RAG, "
        "LangChain, GenAI, Data Science, TensorFlow, PyTorch, "
        "Pandas, NumPy, SQL, Data Analysis, Generative AI"
    )

    API_PORT: int = 8000

    class Config:
        env_file = ".env"

    # Helper: split comma-separated key strings into lists
    def groq_keys(self) -> List[str]:
        return [k.strip() for k in self.GROQ_API_KEYS.split(",") if k.strip()]

    def gemini_keys(self) -> List[str]:
        return [k.strip() for k in self.GEMINI_API_KEYS.split(",") if k.strip()]


@lru_cache()
def get_settings() -> Settings:
    return Settings()


def setup_langsmith():
    """Set env vars so LangSmith tracing is active."""
    s = get_settings()
    if s.LANGCHAIN_API_KEY:
        os.environ["LANGCHAIN_API_KEY"] = s.LANGCHAIN_API_KEY
        os.environ["LANGCHAIN_TRACING_V2"] = s.LANGCHAIN_TRACING_V2
        os.environ["LANGCHAIN_PROJECT"] = s.LANGCHAIN_PROJECT