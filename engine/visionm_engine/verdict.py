"""OK / NOT_OK / NO_PRODUCT verdict, product counting and defect logging.

This is a line-for-line port of the live camera logic in the Vision-M Studio
web app (PredictionPage.tsx) so that a station and the web app give the same
answer for the same detections. Keep the two in sync when either changes.
"""

from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass, field

from .core import Detection, Verdict

# Thresholds hard-coded in the web app.
PRODUCT_MIN_CONFIDENCE = 0.45
DEFECT_MIN_CONFIDENCE = 0.35

# Smoothing window: the shown verdict changes only when the recent frames agree.
HISTORY_SIZE = 7
NOT_OK_VOTES = 2
OK_VOTES = 5
NO_PRODUCT_VOTES = 5

CENTER_REGION_MIN_PERCENT = 40
CENTER_REGION_MAX_PERCENT = 95


@dataclass(slots=True)
class VerdictSettings:
    good_classes: list[str]
    verdict_enabled: bool = True
    defect_logging_enabled: bool = True
    center_guide_enabled: bool = True
    center_guide_percent: float = 40

    def clamped_center_ratio(self) -> float:
        pct = min(max(self.center_guide_percent, CENTER_REGION_MIN_PERCENT), CENTER_REGION_MAX_PERCENT)
        return pct / 100.0


@dataclass(slots=True)
class DefectEvent:
    """A NOT_OK incident that should be logged (one per product, not per frame)."""

    defect_classes: list[str]


@dataclass(slots=True)
class FrameOutcome:
    frame_verdict: Verdict | None  # raw verdict of this frame (None when verdict is disabled)
    verdict: Verdict  # smoothed verdict to display
    product_in_region: bool
    defect_event: DefectEvent | None = None
    counted_product: bool = False  # a product incident was closed and counted on this frame


@dataclass(slots=True)
class RunAnalytics:
    frames_processed: int = 0  # web app semantics: number of counted products
    total_products: int = 0
    good_products: int = 0
    bad_products: int = 0
    class_counts: dict[str, int] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "framesProcessed": self.frames_processed,
            "totalProducts": self.total_products,
            "goodProducts": self.good_products,
            "badProducts": self.bad_products,
            "classCounts": dict(self.class_counts),
        }


def _region(width: int, height: int, settings: VerdictSettings) -> tuple[float, float, float, float]:
    if not settings.center_guide_enabled:
        return 0.0, 0.0, float(width), float(height)
    r = settings.clamped_center_ratio()
    margin = (1 - r) / 2
    return width * margin, height * margin, width * (1 - margin), height * (1 - margin)


def _bounds(det: Detection) -> tuple[float, float, float, float]:
    if det.bbox:
        return det.bbox
    xs = [p[0] for p in det.polygon or []]
    ys = [p[1] for p in det.polygon or []]
    return min(xs), min(ys), max(xs), max(ys)


class VerdictEngine:
    """Stateful per-run verdict + analytics tracker. Not thread-safe; owned by the pipeline thread."""

    def __init__(self, settings: VerdictSettings) -> None:
        self.settings = settings
        self.analytics = RunAnalytics()
        self._history: deque[Verdict] = deque(maxlen=HISTORY_SIZE)
        self._verdict: Verdict = "NO_PRODUCT"
        # Defect-log lock: one log per product while it stays in view.
        self._log_lock = False
        # Product-count incident tracking.
        self._incident_open = False
        self._incident_classes: set[str] = set()
        self._incident_has_defect = False

    @property
    def verdict(self) -> Verdict:
        return self._verdict

    def update_settings(self, settings: VerdictSettings) -> None:
        self.settings = settings

    def process(self, detections: list[Detection], width: int, height: int) -> FrameOutcome:
        s = self.settings
        good = set(s.good_classes)

        if not s.verdict_enabled:
            return FrameOutcome(frame_verdict=None, verdict=self._verdict, product_in_region=False)

        products = sorted(
            (d for d in detections if d.cls in good and d.confidence >= PRODUCT_MIN_CONFIDENCE),
            key=lambda d: d.confidence,
            reverse=True,
        )
        product_detected = bool(good) and bool(products)
        defect_detected = any(d.cls not in good and d.confidence >= DEFECT_MIN_CONFIDENCE for d in detections)

        frame_verdict: Verdict
        if not product_detected:
            frame_verdict = "NO_PRODUCT"
        elif defect_detected:
            frame_verdict = "NOT_OK"
        else:
            frame_verdict = "OK"

        self._history.append(frame_verdict)
        votes = Counter(self._history)
        if votes["NOT_OK"] >= NOT_OK_VOTES:
            self._verdict = "NOT_OK"
        elif votes["OK"] >= OK_VOTES:
            self._verdict = "OK"
        elif votes["NO_PRODUCT"] >= NO_PRODUCT_VOTES:
            self._verdict = "NO_PRODUCT"
        final = self._verdict

        left, top, right, bottom = _region(width, height, s)
        in_region = False
        if products:
            x1, y1, x2, y2 = _bounds(products[0])
            in_region = x1 >= left and y1 >= top and x2 <= right and y2 <= bottom

        outcome = FrameOutcome(frame_verdict=frame_verdict, verdict=final, product_in_region=in_region)

        # Product counting: an incident spans from the product entering the region until NO_PRODUCT.
        if final == "NO_PRODUCT":
            if self._incident_open:
                outcome.counted_product = self.flush_incident()
        elif in_region and frame_verdict in ("OK", "NOT_OK"):
            for d in detections:
                threshold = PRODUCT_MIN_CONFIDENCE if d.cls in good else DEFECT_MIN_CONFIDENCE
                if d.confidence >= threshold:
                    self._incident_classes.add(d.cls or "unknown")
            if defect_detected:
                self._incident_has_defect = True
            self._incident_open = True

        # Defect logging: once per product, on the first NOT_OK frame inside the region.
        if final == "NO_PRODUCT":
            self._log_lock = False
        elif s.verdict_enabled and s.defect_logging_enabled and frame_verdict == "NOT_OK" and not self._log_lock and in_region:
            defects = sorted((d for d in detections if d.cls not in good), key=lambda d: d.confidence, reverse=True)
            classes = list(dict.fromkeys(d.cls for d in defects if d.cls))
            outcome.defect_event = DefectEvent(defect_classes=classes or ["unknown_defect"])
            self._log_lock = True

        return outcome

    def flush_incident(self) -> bool:
        """Close the open product incident and count it. Returns True if a product was counted."""
        classes = list(self._incident_classes)
        has_defect = self._incident_has_defect
        self._incident_open = False
        self._incident_classes = set()
        self._incident_has_defect = False
        if not classes:
            return False
        a = self.analytics
        a.frames_processed += 1
        a.total_products += 1
        if has_defect:
            a.bad_products += 1
        else:
            a.good_products += 1
        for c in classes:
            a.class_counts[c] = a.class_counts.get(c, 0) + 1
        return True
