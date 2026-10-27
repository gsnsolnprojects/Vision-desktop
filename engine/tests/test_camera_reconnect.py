"""Camera unplugged mid-run: the capture worker must report 'reconnecting' and resume when it comes back."""

import threading
import time

import numpy as np

from visionm_engine import pipeline
from visionm_engine.cameras import CameraError, CameraSettings, CameraSource


class FlakyCamera(CameraSource):
    """Delivers frames, then 'unplugs' (reads fail), refuses to reopen for a while, then works again."""

    state = {"opens": 0, "unplugged_until": 0.0}

    def open(self):
        if time.monotonic() < self.state["unplugged_until"]:
            raise CameraError("device not found")
        self.state["opens"] += 1
        self.n = 0

    def read(self):
        time.sleep(0.005)
        self.n += 1
        if self.state["opens"] == 1 and self.n > 20:  # first session: unplug after 20 frames
            self.state["unplugged_until"] = time.monotonic() + 1.0
            return None
        return np.zeros((48, 64, 3), np.uint8)

    def close(self):
        pass

    @property
    def actual_resolution(self):
        return (64, 48)


def test_capture_reconnects_after_unplug(monkeypatch):
    monkeypatch.setattr(pipeline, "create_camera", lambda s: FlakyCamera(s))
    monkeypatch.setattr(pipeline.CaptureWorker, "MAX_READ_FAILURES", 5)
    stop = threading.Event()
    slot = pipeline.LatestSlot()
    w = pipeline.CaptureWorker(CameraSettings(camera_id="uvc:0"), slot, stop)
    w.start()
    seen = set()
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        seen.add(w.status)
        if FlakyCamera.state["opens"] >= 2 and w.status == "streaming":
            break
        time.sleep(0.02)
    stop.set()
    w.join(3)
    assert "reconnecting" in seen, seen
    assert FlakyCamera.state["opens"] >= 2, "never reopened"
    assert w.status == "streaming"
