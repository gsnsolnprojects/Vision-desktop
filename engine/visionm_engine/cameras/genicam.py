"""Industrial cameras through GenICam / GenTL (Basler, Hikvision, IDS, Baumer, FLIR, ...).

Each vendor's SDK installs a GenTL producer (.cti file). We find producers through the standard
GENICAM_GENTL64_PATH variable (set by the vendor installers) and talk to every camera through the
`harvesters` library, so one code path covers all GenICam vendors.

NOTE: written against the GenICam/GenTL standard but not yet tested on real industrial hardware.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

import cv2
import numpy as np

from .base import CameraError, CameraInfo, CameraSettings, CameraSource

log = logging.getLogger(__name__)

_lock = threading.RLock()
_harvester = None
_loaded_ctis: tuple[str, ...] = ()


def producer_files() -> list[str]:
    """All GenTL producers (.cti) advertised on this PC."""
    files: list[str] = []
    for env in ("GENICAM_GENTL64_PATH", "GENICAM_GENTL32_PATH"):
        for d in os.environ.get(env, "").split(os.pathsep):
            p = Path(d.strip())
            if p.is_dir():
                files += [str(f) for f in sorted(p.glob("*.cti"))]
            elif p.suffix.lower() == ".cti" and p.is_file():
                files.append(str(p))
    return list(dict.fromkeys(files))


def _get_harvester():
    """One shared Harvester per process (GenTL producers don't like being loaded twice)."""
    global _harvester, _loaded_ctis
    ctis = tuple(producer_files())
    if not ctis:
        return None
    try:
        from harvesters.core import Harvester
    except ImportError:
        log.info("GenTL producers found but the 'harvesters' package is missing")
        return None
    with _lock:
        if _harvester is None or ctis != _loaded_ctis:
            if _harvester is not None:
                _harvester.reset()
            h = Harvester()
            for cti in ctis:
                try:
                    h.add_file(cti)
                except Exception:
                    log.warning("Could not load GenTL producer %s", cti, exc_info=True)
            _harvester, _loaded_ctis = h, ctis
        _harvester.update()
        return _harvester


def enumerate_genicam() -> list[CameraInfo]:
    with _lock:
        h = _get_harvester()
        if h is None:
            return []
        out = []
        for info in h.device_info_list:
            serial = str(getattr(info, "serial_number", "") or getattr(info, "id_", ""))
            vendor = str(getattr(info, "vendor", "") or "")
            model = str(getattr(info, "model", "") or "Camera")
            if serial:
                out.append(CameraInfo(id=f"genicam:{serial}", kind="genicam", name=f"{vendor} {model} ({serial})".strip()))
        return out


# GenICam Bayer name (first-row order) -> OpenCV conversion. The *RGGB-style constants name the
# full 2x2 tile, matching GenICam; the older BayerRG2BGR names are offset by a row and swap colours.
_BAYER = {
    "BayerRG8": cv2.COLOR_BayerRGGB2BGR,
    "BayerGR8": cv2.COLOR_BayerGRBG2BGR,
    "BayerBG8": cv2.COLOR_BayerBGGR2BGR,
    "BayerGB8": cv2.COLOR_BayerGBRG2BGR,
}


def to_bgr(data: np.ndarray, width: int, height: int, pixel_format: str) -> np.ndarray:
    """Convert a raw GenICam buffer to an OpenCV BGR image."""
    if pixel_format in ("BGR8", "BGR8Packed"):
        return data.reshape(height, width, 3).copy()
    if pixel_format in ("RGB8", "RGB8Packed"):
        return cv2.cvtColor(data.reshape(height, width, 3), cv2.COLOR_RGB2BGR)
    if pixel_format == "Mono8":
        return cv2.cvtColor(data.reshape(height, width), cv2.COLOR_GRAY2BGR)
    if pixel_format in _BAYER:
        return cv2.cvtColor(data.reshape(height, width), _BAYER[pixel_format])
    raise CameraError(f"Unsupported pixel format {pixel_format}. Set the camera to BGR8, RGB8, Mono8 or Bayer*8.")


def _set(node_map, name: str, value) -> bool:
    """Set a GenICam feature if the camera has it and it's writable."""
    try:
        node = getattr(node_map, name)
        node.value = value
        return True
    except Exception:
        return False


class GenicamCamera(CameraSource):
    def __init__(self, settings: CameraSettings, serial: str) -> None:
        super().__init__(settings)
        self.serial = serial
        self._ia = None
        self._resolution = (0, 0)

    def open(self) -> None:
        with _lock:
            h = _get_harvester()
            if h is None:
                raise CameraError("No GenICam camera driver (GenTL producer) is installed")
            try:
                ia = h.create({"serial_number": self.serial})
            except Exception as exc:
                raise CameraError(f"Industrial camera {self.serial} not found: {exc}") from exc
        nm = ia.remote_device.node_map
        # Prefer a colour format OpenCV handles directly; fall back to Bayer / mono.
        for fmt in ("BGR8", "RGB8", "BayerRG8", "BayerGR8", "BayerBG8", "BayerGB8", "Mono8"):
            if _set(nm, "PixelFormat", fmt):
                break
        _set(nm, "Width", int(self.settings.width))
        _set(nm, "Height", int(self.settings.height))
        if self.settings.fps > 0:
            _set(nm, "AcquisitionFrameRateEnable", True)
            _set(nm, "AcquisitionFrameRate", float(self.settings.fps))
        else:
            _set(nm, "AcquisitionFrameRateEnable", False)  # auto: as fast as exposure/bandwidth allow
        # Keep only the newest frame so inference never processes stale images.
        try:
            ia.num_buffers = 2
            ia.keep_latest = True
        except Exception:
            pass
        ia.start()
        self._ia = ia
        frame = self.read()
        if frame is None:
            self.close()
            raise CameraError(f"Industrial camera {self.serial} opened but returned no frames")
        self._resolution = (int(frame.shape[1]), int(frame.shape[0]))
        log.info("Opened GenICam camera %s at %sx%s", self.serial, *self._resolution)

    def read(self) -> np.ndarray | None:
        if self._ia is None:
            return None
        try:
            with self._ia.fetch(timeout=2.0) as buffer:
                comp = buffer.payload.components[0]
                return to_bgr(np.asarray(comp.data), int(comp.width), int(comp.height), str(comp.data_format))
        except CameraError:
            raise
        except Exception:
            return None  # timeout / dropped frame: the capture worker counts failures and reconnects

    def close(self) -> None:
        ia, self._ia = self._ia, None
        if ia is not None:
            try:
                ia.stop()
            finally:
                ia.destroy()

    @property
    def actual_resolution(self) -> tuple[int, int]:
        return self._resolution
