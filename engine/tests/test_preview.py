import json
import struct
import time

import numpy as np

from visionm_engine import pipeline, preview
from visionm_engine.cameras import CameraSettings, CameraSource


class FakeCamera(CameraSource):
    opened = 0
    closed = 0

    def open(self):
        FakeCamera.opened += 1

    def read(self):
        time.sleep(1 / 60)
        img = np.full((1200, 1920, 3), 120, np.uint8)
        img[::10] = 255
        return img

    def close(self):
        FakeCamera.closed += 1

    @property
    def actual_resolution(self):
        return (1920, 1200)


def headers(packets):
    out = []
    for p in packets:
        n = struct.unpack(">I", p[:4])[0]
        out.append(json.loads(p[4 : 4 + n]))
    return out


def test_preview_streams_downscaled_frames_with_focus_metrics(monkeypatch):
    monkeypatch.setattr(pipeline, "create_camera", lambda s: FakeCamera(s))
    packets = []
    p = preview.Preview(CameraSettings(camera_id="uvc:1", width=1920, height=1200), packets.append)
    p.start()
    time.sleep(1.2)
    p.stop()
    hs = headers(packets)
    assert 8 <= len(hs) <= 25, len(hs)  # rate-limited to ~15 fps
    h = hs[-1]
    assert h["type"] == "preview" and h["width"] == preview.PREVIEW_WIDTH and h["sourceWidth"] == 1920
    assert h["sharpness"] > 0 and 100 < h["brightness"] < 200
    assert FakeCamera.closed >= 1  # camera released on stop


def test_preview_stops_itself_when_not_kept_alive(monkeypatch):
    monkeypatch.setattr(pipeline, "create_camera", lambda s: FakeCamera(s))
    monkeypatch.setattr(preview, "IDLE_TIMEOUT_S", 0.5)
    p = preview.Preview(CameraSettings(camera_id="uvc:1"), lambda b: None)
    p.start()
    time.sleep(1.5)
    assert not p.alive
    p.stop()
