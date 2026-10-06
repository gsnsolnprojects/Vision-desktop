"""Real Run pipeline (threads, verdict, defect snapshots, store, report) with a fake camera + detector."""

import time

import numpy as np

from visionm_engine import pipeline
from visionm_engine.cameras import CameraSettings, CameraSource
from visionm_engine.core import Detection, ModelMeta
from visionm_engine.exporter import build_run_report
from visionm_engine.run_store import RunStore

W, H = 640, 480
CENTER = (280.0, 200.0, 360.0, 280.0)


class FakeCamera(CameraSource):
    def open(self):
        self.n = 0

    def read(self):
        time.sleep(1 / 120)
        self.n += 1
        return np.full((H, W, 3), self.n % 255, np.uint8)

    def close(self):
        pass

    @property
    def actual_resolution(self):
        return (W, H)


class ScriptedDetector:
    """Product passes: good one, bad one, then empty belt — repeated."""

    meta = ModelMeta(id="m", name="m", model_type="YOLO", file_name="x")

    def __init__(self):
        self.calls = 0

    def predict(self, image, conf):
        self.calls += 1
        phase = (self.calls // 15) % 3
        if phase == 0:
            return [Detection("product", 0.9, CENTER)]
        if phase == 1:
            return [Detection("product", 0.9, CENTER), Detection("dent", 0.8, CENTER)]
        return []


def test_run_counts_products_and_logs_defects(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "create_camera", lambda s: FakeCamera(s))
    store = RunStore(tmp_path)
    run_id = store.create_run(model={"id": "m", "name": "m"}, user=None, camera_name="fake", config={"live": {"goodClasses": ["product"]}}, sync=False)
    frames, defects = [], []
    run = pipeline.Run(
        run_id=run_id,
        detector=ScriptedDetector(),  # type: ignore[arg-type]
        camera=CameraSettings(camera_id="uvc:0"),
        live={"confidence": 0.25, "good_classes": ["product"], "verdict_enabled": True, "defect_logging_enabled": True, "center_guide_enabled": True, "center_guide_percent": 40},
        store=store,
        publish_frame=frames.append,
        on_defect=defects.append,
        stream_quality=70,
        config_for_store={"live": {"goodClasses": ["product"]}},
    )
    run.start()
    time.sleep(2.0)
    analytics = run.stop()

    assert frames, "no frames published"
    assert analytics["totalProducts"] >= 2
    assert analytics["badProducts"] >= 1
    assert defects and defects[0]["defectClasses"] == ["dent"]
    saved = store.list_defects(run_id)
    assert len(saved) == len(defects)
    assert store.defect_image_path(run_id, saved[0]["id"]).read_bytes()[:2] == b"\xff\xd8"
    rec = store.get_run(run_id)
    assert rec["status"] == "completed" and rec["stats"]["framesInferred"] > 50
    assert build_run_report(store, run_id)[:2] == b"PK"
