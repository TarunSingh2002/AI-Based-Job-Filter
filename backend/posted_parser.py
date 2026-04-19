"""
Convert the human-readable "posted" strings from LinkedIn and Glassdoor
into actual datetime objects using scraped_at as the reference point.

LinkedIn examples : "11 hours ago", "3 days ago", "1 week ago", "2 weeks ago"
Glassdoor examples: "24h", "15d", "30d+", "4d"
"""

import re
from datetime import datetime, timedelta


def parse_posted(posted: str, scraped_at: datetime) -> datetime:
    """
    Try to convert posted string to a datetime.
    Falls back to scraped_at if parsing fails.
    """
    if not posted:
        return scraped_at

    posted = posted.strip().lower()

    # ── Glassdoor format: "24h", "15d", "30d+" ────────────────────
    gd_hour = re.match(r"^(\d+)h$", posted)
    gd_day  = re.match(r"^(\d+)d\+?$", posted)

    if gd_hour:
        hours = int(gd_hour.group(1))
        return scraped_at - timedelta(hours=hours)

    if gd_day:
        days = int(gd_day.group(1))
        # "30d+" means 30+ days — use scraped_at as approximation
        return scraped_at - timedelta(days=days)

    # ── LinkedIn format: "N hours ago", "N days ago", "N weeks ago" ─
    li_hour  = re.match(r"^(\d+)\s+hours?\s+ago$", posted)
    li_day   = re.match(r"^(\d+)\s+days?\s+ago$", posted)
    li_week  = re.match(r"^(\d+)\s+weeks?\s+ago$", posted)
    li_month = re.match(r"^(\d+)\s+months?\s+ago$", posted)

    if li_hour:
        return scraped_at - timedelta(hours=int(li_hour.group(1)))
    if li_day:
        return scraped_at - timedelta(days=int(li_day.group(1)))
    if li_week:
        return scraped_at - timedelta(weeks=int(li_week.group(1)))
    if li_month:
        return scraped_at - timedelta(days=int(li_month.group(1)) * 30)

    # Couldn't parse → fall back to scraped_at
    return scraped_at