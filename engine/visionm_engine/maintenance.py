"""Snapshot retention and disk-space protection.

Runs and their counts are kept forever (tiny). Only defect snapshot images are removed:
  * older than the retention period (default 30 days; 0 = keep forever), and
  * oldest-first when free disk space drops below LOW_FREE_BYTES, until TARGET_FREE_BYTES is free.
Below CRITICAL_FREE_BYTES new snapshots are not written at all, so a full disk never stops inspection.
Snapshots still waiting to upload are never removed while uploads are enabled.
"""

from __future__ import annotations

import logging
import shutil
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from .run_store import RunStore, now_iso

log = logging.getLogger(__name__)

GB = 1024**3
LOW_FREE_BYTES = 5 * GB
TARGET_FREE_BYTES = 8 * GB
CRITICAL_FREE_BYTES = GB // 2
RETENTION_CHOICES = (0, 7, 30, 90, 365)
DEFAULT_RETENTION_DAYS = 30


class StorageMaintainer(threading.Thread):
    INTERVAL_S = 3600.0
    FREE_CACHE_S = 10.0

    def __init__(self, store: RunStore, data_dir: Path, uploads_enabled: Callable[[], bool]) -> None:
        super().__init__(name="storage", daemon=True)
        self.store = store
        self.data_dir = data_dir
        self.uploads_enabled = uploads_enabled
        self.retention_days = DEFAULT_RETENTION_DAYS
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._free_cache: tuple[float, int] = (0.0, 0)
        self._snapshots_bytes: int | None = None
        self.last_cleanup_at: str | None = None
        self.last_removed = 0
        self.last_freed_bytes = 0
        self._warned_critical = False

    # ---------- config / control ----------

    def set_retention(self, days: int) -> None:
        if days not in RETENTION_CHOICES:
            raise ValueError(f"retention must be one of {RETENTION_CHOICES}")
        changed = days != self.retention_days
        self.retention_days = days
        if changed:
            self.nudge()

    def nudge(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    # ---------- disk ----------

    def free_bytes(self) -> int:
        t, free = self._free_cache
        if time.monotonic() - t > self.FREE_CACHE_S:
            free = shutil.disk_usage(self.data_dir).free
            self._free_cache = (time.monotonic(), free)
        return free

    def snapshots_allowed(self) -> bool:
        """False when the disk is almost full: defects are still logged, just without an image."""
        ok = self.free_bytes() > CRITICAL_FREE_BYTES
        if not ok and not self._warned_critical:
            log.error("Disk almost full (%.2f GB free): defect snapshots are paused", self.free_bytes() / GB)
            self._warned_critical = True
            self.nudge()
        elif ok:
            self._warned_critical = False
        return ok

    def status(self) -> dict:
        usage = shutil.disk_usage(self.data_dir)
        return {
            "retentionDays": self.retention_days,
            "snapshotsBytes": self._snapshots_bytes,
            "freeBytes": usage.free,
            "totalBytes": usage.total,
            "lowDisk": usage.free < LOW_FREE_BYTES,
            "snapshotsPaused": usage.free <= CRITICAL_FREE_BYTES,
            "lastCleanupAt": self.last_cleanup_at,
            "lastRemoved": self.last_removed,
            "lastFreedBytes": self.last_freed_bytes,
        }

    # ---------- cleanup ----------

    def cleanup(self) -> dict:
        with self._lock:
            protect = self.uploads_enabled()
            removed = freed = 0
            if self.retention_days > 0:
                cutoff = (datetime.now(timezone.utc) - timedelta(days=self.retention_days)).isoformat()
                while True:
                    rows = self.store.snapshots_older_than(cutoff, protect)
                    if not rows:
                        break
                    freed += self.store.remove_snapshots(rows)
                    removed += len(rows)
            self._free_cache = (0.0, 0)
            if self.free_bytes() < LOW_FREE_BYTES:
                log.warning("Low disk space (%.1f GB free): removing oldest snapshots", self.free_bytes() / GB)
                while self.free_bytes() < TARGET_FREE_BYTES:
                    rows = self.store.oldest_snapshots(protect)
                    if not rows:
                        break
                    freed += self.store.remove_snapshots(rows)
                    removed += len(rows)
                    self._free_cache = (0.0, 0)
            self._snapshots_bytes = self.store.snapshots_bytes()
            self.last_cleanup_at = now_iso()
            self.last_removed, self.last_freed_bytes = removed, freed
            if removed:
                log.info("Storage cleanup removed %s snapshots (%.1f MB)", removed, freed / 2**20)
            return self.status()

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                self.cleanup()
            except Exception:
                log.exception("Storage cleanup failed")
            self._wake.wait(self.INTERVAL_S)
            self._wake.clear()
