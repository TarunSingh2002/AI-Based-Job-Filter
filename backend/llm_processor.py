"""
LangGraph linear workflow for scoring job postings.

Workflow:  START → process_job → END

Provider rotation order:
  1. Groq free keys (all of them in sequence)
  2. Gemini free keys (all of them in sequence)
  3. Mark as "needs_paid" → human approves in Streamlit UI → paid Grok

State fields (exactly what the user specified):
  - job_title
  - company_name
  - jd
  - output  (the structured LLM result)
"""

import logging
from typing import TypedDict, Optional
from pydantic import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate
from langgraph.graph import StateGraph, START, END

from config import get_settings, setup_langsmith

logger = logging.getLogger(__name__)

# ── Structured output schema ───────────────────────────────────────────────────

class JobAnalysis(BaseModel):
    """What the LLM returns for each job."""
    skills_match_score: int = Field(
        description="1–10: how well candidate skills match JD requirements. 10 = perfect match."
    )
    work_type: str = Field(
        description="One of: 'Remote', 'Hybrid', 'Onsite', 'Unknown'. Read from JD."
    )
    experience_start: int = Field(
        description="Minimum years of experience required. Use -1 if not mentioned."
    )
    experience_end: int = Field(
        description="Maximum years of experience required. Use -1 if not mentioned."
    )
    company_rating: int = Field(
        description=(
            "0–5 company prestige. "
            "5=Google/Amazon/Microsoft/Meta/Netflix, "
            "4=large well-known company (Wipro/Infosys/TCS/Zomato), "
            "3=mid-size known company, "
            "2=small company, "
            "1=startup, "
            "0=unknown/no info."
        )
    )


# ── LangGraph state ────────────────────────────────────────────────────────────

class JobState(TypedDict):
    job_title:    str
    company_name: str
    jd:           str
    output:       Optional[dict]   # None until LLM fills it
    llm_name:     Optional[str]    # which model succeeded — must be in state or LangGraph drops it


# ── Prompt ─────────────────────────────────────────────────────────────────────

PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     """You are a job evaluator helping a candidate decide which jobs to apply to.

Candidate skills: {my_skills}

You will read a job posting and extract 5 specific pieces of information.
Be accurate. Do not guess. If something is not mentioned in the JD, say so explicitly.

Here is exactly what each field means:

1. skills_match_score (integer 1-10):
   - Read the JD carefully. List the technical skills it asks for.
   - Count how many of those skills the candidate has from their skills list above.
   - 10 = almost all required skills match perfectly.
   - 7-9 = good match, candidate has most key skills.
   - 4-6 = partial match, candidate has some but missing important ones.
   - 1-3 = poor match, job requires very different skills.
   - Be conservative. If the job wants 5 years of Java and candidate has none, score low.

2. work_type (string):
   - Read the JD for words like "remote", "work from home", "onsite", "in-office", "hybrid".
   - Return exactly one of: "Remote", "Hybrid", "Onsite", "Unknown".
   - If not mentioned anywhere in the JD, return "Unknown".

3. experience_start (integer):
   - Look for phrases like "2+ years", "minimum 3 years", "2-5 years experience".
   - Return the MINIMUM number. For "2-5 years" return 2. For "5+ years" return 5.
   - If experience is not mentioned at all, return -1.

4. experience_end (integer):
   - Return the MAXIMUM number from ranges. For "2-5 years" return 5.
   - If it says "5+ years" with no upper limit, return -1.
   - If experience is not mentioned at all, return -1.

5. company_rating (integer 0-5):
   - This is about the COMPANY NAME only, not the job.
   - 5 = tier-1 global tech giant (Google, Amazon, Microsoft, Meta, Apple, Netflix, OpenAI, Anthropic, Goldman Sachs, McKinsey).
   - 4 = well-known large company (Wipro, Infosys, TCS, Accenture, IBM, Zomato, Flipkart, Paytm, HDFC, Reliance).
   - 3 = recognizable mid-size company you have heard of.
   - 2 = small company, fewer than 500 employees, less well known.
   - 1 = startup, very new, very small, or very obscure.
   - 0 = you have never heard of this company and cannot determine its size.
   - Base this ONLY on the company name. Do not search the web. If you are unsure, return 0 or 1."""),
    ("human",
     """Job Title: {job_title}
Company: {company_name}

Job Description:
{jd}

Extract the 5 fields described above. Be precise and conservative."""),
])


# ── LLM builder helpers ────────────────────────────────────────────────────────

def _make_groq_llm(api_key: str):
    from langchain_groq import ChatGroq
    return ChatGroq(api_key=api_key, model="llama-3.3-70b-versatile", temperature=0)


def _make_gemini_llm(api_key: str):
    from langchain_google_genai import ChatGoogleGenerativeAI
    return ChatGoogleGenerativeAI(
        google_api_key=api_key,
        model="gemini-1.5-flash",
        temperature=0,
    )


def _make_grok_paid_llm(api_key: str):
    """xAI Grok via OpenAI-compatible API."""
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        base_url="https://api.x.ai/v1",
        api_key=api_key,
        model="grok-3",
        temperature=0,
    )


# ── Core: try one LLM and return (result, llm_name) or raise ──────────────────

def _call_llm(llm, state: JobState) -> dict:
    settings = get_settings()
    chain = PROMPT | llm.with_structured_output(JobAnalysis)
    result: JobAnalysis = chain.invoke({
        "my_skills":    settings.MY_SKILLS,
        "job_title":    state["job_title"],
        "company_name": state["company_name"],
        "jd":           state["jd"] or "No job description provided.",
    })
    return result.model_dump()


# ── LangGraph node ─────────────────────────────────────────────────────────────

def process_job_node(state: JobState) -> dict:
    """
    Tries LLM providers in order:
      1. Groq free keys
      2. Gemini free keys
    If all fail, returns output=None (caller marks as needs_paid).
    """
    settings = get_settings()

    # Try Groq free keys
    for key in settings.groq_keys():
        try:
            llm = _make_groq_llm(key)
            output = _call_llm(llm, state)
            logger.info(f"Groq success for: {state['job_title']}")
            return {"output": output, "llm_name": "groq/llama-3.3-70b"}
        except Exception as e:
            logger.warning(f"Groq key failed: {str(e)[:80]}")
            continue

    # Try Gemini free keys
    for key in settings.gemini_keys():
        try:
            llm = _make_gemini_llm(key)
            output = _call_llm(llm, state)
            logger.info(f"Gemini success for: {state['job_title']}")
            return {"output": output, "llm_name": "gemini/gemini-1.5-flash"}
        except Exception as e:
            logger.warning(f"Gemini key failed: {str(e)[:80]}")
            continue

    # All free providers exhausted
    logger.warning(f"All free LLMs failed for: {state['job_title']}")
    return {"output": None, "llm_name": None}


# ── Build the LangGraph ────────────────────────────────────────────────────────

def build_graph():
    setup_langsmith()
    graph = StateGraph(JobState)
    graph.add_node("process_job", process_job_node)
    graph.add_edge(START, "process_job")
    graph.add_edge("process_job", END)
    return graph.compile()


# Compile once at import time
_graph = build_graph()


# ── Public API ─────────────────────────────────────────────────────────────────

def process_one_job(mongo_id: str, job_title: str, company_name: str, jd: str):
    """
    Run the LangGraph workflow for one job.
    Updates MongoDB directly.
    Returns: "done" | "needs_paid" | "error"
    """
    from db import update_job_with_llm_output, mark_job_needs_paid

    state: JobState = {
        "job_title":    job_title,
        "company_name": company_name,
        "jd":           jd,
        "output":       None,
        "llm_name":     None,
    }

    try:
        result = _graph.invoke(state)
    except Exception as e:
        logger.error(f"Graph error for {mongo_id}: {e}")
        return "error"

    if result.get("output") is None:
        mark_job_needs_paid(mongo_id)
        return "needs_paid"

    llm_name = result.get("llm_name", "unknown")
    update_job_with_llm_output(mongo_id, result["output"], llm_name)
    return "done"


def process_one_job_paid(mongo_id: str, job_title: str, company_name: str, jd: str):
    """
    Same as process_one_job but forces the paid Grok model.
    Called from Streamlit when user approves paid usage.
    """
    from db import update_job_with_llm_output, mark_job_needs_paid
    settings = get_settings()

    if not settings.XAI_API_KEY:
        logger.error("No XAI_API_KEY configured")
        return "error"

    state: JobState = {
        "job_title":    job_title,
        "company_name": company_name,
        "jd":           jd,
        "output":       None,
    }

    try:
        llm    = _make_grok_paid_llm(settings.XAI_API_KEY)
        output = _call_llm(llm, state)
        update_job_with_llm_output(mongo_id, output, "grok/grok-3-paid")
        return "done"
    except Exception as e:
        logger.error(f"Paid Grok failed for {mongo_id}: {e}")
        mark_job_needs_paid(mongo_id)
        return "error"