"""GenICam support without hardware: discovery degrades gracefully, pixel formats convert correctly."""
import numpy as np
import pytest

from visionm_engine.cameras import CameraError, CameraSettings, create_camera, list_cameras
from visionm_engine.cameras import genicam


def test_no_producers_means_no_industrial_cameras(monkeypatch):
    monkeypatch.delenv("GENICAM_GENTL64_PATH", raising=False)
    monkeypatch.delenv("GENICAM_GENTL32_PATH", raising=False)
    assert genicam.enumerate_genicam() == []
    list_cameras()  # webcams still listed, no crash


def test_create_genicam_camera_without_driver_fails_cleanly(monkeypatch):
    monkeypatch.delenv("GENICAM_GENTL64_PATH", raising=False)
    cam = create_camera(CameraSettings(camera_id="genicam:12345"))
    with pytest.raises(CameraError, match="No GenICam camera driver"):
        cam.open()


# Where the red photosite sits in the 2x2 tile for each GenICam Bayer format (row, col).
RED_SITE = {"BayerRG8": (0, 0), "BayerGR8": (0, 1), "BayerGB8": (1, 0), "BayerBG8": (1, 1)}


@pytest.mark.parametrize("fmt", sorted(RED_SITE))
def test_bayer_red_scene_stays_red(fmt):
    """A pure red scene seen through each Bayer pattern must come out red, not blue."""
    raw = np.zeros((8, 8), np.uint8)
    r, c = RED_SITE[fmt]
    raw[r::2, c::2] = 200
    b, g, red = genicam.to_bgr(raw.reshape(-1), 8, 8, fmt)[4, 4]
    assert red > 150 and b < 50 and g < 50, (fmt, b, g, red)


def test_rgb_and_mono_formats():
    rgb = np.zeros((2, 2, 3), np.uint8); rgb[..., 0] = 255  # pure red in RGB
    assert tuple(genicam.to_bgr(rgb.reshape(-1), 2, 2, "RGB8")[0, 0]) == (0, 0, 255)
    mono = np.full((2, 2), 77, np.uint8)
    assert tuple(genicam.to_bgr(mono.reshape(-1), 2, 2, "Mono8")[0, 0]) == (77, 77, 77)
    with pytest.raises(CameraError):
        genicam.to_bgr(mono.reshape(-1), 2, 2, "YUV422")
