"""Model runtimes.

Each detector mirrors how VisionBackend's live scripts call the model
(inference-scripts/process_frame_stream*.py) so predictions match the web app;
the only difference is that the model runs on the station's local GPU.
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np

from .core import Detection, ModelMeta

log = logging.getLogger(__name__)


class DetectorError(RuntimeError):
    pass


def cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def gpu_name() -> str | None:
    try:
        import torch

        return torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:
        return None


class Detector(ABC):
    def __init__(self, meta: ModelMeta, path: Path, precision: str, device: str) -> None:
        self.meta = meta
        self.path = path
        self.precision = precision
        self.device = device
        self.class_names: list[str] = list(meta.class_names)

    @abstractmethod
    def load(self) -> None: ...

    @abstractmethod
    def predict(self, image_bgr: np.ndarray, conf: float) -> list[Detection]: ...

    def warmup(self, width: int = 640, height: int = 480, runs: int = 3) -> float:
        """Run a few dummy inferences so CUDA kernels are compiled before the first real frame."""
        dummy = np.zeros((height, width, 3), dtype=np.uint8)
        t0 = time.perf_counter()
        for _ in range(runs):
            self.predict(dummy, 0.5)
        return (time.perf_counter() - t0) / runs * 1000


class YoloDetector(Detector):
    """Ultralytics YOLO (detection + segmentation). Also accepts .onnx / .engine exports."""

    def load(self) -> None:
        try:
            from ultralytics import YOLO
        except ImportError as exc:
            raise DetectorError("ultralytics is not installed") from exc
        try:
            self._model = YOLO(str(self.path))
        except Exception as exc:
            raise DetectorError(f"Failed to load YOLO model: {exc}") from exc
        names = getattr(self._model, "names", None)
        if isinstance(names, dict) and names:
            self.class_names = [str(names[k]) for k in sorted(names)]
        # FP16 is only valid on CUDA and only for PyTorch weights.
        self._half = self.precision == "fp16" and self.device.startswith("cuda") and self.path.suffix == ".pt"

    def predict(self, image_bgr: np.ndarray, conf: float) -> list[Detection]:
        results = self._model.predict(
            source=image_bgr,
            conf=conf,
            device=self.device,
            half=self._half,
            save=False,
            verbose=False,
        )
        if not results:
            return []
        result = results[0]
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            return []
        names = result.names or {}
        xyxy = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        cls_ids = boxes.cls.cpu().numpy().astype(int)
        polygons = None
        if getattr(result, "masks", None) is not None and getattr(result.masks, "xy", None) is not None:
            polygons = result.masks.xy
        out: list[Detection] = []
        for i in range(len(xyxy)):
            cid = int(cls_ids[i])
            poly = None
            if polygons is not None and i < len(polygons) and len(polygons[i]) > 0:
                poly = [(float(x), float(y)) for x, y in polygons[i]]
            out.append(
                Detection(
                    cls=str(names.get(cid, f"class_{cid}")),
                    confidence=float(confs[i]),
                    bbox=tuple(float(v) for v in xyxy[i]),  # type: ignore[arg-type]
                    polygon=poly,
                )
            )
        return out


class RfdetrDetector(Detector):
    """RF-DETR Nano, loaded exactly like process_frame_stream_rfdetr.py."""

    def load(self) -> None:
        try:
            from rfdetr import RFDETRNano
        except ImportError as exc:
            raise DetectorError("rfdetr is not installed") from exc
        try:
            self._model = RFDETRNano(pretrain_weights=str(self.path), device=self.device)
        except Exception as exc:
            raise DetectorError(f"Failed to load RF-DETR model: {exc}") from exc
        # Traces the model once for much faster inference; fp32 keeps predictions identical to the backend.
        if hasattr(self._model, "optimize_for_inference"):
            try:
                import torch

                dtype = torch.float16 if self.precision == "fp16" and self.device.startswith("cuda") else torch.float32
                self._model.optimize_for_inference(dtype=dtype)
            except Exception:
                log.warning("RF-DETR inference optimisation unavailable; running unoptimised", exc_info=True)

    def predict(self, image_bgr: np.ndarray, conf: float) -> list[Detection]:
        from PIL import Image

        rgb = image_bgr[:, :, ::-1]
        dets = self._model.predict(Image.fromarray(np.ascontiguousarray(rgb)), threshold=conf)
        if dets is None or len(dets) == 0:
            return []
        out: list[Detection] = []
        for i in range(len(dets)):
            cid = int(dets.class_id[i]) if dets.class_id is not None else 0
            label = self.class_names[cid] if 0 <= cid < len(self.class_names) else f"class_{cid}"
            box = dets.xyxy[i]
            out.append(
                Detection(
                    cls=label,
                    confidence=float(dets.confidence[i]) if dets.confidence is not None else 0.0,
                    bbox=(float(box[0]), float(box[1]), float(box[2]), float(box[3])),
                )
            )
        return out


def create_detector(meta: ModelMeta, path: Path, precision: str = "fp32", device: str = "cuda:0") -> Detector:
    is_rfdetr = meta.model_type.upper().replace("-", "_") == "RF_DETR" or path.suffix == ".pth"
    cls = RfdetrDetector if is_rfdetr else YoloDetector
    det = cls(meta, path, precision, device)
    det.load()
    return det


def read_class_names(path: Path) -> list[str]:
    """Best-effort class names from a YOLO weights file (CPU load, no GPU needed)."""
    if path.suffix not in (".pt", ".onnx"):
        return []
    try:
        from ultralytics import YOLO

        names = YOLO(str(path)).names
        return [str(names[k]) for k in sorted(names)] if isinstance(names, dict) else []
    except Exception:
        log.warning("Could not read class names from %s", path, exc_info=True)
        return []


def preload_runtime() -> None:
    """Import torch/ultralytics and initialise CUDA in the background so the first model load is fast."""
    t0 = time.perf_counter()
    try:
        import torch

        if torch.cuda.is_available():
            torch.zeros(1, device="cuda")
        import ultralytics  # noqa: F401

        log.info("Runtime preloaded in %.1fs (CUDA: %s)", time.perf_counter() - t0, torch.cuda.is_available())
    except Exception:
        log.warning("Runtime preload failed", exc_info=True)
