"""Station orchestrator: owns the loaded model, the active run and the services around it."""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable

from .cameras import CameraSettings
from .detectors import Detector, create_detector
from .gpu import live_stats, resolve_device, system_info
from .model_store import ModelStore, ModelStoreError, meta_to_json
from .pipeline import Run
from .maintenance import StorageMaintainer
from .run_store import RunStore
from .schemas import LiveSettingsPatch, StartRunRequest, UserIdentity
from .sync import BackendSession, SyncWorker

log = logging.getLogger(__name__)


class StationError(RuntimeError):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


class Station:
    FIRST_FRAME_TIMEOUT_S = 15.0

    def __init__(self, data_dir: Path, publish_frame: Callable[[bytes], None], publish_event: Callable[[dict], None]) -> None:
        self.data_dir = data_dir
        self.models = ModelStore(data_dir)
        self.runs = RunStore(data_dir)
        self.sync = SyncWorker(self.runs)
        self.sync.start()
        self.storage = StorageMaintainer(self.runs, data_dir, uploads_enabled=lambda: self.sync.enabled)
        self.storage.start()
        self._publish_frame = publish_frame
        self._publish_event = publish_event
        self._lock = threading.RLock()
        self._detector: Detector | None = None
        self._detector_key: tuple[str, str, str] | None = None
        self._gpu_info = system_info()
        self._run: Run | None = None
        self._state = "idle"  # idle | starting | running | stopping
        self._last_error: str | None = None
        self._user: UserIdentity | None = None

    # ---------- session ----------

    def set_session(
        self, api_base: str, headers: dict[str, str], user: UserIdentity, station_name: str | None = None, upload_enabled: bool = False
    ) -> None:
        self._user = user
        self.sync.enabled = upload_enabled
        if station_name:
            self.sync.station_name = station_name
        self.sync.set_session(BackendSession(api_base=api_base, headers=headers, user=user.model_dump(by_alias=True)))

    def clear_session(self) -> None:
        self._user = None
        self.sync.set_session(None)

    # ---------- status ----------

    def status(self) -> dict:
        run = self._run
        return {
            "state": self._state,
            "lastError": self._last_error,
            "gpu": self._gpu_status(),
            "model": meta_to_json(self._detector.meta) if self._detector else None,
            "run": self._run_status(run) if run else None,
            "sync": self.sync.status(),
            "storage": self.storage.status(),
        }

    def _gpu_status(self) -> dict:
        """GPU in use (or the default one when idle) plus live health."""
        info = self._gpu_info
        device = self._detector.device if self._detector else ("cuda:0" if info["cuda"] else "cpu")
        index = int(device.split(":")[1]) if device.startswith("cuda:") else None
        gpu = next((g for g in info["gpus"] if g["index"] == index), None) if index is not None else None
        return {
            "cuda": info["cuda"],
            "name": gpu["name"] if gpu else None,
            "index": index,
            "device": device,
            "count": len([g for g in info["gpus"] if g.get("usable", True)]),
            "live": live_stats(index) if index is not None else None,
        }

    def gpu_info(self) -> dict:
        info = system_info()
        self._gpu_info = info
        return info

    @staticmethod
    def _run_status(run: Run) -> dict:
        return {
            "id": run.run_id,
            "startedAt": run.started_at,
            "live": run.config_for_store.get("live"),
            "camera": {
                "status": run.capture.status,
                "error": run.capture.error,
                "resolution": list(run.capture.resolution),
            },
            "analytics": run.analytics_json(),
            "stats": run.stats.to_json(),
        }

    # ---------- run lifecycle ----------

    def start_run(self, req: StartRunRequest) -> dict:
        with self._lock:
            if self._state != "idle":
                raise StationError(f"Cannot start: station is {self._state}", 409)
            self._state = "starting"
            self._last_error = None
        try:
            try:
                meta, path = self.models.get(req.model_id)
            except ModelStoreError as exc:
                raise StationError(str(exc), 404) from exc
            device = resolve_device(req.gpu_index)
            key = (meta.id, req.precision, device)
            if self._detector_key != key:
                self._detector = None
                log.info("Loading model %s (%s, %s) on %s", meta.name, meta.model_type, req.precision, device)
                det = create_detector(meta, path, req.precision, device)
                warm = det.warmup(req.camera.width, req.camera.height)
                log.info("Model ready on %s, warm-up %.1f ms/frame", det.device, warm)
                if det.class_names and det.class_names != meta.class_names:
                    self.models.update_class_names(meta.id, det.class_names)
                    meta.class_names = det.class_names
                self._detector, self._detector_key = det, key
            detector = self._detector
            assert detector is not None

            config = req.model_dump(by_alias=True)
            model_json = meta_to_json(meta)
            sync_enabled = bool(meta.backend_model_id) and self._user is not None
            run_id = self.runs.create_run(
                model=model_json,
                user=self._user.model_dump(by_alias=True) if self._user else None,
                camera_name=req.camera.camera_name or req.camera.camera_id,
                config=config,
                sync=sync_enabled,
            )
            run = Run(
                run_id=run_id,
                detector=detector,
                camera=CameraSettings(
                    camera_id=req.camera.camera_id, width=req.camera.width, height=req.camera.height, fps=req.camera.fps
                ),
                live=req.live.model_dump(),
                store=self.runs,
                publish_frame=self._publish_frame,
                on_defect=lambda entry: self._publish_event({"type": "defect", "defect": entry}),
                stream_quality=req.stream_quality,
                config_for_store=config,
                snapshots_allowed=self.storage.snapshots_allowed,
            )
            run.start()
            if not run.capture.first_frame.wait(self.FIRST_FRAME_TIMEOUT_S):
                err = run.capture.error or "Camera did not deliver a frame"
                run.stop()
                self.runs.delete_run(run_id)  # nothing was inspected; don't clutter history
                raise StationError(f"Camera failed to start: {err}", 503)
            with self._lock:
                self._run = run
                self._state = "running"
            self._publish_event({"type": "status", "status": self.status()})
            self.sync.nudge()
            return self.status()
        except StationError as exc:
            self._fail(str(exc))
            raise
        except Exception as exc:
            log.exception("Failed to start run")
            self._fail(str(exc))
            raise StationError(str(exc), 500) from exc

    def _fail(self, message: str) -> None:
        with self._lock:
            self._state = "idle"
            self._last_error = message
        self._publish_event({"type": "status", "status": self.status()})

    def stop_run(self) -> dict | None:
        with self._lock:
            run = self._run
            if run is None or self._state != "running":
                return None
            self._state = "stopping"
        try:
            run.stop()
        finally:
            with self._lock:
                self._run = None
                self._state = "idle"
        self.sync.nudge()
        self._publish_event({"type": "status", "status": self.status()})
        return self.runs.get_run(run.run_id)

    def update_live(self, patch: LiveSettingsPatch) -> dict:
        run = self._run
        if run is None:
            raise StationError("No run is active", 409)
        run.update_live(patch.model_dump(exclude_none=True))
        return run.config_for_store["live"]

    def unload_model(self) -> None:
        with self._lock:
            if self._state != "idle":
                raise StationError("Stop the run before unloading the model", 409)
            self._detector, self._detector_key = None, None
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:
            pass

    def shutdown(self) -> None:
        try:
            self.stop_run()
        finally:
            self.sync.stop()
            self.storage.stop()
            self.runs.close()
