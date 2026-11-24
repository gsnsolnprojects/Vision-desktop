"""Camera preview for Run Setup: live picture without running a model, to aim and focus the camera.

Frames go out on the same WebSocket as run frames, with header type "preview", downscaled and
rate-limited so it stays light. Brightness and a focus score are included so the operator can
turn the lens until the focus number peaks. A preview that the UI stops refreshing shuts itself
down, so a closed window or crashed screen never keeps the camera locked.
"""

from __future__ import annotations

import json
import logging
import struct
import threading
import time
from typing import Callable

import cv2

from .annotate import encode_jpeg
from .camera_check import sharpness
from .camera_health import brightness
from .cameras import CameraSettings
from .core import Frame
from .pipeline import CaptureWorker, LatestSlot

log = logging.getLogger(__name__)

PREVIEW_WIDTH = 960  # default; the full-screen camera tuner asks for full resolution
MAX_PREVIEW_WIDTH = 4096
PREVIEW_FPS = 15
METRICS_EVERY_S = 0.5
IDLE_TIMEOUT_S = 45.0  # the UI sends a keep-alive every ~15 s


class Preview:
    def __init__(self, settings: CameraSettings, publish_frame: Callable[[bytes], None], max_width: int = PREVIEW_WIDTH) -> None:
        self.settings = settings
        # Changeable while running (small preview <-> full-screen tuner) without reopening the camera.
        self.max_width = max(160, min(int(max_width), MAX_PREVIEW_WIDTH))
        self._publish = publish_frame
        self._stop = threading.Event()
        self._frames: LatestSlot[Frame] = LatestSlot()
        self.capture = CaptureWorker(settings, self._frames, self._stop)
        self._thread = threading.Thread(target=self._loop, name="preview", daemon=True)
        self._last_keepalive = time.monotonic()
        self.sharpness: float | None = None
        self.brightness: float | None = None

    @property
    def camera_id(self) -> str:
        return self.settings.camera_id

    @property
    def alive(self) -> bool:
        return not self._stop.is_set()

    def start(self) -> None:
        self.capture.start()
        self._thread.start()

    def keepalive(self) -> None:
        self._last_keepalive = time.monotonic()

    def stop(self) -> None:
        self._stop.set()
        self._frames.wake()
        self.capture.join(timeout=5)
        self._thread.join(timeout=5)

    def _loop(self) -> None:
        seen = 0
        next_send = 0.0
        next_metrics = 0.0
        while not self._stop.is_set():
            if time.monotonic() - self._last_keepalive > IDLE_TIMEOUT_S:
                log.info("Preview idle for %.0fs; stopping it to free the camera", IDLE_TIMEOUT_S)
                self._stop.set()
                break
            got = self._frames.get_newer(seen, timeout=0.5)
            if got is None:
                continue
            frame, seen = got
            now = time.monotonic()
            if now < next_send:
                continue
            next_send = now + 1.0 / PREVIEW_FPS
            try:
                img = frame.image
                if now >= next_metrics:
                    next_metrics = now + METRICS_EVERY_S
                    self.sharpness = sharpness(img)
                    self.brightness = brightness(img)
                h, w = img.shape[:2]
                mw = self.max_width
                if w > mw:
                    img = cv2.resize(img, (mw, int(round(h * mw / w))), interpolation=cv2.INTER_AREA)
                header = {
                    "type": "preview",
                    "cameraId": self.settings.camera_id,
                    "seq": frame.seq,
                    "width": int(img.shape[1]),
                    "height": int(img.shape[0]),
                    "sourceWidth": w,
                    "sourceHeight": h,
                    "pixelFormat": self.capture.pixel_format,
                    "warning": self.capture.warning,
                    "cameraFps": round(self.capture.fps.value, 1) if self.capture.fps.value else None,
                    "sharpness": round(self.sharpness, 1) if self.sharpness is not None else None,
                    "brightness": round(self.brightness, 1) if self.brightness is not None else None,
                    "detections": [],
                }
                hb = json.dumps(header, separators=(",", ":")).encode()
                self._publish(struct.pack(">I", len(hb)) + hb + encode_jpeg(img, 85 if mw > PREVIEW_WIDTH else 75))
            except Exception:
                log.exception("Preview frame failed")

    def status(self) -> dict:
        return {
            "cameraId": self.settings.camera_id,
            "status": self.capture.status,
            "error": self.capture.error,
            "resolution": list(self.capture.resolution),
            "pixelFormat": self.capture.pixel_format,
            "warning": self.capture.warning,
        }
