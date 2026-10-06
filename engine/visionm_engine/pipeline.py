"""Real-time capture → inference → publish pipeline.

Three threads, each always working on the *newest* item:

    CaptureWorker  ──latest frame──▶  InferenceWorker  ──latest result──▶  Publisher ──▶ UI (WebSocket)
                                           │
                                           └─▶ verdict / analytics / defect log ─▶ RunStore (disk)

No queue grows unbounded: if inference is slower than the camera, stale frames
are skipped; if the UI is slower than inference, stale results are skipped.
Production logic (verdict, counts, logs) never waits on the UI.
"""

from __future__ import annotations

import json
import logging
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Generic, TypeVar

from .annotate import annotate, encode_jpeg
from .cameras import CameraError, CameraSettings, create_camera
from .detectors import Detector
from .run_store import RunStore, now_iso
from .schemas import LiveSettings
from .core import Detection, Frame
from .verdict import FrameOutcome, VerdictEngine, VerdictSettings

log = logging.getLogger(__name__)
T = TypeVar("T")


class LatestSlot(Generic[T]):
    """Single-item mailbox: writers overwrite, readers wait for something newer than they last saw."""

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._item: T | None = None
        self._version = 0

    def put(self, item: T) -> None:
        with self._cond:
            self._item = item
            self._version += 1
            self._cond.notify_all()

    def get_newer(self, seen: int, timeout: float) -> tuple[T, int] | None:
        with self._cond:
            if self._version == seen:
                self._cond.wait(timeout)
            if self._version == seen or self._item is None:
                return None
            return self._item, self._version

    def wake(self) -> None:
        with self._cond:
            self._cond.notify_all()


class Ema:
    def __init__(self, alpha: float = 0.1) -> None:
        self.alpha = alpha
        self.value: float | None = None

    def add(self, x: float) -> float:
        self.value = x if self.value is None else self.value + self.alpha * (x - self.value)
        return self.value


class CaptureWorker(threading.Thread):
    MAX_READ_FAILURES = 30

    def __init__(self, settings: CameraSettings, out: LatestSlot[Frame], stop: threading.Event) -> None:
        super().__init__(name="capture", daemon=True)
        self.settings = settings
        self.out = out
        self.stop_event = stop
        self.status = "connecting"  # connecting | streaming | reconnecting
        self.error: str | None = None
        self.resolution = (0, 0)
        self.fps = Ema(0.05)
        self.first_frame = threading.Event()
        self._seq = 0

    def run(self) -> None:
        backoff = 0.5
        while not self.stop_event.is_set():
            camera = create_camera(self.settings)
            try:
                camera.open()
                self.resolution = camera.actual_resolution
                self.status, self.error, backoff = "streaming", None, 0.5
                failures = 0
                last = time.perf_counter()
                while not self.stop_event.is_set():
                    img = camera.read()
                    if img is None:
                        failures += 1
                        if failures >= self.MAX_READ_FAILURES:
                            raise CameraError("Camera stopped delivering frames")
                        time.sleep(0.01)
                        continue
                    failures = 0
                    now = time.perf_counter()
                    self.fps.add(1.0 / max(now - last, 1e-6))
                    last = now
                    self._seq += 1
                    self.out.put(Frame(image=img, seq=self._seq, captured_at=time.monotonic(), wall_time=time.time()))
                    self.first_frame.set()
            except Exception as exc:  # camera unplugged, driver error, ...
                if self.stop_event.is_set():
                    break
                self.status, self.error = "reconnecting", str(exc)
                log.warning("Camera error (%s); retrying in %.1fs", exc, backoff)
            finally:
                camera.close()
            self.stop_event.wait(backoff)
            backoff = min(backoff * 2, 5.0)


@dataclass(slots=True)
class InferenceResult:
    frame: Frame
    detections: list[Detection]
    outcome: FrameOutcome
    infer_ms: float
    latency_ms: float


class RunStats:
    def __init__(self) -> None:
        self.frames_inferred = 0
        self.frames_skipped = 0
        self.inference_errors = 0
        self.infer_ms = Ema(0.1)
        self.latency_ms = Ema(0.1)
        self.infer_fps = Ema(0.1)
        self._infer_ms_sum = 0.0

    def record(self, infer_ms: float, latency_ms: float, interval_s: float | None) -> None:
        self.frames_inferred += 1
        self._infer_ms_sum += infer_ms
        self.infer_ms.add(infer_ms)
        self.latency_ms.add(latency_ms)
        if interval_s:
            self.infer_fps.add(1.0 / max(interval_s, 1e-6))

    def to_json(self) -> dict:
        avg = self._infer_ms_sum / self.frames_inferred if self.frames_inferred else None
        return {
            "framesInferred": self.frames_inferred,
            "framesSkipped": self.frames_skipped,
            "inferenceErrors": self.inference_errors,
            "avgInferMs": round(avg, 2) if avg else None,
            "inferMs": round(self.infer_ms.value, 2) if self.infer_ms.value else None,
            "latencyMs": round(self.latency_ms.value, 2) if self.latency_ms.value else None,
            "inferFps": round(self.infer_fps.value, 1) if self.infer_fps.value else None,
        }


class Run:
    """One live inspection run: owns the threads, verdict state and persistence for that run."""

    CHECKPOINT_EVERY_S = 5.0

    def __init__(
        self,
        *,
        run_id: str,
        detector: Detector,
        camera: CameraSettings,
        live: dict,
        store: RunStore,
        publish_frame: Callable[[bytes], None],
        on_defect: Callable[[dict], None],
        stream_quality: int,
        config_for_store: dict,
    ) -> None:
        self.run_id = run_id
        self.detector = detector
        self.store = store
        self.publish_frame = publish_frame
        self.on_defect = on_defect
        self.stream_quality = stream_quality
        self.config_for_store = config_for_store
        self.started_at = now_iso()

        self._live = dict(live)
        self.verdict = VerdictEngine(self._verdict_settings(self._live))
        self.stats = RunStats()

        self._stop = threading.Event()
        self._frames: LatestSlot[Frame] = LatestSlot()
        self._results: LatestSlot[InferenceResult] = LatestSlot()
        self.capture = CaptureWorker(camera, self._frames, self._stop)
        self._infer_thread = threading.Thread(target=self._infer_loop, name="inference", daemon=True)
        self._publish_thread = threading.Thread(target=self._publish_loop, name="publisher", daemon=True)
        self._io = ThreadPoolExecutor(max_workers=1, thread_name_prefix="run-io")
        self._last_defect_count = 0

    # ---------- lifecycle ----------

    def start(self) -> None:
        self.capture.start()
        self._infer_thread.start()
        self._publish_thread.start()

    def stop(self) -> dict:
        self._stop.set()
        self._frames.wake()
        self._results.wake()
        for t in (self.capture, self._infer_thread, self._publish_thread):
            t.join(timeout=5)
        # A product still in view when the run stops is counted, like the web app does.
        self.verdict.flush_incident()
        self._io.shutdown(wait=True)
        analytics = self.analytics_json()
        self.store.finish_run(self.run_id, analytics, self.stats.to_json())
        return analytics

    # ---------- live settings ----------

    @staticmethod
    def _verdict_settings(live: dict) -> VerdictSettings:
        return VerdictSettings(
            good_classes=list(live["good_classes"]),
            verdict_enabled=live["verdict_enabled"],
            defect_logging_enabled=live["defect_logging_enabled"],
            center_guide_enabled=live["center_guide_enabled"],
            center_guide_percent=live["center_guide_percent"],
        )

    @property
    def live(self) -> dict:
        return dict(self._live)

    def update_live(self, patch: dict) -> dict:
        self._live.update({k: v for k, v in patch.items() if v is not None})
        # Swapping the settings object is atomic; the inference thread picks it up on the next frame.
        self.verdict.update_settings(self._verdict_settings(self._live))
        self.config_for_store["live"] = LiveSettings(**self._live).model_dump(by_alias=True)
        return self.live

    def analytics_json(self) -> dict:
        a = self.verdict.analytics.to_json()
        a["runStartedAt"] = self.started_at
        return a

    # ---------- threads ----------

    def _infer_loop(self) -> None:
        seen = 0
        last_seq = 0
        last_done: float | None = None
        last_checkpoint = time.monotonic()
        while not self._stop.is_set():
            got = self._frames.get_newer(seen, timeout=0.5)
            if got is None:
                continue
            frame, seen = got
            if last_seq and frame.seq > last_seq + 1:
                self.stats.frames_skipped += frame.seq - last_seq - 1
            last_seq = frame.seq
            conf = float(self._live["confidence"])
            t0 = time.perf_counter()
            try:
                detections = self.detector.predict(frame.image, conf)
            except Exception:
                self.stats.inference_errors += 1
                log.exception("Inference failed on frame %s", frame.seq)
                continue
            t1 = time.perf_counter()
            outcome = self.verdict.process(detections, frame.width, frame.height)
            infer_ms = (t1 - t0) * 1000
            latency_ms = (time.monotonic() - frame.captured_at) * 1000
            self.stats.record(infer_ms, latency_ms, (t1 - last_done) if last_done else None)
            last_done = t1

            if outcome.defect_event is not None:
                self._io.submit(self._save_defect, frame, detections, outcome)

            self._results.put(InferenceResult(frame, detections, outcome, infer_ms, latency_ms))

            if time.monotonic() - last_checkpoint >= self.CHECKPOINT_EVERY_S:
                last_checkpoint = time.monotonic()
                self._io.submit(self.store.checkpoint, self.run_id, self.analytics_json(), self.stats.to_json(), dict(self.config_for_store))

    def _save_defect(self, frame: Frame, detections: list[Detection], outcome: FrameOutcome) -> None:
        try:
            good = set(self._live["good_classes"])
            snapshot = annotate(frame.image, detections, good, "NOT_OK")
            ts = datetime.fromtimestamp(frame.wall_time, timezone.utc).isoformat()
            entry = self.store.add_defect(self.run_id, outcome.defect_event.defect_classes, encode_jpeg(snapshot, 85), ts)
            self._last_defect_count += 1
            self.on_defect(entry)
        except Exception:
            log.exception("Failed to save defect snapshot")

    def _publish_loop(self) -> None:
        seen = 0
        while not self._stop.is_set():
            got = self._results.get_newer(seen, timeout=0.5)
            if got is None:
                continue
            r, seen = got
            try:
                jpeg = encode_jpeg(r.frame.image, self.stream_quality)
                header = {
                    "type": "frame",
                    "runId": self.run_id,
                    "seq": r.frame.seq,
                    "width": r.frame.width,
                    "height": r.frame.height,
                    "detections": [d.to_json() for d in r.detections],
                    "verdict": r.outcome.verdict if r.outcome.frame_verdict is not None else None,
                    "frameVerdict": r.outcome.frame_verdict,
                    "productInRegion": r.outcome.product_in_region,
                    "analytics": self.analytics_json(),
                    "defectCount": self._last_defect_count,
                    "stats": {
                        **self.stats.to_json(),
                        "cameraFps": round(self.capture.fps.value, 1) if self.capture.fps.value else None,
                        "inferMsFrame": round(r.infer_ms, 2),
                        "latencyMsFrame": round(r.latency_ms, 2),
                    },
                }
                hb = json.dumps(header, separators=(",", ":")).encode()
                self.publish_frame(struct.pack(">I", len(hb)) + hb + jpeg)
            except Exception:
                log.exception("Failed to publish frame")
