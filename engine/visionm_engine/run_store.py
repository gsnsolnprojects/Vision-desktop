"""Durable local storage for inspection runs and defect logs (SQLite, WAL).

Everything a run produces is written here first; the sync worker uploads to the
backend afterwards. A crash, power cut or network outage never loses results.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,              -- running | completed | interrupted
    model_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    model_type TEXT,
    backend_model_id TEXT,
    company TEXT,
    project TEXT,
    project_id TEXT,
    user_json TEXT,
    camera_name TEXT,
    config_json TEXT NOT NULL,
    analytics_json TEXT NOT NULL,
    stats_json TEXT NOT NULL DEFAULT '{}',
    sync_state TEXT NOT NULL DEFAULT 'pending',   -- pending | synced | local_only
    sync_error TEXT,
    backend_run_id TEXT
);
CREATE TABLE IF NOT EXISTS defects (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    verdict TEXT NOT NULL,
    classes_json TEXT NOT NULL,
    image_file TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_defects_run ON defects(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class RunStore:
    def __init__(self, data_dir: Path) -> None:
        self.dir = data_dir / "runs"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(data_dir / "station.db", check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.execute("PRAGMA foreign_keys=ON")
            self._db.executescript(SCHEMA)
            self._migrate()
            # Runs left "running" by a crash are closed as interrupted (their last checkpoint is kept).
            self._db.execute(
                "UPDATE runs SET status='interrupted', ended_at=COALESCE(ended_at, ?) WHERE status='running'",
                (now_iso(),),
            )

    def _migrate(self) -> None:
        """Additive schema upgrades for databases created by older versions."""
        cols = {r["name"] for r in self._db.execute("PRAGMA table_info(runs)").fetchall()}
        if "name" not in cols:
            self._db.execute("ALTER TABLE runs ADD COLUMN name TEXT")
        if "notes" not in cols:
            self._db.execute("ALTER TABLE runs ADD COLUMN notes TEXT")

    def _exec(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, params)

    # ---------- runs ----------

    def create_run(self, *, model: dict, user: dict | None, camera_name: str, config: dict, sync: bool) -> str:
        run_id = f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
        self._exec(
            """INSERT INTO runs (id, started_at, status, model_id, model_name, model_type, backend_model_id,
                company, project, project_id, user_json, camera_name, config_json, analytics_json, sync_state)
               VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)""",
            (
                run_id, now_iso(), model["id"], model["name"], model.get("modelType"), model.get("backendModelId"),
                model.get("company"), model.get("project"), model.get("projectId"),
                json.dumps(user) if user else None, camera_name, json.dumps(config),
                "pending" if sync else "local_only",
            ),
        )
        (self.dir / run_id).mkdir(parents=True, exist_ok=True)
        return run_id

    def checkpoint(self, run_id: str, analytics: dict, stats: dict, config: dict | None = None) -> None:
        if config is None:
            self._exec("UPDATE runs SET analytics_json=?, stats_json=? WHERE id=?", (json.dumps(analytics), json.dumps(stats), run_id))
        else:
            self._exec(
                "UPDATE runs SET analytics_json=?, stats_json=?, config_json=? WHERE id=?",
                (json.dumps(analytics), json.dumps(stats), json.dumps(config), run_id),
            )

    def finish_run(self, run_id: str, analytics: dict, stats: dict, status: str = "completed") -> None:
        self._exec(
            "UPDATE runs SET status=?, ended_at=?, analytics_json=?, stats_json=? WHERE id=?",
            (status, now_iso(), json.dumps(analytics), json.dumps(stats), run_id),
        )

    def update_meta(self, run_id: str, name: str | None, notes: str | None) -> bool:
        cur = self._exec(
            "UPDATE runs SET name=?, notes=? WHERE id=?",
            ((name or "").strip() or None, (notes or "").strip() or None, run_id),
        )
        return cur.rowcount > 0

    def list_runs(self, limit: int = 200) -> list[dict]:
        rows = self._exec(
            """SELECT r.*, (SELECT COUNT(*) FROM defects d WHERE d.run_id = r.id) AS defect_count
               FROM runs r ORDER BY started_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [self._run_json(r) for r in rows]

    def get_run(self, run_id: str) -> dict | None:
        row = self._exec(
            "SELECT r.*, (SELECT COUNT(*) FROM defects d WHERE d.run_id = r.id) AS defect_count FROM runs r WHERE id=?",
            (run_id,),
        ).fetchone()
        return self._run_json(row) if row else None

    def delete_run(self, run_id: str) -> None:
        self._exec("DELETE FROM runs WHERE id=?", (run_id,))
        run_dir = self.dir / run_id
        if run_dir.is_dir():
            for f in run_dir.iterdir():
                f.unlink(missing_ok=True)
            run_dir.rmdir()

    @staticmethod
    def _run_json(r: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": r["id"],
            "name": r["name"],
            "notes": r["notes"],
            "startedAt": r["started_at"],
            "endedAt": r["ended_at"],
            "status": r["status"],
            "model": {
                "id": r["model_id"],
                "name": r["model_name"],
                "modelType": r["model_type"],
                "backendModelId": r["backend_model_id"],
            },
            "company": r["company"],
            "project": r["project"],
            "projectId": r["project_id"],
            "user": json.loads(r["user_json"]) if r["user_json"] else None,
            "cameraName": r["camera_name"],
            "config": json.loads(r["config_json"]),
            "analytics": json.loads(r["analytics_json"] or "{}"),
            "stats": json.loads(r["stats_json"] or "{}"),
            "defectCount": r["defect_count"],
            "syncState": r["sync_state"],
            "syncError": r["sync_error"],
            "backendRunId": r["backend_run_id"],
        }

    # ---------- defects ----------

    def add_defect(self, run_id: str, classes: list[str], jpeg: bytes, ts: str | None = None) -> dict:
        defect_id = uuid.uuid4().hex
        image_file = f"{defect_id}.jpg"
        path = self.dir / run_id / image_file
        tmp = path.with_suffix(".part")
        tmp.write_bytes(jpeg)
        tmp.replace(path)
        ts = ts or now_iso()
        self._exec(
            "INSERT INTO defects (id, run_id, ts, verdict, classes_json, image_file) VALUES (?, ?, ?, 'NOT_OK', ?, ?)",
            (defect_id, run_id, ts, json.dumps(classes), image_file),
        )
        return {"id": defect_id, "runId": run_id, "timestamp": ts, "verdict": "NOT_OK", "defectClasses": classes}

    def list_defects(self, run_id: str, limit: int | None = None) -> list[dict]:
        sql = "SELECT * FROM defects WHERE run_id=? ORDER BY ts DESC"
        params: tuple = (run_id,)
        if limit:
            sql += " LIMIT ?"
            params = (run_id, limit)
        return [
            {
                "id": r["id"],
                "runId": r["run_id"],
                "timestamp": r["ts"],
                "verdict": r["verdict"],
                "defectClasses": json.loads(r["classes_json"]),
                "synced": bool(r["synced"]),
            }
            for r in self._exec(sql, params).fetchall()
        ]

    def defect_image_path(self, run_id: str, defect_id: str) -> Path | None:
        row = self._exec("SELECT image_file FROM defects WHERE id=? AND run_id=?", (defect_id, run_id)).fetchone()
        if not row:
            return None
        p = self.dir / run_id / row["image_file"]
        return p if p.is_file() else None

    # ---------- sync bookkeeping ----------

    def runs_needing_sync(self) -> list[dict]:
        rows = self._exec(
            """SELECT r.*, 0 AS defect_count FROM runs r
               WHERE r.sync_state = 'pending'
                  OR (r.sync_state = 'synced' AND EXISTS (SELECT 1 FROM defects d WHERE d.run_id = r.id AND d.synced = 0))
               ORDER BY started_at ASC"""
        ).fetchall()
        return [self._run_json(r) for r in rows]

    def unsynced_defects(self, run_id: str, limit: int = 20) -> list[dict]:
        rows = self._exec(
            "SELECT * FROM defects WHERE run_id=? AND synced=0 ORDER BY ts ASC LIMIT ?", (run_id, limit)
        ).fetchall()
        return [
            {"id": r["id"], "timestamp": r["ts"], "verdict": r["verdict"], "defectClasses": json.loads(r["classes_json"]), "imageFile": r["image_file"]}
            for r in rows
        ]

    def mark_run_synced(self, run_id: str, backend_run_id: str, final: bool) -> None:
        self._exec(
            "UPDATE runs SET backend_run_id=?, sync_error=NULL, sync_state=? WHERE id=?",
            (backend_run_id, "synced" if final else "pending", run_id),
        )

    def mark_run_sync_error(self, run_id: str, error: str) -> None:
        self._exec("UPDATE runs SET sync_error=? WHERE id=?", (error[:500], run_id))

    def mark_defect_synced(self, defect_id: str) -> None:
        self._exec("UPDATE defects SET synced=1 WHERE id=?", (defect_id,))

    def close(self) -> None:
        with self._lock:
            self._db.close()
