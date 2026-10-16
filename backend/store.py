"""
Storage.

1. SQLite cache (data/jobs.db): one row per (site, job_id) with the latest verdict, so a job is never
   sent to the AI twice. A JD-stage verdict replaces a title-stage one, never the other way round.
   Same file, table seen_keys: the repost lists (dedupe.py) - which job first claimed a (title, company).
   An older jobs.db is upgraded in place at startup (new columns / table added, nothing removed).
2. CSV files, one folder per day (OUTPUT_DIR = backend/output, so they show up in VS Code):
       OUTPUT_DIR/YYYY-MM-DD/<site>_matches.csv    jobs that passed the JD stage
       OUTPUT_DIR/YYYY-MM-DD/<site>_rejected.csv   every reject (title or JD), to spot AI drift
   When the columns change (a new version), today's older file is renamed <site>_matches.before-HHMMSS.csv
   and a fresh one is started: rows are never appended under a header that doesn't fit them.
3. OUTPUT_DIR/YYYY-MM-DD/jobs.xlsx: the same rows as one sortable Excel workbook (excel.py). Open this
   one in Excel, not the CSVs. It is rebuilt from the CSVs a couple of seconds after new rows arrive
   (keep_workbooks_fresh), so don't edit it: your changes are overwritten. Use Save As for your own copy.
"""

import asyncio
import csv
import logging
import sqlite3
import threading
from datetime import date, datetime
from pathlib import Path

import excel

log = logging.getLogger(__name__)

WORKBOOK_DELAY = 2  # seconds between new CSV rows and the jobs.xlsx rebuild; rows arriving meanwhile share it
WORKBOOK_RETRY = 15  # seconds between retries while a rebuild fails (jobs.xlsx open in Excel)

MATCH_COLUMNS = [
    "time", "site", "job_id", "title", "company", "location", "match_score", "position_score", "skills_score",
    "confidence", "role_family", "min_years", "work_mode", "link", "provider",
]
REJECT_COLUMNS = ["time", "site", "job_id", "stage", "title", "company", "reason", "confidence", "link", "provider"]

DB_COLUMNS = [
    "site", "job_id", "stage", "decision", "reason", "confidence", "match_score", "position_score", "skills_score",
    "role_family", "min_years", "max_years", "work_mode", "title", "company", "location", "link", "provider",
    "model", "created_at",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    site TEXT NOT NULL, job_id TEXT NOT NULL, stage TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
    confidence REAL, match_score INTEGER, role_family TEXT, min_years INTEGER, max_years INTEGER,
    work_mode TEXT, title TEXT, company TEXT, location TEXT, link TEXT, provider TEXT, model TEXT,
    created_at TEXT,
    PRIMARY KEY (site, job_id)
)"""
# Columns added after the first version: a jobs.db from then gets them with ALTER TABLE (old rows: NULL).
ADDED_COLUMNS = {"position_score": "INTEGER", "skills_score": "INTEGER"}

SEEN_KEYS_SCHEMA = """
CREATE TABLE IF NOT EXISTS seen_keys (
    grp TEXT NOT NULL, key TEXT NOT NULL, site TEXT NOT NULL, job_id TEXT NOT NULL, first_seen TEXT,
    PRIMARY KEY (grp, key)
)"""


class Store:
    def __init__(self, db_path: Path, output_dir: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_dir = output_dir
        # isolation_level=None = autocommit: every statement is saved immediately.
        # check_same_thread=False: the server may reach the DB from more than one thread.
        self.db = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute(SCHEMA)
        self.db.execute(SEEN_KEYS_SCHEMA)
        # Upgrade an older jobs.db in place. ADD COLUMN only adds; every existing row and verdict stays.
        existing = {row["name"] for row in self.db.execute("PRAGMA table_info(jobs)")}
        for column, sql_type in ADDED_COLUMNS.items():
            if column not in existing:
                self.db.execute(f"ALTER TABLE jobs ADD COLUMN {column} {sql_type}")
                log.info("jobs.db: added column %s", column)

        # Day folders whose jobs.xlsx is behind their CSVs. _append adds to it on the event loop while
        # refresh_workbooks takes from it in a worker thread, hence the lock.
        self._stale_workbooks: set[Path] = set()
        self._stale_lock = threading.Lock()
        self._rebuild_lock = threading.Lock()  # one rebuild at a time: they share the file jobs.xlsx.tmp
        self._workbook_warned = False  # see refresh_workbooks

    def close(self) -> None:
        self.db.close()

    # ── SQLite cache ────────────────────────────────────────────────────────────────────────────

    def get_verdict(self, site: str, job_id: str) -> dict | None:
        """The cached verdict in the same shape the graph produces, marked cached=True."""
        row = self.db.execute("SELECT * FROM jobs WHERE site = ? AND job_id = ?", (site, job_id)).fetchone()
        if row is None:
            return None
        return {
            "job_id": row["job_id"], "stage": row["stage"], "decision": row["decision"], "reason": row["reason"],
            "confidence": row["confidence"], "match_score": row["match_score"],
            "position_score": row["position_score"], "skills_score": row["skills_score"],  # NULL in older rows
            "role_family": row["role_family"],
            "min_years": row["min_years"], "max_years": row["max_years"], "work_mode": row["work_mode"],
            "cached": True, "final": row["stage"] == "jd", "duplicate": False, "saved_to_csv": False,
        }

    def save_verdict(self, site: str, job: dict, verdict: dict, provider: str, model: str) -> None:
        existing = self.get_verdict(site, job["job_id"])
        if existing and existing["stage"] == "jd" and verdict["stage"] == "title":
            return  # a JD verdict knows more than a title verdict - keep it
        row = {
            **{k: verdict[k] for k in ("stage", "decision", "reason", "confidence", "match_score", "position_score",
                                       "skills_score", "role_family", "min_years", "max_years", "work_mode")},
            "site": site, "job_id": job["job_id"], "title": job["title"], "company": job["company"],
            "location": job["location"], "link": job["link"], "provider": provider, "model": model,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        self.db.execute(
            f"INSERT OR REPLACE INTO jobs ({', '.join(DB_COLUMNS)}) VALUES ({', '.join(':' + c for c in DB_COLUMNS)})",
            row,
        )

    # ── Repost lists (dedupe.py) ────────────────────────────────────────────────────────────────

    def claim_repost_key(self, group: str, key: str, site: str, job_id: str) -> tuple[str, str]:
        """Claim (group, key) for this job unless a job already holds it. Returns the holder (site, job_id):
        this job itself, or the job it is a repost of. Plain synchronous calls that app.py makes before its
        first await, so two copies in the same batch can't both claim it."""
        self.db.execute(
            "INSERT OR IGNORE INTO seen_keys (grp, key, site, job_id, first_seen) VALUES (?, ?, ?, ?, ?)",
            (group, key, site, job_id, datetime.now().isoformat(timespec="seconds")),
        )
        row = self.db.execute("SELECT site, job_id FROM seen_keys WHERE grp = ? AND key = ?", (group, key)).fetchone()
        return row["site"], row["job_id"]

    def clear_repost_keys(self, group: str) -> int:
        """Forget every (title, company) of one group: the next copy of each is screened again."""
        return self.db.execute("DELETE FROM seen_keys WHERE grp = ?", (group,)).rowcount

    # ── CSV files ───────────────────────────────────────────────────────────────────────────────

    def append_match(self, site: str, job: dict, verdict: dict, provider: str) -> None:
        self._append(site, "matches", MATCH_COLUMNS, {
            "site": site, "job_id": job["job_id"], "title": job["title"], "company": job["company"],
            "location": job["location"], "match_score": verdict["match_score"],
            "position_score": verdict["position_score"], "skills_score": verdict["skills_score"],
            "confidence": verdict["confidence"], "role_family": verdict["role_family"],
            "min_years": verdict["min_years"], "work_mode": verdict["work_mode"], "link": job["link"],
            "provider": provider,
        })

    def append_rejected(self, site: str, job: dict, verdict: dict, provider: str) -> None:
        self._append(site, "rejected", REJECT_COLUMNS, {
            "site": site, "job_id": job["job_id"], "stage": verdict["stage"], "title": job["title"],
            "company": job["company"], "reason": verdict["reason"], "confidence": verdict["confidence"],
            "link": job["link"], "provider": provider,
        })

    def _append(self, site: str, kind: str, columns: list[str], row: dict) -> None:
        now = datetime.now()  # local time: the folder is the day you ran it
        folder = self.output_dir / now.strftime("%Y-%m-%d")
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{site}_{kind}.csv"
        _rotate_if_header_changed(path, columns, now)

        is_new = not path.exists() or path.stat().st_size == 0
        row = {"time": now.strftime("%Y-%m-%d %H:%M:%S"), **{k: _excel_safe(v) for k, v in row.items()}}
        # Excel only reads the file as UTF-8 when it starts with a BOM ("utf-8-sig"); write BOM + header once.
        # If the file is open in Excel, Windows locks it and this raises - the caller then caches nothing.
        with open(path, "a", newline="", encoding="utf-8-sig" if is_new else "utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=columns)
            if is_new:
                writer.writeheader()
            writer.writerow(row)
        # Only queue the workbook here: a rebuild re-reads the whole day, so one per row would make each
        # screening slower as the day goes on. keep_workbooks_fresh does it a moment later, off the event loop.
        with self._stale_lock:
            self._stale_workbooks.add(folder)

    # ── Excel workbook ──────────────────────────────────────────────────────────────────────────

    async def keep_workbooks_fresh(self) -> None:
        """Runs for the whole life of the server (app.py): rebuilds queued workbooks in a worker thread,
        so the screening requests never wait for it. While a rebuild keeps failing, it retries less often."""
        delay = WORKBOOK_DELAY
        while True:
            await asyncio.sleep(delay)
            if self._stale_workbooks:
                ok = await asyncio.to_thread(self.refresh_workbooks)
                delay = WORKBOOK_DELAY if ok else WORKBOOK_RETRY

    def queue_outdated_workbooks(self) -> None:
        """At startup: queue every day whose jobs.xlsx is missing or older than its CSVs - rows written just
        before a restart, a day that ended while Excel had jobs.xlsx open, or a day from before jobs.xlsx."""
        for folder in self.output_dir.glob("????-??-??"):
            csv_times = [path.stat().st_mtime for path in folder.glob("*.csv")]
            workbook = folder / excel.WORKBOOK_NAME
            if csv_times and (not workbook.exists() or workbook.stat().st_mtime < max(csv_times)):
                with self._stale_lock:
                    self._stale_workbooks.add(folder)

    def refresh_workbooks(self) -> bool:
        """Rebuild jobs.xlsx in every queued day folder. Never raises: the CSV rows are already safe, so a
        workbook problem must not fail a screening. A folder that fails (jobs.xlsx open in Excel) stays
        queued for the next call. Returns False when a rebuild failed."""
        with self._rebuild_lock:
            # Take the queue before reading the CSVs: a row appended during the rebuild queues its folder again.
            with self._stale_lock:
                folders, self._stale_workbooks = self._stale_workbooks, set()
            ok = True
            for folder in sorted(folders):
                if not any(folder.glob("*.csv")):
                    continue  # the day's CSVs were deleted: nothing to show, and nothing to retry forever
                try:
                    excel.write_workbook(folder)
                except Exception as e:
                    ok = False
                    with self._stale_lock:
                        self._stale_workbooks.add(folder)
                    if not self._workbook_warned:  # say it once, not on every retry while Excel keeps it open
                        if isinstance(e, PermissionError):
                            log.warning("%s/%s is open in Excel - it is updated within %d s after you close it",
                                        folder.name, excel.WORKBOOK_NAME, WORKBOOK_RETRY)
                        else:
                            log.warning("could not update %s/%s: %s: %s", folder.name, excel.WORKBOOK_NAME,
                                        type(e).__name__, e)
                    self._workbook_warned = True
            if ok and self._workbook_warned:
                log.info("%s is up to date again", excel.WORKBOOK_NAME)
                self._workbook_warned = False
            return ok

    def stats(self) -> dict:
        """Today's row counts per site, read straight from the CSV files (renamed .before-HHMMSS ones too)."""
        today = date.today().strftime("%Y-%m-%d")
        sites: dict[str, dict] = {}
        folder = self.output_dir / today
        for kind in ("matches", "rejected"):
            for site, path in excel.day_csvs(folder, kind):
                with open(path, encoding="utf-8-sig", newline="") as f:
                    rows = max(sum(1 for _ in csv.reader(f)) - 1, 0)  # minus the header
                counts = sites.setdefault(site, {"matches": 0, "rejected": 0})
                counts[kind] += rows
        return {"date": today, "sites": sites}


def _rotate_if_header_changed(path: Path, columns: list[str], now: datetime) -> None:
    """A CSV started by an older version has other columns: appending under its header would put values
    in the wrong columns. Rename it to <site>_<kind>.before-HHMMSS.csv (jobs.xlsx still reads it, by
    column name) so the caller starts a fresh file with the right header."""
    if not path.exists() or path.stat().st_size == 0:
        return
    with open(path, encoding="utf-8-sig", newline="") as f:
        header = next(csv.reader(f), [])
    if header == columns:
        return
    stem = f"{path.stem}.before-{now.strftime('%H%M%S')}"
    target, n = path.with_name(stem + ".csv"), 2
    while target.exists():  # two renames in the same second
        target, n = path.with_name(f"{stem}-{n}.csv"), n + 1
    path.rename(target)
    log.info("%s has older columns: renamed it to %s, starting a new one", path.name, target.name)


def _excel_safe(value):
    """Text from job pages ends up in Excel: a cell starting with = + - @ would run as a formula."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@"):
        return "'" + value
    return value
