"""Background upload of runs and defect logs to VisionBackend.

Idempotent by design: runs are upserted by their station run id and defects by
their local id, so a retry after a timeout never creates duplicates. Failures
back off exponentially and never affect the live pipeline.
"""

from __future__ import annotations

import json
import logging
import socket
import threading
from dataclasses import dataclass

import httpx

from .run_store import RunStore, now_iso

log = logging.getLogger(__name__)


@dataclass
class BackendSession:
    api_base: str
    headers: dict[str, str]
    user: dict


class SyncWorker(threading.Thread):
    IDLE_INTERVAL_S = 15.0
    MAX_BACKOFF_S = 300.0

    def __init__(self, store: RunStore) -> None:
        super().__init__(name="sync", daemon=True)
        self.store = store
        self._session: BackendSession | None = None
        # Off by default: runs stay on this PC (still queued) until uploads are switched on in Settings.
        self.enabled = False
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._backoff = 0.0
        self.station_name = socket.gethostname()
        self.last_error: str | None = None
        self.last_success_at: str | None = None

    def set_session(self, session: BackendSession | None) -> None:
        self._session = session
        self.nudge()

    def nudge(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def status(self) -> dict:
        pending = len(self.store.runs_needing_sync())
        return {
            "enabled": self.enabled,
            "signedIn": self._session is not None,
            "pendingRuns": pending,
            "lastError": self.last_error,
            "lastSuccessAt": self.last_success_at,
        }

    def run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(self._backoff or self.IDLE_INTERVAL_S)
            self._wake.clear()
            if self._stop.is_set():
                break
            session = self._session
            if session is None or not self.enabled:
                continue
            try:
                self._sync_all(session)
                self._backoff = 0.0
                self.last_error = None
            except Exception as exc:
                self._backoff = min(max(self._backoff * 2, 5.0), self.MAX_BACKOFF_S)
                self.last_error = str(exc)
                log.warning("Sync failed (%s); next attempt in %.0fs", exc, self._backoff)

    def _sync_all(self, s: BackendSession) -> None:
        headers = {k: v for k, v in s.headers.items() if k.lower() != "content-type"}
        with httpx.Client(base_url=s.api_base.rstrip("/") + "/", headers=headers, timeout=30) as client:
            for run in self.store.runs_needing_sync():
                self._sync_run(client, run)
        self.last_success_at = now_iso()

    def _sync_run(self, client: httpx.Client, run: dict) -> None:
        body = {
            "clientRunId": run["id"],
            "name": run.get("name"),
            "notes": run.get("notes"),
            "stationName": self.station_name,
            "modelId": run["model"]["backendModelId"],
            "modelName": run["model"]["name"],
            "modelType": run["model"]["modelType"],
            "company": run["company"],
            "project": run["project"],
            "projectId": run["projectId"],
            "cameraName": run["cameraName"],
            "startedAt": run["startedAt"],
            "endedAt": run["endedAt"],
            "status": run["status"],
            "config": run["config"],
            "analytics": run["analytics"],
            "stats": run["stats"],
            "operator": run["user"],
        }
        r = client.post("station/runs", json=body)
        if r.status_code >= 400:
            self.store.mark_run_sync_error(run["id"], f"{r.status_code}: {r.text[:200]}")
            r.raise_for_status()
        backend_run_id = r.json()["runId"]

        while True:
            batch = self.store.unsynced_defects(run["id"])
            if not batch:
                break
            for d in batch:
                path = self.store.dir / run["id"] / d["imageFile"]
                if not path.is_file():
                    self.store.mark_defect_synced(d["id"])  # snapshot lost; nothing to upload
                    continue
                with path.open("rb") as f:
                    resp = client.post(
                        f"station/runs/{backend_run_id}/defects",
                        data={
                            "clientDefectId": d["id"],
                            "timestamp": d["timestamp"],
                            "verdict": d["verdict"],
                            "defectClasses": json.dumps(d["defectClasses"]),
                        },
                        files={"image": (d["imageFile"], f, "image/jpeg")},
                    )
                if resp.status_code >= 400:
                    self.store.mark_run_sync_error(run["id"], f"defect upload {resp.status_code}: {resp.text[:200]}")
                    resp.raise_for_status()
                self.store.mark_defect_synced(d["id"])

        self.store.mark_run_synced(run["id"], backend_run_id, final=run["status"] != "running")
