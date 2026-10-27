"""TensorRT optimisation for YOLO models ("Fastest" precision).

A TensorRT engine is compiled for one GPU model and one TensorRT version, so engines are cached
per (GPU, TensorRT version) next to the model:  models/<id>/trt/<gpu-slug>__trt<ver>.engine (+ .json).
Building takes a few minutes, so it runs as a background job the UI polls.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


def tensorrt_version() -> str | None:
    try:
        import tensorrt

        return str(tensorrt.__version__)
    except Exception:
        return None


def engine_key(gpu_name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", gpu_name.lower()).strip("-")
    return f"{slug}__trt{tensorrt_version()}"


def engine_paths(model_dir: Path, gpu_name: str) -> tuple[Path, Path]:
    base = model_dir / "trt" / engine_key(gpu_name)
    return base.with_suffix(".engine"), base.with_suffix(".json")


def engine_info(model_dir: Path, gpu_name: str | None) -> dict | None:
    """Info about a ready engine for this GPU, or None."""
    if not gpu_name or tensorrt_version() is None:
        return None
    eng, info = engine_paths(model_dir, gpu_name)
    if not (eng.is_file() and info.is_file()):
        return None
    try:
        return json.loads(info.read_text(encoding="utf-8"))
    except Exception:
        return None


@dataclass
class OptimizeJob:
    id: str
    model_id: str
    gpu_name: str
    status: str = "running"  # running | done | failed
    started_at: float = 0.0
    finished_at: float | None = None
    error: str | None = None

    def to_json(self) -> dict:
        end = self.finished_at or time.time()
        return {
            "id": self.id,
            "modelId": self.model_id,
            "gpuName": self.gpu_name,
            "status": self.status,
            "elapsedS": round(end - self.started_at, 1),
            "error": self.error,
        }


class TensorRtOptimizer:
    def __init__(self) -> None:
        self._jobs: dict[str, OptimizeJob] = {}
        self._lock = threading.Lock()

    def running(self) -> OptimizeJob | None:
        return next((j for j in self._jobs.values() if j.status == "running"), None)

    def job(self, job_id: str) -> OptimizeJob | None:
        return self._jobs.get(job_id)

    def start(self, model_id: str, weights: Path, gpu_index: int, gpu_name: str) -> OptimizeJob:
        if tensorrt_version() is None:
            raise RuntimeError("TensorRT is not installed on this station")
        with self._lock:
            current = self.running()
            if current is not None:
                if current.model_id == model_id:
                    return current
                raise RuntimeError("Another model is being optimised. Wait for it to finish.")
            job = OptimizeJob(id=uuid.uuid4().hex, model_id=model_id, gpu_name=gpu_name, started_at=time.time())
            self._jobs[job.id] = job
        threading.Thread(target=self._build, args=(job, weights, gpu_index), name=f"trt-{model_id}", daemon=True).start()
        return job

    def _build(self, job: OptimizeJob, weights: Path, gpu_index: int) -> None:
        eng_path, info_path = engine_paths(weights.parent, job.gpu_name)
        work = weights.parent / "trt" / f".build-{job.id}"
        try:
            from ultralytics import YOLO

            work.mkdir(parents=True, exist_ok=True)
            src = work / "model.pt"
            shutil.copyfile(weights, src)  # export writes next to the source; keep the model folder clean
            model = YOLO(str(src))
            task = model.task
            t0 = time.time()
            # FP16 engine; imgsz comes from the model's training args, same as PyTorch inference.
            out = Path(model.export(format="engine", half=True, device=gpu_index, verbose=False))
            eng_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = eng_path.with_suffix(".engine.part")
            shutil.move(str(out), tmp)
            tmp.replace(eng_path)
            info_path.write_text(
                json.dumps(
                    {
                        "task": task,
                        "gpuName": job.gpu_name,
                        "tensorrt": tensorrt_version(),
                        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        "buildSeconds": round(time.time() - t0, 1),
                        "sizeBytes": eng_path.stat().st_size,
                    }
                ),
                encoding="utf-8",
            )
            job.status = "done"
            log.info("TensorRT engine for %s built in %.0fs", job.model_id, time.time() - t0)
        except Exception as exc:
            log.exception("TensorRT optimisation failed for %s", job.model_id)
            job.status, job.error = "failed", str(exc)
            eng_path.with_suffix(".engine.part").unlink(missing_ok=True)
        finally:
            job.finished_at = time.time()
            shutil.rmtree(work, ignore_errors=True)
