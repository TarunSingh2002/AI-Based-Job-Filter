"""
FastAPI server — receives job data from the Chrome extension.

Endpoints:
  POST /jobs   — insert jobs into MongoDB, trigger background LLM processing
  GET  /health — simple health check

Run with:
  uvicorn api:app --port 8000 --reload
"""

import logging
from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

from db import insert_jobs, get_collection
from llm_processor import process_one_job
from config import get_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Job Scraper API")

# Allow Chrome extension to POST here
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Chrome extension uses chrome-extension:// origin
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# ── Request models ─────────────────────────────────────────────────────────────

class JobPayload(BaseModel):
    scraped_date: Optional[str] = None
    source:       str            # "linkedin" or "glassdoor"
    total:        int
    jobs:         List[dict]


# ── Background LLM worker ──────────────────────────────────────────────────────

def run_llm_for_inserted_jobs(inserted_ids: List[str]):
    """
    Processes jobs one by one in the background (sequential, no parallelization).
    Stops immediately if any job returns "needs_paid" — marks remaining as still pending.
    When scraper adds more jobs, this runs again for those new IDs.
    """
    if not inserted_ids:
        return

    col = get_collection()

    for mongo_id in inserted_ids:
        # Fetch the job document
        from bson import ObjectId
        doc = col.find_one({"_id": ObjectId(mongo_id)})
        if not doc:
            continue

        # Skip if already filled (user already applied)
        if doc.get("filled"):
            continue

        logger.info(f"LLM processing: {doc['title']} @ {doc['company']}")

        status = process_one_job(
            mongo_id=mongo_id,
            job_title=doc.get("title", ""),
            company_name=doc.get("company", ""),
            jd=doc.get("jd", ""),
        )

        if status == "needs_paid":
            # All free LLMs exhausted — stop processing this batch.
            # Remaining jobs stay as "pending". User will see them in Streamlit
            # under "needs paid approval" and can trigger manually.
            logger.warning(
                f"All free LLMs exhausted at job {mongo_id}. "
                f"Stopping batch. Remaining {len(inserted_ids)} jobs stay pending."
            )
            return

        if status == "error":
            logger.error(f"Unexpected error for {mongo_id}, stopping batch.")
            return

        logger.info(f"Done: {doc['title']} — status={status}")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.post("/jobs")
def receive_jobs(payload: JobPayload, background_tasks: BackgroundTasks):
    """
    Called by the Chrome extension after scraping a batch of jobs.
    1. Insert jobs into MongoDB (deduplication by job_id)
    2. Trigger background LLM processing for newly inserted jobs
    """
    inserted_ids = insert_jobs(payload.jobs)

    logger.info(
        f"Received {payload.total} jobs from {payload.source}. "
        f"Inserted {len(inserted_ids)} new ones."
    )

    # Run LLM processing in background — scraper continues immediately
    if inserted_ids:
        background_tasks.add_task(run_llm_for_inserted_jobs, inserted_ids)

    return {
        "received": payload.total,
        "inserted": len(inserted_ids),
        "skipped":  payload.total - len(inserted_ids),
        "ids":      inserted_ids,
    }


@app.get("/health")
def health():
    return {"status": "ok", "settings": get_settings().DB_NAME}

# uvicorn api:app --port 8000 --reload
# streamlit run app.py