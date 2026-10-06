"""Core data types shared across the engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

Verdict = Literal["NO_PRODUCT", "OK", "NOT_OK"]


@dataclass(slots=True)
class Detection:
    """One model detection in original-image pixel coordinates."""

    cls: str
    confidence: float
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2
    polygon: list[tuple[float, float]] | None = None

    def to_json(self) -> dict:
        out: dict = {
            "class": self.cls,
            "confidence": round(self.confidence, 4),
            "bbox": [round(v, 1) for v in self.bbox],
        }
        if self.polygon:
            out["polygon"] = [[round(x, 1), round(y, 1)] for x, y in self.polygon]
        return out


@dataclass(slots=True)
class Frame:
    """A captured camera frame (BGR) with capture metadata."""

    image: np.ndarray
    seq: int
    captured_at: float  # time.monotonic()
    wall_time: float  # time.time()

    @property
    def width(self) -> int:
        return int(self.image.shape[1])

    @property
    def height(self) -> int:
        return int(self.image.shape[0])


@dataclass(slots=True)
class ModelMeta:
    """Metadata stored next to every cached model file."""

    id: str  # local id (backend modelId, or "local_<hash>" for file imports)
    name: str
    model_type: str  # e.g. YOLOv8, YOLO11, RF_DETR
    file_name: str
    class_names: list[str] = field(default_factory=list)
    source: Literal["library", "file"] = "library"
    backend_model_id: str | None = None
    company: str | None = None
    project: str | None = None
    project_id: str | None = None
    model_version: str | None = None
    metrics: dict | None = None
    imported_at: str | None = None
    size_bytes: int = 0
