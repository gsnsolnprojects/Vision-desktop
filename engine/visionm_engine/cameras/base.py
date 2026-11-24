"""Camera source interface.

Every camera type (USB/UVC webcams today; GenICam/GigE industrial cameras later)
implements `CameraSource`. The capture worker only talks to this interface, so
adding a new camera type means adding one class and registering it in
`registry.py` — nothing else in the pipeline changes.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np


@dataclass(slots=True)
class CameraInfo:
    id: str  # stable id used by the UI, e.g. "uvc:0"
    kind: str  # "uvc", later "genicam", ...
    name: str
    index: int | None = None


@dataclass(slots=True)
class CameraSettings:
    camera_id: str
    width: int = 1280
    height: int = 720
    fps: int = 0  # 0 = auto: the fastest rate the camera really sustains
    # "auto": compressed MJPG when the camera offers it (USB 2 webcams need it for speed),
    # otherwise the camera's own format (e.g. uncompressed YUY2 on USB 3 cameras).
    pixel_format: str = "auto"  # auto | mjpg | yuy2
    # Image controls to apply when the camera opens: {key: {"value": int | None, "auto": bool}}.
    # None = leave the camera as it is.
    controls: dict | None = None


class CameraError(RuntimeError):
    pass


class CameraSource(ABC):
    def __init__(self, settings: CameraSettings) -> None:
        self.settings = settings
        # Filled in by open(): what the device really delivers, and a warning if it is less than asked for.
        self.actual_format: str | None = None
        self.warning: str | None = None

    @abstractmethod
    def open(self) -> None:
        """Open the device. Raises CameraError on failure."""

    @abstractmethod
    def read(self) -> np.ndarray | None:
        """Block until the next frame (BGR uint8) is available. Returns None on a read failure."""

    @abstractmethod
    def close(self) -> None:
        """Release the device. Must be safe to call more than once."""

    @property
    @abstractmethod
    def actual_resolution(self) -> tuple[int, int]:
        """Resolution the device actually delivers (may differ from what was requested)."""
