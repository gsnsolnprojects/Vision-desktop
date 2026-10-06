from visionm_engine.core import Detection
from visionm_engine.verdict import VerdictEngine, VerdictSettings

W, H = 1000, 1000
CENTER = (400.0, 400.0, 600.0, 600.0)  # inside a 40% centre region (300..700)
EDGE = (10.0, 10.0, 200.0, 200.0)


def product(conf=0.9, box=CENTER):
    return Detection("product", conf, box)


def defect(cls="scratch", conf=0.8, box=CENTER):
    return Detection(cls, conf, box)


def engine(**kw):
    return VerdictEngine(VerdictSettings(good_classes=["product"], **kw))


def feed(e, frames):
    return [e.process(f, W, H) for f in frames]


def test_frame_verdicts():
    e = engine()
    assert e.process([], W, H).frame_verdict == "NO_PRODUCT"
    assert e.process([product()], W, H).frame_verdict == "OK"
    assert e.process([product(), defect()], W, H).frame_verdict == "NOT_OK"
    # Thresholds: product needs >= 0.45, defect needs >= 0.35
    assert e.process([product(0.44)], W, H).frame_verdict == "NO_PRODUCT"
    assert e.process([product(), defect(conf=0.34)], W, H).frame_verdict == "OK"


def test_no_good_classes_means_no_product():
    e = VerdictEngine(VerdictSettings(good_classes=[]))
    assert e.process([product()], W, H).frame_verdict == "NO_PRODUCT"


def test_smoothing_needs_votes():
    e = engine()
    outs = feed(e, [[product()]] * 4)
    assert outs[-1].verdict == "NO_PRODUCT"  # only 4 OK votes
    assert feed(e, [[product()]])[-1].verdict == "OK"  # 5th vote flips it
    # Two NOT_OK frames in the window are enough for NOT_OK
    assert feed(e, [[product(), defect()]])[-1].verdict == "OK"
    assert feed(e, [[product(), defect()]])[-1].verdict == "NOT_OK"


def test_counts_one_good_product_per_incident():
    e = engine()
    feed(e, [[product()]] * 10 + [[]] * 10)
    a = e.analytics
    assert (a.total_products, a.good_products, a.bad_products) == (1, 1, 0)
    assert a.class_counts == {"product": 1}


def test_counts_bad_product_and_classes():
    e = engine()
    feed(e, [[product()]] * 5 + [[product(), defect("dent")]] * 3 + [[]] * 10)
    a = e.analytics
    assert (a.total_products, a.good_products, a.bad_products) == (1, 0, 1)
    assert a.class_counts == {"product": 1, "dent": 1}


def test_product_outside_centre_region_is_not_counted():
    e = engine()
    feed(e, [[product(box=EDGE)]] * 10 + [[]] * 10)
    assert e.analytics.total_products == 0
    # ...unless the centre guide is off
    e = engine(center_guide_enabled=False)
    feed(e, [[product(box=EDGE)]] * 10 + [[]] * 10)
    assert e.analytics.total_products == 1


def test_defect_logged_once_per_product():
    e = engine()
    outs = feed(e, [[product(), defect("dent", 0.2), defect("scratch", 0.9)]] * 6)
    events = [o.defect_event for o in outs if o.defect_event]
    assert len(events) == 1
    # Sorted by confidence; low-confidence defect classes are still listed (web app behaviour)
    assert events[0].defect_classes == ["scratch", "dent"]
    # After the product leaves (NO_PRODUCT), the next product can log again
    feed(e, [[]] * 10)
    outs = feed(e, [[product(), defect()]] * 3)
    assert sum(1 for o in outs if o.defect_event) == 1


def test_defect_logging_toggle():
    e = engine(defect_logging_enabled=False)
    outs = feed(e, [[product(), defect()]] * 5)
    assert not any(o.defect_event for o in outs)


def test_verdict_disabled_skips_everything():
    e = engine(verdict_enabled=False)
    outs = feed(e, [[product(), defect()]] * 10 + [[]] * 10)
    assert all(o.frame_verdict is None for o in outs)
    assert e.analytics.total_products == 0


def test_flush_on_stop_counts_product_in_view():
    e = engine()
    feed(e, [[product()]] * 6)
    assert e.analytics.total_products == 0
    assert e.flush_incident() is True
    assert e.analytics.total_products == 1
