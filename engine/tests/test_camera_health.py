import numpy as np

from visionm_engine.camera_health import CameraHealth, brightness


def feed(h, level, fps, start, seconds, step=0.5):
    t = start
    while t < start + seconds:
        h.update(level, fps, t)
        t += step
    return t


def test_brightness_of_black_and_white():
    assert brightness(np.zeros((720, 1280, 3), np.uint8)) == 0
    assert brightness(np.full((720, 1280, 3), 200, np.uint8)) == 200


def test_dark_needs_to_last_then_clears_with_hysteresis():
    h = CameraHealth()
    t = feed(h, 10, 30, 0, 2.0)
    assert not h.dark  # a hand over the lens for 2 s: no warning
    t = feed(h, 10, 30, t, 2.0)
    assert h.dark
    t = feed(h, 40, 30, t, 5.0)
    assert h.dark  # 40 is between ON (35) and OFF (45): stays on, no flicker
    feed(h, 120, 30, t, 2.5)
    assert not h.dark


def test_slow_camera_flag():
    h = CameraHealth()
    t = feed(h, 120, 3, 0, 4.0)
    assert h.slow and not h.dark
    feed(h, 120, 30, t, 2.5)
    assert not h.slow
