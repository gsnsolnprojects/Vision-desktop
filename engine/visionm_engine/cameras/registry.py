"""Camera discovery and construction across all supported camera kinds."""

from __future__ import annotations

import logging

from .base import CameraError, CameraInfo, CameraSettings, CameraSource
from .genicam import GenicamCamera, enumerate_genicam
from .uvc import UvcCamera, enumerate_uvc, list_uvc_modes

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


def camera_controls(camera_id: str) -> list[dict] | None:
    """Image controls (exposure, gain, ...) this camera supports, or None if its type can't report them."""
    kind, _, ref = camera_id.partition(":")
    if kind == "uvc" and ref.isdigit():
        from .controls import ControlsUnavailable, list_controls

        try:
            return list_controls(int(ref))
        except ControlsUnavailable:
            return None
    return None


def apply_camera_controls(camera_id: str, values: dict) -> dict:
    kind, _, ref = camera_id.partition(":")
    if kind == "uvc" and ref.isdigit():
        from .controls import apply_controls

        return apply_controls(int(ref), values)
    raise CameraError("This camera type does not support image controls yet")


def camera_modes(camera_id: str, name: str | None = None) -> list[dict] | None:
    """Supported sizes / top frame rates, or None if this camera type can't report them."""
    kind, _, ref = camera_id.partition(":")
    if kind == "uvc" and ref.isdigit():
        return list_uvc_modes(int(ref), name)
    return None


def resolve_camera_id(camera_id: str, name: str | None) -> str:
    """Camera numbers shift when cameras are replugged or the PC restarts. If the saved number now
    belongs to a different camera, find the saved camera by name instead."""
    if not name:
        return camera_id
    try:
        cams = list_cameras()
    except Exception:
        return camera_id
    current = next((c for c in cams if c.id == camera_id), None)
    if current is not None and current.name == name:
        return camera_id
    same = [c for c in cams if c.name == name]
    if len(same) == 1:
        if same[0].id != camera_id:
            log.info("Camera %r moved from %s to %s", name, camera_id, same[0].id)
        return same[0].id
    return camera_id
