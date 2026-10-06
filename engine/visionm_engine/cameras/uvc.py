"""USB / UVC webcams through OpenCV (DirectShow on Windows)."""

from __future__ import annotations

import logging
import sys
import time

import cv2
import numpy as np

from .base import CameraError, CameraInfo, CameraSettings, CameraSource

log = logging.getLogger(__name__)

# Auto frame rate: candidates tried from fastest, keeping the first the camera really sustains.
_AUTO_FPS_CANDIDATES = (60, 30)
_PROBE_FRAMES = 12
_PROBE_SETTLE_S = 0.15
_PROBE_BUDGET_S = 1.0

# DirectShow opens fast and honours MJPG + resolution requests on most webcams.
# Media Foundation (the OpenCV default) is slow to open and often ignores them.
_BACKEND = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY


def enumerate_uvc() -> list[CameraInfo]:
    try:
        from cv2_enumerate_cameras import enumerate_cameras

        cams = enumerate_cameras(_BACKEND)
        return [CameraInfo(id=f"uvc:{c.index}", kind="uvc", name=c.name, index=c.index) for c in cams]
    except Exception:  # pragma: no cover - fallback for platforms without the enumerator
        log.warning("Camera name enumeration unavailable; probing indexes", exc_info=True)
        found = []
        for i in range(6):
            cap = cv2.VideoCapture(i, _BACKEND)
            if cap.isOpened():
                found.append(CameraInfo(id=f"uvc:{i}", kind="uvc", name=f"Camera {i}", index=i))
            cap.release()
        return found


class UvcCamera(CameraSource):
    def __init__(self, settings: CameraSettings, index: int) -> None:
        super().__init__(settings)
        self.index = index
        self._cap: cv2.VideoCapture | None = None
        self._resolution = (0, 0)
        self._fps: float | None = None

    @staticmethod
    def _measure_fps(cap: cv2.VideoCapture) -> float:
        """Frames per second actually delivered, within a fixed time budget.

        A webcam in a dark scene stretches exposure (down to ~1 fps), so the probe must never wait
        for a fixed number of frames — that turned a slow camera into a failed start.
        """
        settle_until = time.perf_counter() + _PROBE_SETTLE_S
        while time.perf_counter() < settle_until:  # let the driver settle after a mode change
            cap.read()
        t0 = time.perf_counter()
        got = 0
        while got < _PROBE_FRAMES and time.perf_counter() - t0 < _PROBE_BUDGET_S:
            ok, _f = cap.read()
            got += 1 if ok else 0
        dt = time.perf_counter() - t0
        return got / dt if dt > 0 else 0.0

    def _pick_auto_fps(self, cap: cv2.VideoCapture) -> float:
        """Measure what the camera really delivers (lighting and USB limits included) and keep the fastest.

        If a faster request doesn't give a clear gain, the slower setting wins: same speed, longer exposure.
        """
        results: list[tuple[int, float]] = []
        for req in _AUTO_FPS_CANDIDATES:
            cap.set(cv2.CAP_PROP_FPS, req)
            measured = self._measure_fps(cap)
            log.info("Auto fps probe: requested %s, measured %.1f", req, measured)
            results.append((req, measured))
            if measured >= req * 0.85:  # sustained the fastest rate tried so far; slower ones can't beat it
                break
        best_req, best_fps = results[0]
        for req, measured in results[1:]:
            if measured >= best_fps * 0.9:  # no clear loss -> prefer the slower request
                best_req, best_fps = req, max(measured, best_fps)
        cap.set(cv2.CAP_PROP_FPS, best_req)
        log.info("Auto fps: using %s (%.1f fps measured)", best_req, best_fps)
        if best_fps < 10:
            log.warning("Camera only delivers %.1f fps; the scene is probably too dark (auto-exposure) or the camera is busy", best_fps)
        return best_fps

    def open(self) -> None:
        cap = cv2.VideoCapture(self.index, _BACKEND)
        if not cap.isOpened():
            cap.release()
            raise CameraError(f"Could not open camera {self.index}")
        # MJPG lets USB2 webcams deliver 720p/1080p at 30 fps instead of ~5 fps raw YUY2.
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.settings.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.settings.height)
        if self.settings.fps > 0:
            cap.set(cv2.CAP_PROP_FPS, self.settings.fps)
        # Keep the driver queue minimal so we always process the newest frame.
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        ok, frame = cap.read()
        if not ok or frame is None:
            cap.release()
            raise CameraError(f"Camera {self.index} opened but returned no frames")
        self._resolution = (int(frame.shape[1]), int(frame.shape[0]))
        self._fps = self._pick_auto_fps(cap) if self.settings.fps <= 0 else None
        self._cap = cap
        log.info(
            "Opened UVC camera %s at %sx%s (requested %sx%s@%s)",
            self.index, *self._resolution, self.settings.width, self.settings.height,
            "auto" if self.settings.fps <= 0 else self.settings.fps,
        )

    def read(self) -> np.ndarray | None:
        if self._cap is None:
            return None
        ok, frame = self._cap.read()
        return frame if ok else None

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    @property
    def actual_resolution(self) -> tuple[int, int]:
        return self._resolution
