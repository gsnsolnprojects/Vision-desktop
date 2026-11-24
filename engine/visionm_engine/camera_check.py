"""One-click camera check: open the camera briefly with the run's settings and report what it really delivers.

Answers the questions an operator otherwise asks someone else: is it connected, is it on USB 3,
does it give the size and speed I picked, is the picture bright enough, is the lens in focus.
"""

from __future__ import annotations

import base64
import time

import cv2
import numpy as np

from .annotate import encode_jpeg
from .camera_health import DARK_ON, SLOW_ON_FPS, brightness
from .cameras import CameraError, CameraSettings, create_camera

MEASURE_S = 1.5
SETTLE_S = 0.4  # auto-exposure / white balance settle after opening
TOO_BRIGHT = 225.0
# Variance of the Laplacian on a 640px-wide grey centre crop. Scene dependent, so it's a guide:
# compare while turning the lens — higher is sharper.
BLURRY_BELOW = 40.0
SOFT_BELOW = 100.0
PREVIEW_WIDTH = 480


def sharpness(image: np.ndarray) -> float:
    """Focus score of the centre of the frame (where the product is inspected)."""
    h, w = image.shape[:2]
    crop = image[h // 4 : h - h // 4, w // 4 : w - w // 4]
    grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    scale = 640 / grey.shape[1]
    grey = cv2.resize(grey, (640, max(1, int(grey.shape[0] * scale))), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def _item(key: str, label: str, status: str, value: str, tip: str | None = None) -> dict:
    return {"key": key, "label": label, "status": status, "value": value, "tip": tip}


def check_camera(settings: CameraSettings, camera_name: str | None = None) -> dict:
    items: list[dict] = []
    camera = create_camera(settings)
    t_open = time.perf_counter()
    try:
        camera.open()
    except CameraError as exc:
        items.append(
            _item("detected", "Camera", "error", "Not working", f"{exc}. Check the cable, replug the camera, or close other apps using it.")
        )
        return {"ok": False, "items": items, "preview": None}
    except Exception as exc:  # driver errors
        items.append(_item("detected", "Camera", "error", "Not working", str(exc)))
        return {"ok": False, "items": items, "preview": None}

    try:
        open_s = time.perf_counter() - t_open
        items.append(_item("detected", "Camera", "ok", camera_name or settings.camera_id, None))

        settle_until = time.perf_counter() + SETTLE_S
        frame = None
        while time.perf_counter() < settle_until:
            img = camera.read()
            if img is not None:
                frame = img
        got, last = 0, None
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < MEASURE_S:
            img = camera.read()
            if img is not None:
                got += 1
                last = img
        fps = got / max(time.perf_counter() - t0, 1e-6)
        frame = last if last is not None else frame
        if frame is None:
            items.append(_item("frames", "Picture", "error", "No frames", "The camera opened but sent no picture. Replug it."))
            return {"ok": False, "items": items, "preview": None}

        w, h = camera.actual_resolution
        rw, rh = settings.width, settings.height
        usb3_model = "usb3" in (camera_name or "").lower().replace(" ", "")
        # On USB 2 these cameras only offer their smallest mode at ~10 fps; on USB 3 they give
        # full size, or the small mode at high speed.
        on_usb2 = usb3_model and w * h < 1920 * 1080 and fps <= 12
        if (w, h) == (rw, rh):
            items.append(_item("resolution", "Size", "ok", f"{w}×{h}", None))
        elif on_usb2:
            items.append(
                _item(
                    "resolution", "Size", "error", f"{w}×{h} (asked {rw}×{rh})",
                    "This USB 3 camera is running in its slow USB 2 mode. Unplug it and push it firmly into a USB 3 port (blue / SS); try another USB 3 cable if it keeps happening.",
                )
            )
        else:
            items.append(
                _item("resolution", "Size", "warn", f"{w}×{h} (asked {rw}×{rh})", f"This camera doesn't support {rw}×{rh}. Choose a size it supports, e.g. {w}×{h}.")
            )

        if usb3_model:
            items.append(
                _item(
                    "connection", "Connection", "error" if on_usb2 else "ok", "USB 2 (slow)" if on_usb2 else "USB 3",
                    "Replug into a USB 3 port (blue / SS), pushing the plug in fully." if on_usb2 else None,
                )
            )

        target = settings.fps if settings.fps > 0 else None
        fps_txt = f"{fps:.0f} fps" + (f" (asked {target})" if target else " (auto)")
        if fps < SLOW_ON_FPS:
            items.append(_item("fps", "Speed", "error", fps_txt, "Very slow. Usually too little light (the camera lengthens exposure) or a USB 2 connection."))
        elif target and fps < target * 0.8:
            items.append(_item("fps", "Speed", "warn", fps_txt, "Slower than asked. Add light, or pick a lower frame rate / size."))
        else:
            items.append(_item("fps", "Speed", "ok", fps_txt, None))

        fmt = camera.actual_format
        if fmt:
            label = {"YUY2": "YUY2 (uncompressed)", "MJPG": "MJPG (compressed)"}.get(fmt, fmt)
            items.append(_item("format", "Format", "ok", label, None))

        level = brightness(frame)
        if level < DARK_ON:
            items.append(_item("brightness", "Brightness", "warn", f"{level:.0f}/255 — too dark", "Add light on the product, or check the lens cap is off."))
        elif level > TOO_BRIGHT:
            items.append(_item("brightness", "Brightness", "warn", f"{level:.0f}/255 — too bright", "Reduce direct light or glare on the product."))
        else:
            items.append(_item("brightness", "Brightness", "ok", f"{level:.0f}/255", None))

        sharp = sharpness(frame)
        if sharp < BLURRY_BELOW:
            items.append(_item("focus", "Focus", "warn", f"{sharp:.0f} — blurry", "Turn the lens slowly (anticlockwise = closer) until this number is as high as it goes. Put a product or printed label in view first."))
        elif sharp < SOFT_BELOW:
            items.append(_item("focus", "Focus", "warn", f"{sharp:.0f} — a bit soft", "Turn the lens slowly to raise this number, then lock it."))
        else:
            items.append(_item("focus", "Focus", "ok", f"{sharp:.0f} — sharp", None))

        ph = int(round(frame.shape[0] * PREVIEW_WIDTH / frame.shape[1]))
        preview = cv2.resize(frame, (PREVIEW_WIDTH, max(1, ph)), interpolation=cv2.INTER_AREA)
        preview_b64 = "data:image/jpeg;base64," + base64.b64encode(encode_jpeg(preview, 80)).decode()

        ok = not any(i["status"] == "error" for i in items)
        return {
            "ok": ok,
            "items": items,
            "preview": preview_b64,
            "measured": {"width": w, "height": h, "fps": round(fps, 1), "format": fmt, "brightness": round(level, 1), "sharpness": round(sharp, 1), "openSeconds": round(open_s, 1)},
        }
    finally:
        camera.close()
