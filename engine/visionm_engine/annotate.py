"""Draw detections and the verdict onto a frame (used for saved defect snapshots)."""

from __future__ import annotations

import cv2
import numpy as np

from .core import Detection

_GOOD = (94, 197, 34)  # BGR green
_BAD = (68, 68, 239)  # BGR red


def encode_jpeg(image: np.ndarray, quality: int = 85) -> bytes:
    ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return buf.tobytes()


THUMB_WIDTH = 320


def make_thumbnail(image: np.ndarray, quality: int = 80) -> bytes:
    """Small JPEG for report grids and Excel export (keeps aspect ratio)."""
    h, w = image.shape[:2]
    scale = THUMB_WIDTH / w
    small = cv2.resize(image, (THUMB_WIDTH, max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)
    return encode_jpeg(small, quality)


def annotate(image: np.ndarray, detections: list[Detection], good_classes: set[str], verdict: str | None) -> np.ndarray:
    out = image.copy()
    h, w = out.shape[:2]
    scale = max(0.5, min(w, h) / 720)
    thickness = max(2, int(2 * scale))
    font_scale = 0.6 * scale

    for d in detections:
        color = _GOOD if d.cls in good_classes else _BAD
        if d.polygon:
            pts = np.array(d.polygon, dtype=np.int32).reshape(-1, 1, 2)
            overlay = out.copy()
            cv2.fillPoly(overlay, [pts], color)
            cv2.addWeighted(overlay, 0.25, out, 0.75, 0, out)
            cv2.polylines(out, [pts], True, color, thickness)
        x1, y1, x2, y2 = (int(round(v)) for v in d.bbox)
        cv2.rectangle(out, (x1, y1), (x2, y2), color, thickness)
        label = f"{d.cls} {d.confidence * 100:.0f}%"
        (tw, th), base = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, 1)
        ty = max(y1, th + base + 4)
        cv2.rectangle(out, (x1, ty - th - base - 4), (x1 + tw + 6, ty), color, -1)
        cv2.putText(out, label, (x1 + 3, ty - base - 2), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), 1, cv2.LINE_AA)

    if verdict:
        text = verdict.replace("_", " ")
        color = _BAD if verdict == "NOT_OK" else _GOOD if verdict == "OK" else (120, 120, 120)
        fs = 1.0 * scale
        (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, fs, 2)
        cv2.rectangle(out, (10, 10), (10 + tw + 20, 10 + th + base + 16), color, -1)
        cv2.putText(out, text, (20, 10 + th + 8), cv2.FONT_HERSHEY_SIMPLEX, fs, (255, 255, 255), 2, cv2.LINE_AA)
    return out
