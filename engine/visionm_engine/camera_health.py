"""Camera picture health: warns when the image is too dark or the camera is too slow.

Both usually mean the same thing on a webcam: in low light auto-exposure stretches each frame
(down to ~1 fps) and the picture goes black. Flags use hold times + hysteresis so a hand passing
in front of the lens doesn't make the warning flicker.
"""

from __future__ import annotations

import cv2
import numpy as np

DARK_ON = 35.0  # mean brightness (0-255) below this ...
DARK_OFF = 45.0  # ... and back above this to clear
SLOW_ON_FPS = 10.0
SLOW_OFF_FPS = 14.0
HOLD_ON_S = 3.0
HOLD_OFF_S = 2.0
SAMPLE_EVERY_S = 0.5


def brightness(image: np.ndarray) -> float:
    """Mean brightness of a tiny downscaled copy (microseconds, not milliseconds)."""
    small = cv2.resize(image, (32, 18), interpolation=cv2.INTER_AREA)
    return float(small.mean())


class _Flag:
    def __init__(self) -> None:
        self.on = False
        self._since: float | None = None

    def update(self, bad: bool, good: bool, now: float) -> bool:
        if not self.on:
            if bad:
                self._since = self._since if self._since is not None else now
                if now - self._since >= HOLD_ON_S:
                    self.on, self._since = True, None
            else:
                self._since = None
        else:
            if good:
                self._since = self._since if self._since is not None else now
                if now - self._since >= HOLD_OFF_S:
                    self.on, self._since = False, None
            else:
                self._since = None
        return self.on


class CameraHealth:
    def __init__(self) -> None:
        self.brightness: float | None = None
        self.fps: float | None = None
        self._dark = _Flag()
        self._slow = _Flag()
        self._last_sample = -1e9

    def due(self, now: float) -> bool:
        return now - self._last_sample >= SAMPLE_EVERY_S

    def update(self, level: float, fps: float | None, now: float) -> None:
        self._last_sample = now
        self.brightness = level
        self.fps = fps
        self._dark.update(level < DARK_ON, level > DARK_OFF, now)
        if fps is not None:
            self._slow.update(fps < SLOW_ON_FPS, fps > SLOW_OFF_FPS, now)

    @property
    def dark(self) -> bool:
        return self._dark.on

    @property
    def slow(self) -> bool:
        return self._slow.on

    def to_json(self) -> dict:
        return {
            "brightness": round(self.brightness, 1) if self.brightness is not None else None,
            "dark": self.dark,
            "slow": self.slow,
        }
