"""Camera discovery and construction across all supported camera kinds."""

from __future__ import annotations

import logging

from .base import CameraError, CameraInfo, CameraSettings, CameraSource
from .genicam import GenicamCamera, enumerate_genicam
from .uvc import UvcCamera, enumerate_uvc

log = logging.getLogger(__name__)


def list_cameras() -> list[CameraInfo]:
    cams = enumerate_uvc()
    try:
        cams += enumerate_genicam()  # empty unless an industrial camera driver (GenTL producer) is installed
    except Exception:
        log.warning("Industrial camera discovery failed", exc_info=True)
    return cams


def create_camera(settings: CameraSettings) -> CameraSource:
    kind, _, ref = settings.camera_id.partition(":")
    if kind == "uvc":
        try:
            return UvcCamera(settings, int(ref))
        except ValueError as exc:
            raise CameraError(f"Invalid camera id: {settings.camera_id}") from exc
    if kind == "genicam" and ref:
        return GenicamCamera(settings, ref)
    raise CameraError(f"Unsupported camera type: {kind}")
