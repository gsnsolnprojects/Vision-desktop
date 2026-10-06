import { useEffect, useRef } from "react";
import type { DisplaySettings } from "@/lib/presets";
import type { LiveFrame } from "@/lib/station";
import { useStation } from "@/lib/station";

const GOOD = "#22c55e";
const BAD = "#ef4444";

interface Props {
  goodClasses: string[];
  centerGuideEnabled: boolean;
  centerGuidePercent: number;
  display: DisplaySettings;
}

/**
 * Draws the camera frame and overlays on a canvas, on every frame, outside React.
 * Overlays are drawn here (not burned into the JPEG) so display toggles apply instantly.
 */
export function LiveCanvas(props: Props) {
  const { subscribeFrames } = useStation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const frameRef = useRef<LiveFrame | null>(null);
  const rafRef = useRef<number | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d", { alpha: false })!;

    const draw = () => {
      rafRef.current = null;
      const frame = frameRef.current;
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(canvas.clientWidth * dpr);
      const ch = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.fillStyle = "#020617";
      ctx.fillRect(0, 0, cw, ch);
      if (!frame) return;

      const { header, bitmap } = frame;
      const iw = header.width;
      const ih = header.height;
      const scale = Math.min(cw / iw, ch / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const ox = (cw - dw) / 2;
      const oy = (ch - dh) / 2;
      try {
        ctx.drawImage(bitmap, ox, oy, dw, dh);
      } catch {
        return; // bitmap already released (frame superseded); next frame will draw
      }

      const p = propsRef.current;
      const good = new Set(p.goodClasses);
      const X = (x: number) => ox + x * scale;
      const Y = (y: number) => oy + y * scale;
      const lw = Math.max(2, 2 * dpr);

      // Centre guide: products are only counted/logged when fully inside it.
      if (p.centerGuideEnabled) {
        const r = Math.min(Math.max(p.centerGuidePercent, 40), 95) / 100;
        const m = (1 - r) / 2;
        ctx.save();
        ctx.setLineDash([10 * dpr, 8 * dpr]);
        ctx.strokeStyle = header.productInRegion ? "rgba(34,197,94,0.9)" : "rgba(255,255,255,0.6)";
        ctx.lineWidth = lw;
        ctx.strokeRect(X(iw * m), Y(ih * m), iw * r * scale, ih * r * scale);
        ctx.restore();
      }

      ctx.font = `${Math.round(13 * dpr)}px "Segoe UI", sans-serif`;
      ctx.textBaseline = "top";
      for (const d of header.detections) {
        const color = good.has(d.class) ? GOOD : BAD;
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        if (p.display.showPolygons && d.polygon && d.polygon.length > 2) {
          ctx.beginPath();
          d.polygon.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(X(x), Y(y)) : ctx.lineTo(X(x), Y(y))));
          ctx.closePath();
          ctx.globalAlpha = 0.22;
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.stroke();
        }
        const [x1, y1, x2, y2] = d.bbox;
        if (p.display.showBoxes) ctx.strokeRect(X(x1), Y(y1), (x2 - x1) * scale, (y2 - y1) * scale);
        if (p.display.showLabels && (p.display.showBoxes || p.display.showPolygons)) {
          const label = `${d.class} ${(d.confidence * 100).toFixed(0)}%`;
          const tw = ctx.measureText(label).width + 10 * dpr;
          const th = 20 * dpr;
          const ly = Math.max(Y(y1) - th, oy);
          ctx.fillStyle = color;
          ctx.fillRect(X(x1), ly, tw, th);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, X(x1) + 5 * dpr, ly + 3 * dpr);
        }
      }
    };

    const schedule = () => {
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;
    const off = subscribeFrames((f) => {
      frameRef.current = f;
      schedule();
    });
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      off();
      ro.disconnect();
      scheduleRef.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      // Must reset, or a remount (React StrictMode, HMR) thinks a draw is still queued and never draws again.
      rafRef.current = null;
    };
  }, [subscribeFrames]);

  // Redraw immediately when overlay toggles change (even if frames are paused).
  useEffect(() => {
    scheduleRef.current?.();
  }, [props.display, props.centerGuideEnabled, props.centerGuidePercent, props.goodClasses]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}
