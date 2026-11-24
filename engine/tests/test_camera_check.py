import numpy as np

from visionm_engine import camera_check
from visionm_engine.cameras import CameraError, CameraSettings, CameraSource


class FakeCam(CameraSource):
    def __init__(self, settings, res, frame, fail=False):
        super().__init__(settings)
        self._res, self._frame, self._fail = res, frame, fail
        self.actual_format = "YUY2"

    def open(self):
        if self._fail:
            raise CameraError("Could not open camera 1")

    def read(self):
        return self._frame

    def close(self):
        pass

    @property
    def actual_resolution(self):
        return self._res


def textured(w, h, level=128):
    rng = np.random.default_rng(0)
    img = np.full((h, w, 3), level, np.uint8)
    img[::8, :, :] = 255  # strong edges -> sharp
    return np.clip(img.astype(int) + rng.integers(-5, 5, img.shape), 0, 255).astype(np.uint8)


def run(monkeypatch, res, frame, req=(1920, 1200), name="Arducam B0495 (USB3 2.3MP)", fail=False):
    monkeypatch.setattr(camera_check, "MEASURE_S", 0.2)
    monkeypatch.setattr(camera_check, "SETTLE_S", 0.05)
    monkeypatch.setattr(camera_check, "create_camera", lambda s: FakeCam(s, res, frame, fail))
    out = camera_check.check_camera(CameraSettings(camera_id="uvc:1", width=req[0], height=req[1]), name)
    return out, {i["key"]: i for i in out["items"]}


def test_good_camera(monkeypatch):
    out, items = run(monkeypatch, (1920, 1200), textured(1920, 1200))
    assert out["ok"] and out["preview"].startswith("data:image/jpeg;base64,")
    assert items["resolution"]["status"] == "ok" and items["connection"]["value"] == "USB 3"
    assert items["focus"]["status"] == "ok" and items["brightness"]["status"] == "ok"


def test_usb2_fallback_is_an_error(monkeypatch):
    monkeypatch.setattr(FakeCam, "read", lambda self: (__import__("time").sleep(0.1), self._frame)[1])  # ~10 fps
    out, items = run(monkeypatch, (960, 600), textured(960, 600))
    assert not out["ok"]
    assert items["resolution"]["status"] == "error" and "USB 2" in items["resolution"]["tip"]
    assert items["connection"]["value"] == "USB 2 (slow)"


def test_unsupported_size_on_usb3_is_not_called_usb2(monkeypatch):
    out, items = run(monkeypatch, (960, 600), textured(960, 600), req=(1280, 720))  # fast frames = USB 3
    assert items["resolution"]["status"] == "warn" and "doesn't support" in items["resolution"]["tip"]
    assert items["connection"]["value"] == "USB 3"


def test_dark_and_blurry(monkeypatch):
    out, items = run(monkeypatch, (1920, 1200), np.full((1200, 1920, 3), 10, np.uint8))
    assert items["brightness"]["status"] == "warn" and items["focus"]["status"] == "warn"


def test_unsupported_size_on_normal_webcam_is_a_warning(monkeypatch):
    out, items = run(monkeypatch, (1280, 720), textured(1280, 720), req=(1920, 1200), name="USB Webcam")
    assert items["resolution"]["status"] == "warn" and "connection" not in items


def test_camera_not_opening(monkeypatch):
    out, items = run(monkeypatch, (0, 0), None, fail=True)
    assert not out["ok"] and items["detected"]["status"] == "error"


def test_resolve_camera_id_follows_name_when_numbers_shift(monkeypatch):
    from visionm_engine.cameras import CameraInfo, registry

    cams = [CameraInfo("uvc:0", "uvc", "Arducam B0495 (USB3 2.3MP)", 0), CameraInfo("uvc:1", "uvc", "Phone Virtual Camera", 1)]
    monkeypatch.setattr(registry, "list_cameras", lambda: cams)
    assert registry.resolve_camera_id("uvc:1", "Arducam B0495 (USB3 2.3MP)") == "uvc:0"  # moved
    assert registry.resolve_camera_id("uvc:0", "Arducam B0495 (USB3 2.3MP)") == "uvc:0"  # unchanged
    assert registry.resolve_camera_id("uvc:1", "Unplugged Camera") == "uvc:1"  # not found: keep
    assert registry.resolve_camera_id("uvc:1", None) == "uvc:1"
