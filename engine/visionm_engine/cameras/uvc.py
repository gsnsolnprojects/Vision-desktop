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
_AUTO_FPS_CANDIDATES = (60, 50, 30)
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


def _fourcc_name(cap: cv2.VideoCapture) -> str | None:
    """Pixel format the driver reports (e.g. 'MJPG', 'YUY2'); None if it reports nothing readable."""
    code = int(cap.get(cv2.CAP_PROP_FOURCC))
    name = "".join(chr((code >> 8 * i) & 0xFF) for i in range(4))
    return name.upper() if name.isascii() and name.isalnum() else None


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
        lowest = _AUTO_FPS_CANDIDATES[-1]
        candidates = list(_AUTO_FPS_CANDIDATES)
        while candidates:
            req = candidates.pop(0)
            cap.set(cv2.CAP_PROP_FPS, req)
            measured = self._measure_fps(cap)
            log.info("Auto fps probe: requested %s, measured %.1f", req, measured)
            results.append((req, measured))
            if measured >= req * 0.85:  # sustained the fastest rate tried so far; slower ones can't beat it
                break
            if measured < lowest * 0.85:
                # Slower than even the lowest option (dark scene, busy camera): only the lowest is worth
                # checking, and skipping the middle steps keeps a slow camera from timing out the start.
                candidates = [lowest] if req != lowest else []
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
        # MJPG lets USB 2 webcams deliver 720p/1080p at 30 fps instead of ~5 fps raw YUY2. A camera that has no
        # MJPG (e.g. USB 3 industrial-style modules) ignores the request and keeps its own uncompressed format.
        fmt = (self.settings.pixel_format or "auto").lower()
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*("YUY2" if fmt == "yuy2" else "MJPG")))
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
        self.actual_format = _fourcc_name(cap)
        if fmt in ("mjpg", "yuy2") and self.actual_format not in (None, fmt.upper()):
            log.warning("Requested %s but camera delivers %s", fmt.upper(), self.actual_format)
        self.warning = self._resolution_warning()
        if self.warning:
            log.warning(self.warning)
        if self.settings.controls:
            # After the stream starts: some drivers reset image controls when streaming begins.
            from .controls import apply_controls

            try:
                report = apply_controls(self.index, self.settings.controls)
                if report["skipped"]:
                    log.warning("Camera ignored settings it doesn't support: %s", ", ".join(report["skipped"]))
            except Exception as exc:
                log.warning("Could not apply camera settings: %s", exc)
        self._fps = self._pick_auto_fps(cap) if self.settings.fps <= 0 else None
        self._cap = cap
        log.info(
            "Opened UVC camera %s at %sx%s %s (requested %sx%s@%s, format %s)",
            self.index, *self._resolution, self.actual_format or "?", self.settings.width, self.settings.height,
            "auto" if self.settings.fps <= 0 else self.settings.fps, fmt,
        )

    def _resolution_warning(self) -> str | None:
        """A camera that can't do the requested size silently falls back to another one — say so.

        The most common cause on USB 3 cameras is a USB 2 connection (wrong port, cable or loose plug),
        where they only offer their smallest, slowest mode.
        """
        w, h = self._resolution
        rw, rh = self.settings.width, self.settings.height
        if (w, h) == (rw, rh):
            return None
        msg = f"Camera gave {w}x{h} instead of the requested {rw}x{rh}."
        if w * h < rw * rh:
            msg += " Pick a size this camera supports"
            msg += ", or if it is a USB 3 camera, check it is on a USB 3 port (blue / SS) with a USB 3 cable - on USB 2 it only offers its smallest, slow mode."
        return msg

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


def list_uvc_modes(index: int, name: str | None = None) -> list[dict] | None:
    """Sizes and top frame rates the camera really offers (DirectShow media types), largest first.

    Returns None when the list can't be read (non-Windows, driver quirk) so the UI falls back to common sizes.
    """
    if sys.platform != "win32":
        return None
    try:
        import comtypes
        from pygrabber.dshow_graph import FilterGraph
    except ImportError:
        return None
    comtypes.CoInitialize()  # called from worker threads; COM must be initialised per thread
    try:
        names = FilterGraph().get_input_devices()
        # DirectShow device order matches OpenCV's DSHOW index; prefer a name match when names are unique.
        dev_index = names.index(name) if name and names.count(name) == 1 else index
        if not 0 <= dev_index < len(names):
            return None
        graph = FilterGraph()
        graph.add_video_input_device(dev_index)
        modes: dict[tuple[int, int], dict] = {}
        for f in graph.get_input_device().get_formats():
            w, h = int(f["width"]), int(f["height"])
            # pygrabber's min/max labels are swapped on some drivers; the larger value is the top rate.
            top = max(float(f.get("min_framerate") or 0), float(f.get("max_framerate") or 0))
            fmt = str(f.get("media_type_str") or "").upper()
            m = modes.setdefault((w, h), {"width": w, "height": h, "maxFps": 0.0, "formats": []})
            m["maxFps"] = max(m["maxFps"], round(top, 1))
            if fmt and fmt not in m["formats"]:
                m["formats"].append(fmt)
        return sorted(modes.values(), key=lambda m: (m["width"] * m["height"], m["maxFps"]), reverse=True) or None
    except Exception:
        log.warning("Could not list camera modes for camera %s", index, exc_info=True)
        return None
    finally:
        comtypes.CoUninitialize()
