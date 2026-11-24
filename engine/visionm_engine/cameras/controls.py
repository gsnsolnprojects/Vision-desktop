"""USB (UVC) camera image controls on Windows: exposure, gain, white balance, brightness, ...

Uses the DirectShow interfaces every UVC driver implements (IAMVideoProcAmp / IAMCameraControl).
Values live in the camera itself, so they can be changed while it is streaming (live preview) and
they persist until changed again. Only controls the camera reports a range for are exposed.
"""

from __future__ import annotations

import logging
import sys
from ctypes import POINTER, c_long

log = logging.getLogger(__name__)

_FLAG_AUTO = 0x1
_FLAG_MANUAL = 0x2

# key, label, interface, property id (DirectShow VideoProcAmpProperty / CameraControlProperty)
CONTROLS: list[tuple[str, str, str, int]] = [
    ("exposure", "Exposure", "cam", 4),
    ("gain", "Gain", "amp", 9),
    ("white_balance", "White balance", "amp", 7),
    ("brightness", "Brightness", "amp", 0),
    ("contrast", "Contrast", "amp", 1),
    ("saturation", "Saturation", "amp", 3),
    ("hue", "Hue", "amp", 2),
    ("sharpness", "Sharpness", "amp", 4),
    ("gamma", "Gamma", "amp", 5),
    ("backlight_compensation", "Backlight compensation", "amp", 8),
    ("powerline_frequency", "Anti-flicker (power line)", "amp", 10),
    ("focus", "Focus", "cam", 6),
    ("zoom", "Zoom", "cam", 3),
    ("iris", "Iris", "cam", 5),
    ("pan", "Pan", "cam", 0),
    ("tilt", "Tilt", "cam", 1),
    ("roll", "Roll", "cam", 2),
]
_BY_KEY = {c[0]: c for c in CONTROLS}


class ControlsUnavailable(RuntimeError):
    pass


def _interfaces():
    import comtypes
    from comtypes import COMMETHOD, GUID, HRESULT, IUnknown

    methods = [
        COMMETHOD([], HRESULT, "GetRange", (["in"], c_long, "Property"), (["out"], POINTER(c_long), "pMin"),
                  (["out"], POINTER(c_long), "pMax"), (["out"], POINTER(c_long), "pStep"),
                  (["out"], POINTER(c_long), "pDefault"), (["out"], POINTER(c_long), "pCaps")),
        COMMETHOD([], HRESULT, "Set", (["in"], c_long, "Property"), (["in"], c_long, "lValue"), (["in"], c_long, "Flags")),
        COMMETHOD([], HRESULT, "Get", (["in"], c_long, "Property"), (["out"], POINTER(c_long), "lValue"), (["out"], POINTER(c_long), "Flags")),
    ]

    class IAMVideoProcAmp(IUnknown):
        _iid_ = GUID("{C6E13360-30AC-11d0-A18C-00A0C9118956}")
        _methods_ = methods

    class IAMCameraControl(IUnknown):
        _iid_ = GUID("{C6E13370-30AC-11d0-A18C-00A0C9118956}")
        _methods_ = methods

    return comtypes, IAMVideoProcAmp, IAMCameraControl


_IFACES = None


class _Device:
    """Short-lived handle on the camera's control interfaces (COM must be initialised on this thread)."""

    def __init__(self, index: int) -> None:
        global _IFACES
        from pygrabber.dshow_graph import FilterGraph

        if _IFACES is None:
            _IFACES = _interfaces()
        _, amp_t, cam_t = _IFACES
        names = FilterGraph().get_input_devices()
        if not 0 <= index < len(names):
            raise ControlsUnavailable(f"Camera {index} not found")
        self._graph = FilterGraph()
        self._graph.add_video_input_device(index)
        flt = self._graph.get_input_device().instance
        self.ifaces = {}
        for key, t in (("amp", amp_t), ("cam", cam_t)):
            try:
                self.ifaces[key] = flt.QueryInterface(t)
            except Exception:
                pass

    def describe(self, key: str) -> dict | None:
        _, label, iface, prop = _BY_KEY[key]
        i = self.ifaces.get(iface)
        if i is None:
            return None
        try:
            mn, mx, step, default, caps = i.GetRange(prop)
            value, flags = i.Get(prop)
        except Exception:
            return None  # not supported by this camera
        if mx <= mn:
            return None
        return {
            "key": key,
            "label": label,
            "min": int(mn),
            "max": int(mx),
            "step": max(1, int(step)),
            "default": int(default),
            "value": int(value),
            "auto": bool(flags & _FLAG_AUTO),
            "autoSupported": bool(caps & _FLAG_AUTO),
        }

    def set(self, key: str, value: int, auto: bool) -> None:
        _, _, iface, prop = _BY_KEY[key]
        self.ifaces[iface].Set(prop, int(value), _FLAG_AUTO if auto else _FLAG_MANUAL)


def _with_device(index: int, fn):
    if sys.platform != "win32":
        raise ControlsUnavailable("Camera controls are only available on Windows")
    try:
        import comtypes  # noqa: F401
        import pygrabber  # noqa: F401
    except ImportError as exc:
        raise ControlsUnavailable("Camera control support is not installed") from exc
    import comtypes

    comtypes.CoInitialize()
    try:
        dev = _Device(index)
        try:
            return fn(dev)
        finally:
            del dev
    finally:
        comtypes.CoUninitialize()


def list_controls(index: int) -> list[dict]:
    return _with_device(index, lambda dev: [d for d in (dev.describe(k) for k, *_ in CONTROLS) if d])


def defaults_for(controls: list[dict]) -> dict[str, dict]:
    """Camera's own defaults; auto wherever the camera supports it."""
    return {c["key"]: {"value": c["default"], "auto": c["autoSupported"]} for c in controls}


def apply_controls(index: int, values: dict[str, dict]) -> dict:
    """Apply {key: {value, auto}}. Values are clamped/snapped to the camera's range; unknown keys are skipped."""

    def run(dev: _Device) -> dict:
        applied, skipped = [], []
        for key, want in values.items():
            if key not in _BY_KEY:
                skipped.append(key)
                continue
            d = dev.describe(key)
            if d is None:
                skipped.append(key)
                continue
            auto = bool(want.get("auto")) and d["autoSupported"]
            raw = want.get("value")
            value = d["value"] if raw is None else int(raw)
            value = max(d["min"], min(d["max"], value))
            value = d["min"] + round((value - d["min"]) / d["step"]) * d["step"]
            try:
                dev.set(key, value, auto)
                applied.append(key)
            except Exception:
                log.warning("Camera rejected %s=%s (auto=%s)", key, value, auto, exc_info=True)
                skipped.append(key)
        controls = [d for d in (dev.describe(k) for k, *_ in CONTROLS) if d]
        return {"applied": applied, "skipped": skipped, "controls": controls}

    return _with_device(index, run)
