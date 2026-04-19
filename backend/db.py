"""
All MongoDB operations in one place.
Uses synchronous PyMongo — simple and straightforward.
"""

from datetime import datetime, timezone
from typing import List, Optional
from bson import ObjectId
from pymongo import MongoClient, DESCENDING
from posted_parser import parse_posted
from config import get_settings


def get_collection():
    s = get_settings()
    client = MongoClient(s.MONGO_URI)
    return client[s.DB_NAME][s.COLLECTION_NAME]


# ── Insert ─────────────────────────────────────────────────────────────────────

def insert_jobs(jobs: list) -> List[str]:
    """
    Insert jobs into MongoDB. Skip duplicates (by job_id).
    Returns list of MongoDB _id strings for newly inserted documents.
    """
    col = get_collection()
    inserted_ids = []

    for job in jobs:
        # Parse scraped_at string to datetime if needed
        scraped_at = job.get("scraped_at")
        if isinstance(scraped_at, str):
            scraped_at = datetime.fromisoformat(scraped_at.replace("Z", "+00:00"))
        scraped_at = scraped_at or datetime.now(timezone.utc)

        # Convert "posted" string to datetime
        posted_at = parse_posted(job.get("posted", ""), scraped_at)

        doc = {
            "job_id":     job.get("job_id", ""),
            "title":      job.get("title", ""),
            "company":    job.get("company", ""),
            "location":   job.get("location", ""),
            "salary":     job.get("salary", ""),           # Glassdoor only
            "posted":     job.get("posted", ""),           # raw string
            "posted_at":  posted_at,                        # parsed datetime
            "work_type":  job.get("work_type", []),        # LinkedIn only
            "easy_apply": job.get("easy_apply", False),
            "link":       job.get("link", ""),
            "jd":         job.get("jd", ""),
            "source":     job.get("source", ""),
            "scraped_at": scraped_at,

            # LLM fields — filled after processing
            "llm_processed":      False,
            "llm_name":           None,
            "skills_match_score": None,
            "work_type_llm":      None,  # Remote/Hybrid/Onsite
            "experience_start":   None,
            "experience_end":     None,
            "company_rating":     None,
            "llm_status":         "pending",  # pending / done / needs_paid

            # User action
            "filled": False,
        }

        result = col.update_one(
            {"job_id": doc["job_id"]},
            {"$setOnInsert": doc},
            upsert=True
        )

        if result.upserted_id:
            inserted_ids.append(str(result.upserted_id))

    return inserted_ids


# ── LLM update ─────────────────────────────────────────────────────────────────

def update_job_with_llm_output(mongo_id: str, llm_output: dict, llm_name: str):
    col = get_collection()
    col.update_one(
        {"_id": ObjectId(mongo_id)},
        {"$set": {
            "llm_processed":      True,
            "llm_name":           llm_name,
            "llm_status":         "done",
            "skills_match_score": llm_output.get("skills_match_score"),
            "work_type_llm":      llm_output.get("work_type"),
            "experience_start":   llm_output.get("experience_start"),
            "experience_end":     llm_output.get("experience_end"),
            "company_rating":     llm_output.get("company_rating"),
        }}
    )


def mark_job_needs_paid(mongo_id: str):
    """Mark job as needing paid API approval."""
    col = get_collection()
    col.update_one(
        {"_id": ObjectId(mongo_id)},
        {"$set": {"llm_status": "needs_paid"}}
    )


def mark_job_filled(mongo_id: str):
    col = get_collection()
    col.update_one(
        {"_id": ObjectId(mongo_id)},
        {"$set": {"filled": True}}
    )


# ── Queries for Streamlit ──────────────────────────────────────────────────────

def get_unique_dates() -> List[str]:
    """Return sorted list of unique date strings (YYYY-MM-DD) from scraped_at."""
    col = get_collection()
    pipeline = [
        {"$group": {
            "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$scraped_at"}}
        }},
        {"$sort": {"_id": DESCENDING}}
    ]
    return [doc["_id"] for doc in col.aggregate(pipeline) if doc["_id"]]


def get_jobs_for_date(date_str: str) -> List[dict]:
    """Get all jobs scraped on a given date (UTC)."""
    if not date_str:
        return []
    col = get_collection()
    start = datetime.fromisoformat(f"{date_str}T00:00:00+00:00")
    end   = datetime.fromisoformat(f"{date_str}T23:59:59+00:00")
    jobs  = list(col.find(
        {"scraped_at": {"$gte": start, "$lte": end}},
        sort=[("scraped_at", 1)]
    ))
    for job in jobs:
        job["_id"] = str(job["_id"])
    return jobs


def group_into_sessions(jobs: List[dict], gap_hours: int = 5) -> List[dict]:
    """
    Group jobs into scraping sessions.
    A new session starts when there's a >gap_hours gap between consecutive jobs.
    Returns list of session dicts: {start, end, jobs, label}
    """
    if not jobs:
        return []

    sessions = []
    current = [jobs[0]]

    for job in jobs[1:]:
        last_time = current[-1]["scraped_at"]
        this_time = job["scraped_at"]
        diff_hours = (this_time - last_time).total_seconds() / 3600
        if diff_hours > gap_hours:
            sessions.append(current)
            current = [job]
        else:
            current.append(job)

    sessions.append(current)

    result = []
    for session_jobs in sessions:
        start = session_jobs[0]["scraped_at"]
        end   = session_jobs[-1]["scraped_at"]
        result.append({
            "start": start,
            "end":   end,
            "label": start.strftime("%I:%M %p"),   # e.g. "10:00 AM"
            "jobs":  session_jobs,
        })
    return result


def get_jobs_by_ids(mongo_ids: List[str]) -> List[dict]:
    col = get_collection()
    object_ids = [ObjectId(i) for i in mongo_ids]
    jobs = list(col.find({"_id": {"$in": object_ids}}))
    for job in jobs:
        job["_id"] = str(job["_id"])
    return jobs


def get_pending_jobs(mongo_ids: List[str]) -> List[dict]:
    """From a list of IDs, return those not yet LLM-processed and not filled."""
    col = get_collection()
    object_ids = [ObjectId(i) for i in mongo_ids]
    jobs = list(col.find({
        "_id":           {"$in": object_ids},
        "llm_processed": {"$ne": True},
        "filled":        {"$ne": True},
    }))
    for job in jobs:
        job["_id"] = str(job["_id"])
    return jobs