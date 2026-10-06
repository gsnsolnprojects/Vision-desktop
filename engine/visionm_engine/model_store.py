"""Local model cache: library downloads and manual file imports.

Layout:  <data_dir>/models/<model_id>/{meta.json, <weights file>}
Writes go to a temp file first and are renamed into place, so a crash or a
dropped connection never leaves a half-written model that looks valid.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .core import ModelMeta

log = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".pt", ".pth", ".onnx", ".engine"}


class ModelStoreError(RuntimeError):
    pass


@dataclass
class DownloadJob:
    id: str
    model_id: str
    status: str = "running"  # running | done | failed
    bytes_done: int = 0
    bytes_total: int | None = None
    error: str | None = None

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "modelId": self.model_id,
            "status": self.status,
            "bytesDone": self.bytes_done,
            "bytesTotal": self.bytes_total,
            "error": self.error,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_id(value: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in "-_." else "_" for c in value)
    if not cleaned or cleaned.startswith("."):
        raise ModelStoreError(f"Invalid model id: {value!r}")
    return cleaned


def _names_from_data_yaml(path: Path) -> list[str]:
    """Same parser as VisionBackend detection_output.parse_names_from_data_yaml."""
    names: list[str] = []
    if not path.is_file():
        return names
    in_names = False
    for line in path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not in_names:
            if t.startswith("names:"):
                in_names = True
            continue
        if t.startswith("- "):
            names.append(t[2:].strip())
            continue
        if t and not t.startswith("#") and names:
            break
    return names


class ModelStore:
    def __init__(self, root: Path) -> None:
        self.root = root / "models"
        self.root.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, DownloadJob] = {}
        self._lock = threading.Lock()

    # ---------- queries ----------

    def list(self) -> list[ModelMeta]:
        out = []
        for d in sorted(self.root.iterdir()):
            meta = self._read_meta(d)
            if meta and (d / meta.file_name).is_file():
                out.append(meta)
        out.sort(key=lambda m: m.imported_at or "", reverse=True)
        return out

    def get(self, model_id: str) -> tuple[ModelMeta, Path]:
        d = self.root / _safe_id(model_id)
        meta = self._read_meta(d)
        if not meta or not (d / meta.file_name).is_file():
            raise ModelStoreError(f"Model {model_id} is not on this station")
        return meta, d / meta.file_name

    def update_class_names(self, model_id: str, names: list[str]) -> None:
        d = self.root / _safe_id(model_id)
        meta = self._read_meta(d)
        if meta and names and meta.class_names != names:
            meta.class_names = names
            self._write_meta(d, meta)

    def delete(self, model_id: str) -> None:
        d = self.root / _safe_id(model_id)
        if d.is_dir():
            shutil.rmtree(d)

    # ---------- manual import ----------

    def import_file(self, src: Path, name: str | None = None, model_type: str | None = None) -> ModelMeta:
        if not src.is_file():
            raise ModelStoreError(f"File not found: {src}")
        ext = src.suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            raise ModelStoreError(f"Unsupported model file type {ext}. Use one of: {', '.join(sorted(SUPPORTED_EXTENSIONS))}")
        digest = hashlib.sha256()
        with src.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                digest.update(chunk)
        model_id = f"file_{digest.hexdigest()[:16]}"
        d = self.root / model_id
        d.mkdir(parents=True, exist_ok=True)
        file_name = f"weights{ext}"
        tmp = d / f".{file_name}.part"
        shutil.copyfile(src, tmp)
        tmp.replace(d / file_name)
        class_names = _names_from_data_yaml(src.parent / "data.yaml")
        if not class_names:
            from .detectors import read_class_names

            class_names = read_class_names(d / file_name)
        meta = ModelMeta(
            id=model_id,
            name=name or src.stem,
            model_type=model_type or ("RF_DETR" if ext == ".pth" else "YOLO"),
            file_name=file_name,
            class_names=class_names,
            source="file",
            imported_at=_now(),
            size_bytes=(d / file_name).stat().st_size,
        )
        self._write_meta(d, meta)
        log.info("Imported model %s from %s", model_id, src)
        return meta

    # ---------- library download ----------

    def start_download(self, *, api_base: str, headers: dict[str, str], info: dict) -> DownloadJob:
        backend_id = str(info["modelId"])
        model_id = _safe_id(backend_id)
        with self._lock:
            for job in self._jobs.values():
                if job.model_id == model_id and job.status == "running":
                    return job
            job = DownloadJob(id=uuid.uuid4().hex, model_id=model_id)
            self._jobs[job.id] = job
        threading.Thread(
            target=self._download, args=(job, api_base, headers, info), name=f"download-{model_id}", daemon=True
        ).start()
        return job

    def job(self, job_id: str) -> DownloadJob | None:
        return self._jobs.get(job_id)

    def _download(self, job: DownloadJob, api_base: str, headers: dict[str, str], info: dict) -> None:
        d = self.root / job.model_id
        d.mkdir(parents=True, exist_ok=True)
        model_type = str(info.get("modelType") or "YOLO")
        ext = ".pth" if model_type.upper().replace("-", "_") == "RF_DETR" else ".pt"
        file_name = f"weights{ext}"
        tmp = d / f".{file_name}.part"
        url = f"{api_base.rstrip('/')}/models/{info['modelId']}/download"
        try:
            with httpx.stream("GET", url, params={"format": "pt"}, headers=headers, timeout=httpx.Timeout(30, read=300), follow_redirects=True) as r:
                if r.status_code != 200:
                    body = r.read().decode(errors="replace")[:300]
                    raise ModelStoreError(f"Backend returned {r.status_code}: {body}")
                total = r.headers.get("content-length")
                job.bytes_total = int(total) if total and total.isdigit() else None
                with tmp.open("wb") as f:
                    for chunk in r.iter_bytes(1 << 20):
                        f.write(chunk)
                        job.bytes_done += len(chunk)
            if job.bytes_total is not None and job.bytes_done != job.bytes_total:
                raise ModelStoreError("Download was incomplete")
            tmp.replace(d / file_name)
            meta = ModelMeta(
                id=job.model_id,
                name=str(info.get("name") or info["modelId"]),
                model_type=model_type,
                file_name=file_name,
                class_names=[str(c) for c in info.get("classNames") or []],
                source="library",
                backend_model_id=str(info["modelId"]),
                company=info.get("company"),
                project=info.get("project"),
                project_id=info.get("projectId"),
                model_version=str(info.get("modelVersion")) if info.get("modelVersion") is not None else None,
                metrics=info.get("metrics"),
                imported_at=_now(),
                size_bytes=job.bytes_done,
            )
            self._write_meta(d, meta)
            job.status = "done"
            log.info("Downloaded model %s (%s bytes)", job.model_id, job.bytes_done)
        except Exception as exc:
            log.exception("Model download failed for %s", job.model_id)
            job.status = "failed"
            job.error = str(exc)
            tmp.unlink(missing_ok=True)

    # ---------- meta io ----------

    @staticmethod
    def _read_meta(d: Path) -> ModelMeta | None:
        p = d / "meta.json"
        if not p.is_file():
            return None
        try:
            return ModelMeta(**json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            log.warning("Ignoring unreadable model meta %s", p, exc_info=True)
            return None

    @staticmethod
    def _write_meta(d: Path, meta: ModelMeta) -> None:
        tmp = d / "meta.json.part"
        tmp.write_text(json.dumps(asdict(meta), indent=2), encoding="utf-8")
        tmp.replace(d / "meta.json")


def meta_to_json(meta: ModelMeta) -> dict:
    return {
        "id": meta.id,
        "name": meta.name,
        "modelType": meta.model_type,
        "classNames": meta.class_names,
        "source": meta.source,
        "backendModelId": meta.backend_model_id,
        "company": meta.company,
        "project": meta.project,
        "projectId": meta.project_id,
        "modelVersion": meta.model_version,
        "metrics": meta.metrics,
        "importedAt": meta.imported_at,
        "sizeBytes": meta.size_bytes,
    }
