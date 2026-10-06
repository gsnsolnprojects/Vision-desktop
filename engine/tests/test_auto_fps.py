from visionm_engine.cameras import uvc
from visionm_engine.cameras.base import CameraSettings


class FakeCap:
    """Camera that can physically deliver at most `limit` fps."""

    def __init__(self, limit):
        self.limit, self.req = limit, None

    def set(self, prop, value):
        if prop == uvc.cv2.CAP_PROP_FPS:
            self.req = value
        return True


def run(limit, monkeypatch):
    cap = FakeCap(limit)
    monkeypatch.setattr(uvc.UvcCamera, "_measure_fps", staticmethod(lambda c: min(c.req, c.limit)))
    cam = uvc.UvcCamera(CameraSettings(camera_id="uvc:0"), 0)
    fps = cam._pick_auto_fps(cap)
    return cap.req, fps


def test_fast_camera_uses_60(monkeypatch):
    assert run(60, monkeypatch) == (60, 60)


def test_30fps_camera_settles_on_30_request(monkeypatch):
    assert run(30, monkeypatch) == (30, 30)


def test_dim_light_camera_prefers_slower_request(monkeypatch):
    # Can only reach ~20 fps (long exposure): both requests measure 20 -> keep 30 (longer exposure allowed)
    assert run(20, monkeypatch) == (30, 20)


def test_dark_camera_probe_is_time_boxed(monkeypatch):
    """A camera stuck at ~1 fps (dark scene) must not make the auto probe take ~25 s and fail the start."""
    import time as _t

    class SlowCap(FakeCap):
        def read(self):
            _t.sleep(0.5)  # 2 fps
            return True, None

    cam = uvc.UvcCamera(CameraSettings(camera_id="uvc:0"), 0)
    t0 = _t.perf_counter()
    fps = cam._pick_auto_fps(SlowCap(2))
    elapsed = _t.perf_counter() - t0
    assert elapsed < 4.5, elapsed
    assert 1 <= fps <= 3
