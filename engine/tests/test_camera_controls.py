from visionm_engine.cameras import controls


class FakeDevice:
    def __init__(self):
        self.state = {"exposure": (-11, True), "gain": (168, False)}
        self.ranges = {"exposure": (-11, -4, 1, -11, 1), "gain": (168, 1600, 8, 168, 0)}

    def describe(self, key):
        if key not in self.ranges:
            return None
        mn, mx, step, default, caps = self.ranges[key]
        v, auto = self.state[key]
        return {"key": key, "label": key, "min": mn, "max": mx, "step": step, "default": default, "value": v, "auto": auto, "autoSupported": bool(caps & 1)}

    def set(self, key, value, auto):
        self.state[key] = (value, auto)


def test_apply_clamps_snaps_and_skips(monkeypatch):
    dev = FakeDevice()
    monkeypatch.setattr(controls, "_with_device", lambda index, fn: fn(dev))
    r = controls.apply_controls(0, {
        "exposure": {"value": -2, "auto": False},   # above max -> clamped to -4
        "gain": {"value": 175, "auto": True},       # snapped to step 8; auto not supported -> manual
        "focus": {"value": 10, "auto": False},      # camera has no focus -> skipped
        "nonsense": {"value": 1},
    })
    assert dev.state["exposure"] == (-4, False)
    assert dev.state["gain"] == (176, False)
    assert sorted(r["skipped"]) == ["focus", "nonsense"]


def test_defaults_prefer_auto_where_supported():
    ctl = [
        {"key": "exposure", "default": -11, "autoSupported": True},
        {"key": "gain", "default": 168, "autoSupported": False},
    ]
    assert controls.defaults_for(ctl) == {"exposure": {"value": -11, "auto": True}, "gain": {"value": 168, "auto": False}}
