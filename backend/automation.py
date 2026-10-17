"""
Marker files for the hands-off run (the popup's "Start automation": Naukri, then Indeed, then Glassdoor).
They let Windows Power Automate see that a run has begun and that it has ended, so it can close the
browser and this backend afterwards.

    OUTPUT_DIR/YYYY-MM-DD/automation-started.json    {"started_at"}                        a run has begun
    OUTPUT_DIR/YYYY-MM-DD/automation-finished.json   {"finished_at", "summary", "items"}   that run has ended

Started but not finished = a run is in progress. Times are local ISO times ("2026-10-16T14:05:09").

Rules that keep "the file is there" a reliable signal:
- Each file is written to a temp file next to it, then renamed over the real name: a reader never sees half
  a file.
- automation-finished.json always belongs to the LATEST run. When a new run starts, or the backend starts,
  today's older markers are renamed <name>.before-HHMMSS.json (kept as history, still read by last_finished):
  a flow that starts the backend + browser and then waits for the file must not find this morning's run.
  (A second backend started while one already runs leaves them alone: see app.py lifespan.)
- A run that started before midnight and ends after it writes its finished marker into BOTH day folders, so
  a flow waiting in the start day's folder still sees it.
"""

import json
import logging
import os
import tempfile
import time
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

STARTED = "automation-started.json"
FINISHED = "automation-finished.json"

RETRIES = 20  # x RETRY_DELAY = about 2 s of retrying a rename that Windows refuses (see _retry)
RETRY_DELAY = 0.1


def day_folder(output_dir: Path, now: datetime) -> Path:
    return output_dir / now.strftime("%Y-%m-%d")


def mark_started(output_dir: Path, now: datetime) -> Path:
    """A run begins: today's finished marker (an earlier run) goes aside, then automation-started.json."""
    set_aside(output_dir, now, (FINISHED,))
    return write_marker(day_folder(output_dir, now), STARTED, {"started_at": _iso(now)})


def mark_finished(output_dir: Path, now: datetime, summary: str, items: list[dict],
                  started_folder: Path | None = None) -> Path:
    """A run ends: automation-finished.json in today's folder, and also in started_folder (the day the run
    began, when that was before midnight). Returns the path in today's folder."""
    data = {"finished_at": _iso(now), "summary": summary, "items": items}
    path = write_marker(day_folder(output_dir, now), FINISHED, data)
    if started_folder is not None and started_folder != path.parent:
        write_marker(started_folder, FINISHED, data)
    return path


def set_aside(output_dir: Path, now: datetime, names: tuple[str, ...] = (STARTED, FINISHED)) -> None:
    """Rename today's markers to <name>.before-HHMMSS.json: they belong to an earlier run."""
    folder = day_folder(output_dir, now)
    for name in names:
        path = folder / name
        if not path.exists():
            continue
        stem = f"{path.stem}.before-{now.strftime('%H%M%S')}"
        target, n = path.with_name(stem + ".json"), 2
        while target.exists():  # two runs in the same second
            target, n = path.with_name(f"{stem}-{n}.json"), n + 1
        _retry(lambda: os.replace(path, target))
        log.info("%s/%s belongs to an earlier run: renamed it to %s", folder.name, name, target.name)


def last_finished(output_dir: Path) -> dict:
    """The newest finished marker (set-aside ones included), or {"finished_at": None} when there is none.
    Day folders are checked newest first; the first one holding a marker has the newest run."""
    for folder in sorted(output_dir.glob("????-??-??"), reverse=True):
        markers = [m for m in map(_read, folder.glob("automation-finished*.json")) if m is not None]
        if markers:
            return max(markers, key=lambda m: str(m.get("finished_at") or ""))
    return {"finished_at": None}


def write_marker(folder: Path, name: str, data: dict) -> Path:
    """Write folder/name atomically: temp file first, then one rename (the day folder is created if needed)."""
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    # The temp name ends in .tmp, so a wait for "automation-finished.json" can't match it.
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        _retry(lambda: os.replace(tmp, path))
    except BaseException:
        Path(tmp).unlink(missing_ok=True)  # never leave a half-done temp file behind
        raise
    return path


def _read(path: Path) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):  # unreadable or not JSON (edited by hand): skip it
        return None
    return data if isinstance(data, dict) else None


def _retry(action) -> None:
    """Windows refuses to rename over a file another program has open for a moment (a reader such as Power
    Automate or the popup, antivirus, OneDrive). Retry for about 2 s before giving up."""
    for attempt in range(RETRIES):
        try:
            action()
            return
        except PermissionError:
            if attempt == RETRIES - 1:
                raise
            time.sleep(RETRY_DELAY)


def _iso(now: datetime) -> str:
    return now.isoformat(timespec="seconds")
