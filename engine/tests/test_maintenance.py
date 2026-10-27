from datetime import datetime, timedelta, timezone

from visionm_engine import maintenance as m
from visionm_engine.run_store import RunStore

MODEL = {"id": "m1", "name": "M", "modelType": "YOLO", "backendModelId": "m1"}
JPG = b"\xff\xd8" + b"x" * 5000
THUMB = b"\xff\xd8t"


def ago(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def setup(tmp_path, sync=False):
    s = RunStore(tmp_path)
    rid = s.create_run(model=MODEL, user=None, camera_name="c", config={}, sync=sync)
    old = s.add_defect(rid, ["dent"], JPG, ago(40), thumb=THUMB)
    new = s.add_defect(rid, ["dent"], JPG, ago(1), thumb=THUMB)
    return s, rid, old, new


def test_retention_removes_only_old_images_and_keeps_records(tmp_path):
    s, rid, old, new = setup(tmp_path)
    mt = m.StorageMaintainer(s, tmp_path, uploads_enabled=lambda: False)
    st = mt.cleanup()
    assert st["lastRemoved"] == 1
    d = {x["id"]: x for x in s.list_defects(rid)}
    assert len(d) == 2  # records kept
    assert d[old["id"]]["hasImage"] is False and d[new["id"]]["hasImage"] is True
    assert s.defect_image_path(rid, old["id"]) is None
    assert s.defect_thumb(rid, old["id"]) is None
    assert s.defect_thumb(rid, new["id"]) == THUMB


def test_keep_forever(tmp_path):
    s, rid, *_ = setup(tmp_path)
    mt = m.StorageMaintainer(s, tmp_path, uploads_enabled=lambda: False)
    mt.set_retention(0)
    assert mt.cleanup()["lastRemoved"] == 0


def test_unsynced_snapshots_protected_while_uploads_on(tmp_path):
    s, rid, old, _ = setup(tmp_path, sync=True)
    mt = m.StorageMaintainer(s, tmp_path, uploads_enabled=lambda: True)
    assert mt.cleanup()["lastRemoved"] == 0  # waiting to upload -> kept
    s.mark_defect_synced(old["id"])
    assert mt.cleanup()["lastRemoved"] == 1


def test_low_disk_removes_oldest_first(tmp_path, monkeypatch):
    s, rid, old, new = setup(tmp_path)
    mt = m.StorageMaintainer(s, tmp_path, uploads_enabled=lambda: False)
    mt.set_retention(0)
    free = {"v": 1 * m.GB}
    monkeypatch.setattr(mt, "free_bytes", lambda: free["v"])
    orig = s.remove_snapshots

    def remove(rows):
        n = orig(rows)
        free["v"] += 10 * m.GB  # pretend each batch frees enough
        return n

    monkeypatch.setattr(s, "remove_snapshots", remove)
    mt.cleanup()
    d = {x["id"]: x["hasImage"] for x in s.list_defects(rid)}
    assert d[old["id"]] is False  # oldest went first


def test_critical_disk_pauses_snapshots_but_logs_defect(tmp_path, monkeypatch):
    s = RunStore(tmp_path)
    mt = m.StorageMaintainer(s, tmp_path, uploads_enabled=lambda: False)
    monkeypatch.setattr(mt, "free_bytes", lambda: 100 * 1024**2)
    assert mt.snapshots_allowed() is False
    rid = s.create_run(model=MODEL, user=None, camera_name="c", config={}, sync=False)
    e = s.add_defect(rid, ["dent"], None)
    assert e["hasImage"] is False and s.list_defects(rid)[0]["defectClasses"] == ["dent"]
