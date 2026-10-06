"""Camera discovery and construction across all supported camera kinds."""

from __future__ import annotations

from .base import CameraError, CameraInfo, CameraSettings, CameraSource
from .uvc import UvcCamera, enumerate_uvc


def list_cameras() -> list[CameraInfo]:
    # Industrial camera kinds get appended here when their drivers are added.
    return enumerate_uvc()


def create_camera(settings: CameraSettings) -> CameraSource:
    kind, _, ref = settings.camera_id.partition(":")
    if kind == "uvc":
        try:
            return UvcCamera(settings, int(ref))
        except ValueError as exc:
            raise CameraError(f"Invalid camera id: {settings.camera_id}") from exc
    raise CameraError(f"Unsupported camera type: {kind}")
