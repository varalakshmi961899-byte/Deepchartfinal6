import { useEffect, useRef, useState, useCallback, memo, useMemo, useContext, useLayoutEffect } from "react";
import { usePopup } from "@/hooks/usePopup";
import { createPortal } from "react-dom";
import type { Time, Logical } from "lightweight-charts";
import { ColorPickerGlass } from "@/components/ColorPickerGlass";
import { useChartContext } from "@/contexts/ChartContext";
import { ChartBarsContext } from "@/contexts/ChartBarsContext";
import { useDrawingStore, getDeletedDrawingIds, saveDrawingStyle } from "@/store/drawingStore";
import { useChartStore } from "@/store/chartStore";
import { toArray } from "@/lib/safeArray";
import { type Drawing, type DrawingPoint, type DrawingStyle, type ToolType, pointsNeeded, isFreehand, DEFAULT_STYLE } from "@/types/drawing";
import { DrawingSettingsModal } from "@/components/charts/DrawingSettingsModal";
import { PositionToolbar } from "@/components/charts/PositionToolbar";
import { useIsMobile } from "@/hooks/use-mobile";
import { renderDrawingsToCanvas } from "@/components/charts/drawingCanvasRenderer";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

import icoLockUrl    from "@assets/lockicon1_1780335267097.svg";
import ico3DotsUrl   from "@assets/3dots1_1780335267063.svg";
import icoMomentUrl  from "@assets/moment1_1780335267132.svg";
import icoSettingUrl from "@assets/setting1_1780335267166.svg";
import icoPencilUrl  from "@assets/pencil_1780335267014.svg";
import icoAlertUrl   from "@assets/alert1_1780335285769.svg";
import icoBinUrl     from "@assets/bin1_1780335362774.svg";
import icoTextUrl    from "@assets/text1_1780334568624.svg";

function hexToRgba(hex: string, alpha: number): string {
  const h = (hex || "#089981").replace("#", "").slice(0, 6).padEnd(6, "0");
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

function getIntervalSec(tf: string): number {
  if (tf === "1D" || tf === "D")  return 86400;
  if (tf === "1W" || tf === "W")  return 604800;
  if (tf === "1M" || tf === "M")  return 2592000;
  const m = parseInt(tf, 10);
  return isNaN(m) ? 3600 : m * 60;
}

// ── Fibonacci levels ──────────────────────────────────────────────────────────
const FIB_LEVELS = [
  { level: 0,     label: "0",     opacity: 0.9  },
  { level: 0.236, label: "0.236", opacity: 0.75 },
  { level: 0.382, label: "0.382", opacity: 0.85 },
  { level: 0.5,   label: "0.5",   opacity: 0.9  },
  { level: 0.618, label: "0.618", opacity: 0.85 },
  { level: 0.786, label: "0.786", opacity: 0.75 },
  { level: 1,     label: "1",     opacity: 0.9  },
];
const FIB_EXT_LEVELS = [
  { level: 0,     label: "0"     },
  { level: 0.618, label: "0.618" },
  { level: 1,     label: "1"     },
  { level: 1.272, label: "1.272" },
  { level: 1.618, label: "1.618" },
  { level: 2,     label: "2"     },
  { level: 2.618, label: "2.618" },
];

type Px = { x: number; y: number };

// ── SVG path helpers ──────────────────────────────────────────────────────────
function extendBothEnds(a: Px, b: Px, W: number, H: number): string {
  if (Math.abs(b.x - a.x) < 0.5) return `M ${a.x.toFixed(1)} -20 L ${a.x.toFixed(1)} ${(H + 20).toFixed(1)}`;
  const slope = (b.y - a.y) / (b.x - a.x);
  return `M -20 ${(a.y + slope * (-20 - a.x)).toFixed(1)} L ${(W + 20).toFixed(1)} ${(a.y + slope * (W + 20 - a.x)).toFixed(1)}`;
}

function extendRight(a: Px, b: Px, W: number): string {
  if (Math.abs(b.x - a.x) < 0.5) return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${a.x.toFixed(1)} 0`;
  const slope = (b.y - a.y) / (b.x - a.x);
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${(W + 20).toFixed(1)} ${(a.y + slope * (W + 20 - a.x)).toFixed(1)}`;
}

function extendLeft(a: Px, b: Px): string {
  if (Math.abs(b.x - a.x) < 0.5) return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${a.x.toFixed(1)} 9999`;
  const slope = (b.y - a.y) / (b.x - a.x);
  return `M -20 ${(a.y + slope * (-20 - a.x)).toFixed(1)} L ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

function dashArray(s: string): string | undefined {
  return s === "dashed" ? "8 5" : s === "dotted" ? "2 5" : undefined;
}

function arrowHead(a: Px, b: Px, sz = 10): string {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const a1 = ang + Math.PI * 0.75, a2 = ang - Math.PI * 0.75;
  return `M ${b.x.toFixed(1)} ${b.y.toFixed(1)} L ${(b.x + sz * Math.cos(a1)).toFixed(1)} ${(b.y + sz * Math.sin(a1)).toFixed(1)} M ${b.x.toFixed(1)} ${b.y.toFixed(1)} L ${(b.x + sz * Math.cos(a2)).toFixed(1)} ${(b.y + sz * Math.sin(a2)).toFixed(1)}`;
}

function distToSeg(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ── Geometric hit-test for unselected drawings ─────────────────────────────────
// Used by the document-level selection listener. Because unselected drawing hit
// areas have pointerEvents:"none" (so chart panning is never blocked), we need
// our own spatial hit-test here rather than relying on SVG hit-testing.
// (cx, cy) are in overlay-local pixel space.
function hitTestDrawingAtPx(
  d: Drawing,
  cx: number,
  cy: number,
  toPx: (pt: DrawingPoint) => Px | null,
  barHalfWidth: number,
): boolean {
  const pts = d.points.map(toPx).filter(Boolean) as Px[];
  if (pts.length === 0) return false;
  const T = 18; // hit threshold (px)

  switch (d.toolType) {
    case "position_long":
    case "position_short": {
      if (pts.length < 2) return false;
      const slY  = pts.length >= 3 ? pts[2].y : pts[0].y + 40;
      const rawL = Math.min(pts[0].x, pts[1].x);
      const rawR = Math.max(pts[0].x, pts[1].x);
      const zoneW = rawR - rawL;
      // Mirror the zoneW<20 fallback from DrawingShape so hit area matches the visual
      const ELX  = zoneW < 20 ? pts[0].x - 120 : rawL - barHalfWidth;
      const ERX  = zoneW < 20 ? pts[0].x + 120  : rawR;
      const top  = Math.min(pts[1].y, slY);
      const bot  = Math.max(pts[1].y, slY);
      return cx >= ELX && cx <= ERX && cy >= top && cy <= bot;
    }
    case "hline":
      return Math.abs(cy - pts[0].y) < T;
    case "vline":
      return Math.abs(cx - pts[0].x) < T;
    case "rect": {
      if (pts.length < 2) return false;
      const x1 = Math.min(pts[0].x, pts[1].x), x2 = (d.style.extendRight ?? true) ? Number.POSITIVE_INFINITY : Math.max(pts[0].x, pts[1].x);
      const y1 = Math.min(pts[0].y, pts[1].y), y2 = Math.max(pts[0].y, pts[1].y);
      if (cx < x1 - T || cx > x2 + T || cy < y1 - T || cy > y2 + T) return false;
      return (
        Math.abs(cx - x1) < T || Math.abs(cx - x2) < T ||
        Math.abs(cy - y1) < T || Math.abs(cy - y2) < T
      );
    }
    case "channel":
      if (pts.length < 2) return false;
      return (
        distToSeg({ x: cx, y: cy }, pts[0], pts[1]) < T ||
        (pts.length >= 4 ? distToSeg({ x: cx, y: cy }, pts[2], pts[3]) < T : false) ||
        (pts.length >= 3 ? distToSeg({ x: cx, y: cy }, pts[1], pts[2]) < T : false)
      );
    case "fib": {
      if (pts.length < 2) return false;
      for (const lv of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618]) {
        if (Math.abs(cy - (pts[0].y + (pts[1].y - pts[0].y) * lv)) < T) return true;
      }
      return false;
    }
    default:
      if (pts.length === 1) return Math.hypot(cx - pts[0].x, cy - pts[0].y) < T;
      if (pts.length >= 2) return distToSeg({ x: cx, y: cy }, pts[0], pts[pts.length - 1]) < T;
      return false;
  }
}

function parallelOffset(a: Px, b: Px, dist: number): [Px, Px] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * dist, ny = dx / len * dist;
  return [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }];
}

// ── DrawingShape ──────────────────────────────────────────────────────────────
type OhlcBar = { time: number; open: number; high: number; low: number; close: number };

const DrawingShape = memo(function DrawingShape({
  drawing, toPx, W, H, isPreview, onErase,
  cursorMode, isSelected, onBodyDown, onAnchorDown, hasAlert, bars, barHalfWidth, canvasOnly,
  onPnlFoRef, onPnlLineRef,
}: {
  drawing:       Drawing;
  toPx:          (pt: DrawingPoint) => Px | null;
  W:             number;
  H:             number;
  isPreview?:    boolean;
  onErase?:      (id: number) => void;
  cursorMode?:   boolean;
  isSelected?:   boolean;
  onBodyDown?:   (e: React.PointerEvent, id: number, wasSelected: boolean) => void;
  onAnchorDown?: (e: React.PointerEvent, id: number, idx: number) => void;
  hasAlert?:     boolean;
  bars?:         OhlcBar[];
  barHalfWidth?: number;
  canvasOnly?:   boolean;
  // DOM refs for zero-React P&L label position sync on chart pan/zoom
  onPnlFoRef?:   (el: SVGForeignObjectElement | null) => void;
  onPnlLineRef?: (el: SVGLineElement | null) => void;
}) {
  const { style, toolType, points } = drawing;
  const dash = dashArray(style.lineStyle);
  const sw   = style.thickness;
  const col  = style.color;
  const op   = drawing.isVisible ? (isPreview ? 0.5 : (drawing.style.opacity ?? 1)) : 0;
  const HIT  = Math.max(sw + 16, 32);

  // ── Canvas-only fast-exit for unselected drawings ────────────────────────────
  // Canvas2D layer handles all visual rendering. Unselected drawings need zero SVG.
  if (canvasOnly && toolType !== "position_long" && toolType !== "position_short" && (!isSelected || isPreview)) {
    return null;
  }

  const px = points.map(toPx).filter(Boolean) as Px[];
  if (px.length === 0) return null;

  const eraseClick = onErase
    ? { onClick: (e: React.MouseEvent) => { e.stopPropagation(); onErase(drawing.id); } }
    : {};

  // Hit-area props — active in cursor mode so drawing can be selected/dragged.
  //
  // Two-phase interaction (matches TradingView):
  //   Phase 1 (not selected): pointerEvents:"none" — all events fall through to the
  //     chart canvas so panning is never blocked. Selection is detected by a
  //     document-level pointerdown listener in DrawingOverlay (hitTestDrawingAtPx).
  //   Phase 2 (already selected): pointer is captured + touchAction:none for
  //     reliable drag on both mouse and touch. Propagation is stopped immediately.
  //
  // NOTE: DrawingOverlay and the LWC chart canvas are siblings in the DOM, so
  // bubbling from SVG elements never reaches the chart — only pointerEvents:"none"
  // truly lets events through to the canvas below.
  const hitProps = cursorMode && !isPreview && onBodyDown ? (
    isSelected ? {
      onPointerDown: (e: React.PointerEvent) => {
        e.stopPropagation();
        e.preventDefault();
        try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
        onBodyDown(e, drawing.id, true);
      },
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); },
      style: { cursor: "move", pointerEvents: "all" as const, touchAction: "none" as const },
    } : {
      // Unselected: pass ALL pointer events through — chart pans freely.
      // DrawingOverlay's hit-test useEffect handles tap-to-select.
      style: { cursor: "default", pointerEvents: "none" as const },
    }
  ) : { style: { pointerEvents: "none" as const } };

  // Anchor handle — TradingView-style: outer glow + dark fill + blue ring + white core.
  // Uses a transparent top circle as the explicit hit target (reliable across all browsers).
  // Visual circles are pointer-events:none so only the top transparent circle receives events.
  const Anchor = ({ i, p }: { i: number; p: Px }) => {
    if (!isSelected || !cursorMode || isPreview || !onAnchorDown) return null;
    const handleDown = (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      // NOTE: do NOT capture on the circle element — it gets re-created by React
      // during anchor drag (setDragTick re-renders), which would silently release
      // the capture. Capture is done instead on the stable overlayRef in onAnchorDown.
      onAnchorDown(e, drawing.id, i);
    };
    return (
      <>
        {/* Visual layers — no pointer events */}
        <circle cx={p.x} cy={p.y} r={13} fill="rgba(37,99,235,0.10)" style={{ pointerEvents: "none" }} />
        <circle cx={p.x} cy={p.y} r={9}  fill="#0d1117" stroke="#3b82f6" strokeWidth={2.5} style={{ pointerEvents: "none" }} />
        <circle cx={p.x} cy={p.y} r={3}  fill="#ffffff" style={{ pointerEvents: "none" }} />
        {/* Transparent hit-circle — sole event receiver, sits on top.
            r=20 gives a 40px touch target (WCAG minimum 44px guidance, well above 32px). */}
        <circle
          cx={p.x} cy={p.y} r={20}
          fill="transparent" stroke="none"
          style={{ cursor: "grab", pointerEvents: "all", touchAction: "none" }}
          onPointerDown={handleDown}
          onClick={(e) => e.stopPropagation()}
        />
      </>
    );
  };

  // ── Canvas-only mode: render only interactive SVG elements for selected drawings ──
  // Canvas2D layer handles all visual strokes/fills. SVG just provides hit area + anchor handles.
  if (canvasOnly && toolType !== "position_long" && toolType !== "position_short") {
    switch (toolType) {
      case "hline": return (
        <g opacity={op}>
          <line x1={0} y1={px[0].y} x2={W} y2={px[0].y} stroke="transparent" strokeWidth={HIT} {...hitProps} />
          <Anchor i={0} p={px[0]} />
        </g>
      );
      case "hray": return (
        <g opacity={op}>
          <line x1={px[0].x} y1={px[0].y} x2={W} y2={px[0].y} stroke="transparent" strokeWidth={HIT} {...hitProps} />
          <Anchor i={0} p={px[0]} />
        </g>
      );
      case "vline": return (
        <g opacity={op}>
          <line x1={px[0].x} y1={0} x2={px[0].x} y2={H} stroke="transparent" strokeWidth={HIT} {...hitProps} />
          <Anchor i={0} p={px[0]} />
        </g>
      );
      case "rect": {
        if (px.length < 2) return null;
        const rxc = Math.min(px[0].x, px[1].x), ryc = Math.min(px[0].y, px[1].y);
        const rectRight = (style.extendRight ?? false) ? W + 20 : Math.max(px[0].x, px[1].x);
        const rwc = Math.max(1, rectRight - rxc), rhc = Math.abs(px[1].y - px[0].y);
        const rightHandle = (style.extendRight ?? false) ? { x: W, y: px[1].y } : px[1];
        return (
          <g opacity={op}>
            <rect x={rxc} y={ryc} width={Math.max(1, rwc)} height={Math.max(1, rhc)} stroke="transparent" strokeWidth={HIT} fill="transparent" {...hitProps} />
            <Anchor i={0} p={px[0]} /><Anchor i={1} p={rightHandle} />
          </g>
        );
      }
      case "ellipse": {
        if (px.length < 2) return null;
        const ecx = (px[0].x + px[1].x) / 2, ecy = (px[0].y + px[1].y) / 2;
        const erx = Math.abs(px[1].x - px[0].x) / 2, ery = Math.abs(px[1].y - px[0].y) / 2;
        return (
          <g opacity={op}>
            <ellipse cx={ecx} cy={ecy} rx={Math.max(1, erx + HIT / 2)} ry={Math.max(1, ery + HIT / 2)} stroke="transparent" strokeWidth={1} fill="transparent" {...hitProps} />
            <Anchor i={0} p={px[0]} /><Anchor i={1} p={px[1]} />
          </g>
        );
      }
      case "fib":
      case "fib_ext": {
        if (px.length < 2) return null;
        const fx0 = Math.min(px[0].x, px[1].x), fx1 = Math.max(px[0].x, px[1].x);
        const fy0 = Math.min(px[0].y, px[1].y), fy1 = Math.max(px[0].y, px[1].y);
        return (
          <g opacity={op}>
            <rect x={fx0} y={fy0 - 20} width={Math.max(1, fx1 - fx0)} height={Math.max(1, fy1 - fy0 + 40)} fill="transparent" {...hitProps} />
            <Anchor i={0} p={px[0]} /><Anchor i={1} p={px[1]} />
          </g>
        );
      }
      case "brush":
      case "highlighter": {
        const bpx = points.map(toPx).filter(Boolean) as Px[];
        if (bpx.length < 2) return null;
        const bd = bpx.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
        return <g opacity={op}><path d={bd} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} /></g>;
      }
      case "text": {
        const tSz = style.fontSize ?? 13;
        const lbl = style.text ?? "Text";
        const aW  = lbl.length * (tSz * 0.6) + 10;
        const oX  = style.textAlignH === "right" ? aW : style.textAlignH === "center" ? aW / 2 : 0;
        const oY  = style.textAlignV === "bottom" ? 0 : style.textAlignV === "middle" ? -tSz / 2 : -tSz;
        return (
          <g opacity={op}>
            <rect x={px[0].x - 4 - oX} y={px[0].y - tSz - 4 + oY} width={aW + 8} height={tSz + 8} fill="transparent" {...hitProps} />
            <Anchor i={0} p={px[0]} />
          </g>
        );
      }
      case "note": {
        const tSz = style.fontSize ?? 12;
        const nt  = style.text ?? "Note";
        const nl  = nt.split("\n");
        const lH  = Math.max(tSz + 4, 16);
        const nbH = nl.length * lH + 18 + 10;
        const nbW = Math.max(...nl.map((l: string) => l.length * (tSz * 0.6))) + 32;
        return (
          <g opacity={op}>
            <rect x={px[0].x + 10} y={px[0].y - nbH - 4} width={nbW} height={nbH} fill="transparent" {...hitProps} />
            <Anchor i={0} p={px[0]} />
          </g>
        );
      }
      default: {
        // Line-based: trendline, ray, extended, arrow, channel, ruler, curve, path, fib_channel…
        if (px.length < 2) return null;
        let lx1 = px[0].x, ly1 = px[0].y, lx2 = px[1].x, ly2 = px[1].y;
        const linM = Math.abs(px[1].x - px[0].x) > 0.1
          ? (px[1].y - px[0].y) / (px[1].x - px[0].x) : null;
        if (toolType === "extended" || (style.extendLeft && style.extendRight)) {
          lx1 = -10; lx2 = W + 10;
          if (linM !== null) { ly1 = px[0].y + linM * (-10 - px[0].x); ly2 = px[0].y + linM * (W + 10 - px[0].x); }
        } else if (toolType === "ray" || style.extendRight) {
          lx2 = W + 10;
          if (linM !== null) ly2 = px[0].y + linM * (W + 10 - px[0].x);
        } else if (style.extendLeft) {
          lx1 = -10;
          if (linM !== null) ly1 = px[0].y + linM * (-10 - px[0].x);
        }
        return (
          <g opacity={op}>
            <line x1={lx1} y1={ly1} x2={lx2} y2={ly2} stroke="transparent" strokeWidth={HIT} {...hitProps} />
            <Anchor i={0} p={px[0]} />
            <Anchor i={1} p={px[1]} />
          </g>
        );
      }
    }
  }

  // Selection glow helper
  const Glow = ({ d, shape = false, cx = 0, cy = 0, rx = 0, ry = 0, x = 0, y = 0, w = 0, h = 0 }: {
    d?: string; shape?: boolean;
    cx?: number; cy?: number; rx?: number; ry?: number;
    x?: number; y?: number; w?: number; h?: number;
  }) => {
    if (!isSelected) return null;
    if (shape === true) {
      if (rx > 0)
        return <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={col} strokeWidth={sw + 7} strokeOpacity={0.22} />;
      return <rect x={x} y={y} width={w} height={h} fill="none" stroke={col} strokeWidth={sw + 7} strokeOpacity={0.22} />;
    }
    return <path d={d!} stroke={col} strokeWidth={sw + 7} strokeLinecap="round" fill="none" opacity={0.2} />;
  };

  // Alert bell badge — shown at midpoint of drawing when it has an active alert
  const BellMark = () => {
    if (!hasAlert || isPreview || px.length === 0) return null;
    const bx = px.length >= 2 ? (px[0].x + px[px.length - 1].x) / 2 : px[0].x;
    const rawBy = px.length >= 2 ? Math.min(...px.map(p => p.y)) - 18 : px[0].y - 18;
    const by = Math.max(14, rawBy);
    const S = 0.6;
    return (
      <g style={{ pointerEvents: "none" }}>
        <circle cx={bx} cy={by} r={9.5} fill="rgba(183,255,90,0.18)" />
        <circle cx={bx} cy={by} r={7} fill="#0a1510" stroke="#B7FF5A" strokeWidth={1.5} opacity={0.95} />
        <g transform={`translate(${(bx - 12 * S).toFixed(1)},${(by - 12 * S).toFixed(1)}) scale(${S})`}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"
            stroke="#B7FF5A" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"
            stroke="#B7FF5A" strokeWidth={2.2} strokeLinecap="round" fill="none"/>
        </g>
      </g>
    );
  };

  switch (toolType) {
    case "trendline": {
      if (px.length < 2) return null;
      const extL = style.extendLeft  ?? false;
      const extR = style.extendRight ?? false;
      const d = extL && extR
        ? extendBothEnds(px[0], px[1], W, H)
        : extL
        ? extendLeft(px[0], px[1])
        : extR
        ? extendRight(px[0], px[1], W)
        : `M ${px[0].x.toFixed(1)} ${px[0].y.toFixed(1)} L ${px[1].x.toFixed(1)} ${px[1].y.toFixed(1)}`;
      const midX = (px[0].x + px[1].x) / 2;
      const midY = (px[0].y + px[1].y) / 2;
      const showMid = style.showMiddlePoint ?? false;
      const showPL  = style.showPriceLabels ?? false;
      const fmtP = (p: number) => p >= 1000 ? p.toFixed(2) : p.toFixed(5);
      return (
        <g opacity={op} {...eraseClick}>
          {isSelected && (
            <path d={d} stroke="#3b82f6" strokeWidth={Math.max(sw + 16, 20)}
              fill="none" strokeLinecap="round" opacity={0.10} />
          )}
          <Glow d={d} />
          <path d={d} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d} stroke={col} strokeWidth={sw} strokeDasharray={dash} fill="none" strokeLinecap="round" />
          {/* Endpoint dots — hide when selected */}
          {!extL && <circle cx={px[0].x} cy={px[0].y} r={3.5} fill={col} opacity={isSelected ? 0 : 0.85} />}
          {!extR && <circle cx={px[1].x} cy={px[1].y} r={3.5} fill={col} opacity={isSelected ? 0 : 0.85} />}
          {/* Middle point */}
          {showMid && <circle cx={midX} cy={midY} r={4} fill={col} opacity={0.85} style={{ pointerEvents: "none" }} />}
          {/* Price labels at endpoints */}
          {showPL && !extL && (
            <text x={px[0].x + 5} y={px[0].y - 6} fontSize={10} fill={col}
              fontFamily="'JetBrains Mono','Fira Code',monospace" fontWeight={600}
              style={{ pointerEvents: "none", paintOrder: "stroke", stroke: "rgba(7,17,13,0.75)", strokeWidth: 3 }}>
              {fmtP(points[0].price)}
            </text>
          )}
          {showPL && !extR && (
            <text x={px[1].x + 5} y={px[1].y - 6} fontSize={10} fill={col}
              fontFamily="'JetBrains Mono','Fira Code',monospace" fontWeight={600}
              style={{ pointerEvents: "none", paintOrder: "stroke", stroke: "rgba(7,17,13,0.75)", strokeWidth: 3 }}>
              {fmtP(points[1].price)}
            </text>
          )}
          {/* ── Rotated inline label (TradingView-style) ────────────────────── */}
          {style.text && style.text.trim() && (() => {
            const label   = style.text.trim();
            const tCol    = style.textColor ?? col;
            const tSize   = style.fontSize  ?? 13;
            const tWeight = style.fontBold   ? 700 : 500;
            const tStyle  = style.fontItalic ? "italic" : "normal";

            // Always render left-to-right so text is never upside-down
            const [lp, rp] = px[0].x <= px[1].x ? [px[0], px[1]] : [px[1], px[0]];
            const ldx = rp.x - lp.x;
            const ldy = rp.y - lp.y;
            const angleDeg = Math.atan2(ldy, ldx) * 180 / Math.PI;

            // Anchor point along the line
            const tRatio = style.textAlignH === "right" ? 0.8
                         : style.textAlignH === "center" ? 0.5
                         : 0.2;
            const tx = lp.x + ldx * tRatio;
            const ty = lp.y + ldy * tRatio;

            // textAnchor maps left/center/right naturally
            const textAnchor = style.textAlignH === "right" ? "end"
                             : style.textAlignH === "center" ? "middle"
                             : "start";

            // Perpendicular offset — positive = below line (in rotated space)
            const gap = sw / 2 + tSize * 0.6 + 3;
            const dy  = style.textAlignV === "bottom" ?  gap
                      : style.textAlignV === "middle"  ?  0
                      :                                  -gap;   // top (default)

            return (
              <g
                transform={`translate(${tx.toFixed(2)},${ty.toFixed(2)}) rotate(${angleDeg.toFixed(3)})`}
                style={{ pointerEvents: "none" }}
              >
                <text
                  x={0} y={0} dy={dy}
                  fontSize={tSize}
                  fill={tCol}
                  fontWeight={tWeight}
                  fontStyle={tStyle}
                  fontFamily="'Inter','SF Pro Display',system-ui,sans-serif"
                  textAnchor={textAnchor}
                  dominantBaseline="middle"
                  style={{
                    paintOrder: "stroke",
                    stroke: "rgba(7,17,13,0.85)",
                    strokeWidth: 3.5,
                  }}
                >
                  {label}
                </text>
              </g>
            );
          })()}
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "extended": {
      if (px.length < 2) return null;
      const d = extendBothEnds(px[0], px[1], W, H);
      return (
        <g opacity={op} {...eraseClick}>
          <Glow d={d} />
          <path d={d} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d} stroke={col} strokeWidth={sw} strokeDasharray={dash} fill="none" strokeLinecap="round" />
          <circle cx={px[0].x} cy={px[0].y} r={3} fill={col} opacity={isSelected ? 0 : 0.7} />
          <circle cx={px[1].x} cy={px[1].y} r={3} fill={col} opacity={isSelected ? 0 : 0.7} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "ray": {
      if (px.length < 2) return null;
      const d = extendRight(px[0], px[1], W);
      return (
        <g opacity={op} {...eraseClick}>
          <Glow d={d} />
          <path d={d} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d} stroke={col} strokeWidth={sw} strokeDasharray={dash} fill="none" strokeLinecap="round" />
          <circle cx={px[0].x} cy={px[0].y} r={3.5} fill={col} opacity={isSelected ? 0 : 0.85} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "hline": {
      const d = `M 0 ${px[0].y.toFixed(1)} L ${W} ${px[0].y.toFixed(1)}`;
      return (
        <g opacity={op} {...eraseClick}>
          <Glow d={d} />
          <path d={d} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d} stroke={col} strokeWidth={sw} strokeDasharray={dash} fill="none" />
          <text x={W - 6} y={px[0].y - 5} fontSize={11} fill={col}
            fontFamily="'JetBrains Mono','Fira Code',monospace" textAnchor="end">
            {points[0].price.toFixed(points[0].price > 1000 ? 2 : 5)}
          </text>
          <Anchor i={0} p={px[0]} />
        </g>
      );
    }

    case "vline": {
      const d = `M ${px[0].x.toFixed(1)} 0 L ${px[0].x.toFixed(1)} ${H}`;
      return (
        <g opacity={op} {...eraseClick}>
          <Glow d={d} />
          <path d={d} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d} stroke={col} strokeWidth={sw} strokeDasharray={dash} fill="none" />
          <Anchor i={0} p={px[0]} />
        </g>
      );
    }

    case "channel": {
      if (px.length < 2) return null;
      const channelWidth = Math.min(H * 0.12, 60);
      const [c0, c1] = parallelOffset(px[0], px[1], channelWidth);
      const d1 = extendBothEnds(px[0], px[1], W, H);
      const d2 = extendBothEnds(c0, c1, W, H);
      return (
        <g opacity={op} {...eraseClick}>
          <Glow d={d1} />
          <path d={d1} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d1} stroke={col} strokeWidth={sw} strokeDasharray={dash} fill="none" />
          <path d={d2} stroke={col} strokeWidth={sw} strokeDasharray={dash} fill="none" opacity={0.6} />
          <polygon
            points={`${Math.max(-20, px[0].x - 50)},${px[0].y + (px[0].y - px[1].y) * -10} ${Math.min(W + 20, px[1].x + 50)},${px[1].y} ${Math.min(W + 20, c1.x + 50)},${c1.y} ${Math.max(-20, c0.x - 50)},${c0.y}`}
            fill={col} fillOpacity={style.fillOpacity * 0.5} />
          <circle cx={px[0].x} cy={px[0].y} r={3.5} fill={col} opacity={isSelected ? 0 : 0.85} />
          <circle cx={px[1].x} cy={px[1].y} r={3.5} fill={col} opacity={isSelected ? 0 : 0.85} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "rect": {
      if (px.length < 2) return null;
      const rx = Math.min(px[0].x, px[1].x), ry = Math.min(px[0].y, px[1].y);
      const rw = Math.abs(px[1].x - px[0].x), rh = Math.abs(px[1].y - px[0].y);
      return (
        <g opacity={op} {...eraseClick}>
          <Glow shape x={rx} y={ry} w={rw} h={rh} />
          <rect x={rx - HIT / 2} y={ry - HIT / 2} width={rw + HIT} height={rh + HIT} fill="transparent" {...hitProps} />
          <rect x={rx} y={ry} width={rw} height={rh} fill={col} fillOpacity={style.fillOpacity} stroke={col} strokeWidth={sw} strokeDasharray={dash} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "ellipse": {
      if (px.length < 2) return null;
      const cx = (px[0].x + px[1].x) / 2, cy = (px[0].y + px[1].y) / 2;
      const erx = Math.abs(px[1].x - px[0].x) / 2, ery = Math.abs(px[1].y - px[0].y) / 2;
      return (
        <g opacity={op} {...eraseClick}>
          <Glow shape cx={cx} cy={cy} rx={erx} ry={ery} />
          <ellipse cx={cx} cy={cy} rx={erx + HIT / 2} ry={ery + HIT / 2} fill="transparent" {...hitProps} />
          <ellipse cx={cx} cy={cy} rx={erx} ry={ery} fill={col} fillOpacity={style.fillOpacity} stroke={col} strokeWidth={sw} strokeDasharray={dash} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "arrow": {
      if (px.length < 2) return null;
      const d = `M ${px[0].x.toFixed(1)} ${px[0].y.toFixed(1)} L ${px[1].x.toFixed(1)} ${px[1].y.toFixed(1)}`;
      const sz = Math.max(8, sw * 4);
      return (
        <g opacity={op} {...eraseClick}>
          <Glow d={d} />
          <path d={d} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d} stroke={col} strokeWidth={sw} fill="none" strokeLinecap="round" />
          <path d={arrowHead(px[0], px[1], sz)} stroke={col} strokeWidth={sw} fill="none" strokeLinecap="round" />
          <circle cx={px[0].x} cy={px[0].y} r={3} fill={col} opacity={isSelected ? 0 : 0.7} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "brush":
    case "highlighter": {
      if (points.length < 2) return null;
      const pxPts = points.map(p => toPx(p)).filter(Boolean) as Px[];
      if (pxPts.length < 2) return null;
      const d = pxPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
      const isHL = toolType === "highlighter";
      return (
        <g opacity={op} {...eraseClick}>
          <path d={d} stroke="transparent" strokeWidth={HIT + (isHL ? 10 : 0)} fill="none" {...hitProps} />
          <path d={d} stroke={col}
            strokeWidth={isHL ? Math.max(sw * 8, 14) : sw}
            fill="none" strokeLinecap="round" strokeLinejoin="round"
            opacity={isHL ? 0.38 : 1} />
        </g>
      );
    }

    case "path": {
      if (px.length < 2) return null;
      const d = `M ${px[0].x.toFixed(1)} ${px[0].y.toFixed(1)} L ${px[1].x.toFixed(1)} ${px[1].y.toFixed(1)}`;
      return (
        <g opacity={op} {...eraseClick}>
          <Glow d={d} />
          <path d={d} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d} stroke={col} strokeWidth={sw} fill="none" strokeLinecap="round" strokeDasharray={dash} />
          <circle cx={px[0].x} cy={px[0].y} r={3} fill={col} opacity={isSelected ? 0 : 0.8} />
          <circle cx={px[1].x} cy={px[1].y} r={3} fill={col} opacity={isSelected ? 0 : 0.8} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "curve": {
      if (px.length < 2) return null;
      const midX = (px[0].x + px[1].x) / 2;
      const midY = (px[0].y + px[1].y) / 2;
      const dxL = px[1].x - px[0].x, dyL = px[1].y - px[0].y;
      const len = Math.hypot(dxL, dyL) || 1;
      const ctrlX = midX - (dyL / len) * len * 0.25;
      const ctrlY = midY + (dxL / len) * len * 0.25;
      const d = `M ${px[0].x.toFixed(1)} ${px[0].y.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${px[1].x.toFixed(1)} ${px[1].y.toFixed(1)}`;
      return (
        <g opacity={op} {...eraseClick}>
          <Glow d={d} />
          <path d={d} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d} stroke={col} strokeWidth={sw} fill="none" strokeLinecap="round" strokeDasharray={dash} />
          <circle cx={px[0].x} cy={px[0].y} r={3} fill={col} opacity={isSelected ? 0 : 0.8} />
          <circle cx={px[1].x} cy={px[1].y} r={3} fill={col} opacity={isSelected ? 0 : 0.8} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "text": {
      const label    = style.text ?? "Text";
      const tCol     = style.textColor ?? col;
      const tSize    = style.fontSize  ?? 13;
      const tWeight  = style.fontBold   ? 700 : 600;
      const tStyle   = style.fontItalic ? "italic" : "normal";
      const approxW  = label.length * (tSize * 0.6) + 10;
      const anchor   = style.textAlignH === "right" ? "end" : style.textAlignH === "center" ? "middle" : "start";
      const offX     = style.textAlignH === "right" ? approxW : style.textAlignH === "center" ? approxW / 2 : 0;
      const offY     = style.textAlignV === "bottom" ? 0 : style.textAlignV === "middle" ? -tSize / 2 : -tSize;
      return (
        <g opacity={op} {...eraseClick}>
          {isSelected && <rect x={px[0].x - 4 - offX} y={px[0].y - tSize - 4 + offY} width={approxW + 8} height={tSize + 8} fill={tCol} fillOpacity={0.13} stroke={tCol} strokeWidth={1} rx={3} />}
          <rect x={px[0].x - 4 - offX} y={px[0].y - tSize - 4 + offY} width={approxW + 8} height={tSize + 8} fill="transparent" {...hitProps} />
          <text x={px[0].x} y={px[0].y + offY} fontSize={tSize} fill={tCol} fontWeight={tWeight} fontStyle={tStyle}
            textAnchor={anchor}
            fontFamily="'Inter','SF Pro Display',system-ui,sans-serif"
            style={{ paintOrder: "stroke", stroke: "rgba(7,17,13,0.8)", strokeWidth: 3 }}>
            {label}
          </text>
          <Anchor i={0} p={px[0]} />
        </g>
      );
    }

    case "note": {
      const noteText = style.text ?? "Note";
      const tCol    = style.textColor ?? col;
      const tSize   = style.fontSize  ?? 12;
      const tWeight = style.fontBold   ? 700 : 500;
      const tStyle  = style.fontItalic ? "italic" : "normal";
      const lines = noteText.split("\n");
      const lineH = Math.max(tSize + 4, 16);
      const padX = 10, padY = 8;
      const boxW = Math.max(...lines.map(l => l.length * (tSize * 0.6))) + padX * 2 + 12;
      const boxH = lines.length * lineH + padY * 2 + 10;
      const bx = px[0].x + 10;
      const by = px[0].y - boxH - 4;
      const tailH = 8;
      return (
        <g opacity={op} {...eraseClick}>
          <rect x={bx} y={by} width={boxW} height={boxH} rx={6}
            fill={`${col}22`} stroke={col} strokeWidth={1.2} />
          <polygon
            points={`${bx + 12},${by + boxH} ${bx + 22},${by + boxH} ${px[0].x + 1},${px[0].y}`}
            fill={`${col}22`} stroke={col} strokeWidth={1.2} strokeLinejoin="round" />
          <rect x={bx} y={by} width={boxW} height={tailH + 2} rx={6} fill={col} fillOpacity={0.18} />
          <rect x={bx} y={by} width={boxW} height={boxH} fill="transparent" {...hitProps} />
          {lines.map((line, i) => (
            <text key={i} x={bx + padX} y={by + padY + tailH + lineH * i + 2}
              fontSize={tSize} fill={tCol} fontWeight={tWeight} fontStyle={tStyle}
              fontFamily="'Inter','SF Pro Display',system-ui,sans-serif"
              style={{ paintOrder: "stroke", stroke: "rgba(7,17,13,0.85)", strokeWidth: 3 }}>
              {line || " "}
            </text>
          ))}
          <Anchor i={0} p={px[0]} />
        </g>
      );
    }

    case "fib": {
      if (px.length < 2 || points.length < 2) return null;
      const priceDiff = points[1].price - points[0].price;
      const x0 = Math.min(px[0].x, px[1].x), x1 = Math.max(px[0].x, px[1].x);
      return (
        <g opacity={op} {...eraseClick}>
          {FIB_LEVELS.map(({ level, label, opacity: fop }) => {
            const price = points[0].price + priceDiff * level;
            const y = toPx({ time: points[0].time, price });
            if (!y) return null;
            return (
              <g key={label} opacity={fop}>
                <path d={`M ${x0.toFixed(1)} ${y.y.toFixed(1)} L ${x1.toFixed(1)} ${y.y.toFixed(1)}`}
                  stroke={col} strokeWidth={1} strokeDasharray="5 4" fill="none" />
                <text x={x1 + 4} y={y.y + 3} fontSize={11} fill={col} fontWeight={600} fontFamily="'JetBrains Mono','Fira Code',monospace">{label}</text>
                <text x={x0 - 4} y={y.y + 3} fontSize={10} fill={col}
                  fontFamily="'JetBrains Mono','Fira Code',monospace" textAnchor="end">
                  {price.toFixed(price > 1000 ? 2 : 5)}
                </text>
              </g>
            );
          })}
          {/* Hit area over entire fib block */}
          <rect x={x0} y={Math.min(px[0].y, px[1].y)} width={x1 - x0} height={Math.abs(px[1].y - px[0].y)}
            fill="transparent" {...hitProps} />
          <circle cx={px[0].x} cy={px[0].y} r={3} fill={col} opacity={isSelected ? 0 : 0.7} />
          <circle cx={px[1].x} cy={px[1].y} r={3} fill={col} opacity={isSelected ? 0 : 0.7} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "fib_channel": {
      if (px.length < 2) return null;
      // Channel height = vertical pixel distance between the two anchor points
      const channelH = Math.abs(px[1].y - px[0].y) || H * 0.15;
      const fibChLevels = [
        { level: 0,     label: "0",     fop: 1.0  },
        { level: 0.236, label: "0.236", fop: 0.7  },
        { level: 0.382, label: "0.382", fop: 0.85 },
        { level: 0.5,   label: "0.5",   fop: 0.9  },
        { level: 0.618, label: "0.618", fop: 0.85 },
        { level: 0.786, label: "0.786", fop: 0.7  },
        { level: 1.0,   label: "1",     fop: 1.0  },
        { level: 1.618, label: "1.618", fop: 0.6  },
      ];
      return (
        <g opacity={op} {...eraseClick}>
          {fibChLevels.map(({ level, label, fop }) => {
            const [a, b] = parallelOffset(px[0], px[1], channelH * level);
            const d = extendBothEnds(a, b, W, H);
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2;
            return (
              <g key={label} opacity={fop}>
                <path d={d} stroke={col} strokeWidth={level === 0 || level === 1 ? sw : 1}
                  strokeDasharray={level === 0 || level === 1 ? dash : "5 4"} fill="none" />
                <text x={midX + 4} y={midY - 3} fontSize={10} fill={col} fontWeight={600}
                  fontFamily="'JetBrains Mono','Fira Code',monospace">{label}</text>
              </g>
            );
          })}
          {/* fill between 0 and 1 */}
          {(() => {
            const [a0] = parallelOffset(px[0], px[1], 0);
            const [a1] = parallelOffset(px[0], px[1], channelH);
            return (
              <polygon
                points={`-20,${(a0.y - 20 * (a0.y - px[0].y) / (a0.x - px[0].x + 0.001)).toFixed(1)} ${(W + 20).toFixed(1)},${(a0.y + (W + 20 - a0.x) * (px[1].y - px[0].y) / (px[1].x - px[0].x + 0.001)).toFixed(1)} ${(W + 20).toFixed(1)},${(a1.y + (W + 20 - a1.x) * (px[1].y - px[0].y) / (px[1].x - px[0].x + 0.001)).toFixed(1)} -20,${(a1.y - 20 * (a1.y - px[0].y) / (a1.x - px[0].x + 0.001)).toFixed(1)}`}
                fill={col} fillOpacity={style.fillOpacity * 0.4} />
            );
          })()}
          <path d={`M -20 ${(px[0].y + (px[1].y - px[0].y) / 2).toFixed(1)} L ${(W + 20).toFixed(1)} ${(px[0].y + (px[1].y - px[0].y) / 2).toFixed(1)}`}
            stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <circle cx={px[0].x} cy={px[0].y} r={3.5} fill={col} opacity={isSelected ? 0 : 0.9} />
          <circle cx={px[1].x} cy={px[1].y} r={3.5} fill={col} opacity={isSelected ? 0 : 0.9} />
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    case "position_long":
    case "position_short": {
      if (points.length < 2) return null;
      const isLong = toolType === "position_long";

      // points[0] = entry + left edge  {time: left_time,  price: entry}
      // points[1] = TP   + right edge  {time: right_time, price: tp}
      // points[2] = SL   (price only;  time locked to left_time)
      const entryPrice = points[0].price;
      const tpPrice    = points[1].price;
      const slPrice    = points.length >= 3
        ? points[2].price
        : isLong
          ? entryPrice - Math.abs(tpPrice - entryPrice) * 0.5
          : entryPrice + Math.abs(tpPrice - entryPrice) * 0.5;

      const entPx   = toPx(points[0]);
      const tpPx    = toPx(points[1]);
      const slPxRef = toPx({ time: points[0].time, price: slPrice });
      if (!entPx || !tpPx || !slPxRef) return null;

      const entY = entPx.y;
      const tpY  = tpPx.y;
      const slY  = slPxRef.y;

      // Bar half-width — sourced from the LWC logical coordinate system (passed as prop),
      // not from candleBars, to avoid a race condition on initial load where candleBars
      // is empty one frame before toPx() is valid, causing ELX to jump left on the next tick.
      const halfBarW = barHalfWidth ?? 0;

      // Horizontal bounds — ELX/ERX in true chart-space pixel coordinates.
      // Do NOT clamp to [0, W]: clamping pins the zone to the screen edge when
      // candles scroll out of view, making the box look stuck at the left/right.
      // The SVG clipPath="url(#drawing-clip)" already clips everything to the
      // visible chart area, so negative / >W values are handled automatically.
      const rawL  = Math.min(entPx.x, tpPx.x);
      const rawR  = Math.max(entPx.x, tpPx.x);
      const zoneW = Math.max(0, rawR - rawL);

      const ELX  = zoneW < 20 ? entPx.x - 120 : rawL - halfBarW;
      const ERX  = zoneW < 20 ? entPx.x + 120  : rawR;
      const ZW   = Math.max(0, ERX - ELX);
      const midX = (ELX + ERX) / 2;

      // Visible-area equivalents — used where we need screen-clamped values
      // (label text anchor, label visibility threshold, live-fill start).
      const visELX = Math.max(ELX, 0);
      const visERX = Math.min(ERX, W);
      const visZW  = Math.max(0, visERX - visELX);

      // Zone geometry
      const profitTop = Math.min(entY, tpY);
      const profitH   = Math.abs(tpY - entY);
      const lossTop   = Math.min(entY, slY);
      const lossH     = Math.abs(slY - entY);
      const totalTop  = Math.min(tpY, slY);
      const totalH    = Math.abs(tpY - slY);

      // Metrics
      const reward = Math.abs(tpPrice - entryPrice);
      const risk   = Math.abs(slPrice - entryPrice);
      const rrStr  = risk > 0 ? (reward / risk).toFixed(2) : "∞";
      const tpPct  = Math.abs((tpPrice - entryPrice) / entryPrice * 100);
      const slPct  = Math.abs((slPrice - entryPrice) / entryPrice * 100);
      const fmt = (p: number) =>
        p >= 10000 ? p.toFixed(0) : p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(6);

      // ── Color tokens — user-configurable via style.profitColor / style.stopColor ──
      const _profitHex    = drawing.style.profitColor ?? "#089981";
      const _stopHex      = drawing.style.stopColor   ?? "#f23645";
      const TP_STATIC     = hexToRgba(_profitHex, 0.32); // profit zone dim fill
      const SL_STATIC     = hexToRgba(_stopHex,   0.32); // loss zone dim fill
      const PROFIT_ACTIVE = hexToRgba(_profitHex, 0.55); // profit zone live/active fill
      const LOSS_ACTIVE   = hexToRgba(_stopHex,   0.55); // loss zone live/active fill
      const TP_BAR        = hexToRgba(_profitHex, 0.95); // target label bar bg
      const SL_BAR        = hexToRgba(_stopHex,   0.95); // stop label bar bg
      const TP_LINE       = hexToRgba(_profitHex, 1);    // TP boundary line
      const SL_LINE       = hexToRgba(_stopHex,   1);    // SL boundary line
      const ENT_LINE      = "rgba(255,255,255,0.45)";    // entry dashed line
      const TP_CLR_SOLID  = _profitHex;                  // exit badge / move indicator
      const SL_CLR_SOLID  = _stopHex;                    // exit badge / move indicator
      const H_BLUE        = "#2563eb";

      const LBL_H = 26;
      const targetBarY = isLong ? tpY       : tpY - LBL_H;
      const stopBarY   = isLong ? slY - LBL_H : slY;

      // ── Dynamic candle split: capped at first TP or SL hit ───────────────
      // Collects bars from entry candle forward; active fill extends to the
      // latest candle seen, hard-stopping at whichever of TP/SL is touched first.
      const toolLeftTime  = Math.min(points[0].time, points[1].time);
      const toolRightTime = Math.max(points[0].time, points[1].time);

      let profitSplitX: number = ELX;
      let tpWasHit  = false;
      let slWasHit  = false;
      let entryCandleOhlc: OhlcBar | null = null;
      let lastActiveBar:   OhlcBar | null = null;

      if (bars && bars.length > 0) {
        const barsInRange = bars.filter(b => b.time >= toolLeftTime && b.time <= toolRightTime);
        entryCandleOhlc = barsInRange[0] ?? null;

        let tpHitTime: number | null = null;
        let slHitTime: number | null = null;

        for (const bar of barsInRange) {
          if (tpHitTime === null) {
            if (isLong  && bar.high >= tpPrice) tpHitTime = bar.time;
            if (!isLong && bar.low  <= tpPrice) tpHitTime = bar.time;
          }
          if (slHitTime === null) {
            if (isLong  && bar.low  <= slPrice) slHitTime = bar.time;
            if (!isLong && bar.high >= slPrice) slHitTime = bar.time;
          }
        }

        const lastBarTime = barsInRange.length > 0
          ? barsInRange[barsInRange.length - 1].time
          : null;

        // Limit = last candle, capped at whichever TP/SL is hit first
        let limitTime: number | null = lastBarTime;
        const firstHitTime = Math.min(tpHitTime ?? Infinity, slHitTime ?? Infinity);
        if (firstHitTime !== Infinity) {
          tpWasHit = tpHitTime !== null && tpHitTime <= (slHitTime ?? Infinity);
          slWasHit = slHitTime !== null && slHitTime <  (tpHitTime ?? Infinity);
          limitTime = limitTime !== null ? Math.min(limitTime, firstHitTime) : firstHitTime;
        }

        // Capture the last active bar (for current close display)
        if (limitTime !== null) {
          lastActiveBar = barsInRange.filter(b => b.time <= limitTime!).pop() ?? null;
          const sp = toPx({ time: limitTime, price: entryPrice });
          if (sp) profitSplitX = Math.min(ERX, Math.max(ELX, sp.x));
        }
      }

      // Explicit trade state — must be derived after tpWasHit/slWasHit are set above
      const tradeStatus = tpWasHit ? "TP_HIT" : slWasHit ? "SL_HIT" : "RUNNING";

      // Active fill pixel bounds — use visELX (screen-clamped) for fill start
      // so the live progress rect begins at the visible edge, not off-screen.
      const activeFillStartX = visELX;
      const activeFillEndX   = Math.min(W,  profitSplitX + halfBarW);
      const activeFillW      = Math.max(0, activeFillEndX - activeFillStartX);
      const futureFillStartX = activeFillEndX;
      const futureFillW      = Math.max(0, ERX - futureFillStartX);

      const profitActiveW = Math.max(0, profitSplitX - ELX);
      const profitFutureW = Math.max(0, ERX - profitSplitX);

      // Floating P&L from entry candle open → last active bar close
      const entryOpen    = entryCandleOhlc?.open  ?? entryPrice;
      const currentClose = lastActiveBar?.close    ?? entryPrice;
      const floatPct     = entryPrice !== 0
        ? ((isLong ? currentClose - entryOpen : entryOpen - currentClose) / entryOpen * 100)
        : 0;

      // Movement visualization — current price Y + profit/loss color
      const currentPriceY = lastActiveBar
        ? (toPx({ time: lastActiveBar.time, price: lastActiveBar.close })?.y ?? null)
        : null;
      const moveInProfit = lastActiveBar
        ? (isLong ? lastActiveBar.close >= entryPrice : lastActiveBar.close <= entryPrice)
        : true;
      const MOVE_CLR = moveInProfit ? TP_CLR_SOLID : SL_CLR_SOLID;

      const PROGRESS_CLR = "rgba(255,255,255,0.55)";

      // Unique ids for label clipPaths (per drawing so multiple tools don't collide)
      const tpClipId = `lbl-tp-${drawing.id}`;
      const slClipId = `lbl-sl-${drawing.id}`;

      // ── TradingView-style rounded-square handle ───────────────────────────
      const tvHandle = (
        cx: number, cy: number,
        cursor: string, idx: number,
        suffix = ""
      ) => {
        if (!isSelected || !cursorMode || isPreview || !onAnchorDown) return null;
        return (
          <g key={`tvh-${idx}${suffix}-${Math.round(cx)}-${Math.round(cy)}`}>
            <rect x={cx - 16} y={cy - 16} width={32} height={32}
              fill="transparent"
              style={{ cursor, pointerEvents: "all", touchAction: "none" }}
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onAnchorDown(e, drawing.id, idx); }}
              onClick={(e) => e.stopPropagation()}
            />
            <rect x={cx - 10} y={cy - 10} width={20} height={20} rx={5}
              fill="none" stroke={H_BLUE} strokeWidth={1.5} strokeOpacity={0.28}
              style={{ pointerEvents: "none" }}
            />
            <rect x={cx - 7} y={cy - 7} width={14} height={14} rx={3}
              fill="rgba(5,13,35,0.90)" stroke={H_BLUE} strokeWidth={2}
              style={{ pointerEvents: "none" }}
            />
            <circle cx={cx} cy={cy} r={2.5}
              fill={H_BLUE} fillOpacity={0.92}
              style={{ pointerEvents: "none" }}
            />
          </g>
        );
      };

      // ── canvasOnly mode ───────────────────────────────────────────────────
      // Canvas2D renderer draws zones/fills/lines via RAF. SVG provides:
      //   1. Hit-area + resize handles (selected only)
      //   2. Live P&L overlay (always, for RUNNING trades)
      if (canvasOnly) {
        if (isPreview) return null;

        // Build the Live P&L badge + measurement line for RUNNING trades.
        // This always renders regardless of selection state so the user
        // can see floating P&L without needing to select the drawing.
        const livePnlOverlay = tradeStatus === "RUNNING" && lastActiveBar && currentPriceY !== null
          ? (() => {
              const lineX1 = ELX + halfBarW;
              const lineY1 = entY;
              const lineX2 = activeFillEndX;
              const lineY2 = currentPriceY;

              const livePriceDiff = isLong
                ? lastActiveBar.close - entryPrice
                : entryPrice - lastActiveBar.close;

              const inProfit  = moveInProfit;
              const pnlColor  = inProfit ? "rgba(0,255,170,1)"    : "rgba(255,90,110,1)";
              const borderClr = inProfit ? "rgba(0,255,180,0.65)" : "rgba(255,90,110,0.65)";
              const glowClr   = inProfit ? "rgba(0,255,180,0.18)" : "rgba(255,90,110,0.18)";

              const sign     = floatPct >= 0 ? "+" : "";
              const pctStr   = `${sign}${floatPct.toFixed(2)}%`;
              const diffSign = livePriceDiff >= 0 ? "+" : "";
              const diffStr  = `${diffSign}${fmt(Math.abs(livePriceDiff))}`;

              const LBL_W = 150;
              const LBL_H = 72;
              const rawLblX = lineX2 + 10;
              const LBL_X   = Math.min(rawLblX, W - LBL_W - 4);
              const LBL_Y   = lineY2 - LBL_H / 2;

              return (
                <g style={{ pointerEvents: "none" }}>
                  {/* ref registered so scheduleCanvasRender can update x1/y1/x2/y2 on pan/zoom */}
                  <line
                    ref={onPnlLineRef}
                    x1={lineX1} y1={lineY1} x2={lineX2} y2={lineY2}
                    stroke="rgba(255,255,255,0.28)" strokeWidth={1.5}
                    strokeDasharray="6 6" strokeLinecap="round" opacity={0.8}
                  />
                  {/* ref registered so scheduleCanvasRender can update x/y on pan/zoom */}
                  <foreignObject ref={onPnlFoRef} x={LBL_X} y={LBL_Y} width={LBL_W} height={LBL_H}
                    pointerEvents="none" style={{ overflow: "visible" }}>
                    <div style={{
                      background: "rgba(20,24,27,0.92)", border: `2px solid ${borderClr}`,
                      borderRadius: "10px", padding: "6px 10px",
                      backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
                      boxShadow: `0 0 14px ${glowClr}`,
                      width: `${LBL_W}px`, height: `${LBL_H}px`,
                      boxSizing: "border-box", display: "flex", flexDirection: "column",
                      justifyContent: "center", gap: "3px", userSelect: "none",
                      pointerEvents: "none",
                    }}>
                      <div style={{ color: "rgba(255,255,255,0.96)", fontSize: "9.5px", fontWeight: 600, letterSpacing: "0.08em", fontFamily: "'Inter',system-ui,sans-serif", textTransform: "uppercase" }}>Live P&amp;L</div>
                      <div style={{ color: pnlColor, fontSize: "14px", fontWeight: 700, fontFamily: "'Inter',system-ui,sans-serif", lineHeight: 1.15 }}>{pctStr}</div>
                      <div style={{ color: pnlColor, fontSize: "10.5px", fontWeight: 500, fontFamily: "'Inter',system-ui,sans-serif", opacity: 0.82 }}>{diffStr}</div>
                    </div>
                  </foreignObject>
                </g>
              );
            })()
          : null;

        if (!isSelected) {
          if (!livePnlOverlay) return null;
          return <g opacity={op} shapeRendering="geometricPrecision">{livePnlOverlay}</g>;
        }

        return (
          <g opacity={op} shapeRendering="geometricPrecision">
            {livePnlOverlay}
            {/* Transparent body hit-area — lets the user select / move the drawing */}
            <rect
              x={ELX} y={totalTop}
              width={Math.max(ZW, 8)} height={Math.max(totalH, 20)}
              fill="transparent"
              {...hitProps}
            />
            {/* 4 TradingView-style position handles */}
            {tvHandle(ELX, tpY,  "ns-resize", 10, "lt")}
            {tvHandle(ELX, slY,  "ns-resize", 11, "lb")}
            {tvHandle(ELX, entY, "ns-resize", 12, "lm")}
            {tvHandle(ERX, entY, "ew-resize", 13, "rm")}
          </g>
        );
      }

      return (
        <g opacity={op} {...eraseClick} shapeRendering="geometricPrecision">

          {/* ── clipPath defs ── */}
          <defs>
            {/* Box clip: constrains live fill strictly inside the position rectangle */}
            <clipPath id={`box-clip-${drawing.id}`}>
              <rect x={ELX} y={totalTop} width={ZW} height={Math.max(totalH, 1)} />
            </clipPath>
            {profitH >= LBL_H + 2 && (
              <clipPath id={tpClipId}>
                <rect x={ELX} y={targetBarY} width={ZW} height={LBL_H} />
              </clipPath>
            )}
            {lossH >= LBL_H + 2 && (
              <clipPath id={slClipId}>
                <rect x={ELX} y={stopBarY} width={ZW} height={LBL_H} />
              </clipPath>
            )}
          </defs>

          {/* ══ LAYER 1 — tpZone ═════════════════════════════════════════════════
               Background dim fill always spans the full profit zone.
               On TP_HIT an additional bright active fill is overlaid,
               capped at the hit candle — both fills remain visible.           */}
          {profitH > 0 && (
            <>
              {/* Background: always full-width dim green */}
              <rect
                x={ELX} y={profitTop} width={ZW} height={profitH}
                fill={TP_STATIC}
                style={{ pointerEvents: "none" }}
              />
              {/* Active overlay: bright green capped at TP hit candle */}
              {tradeStatus === "TP_HIT" && activeFillW > 0 && (
                <rect
                  x={activeFillStartX} y={profitTop}
                  width={activeFillW} height={profitH}
                  fill={PROFIT_ACTIVE}
                  style={{ pointerEvents: "none" }}
                />
              )}
            </>
          )}

          {/* ══ LAYER 2 — slZone ═════════════════════════════════════════════════
               Background dim fill always spans the full loss zone.
               On SL_HIT an additional bright active fill is overlaid,
               capped at the hit candle — both fills remain visible.           */}
          {lossH > 0 && (
            <>
              {/* Background: always full-width dim red */}
              <rect
                x={ELX} y={lossTop} width={ZW} height={lossH}
                fill={SL_STATIC}
                style={{ pointerEvents: "none" }}
              />
              {/* Active overlay: bright red capped at SL hit candle */}
              {tradeStatus === "SL_HIT" && activeFillW > 0 && (
                <rect
                  x={activeFillStartX} y={lossTop}
                  width={activeFillW} height={lossH}
                  fill={LOSS_ACTIVE}
                  style={{ pointerEvents: "none" }}
                />
              )}
            </>
          )}

          {/* ══ LAYER 3 — liveProgressLayer (RUNNING only) ═══════════════════════
               Bright fill spanning entry price → current price (vertical),
               entry candle → current candle (horizontal).
               Height is DYNAMIC — tracks live price, never fills the full zone.
               Cleared immediately on TP_HIT or SL_HIT.                        */}
          {tradeStatus === "RUNNING" && lastActiveBar && currentPriceY !== null && (() => {
            const inProfitSide = isLong
              ? lastActiveBar.close >= entryPrice
              : lastActiveBar.close <= entryPrice;
            // Loss state: use only the clean static SL zone (LAYER 2) — no bright
            // overlay so no hard vertical right-edge boundary appears near the candle.
            if (!inProfitSide) return null;
            const liveTop = Math.min(entY, currentPriceY);
            const liveH   = Math.abs(currentPriceY - entY);
            if (liveH < 1) return null;
            return (
              // Full box width; box-clip prevents the fill from escaping above the
              // TP line or below the SL line when price moves past those levels.
              <rect
                x={ELX} y={liveTop}
                width={ZW} height={liveH}
                fill={PROFIT_ACTIVE}
                clipPath={`url(#box-clip-${drawing.id})`}
                style={{ pointerEvents: "none" }}
              />
            );
          })()}


          {/* ══ LIVE MEASUREMENT LINE + P&L LABEL (RUNNING only) ══════════════════
               Diagonal dashed line from the entry anchor to the current live
               candle price, plus a floating P&L badge to the right.          */}
          {tradeStatus === "RUNNING" && lastActiveBar && currentPriceY !== null && (() => {
            const lineX1 = ELX + halfBarW;
            const lineY1 = entY;
            const lineX2 = activeFillEndX;
            const lineY2 = currentPriceY;

            const livePriceDiff = isLong
              ? lastActiveBar.close - entryPrice
              : entryPrice - lastActiveBar.close;

            const inProfit  = moveInProfit;
            const pnlColor  = inProfit ? "rgba(0,255,170,1)"       : "rgba(255,90,110,1)";
            const borderClr = inProfit ? "rgba(0,255,180,0.65)"    : "rgba(255,90,110,0.65)";
            const glowClr   = inProfit ? "rgba(0,255,180,0.18)"    : "rgba(255,90,110,0.18)";

            const sign    = floatPct >= 0 ? "+" : "";
            const pctStr  = `${sign}${floatPct.toFixed(2)}%`;
            const diffSign = livePriceDiff >= 0 ? "+" : "";
            const diffStr = `${diffSign}${fmt(Math.abs(livePriceDiff))}`;

            const LBL_W = 150;
            const LBL_H = 72;
            // Place label to the right of the current candle; clamp so it stays in view
            const rawLblX = lineX2 + 10;
            const LBL_X   = Math.min(rawLblX, W - LBL_W - 4);
            const LBL_Y   = lineY2 - LBL_H / 2;

            return (
              <g style={{ pointerEvents: "none" }}>
                {/* Diagonal dashed measurement line */}
                <line
                  x1={lineX1} y1={lineY1}
                  x2={lineX2} y2={lineY2}
                  stroke="rgba(255,255,255,0.28)"
                  strokeWidth={1.5}
                  strokeDasharray="6 6"
                  strokeLinecap="round"
                  opacity={0.8}
                />
                {/* Floating P&L label */}
                <foreignObject x={LBL_X} y={LBL_Y} width={LBL_W} height={LBL_H}
                  pointerEvents="none" style={{ overflow: "visible" }}>
                  <div
                    style={{
                      background:     "rgba(20,24,27,0.92)",
                      border:         `2px solid ${borderClr}`,
                      borderRadius:   "10px",
                      padding:        "6px 10px",
                      backdropFilter: "blur(8px)",
                      WebkitBackdropFilter: "blur(8px)",
                      boxShadow:      `0 0 14px ${glowClr}`,
                      width:          `${LBL_W}px`,
                      height:         `${LBL_H}px`,
                      boxSizing:      "border-box",
                      display:        "flex",
                      flexDirection:  "column",
                      justifyContent: "center",
                      gap:            "3px",
                      userSelect:     "none",
                      pointerEvents:  "none",
                    }}
                  >
                    <div style={{
                      color:       "rgba(255,255,255,0.96)",
                      fontSize:    "9.5px",
                      fontWeight:  600,
                      letterSpacing: "0.08em",
                      fontFamily:  "'Inter',system-ui,sans-serif",
                      textTransform: "uppercase",
                    }}>Live P&amp;L</div>
                    <div style={{
                      color:      pnlColor,
                      fontSize:   "14px",
                      fontWeight: 700,
                      fontFamily: "'Inter',system-ui,sans-serif",
                      lineHeight: 1.15,
                    }}>{pctStr}</div>
                    <div style={{
                      color:      pnlColor,
                      fontSize:   "10.5px",
                      fontWeight: 500,
                      fontFamily: "'Inter',system-ui,sans-serif",
                      opacity:    0.82,
                    }}>{diffStr}</div>
                  </div>
                </foreignObject>
              </g>
            );
          })()}

          {/* Entry progress stroke — shown only on completion */}
          {tradeStatus !== "RUNNING" && activeFillW > 4 && (
            <line
              x1={ELX} y1={entY} x2={profitSplitX} y2={entY}
              stroke={PROGRESS_CLR} strokeWidth={3} strokeLinecap="round"
              style={{ pointerEvents: "none" }}
            />
          )}


          {/* ── Exit marker (TP_HIT / SL_HIT) — dashed line + badge at exit candle ── */}
          {tradeStatus !== "RUNNING" && activeFillW > 4 && totalH > 0 && (() => {
            const isTP      = tradeStatus === "TP_HIT";
            const exitPrice = isTP ? tpPrice  : slPrice;
            const exitY     = isTP ? tpY      : slY;
            const exitClr   = isTP ? TP_CLR_SOLID : SL_CLR_SOLID;
            const exitIcon  = isTP ? "✓ TP"   : "✗ SL";
            const pctStr    = `${floatPct >= 0 ? "+" : ""}${floatPct.toFixed(2)}%`;
            const badgeTxt  = `${exitIcon}   ${fmt(exitPrice)}   ${pctStr}`;
            const badgeW    = badgeTxt.length * 6.8 + 18;
            const badgeH    = 24;
            const badgeX    = activeFillEndX + 5;
            const badgeY    = exitY - badgeH / 2;

            return (
              <g style={{ pointerEvents: "none" }}>
                {/* Exit badge — only when there's room */}
                {badgeW > 60 && (
                  <>
                    <rect x={badgeX} y={badgeY} width={badgeW} height={badgeH} rx={5}
                      fill="rgba(6,12,24,0.93)" stroke={exitClr} strokeWidth={1.5} />
                    <text x={badgeX + badgeW / 2} y={badgeY + 15.5}
                      textAnchor="middle" fontSize={10.5} fontWeight={700} fill={exitClr}
                      fontFamily="'Inter',system-ui,sans-serif">
                      {badgeTxt}
                    </text>
                  </>
                )}
              </g>
            );
          })()}

          {/* ── Boundary lines — always visible regardless of trade outcome ── */}
          <line x1={ELX} y1={tpY}  x2={ERX} y2={tpY}
            stroke={TP_LINE} strokeWidth={tpWasHit ? 2 : 1.5} strokeLinecap="round"
            style={{ pointerEvents: "none" }} />
          <line x1={ELX} y1={entY} x2={ERX} y2={entY}
            stroke={ENT_LINE} strokeWidth={1.5} strokeDasharray="7 4" strokeLinecap="round"
            style={{ pointerEvents: "none" }} />
          <line x1={ELX} y1={slY}  x2={ERX} y2={slY}
            stroke={SL_LINE} strokeWidth={slWasHit ? 2 : 1.5} strokeLinecap="round"
            style={{ pointerEvents: "none" }} />

          {/* ── Target label bar — always visible ── */}
          {profitH >= LBL_H + 2 && visZW >= 60 && (
            <g style={{ pointerEvents: "none" }}>
              <rect x={ELX} y={targetBarY} width={ZW} height={LBL_H}
                fill={TP_BAR} fillOpacity={0.93} rx={2} />
              <text x={visELX + 8} y={targetBarY + 18}
                fontSize={11} fontWeight={700} fill="#ffffff"
                fontFamily="'Inter',system-ui,sans-serif"
                clipPath={`url(#${tpClipId})`}>
                {`Target: ${fmt(tpPrice)}  (${tpPct.toFixed(2)}%)  R:R ${rrStr}`}
              </text>
            </g>
          )}

          {/* ── Stop label bar — always visible ── */}
          {lossH >= LBL_H + 2 && visZW >= 60 && (
            <g style={{ pointerEvents: "none" }}>
              <rect x={ELX} y={stopBarY} width={ZW} height={LBL_H}
                fill={SL_BAR} fillOpacity={0.93} rx={2} />
              <text x={visELX + 8} y={stopBarY + 18}
                fontSize={11} fontWeight={700} fill="#ffffff"
                fontFamily="'Inter',system-ui,sans-serif"
                clipPath={`url(#${slClipId})`}>
                {`Stop: ${fmt(slPrice)}  (${slPct.toFixed(2)}%)`}
              </text>
            </g>
          )}


          {/* ── Selection border glow ── */}
          {isSelected && !isPreview && (
            <rect x={ELX} y={totalTop} width={ZW} height={Math.max(totalH, 20)}
              fill="none"
              stroke={H_BLUE} strokeWidth={1.2} strokeOpacity={0.38}
              rx={2}
              style={{ pointerEvents: "none" }}
            />
          )}

          {/* ── Body hit / drag area ── */}
          <rect x={ELX} y={totalTop} width={Math.max(ZW, 8)} height={Math.max(totalH, 20)}
            fill="transparent"
            {...hitProps}
          />

          {/* ── 4 TradingView-style position handles ── */}
          {/* Left Top    — vertical only → adjusts TP price */}
          {tvHandle(ELX, tpY,                     "ns-resize", 10, "lt")}
          {/* Left Bottom — vertical only → adjusts SL price */}
          {tvHandle(ELX, slY,                     "ns-resize", 11, "lb")}
          {/* Left Middle — vertical only → shifts entire entry (all prices) */}
          {tvHandle(ELX, entY,                    "ns-resize", 12, "lm")}
          {/* Right Middle — horizontal only → resizes width/time range */}
          {tvHandle(ERX, entY,                    "ew-resize", 13, "rm")}
        </g>
      );
    }

    case "ruler": {
      if (px.length < 2 || points.length < 2) return null;
      const priceDiff  = Math.abs(points[1].price - points[0].price);
      const pricePct   = ((points[1].price - points[0].price) / points[0].price * 100).toFixed(2);
      const midX = (px[0].x + px[1].x) / 2;
      const midY = (px[0].y + px[1].y) / 2;
      const d = `M ${px[0].x.toFixed(1)} ${px[0].y.toFixed(1)} L ${px[1].x.toFixed(1)} ${px[1].y.toFixed(1)}`;
      return (
        <g opacity={op} {...eraseClick}>
          <Glow d={d} />
          <path d={d} stroke="transparent" strokeWidth={HIT} fill="none" {...hitProps} />
          <path d={d} stroke={col} strokeWidth={sw} strokeDasharray="6 3" fill="none" />
          <path d={`M ${px[0].x - 4} ${px[0].y.toFixed(1)} L ${px[0].x + 4} ${px[0].y.toFixed(1)}`} stroke={col} strokeWidth={1.5} fill="none" />
          <path d={`M ${px[1].x - 4} ${px[1].y.toFixed(1)} L ${px[1].x + 4} ${px[1].y.toFixed(1)}`} stroke={col} strokeWidth={1.5} fill="none" />
          <rect x={midX - 48} y={midY - 13} width={96} height={24} rx={5} fill="rgba(9,18,14,0.9)" stroke={col} strokeWidth={1} strokeOpacity={0.5} />
          <text x={midX} y={midY + 4} fontSize={11} fill={col} fontFamily="'JetBrains Mono','Fira Code',monospace" textAnchor="middle" fontWeight={700}>
            {priceDiff.toFixed(2)} ({pricePct}%)
          </text>
          <Anchor i={0} p={px[0]} />
          <Anchor i={1} p={px[1]} />
        </g>
      );
    }

    default:
      return null;
  }
});

// ── Floating mini toolbar & drawing style panel ───────────────────────────────
const STYLE_COLORS = [
  "#B7FF5A", "#34d399", "#38bdf8", "#818cf8", "#f472b6",
  "#f59e0b", "#fb923c", "#f87171", "#e2e8f0", "#ffffff",
];

// Tools that support line-extend feature
const LINE_TOOLS = new Set<ToolType>(["trendline","ray","extended","hline","vline","channel"]);

// ── TV-style icon button ───────────────────────────────────────────────────────
function TvBtn({ onClick, title, active, danger, wide, children }: {
  onClick?: () => void; title: string; active?: boolean;
  danger?: boolean; wide?: boolean; children: React.ReactNode;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button title={title} onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        minWidth: wide ? 60 : 36, height: 36, borderRadius: 7,
        display: "flex", alignItems: "center", justifyContent: "center", gap: 3,
        border: `1px solid ${active ? "rgba(255,255,255,0.13)" : "transparent"}`,
        cursor: "pointer", flexShrink: 0, padding: "0 5px",
        background: active ? "rgba(255,255,255,0.10)" : hov ? "rgba(255,255,255,0.08)" : "transparent",
        color: danger
          ? (hov ? "#f05050" : "rgba(200,200,210,0.82)")
          : (active ? "#ffffff" : hov ? "#e8ecf0" : "rgba(200,205,215,0.82)"),
        transition: "background .12s, border-color .12s, color .12s",
        outline: "none",
      }}>
      {children}
    </button>
  );
}

const TvSep = () => (
  <div style={{ width: 1, height: 22, background: "rgba(255,255,255,0.09)", margin: "0 3px", flexShrink: 0 }} />
);

// ── Inline thickness popup ─────────────────────────────────────────────────────
function ThicknessPopup({ current, anchor, onSelect, onClose }: {
  current: number; anchor: DOMRect | null;
  onSelect: (t: number) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePopup("drawing-thickness-popup", ref, onClose);

  const left = anchor ? anchor.left : 0;
  const top  = anchor ? anchor.top - 8 - (5 * 36) : 0;

  return createPortal(
    <div ref={ref} data-drawing-popup
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: "fixed", left: Math.max(4, left - 8), top: Math.max(4, top),
        zIndex: 220, background: "rgba(22,24,28,0.98)", backdropFilter: "blur(16px)",
        border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10,
        boxShadow: "0 8px 28px rgba(0,0,0,0.65)",
        padding: "4px",
        display: "flex", flexDirection: "column", gap: 2,
      }}>
      {[1,2,3,4,5].map(t => (
        <button key={t} onClick={() => { onSelect(t); onClose(); }}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "6px 12px",
            background: current === t ? "rgba(255,255,255,0.09)" : "transparent",
            border: "none", cursor: "pointer", borderRadius: 7, width: 100,
          }}>
          <div style={{ flex: 1, height: t, background: current === t ? "#e2e8f0" : "rgba(175,180,190,0.7)", borderRadius: 2 }} />
          <span style={{ fontSize: 11, color: current === t ? "#e2e8f0" : "rgba(175,180,190,0.7)", fontFamily: "monospace", flexShrink: 0 }}>{t}px</span>
        </button>
      ))}
    </div>,
    document.body
  );
}

// ── Inline line-style popup ───────────────────────────────────────────────────
function LineStylePopup({ current, anchor, onSelect, onClose }: {
  current: "solid"|"dashed"|"dotted"; anchor: DOMRect | null;
  onSelect: (s: "solid"|"dashed"|"dotted") => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePopup("drawing-linestyle-popup", ref, onClose);

  const left = anchor ? anchor.left : 0;
  const top  = anchor ? anchor.top - 8 - (3 * 40) : 0;

  const styles: { key: "solid"|"dashed"|"dotted"; dash?: string; label: string }[] = [
    { key: "solid",  label: "Solid" },
    { key: "dashed", dash: "8 4",  label: "Dashed" },
    { key: "dotted", dash: "2 4",  label: "Dotted" },
  ];

  return createPortal(
    <div ref={ref} data-drawing-popup
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: "fixed", left: Math.max(4, left - 8), top: Math.max(4, top),
        zIndex: 220, background: "rgba(22,24,28,0.98)", backdropFilter: "blur(16px)",
        border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10,
        boxShadow: "0 8px 28px rgba(0,0,0,0.65)",
        padding: "4px",
        display: "flex", flexDirection: "column", gap: 2,
      }}>
      {styles.map(({ key, dash, label }) => (
        <button key={key} onClick={() => { onSelect(key); onClose(); }}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
            background: current === key ? "rgba(255,255,255,0.09)" : "transparent",
            border: "none", cursor: "pointer", borderRadius: 7, width: 120,
          }}>
          <svg width={40} height={10}>
            <line x1={0} y1={5} x2={40} y2={5}
              stroke={current === key ? "#e2e8f0" : "rgba(175,180,190,0.7)"}
              strokeWidth={1.5} strokeDasharray={dash} strokeLinecap="round"/>
          </svg>
          <span style={{ fontSize: 11, color: current === key ? "#e2e8f0" : "rgba(175,180,190,0.7)" }}>{label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}

// ── Template helpers ──────────────────────────────────────────────────────────
const TMPL_KEY = "tv_drawing_templates_v1";
function loadTemplate(toolType: ToolType): Partial<DrawingStyle> | null {
  try { const r = localStorage.getItem(TMPL_KEY); if (!r) return null; return (JSON.parse(r) as Record<string, Partial<DrawingStyle>>)[toolType] ?? null; } catch { return null; }
}
function saveTemplate(toolType: ToolType, style: DrawingStyle): void {
  try { const r = localStorage.getItem(TMPL_KEY); const a = r ? JSON.parse(r) as Record<string, Partial<DrawingStyle>> : {}; a[toolType] = style; localStorage.setItem(TMPL_KEY, JSON.stringify(a)); } catch {}
}

// ── Text-label popup ──────────────────────────────────────────────────────────
function TextLabelPopup({ current, anchor, onApply, onClose }: {
  current: string; anchor: DOMRect | null;
  onApply: (t: string) => void; onClose: () => void;
}) {
  const ref      = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [val, setVal] = useState(current);
  usePopup("drawing-textlabel-popup", ref, onClose);
  useEffect(() => { const t = setTimeout(() => inputRef.current?.focus(), 60); return () => clearTimeout(t); }, []);

  const left = anchor ? anchor.left - 8 : 0;
  const top  = anchor ? anchor.bottom + 6 : 0;

  return createPortal(
    <div ref={ref} data-drawing-popup onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
      style={{ position:"fixed", left:Math.max(4,left), top:Math.max(4,top), zIndex:220,
        background:"rgba(22,24,28,0.98)", backdropFilter:"blur(16px)",
        border:"1px solid rgba(255,255,255,0.09)", borderRadius:10,
        boxShadow:"0 8px 28px rgba(0,0,0,0.65)", padding:"10px", display:"flex", flexDirection:"column", gap:8, minWidth:210 }}>
      <span style={{ fontSize:10, fontWeight:700, color:"rgba(200,205,215,0.5)", textTransform:"uppercase", letterSpacing:".07em" }}>Drawing label</span>
      <input ref={inputRef} value={val} onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key==="Enter"){ onApply(val); onClose(); } if (e.key==="Escape") onClose(); }}
        placeholder="Enter label text…"
        style={{ width:"100%", padding:"7px 10px", borderRadius:7,
          background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.12)",
          color:"#e8ecf0", fontSize:13, outline:"none", fontFamily:"inherit", boxSizing:"border-box" }} />
      <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
        {val && <button onClick={() => { onApply(""); onClose(); }}
          style={{ padding:"5px 10px", borderRadius:6, background:"transparent", border:"1px solid rgba(255,255,255,0.1)", color:"rgba(200,205,215,0.7)", fontSize:11, cursor:"pointer" }}>Clear</button>}
        <button onClick={() => { onApply(val); onClose(); }}
          style={{ padding:"5px 12px", borderRadius:6, background:"rgba(183,255,90,0.13)", border:"1px solid rgba(183,255,90,0.3)", color:"#B7FF5A", fontSize:11, fontWeight:600, cursor:"pointer" }}>Apply</button>
      </div>
    </div>,
    document.body
  );
}

// ── Template popup ────────────────────────────────────────────────────────────
function TemplatePopup({ toolType, style, anchor, onApply, onClose }: {
  toolType: ToolType; style: DrawingStyle; anchor: DOMRect | null;
  onApply: (patch: Partial<DrawingStyle>) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePopup("drawing-template-popup", ref, onClose);
  const saved = loadTemplate(toolType);

  const left = anchor ? anchor.left - 8 : 0;
  const top  = anchor ? anchor.bottom + 6 : 0;

  function TmplItem({ label, sub, onClick, accent }: { label: string; sub?: string; onClick: () => void; accent?: boolean }) {
    const [hov, setHov] = useState(false);
    return (
      <button onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={onClick}
        style={{ display:"flex", flexDirection:"column", alignItems:"flex-start", padding:"8px 12px", width:"100%",
          background:hov?"rgba(255,255,255,0.07)":"transparent", border:"none", cursor:"pointer", borderRadius:7, gap:1 }}>
        <span style={{ fontSize:12, fontWeight:500, color:accent?"#B7FF5A":"#e8ecf0" }}>{label}</span>
        {sub && <span style={{ fontSize:10, color:"rgba(200,205,215,0.4)" }}>{sub}</span>}
      </button>
    );
  }

  return createPortal(
    <div ref={ref} data-drawing-popup onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
      style={{ position:"fixed", left:Math.max(4,left), top:Math.max(4,top), zIndex:220,
        background:"rgba(22,24,28,0.98)", backdropFilter:"blur(16px)",
        border:"1px solid rgba(255,255,255,0.09)", borderRadius:10,
        boxShadow:"0 8px 28px rgba(0,0,0,0.65)", padding:"4px", display:"flex", flexDirection:"column", minWidth:210 }}>
      <TmplItem label="Save as template" sub={`Default style for all ${toolType} drawings`}
        onClick={() => { saveTemplate(toolType, style); onClose(); }} />
      {saved && <>
        <TmplItem label="Apply template" sub="Restore saved style" accent
          onClick={() => { onApply(saved); onClose(); }} />
      </>}
      <div style={{ height:1, background:"rgba(255,255,255,0.07)", margin:"2px 8px" }} />
      <TmplItem label="Reset to default" sub="Restore factory defaults"
        onClick={() => { onApply(DEFAULT_STYLE); onClose(); }} />
    </div>,
    document.body
  );
}

// ── TradingView-style floating toolbar ────────────────────────────────────────
const FloatingMiniToolbar = memo(function FloatingMiniToolbar({ pos, drawing, visible = true, onStylePanel, onAlert, onHide, onDelete, onLock, onUpdate }: {
  pos: { x: number; y: number };
  drawing: Drawing;
  visible?: boolean;
  onStylePanel: () => void;
  onAlert: () => void;
  onHide: () => void;
  onDelete: () => void;
  onLock: () => void;
  onUpdate: (patch: Partial<DrawingStyle>) => void;
}) {
  const [showThick,       setShowThick]       = useState(false);
  const [showLS,          setShowLS]          = useState(false);
  const [showMore,        setShowMore]        = useState(false);
  const [showText,        setShowText]        = useState(false);
  const [showTemplate,    setShowTemplate]    = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [userPos,         setUserPos]         = useState<{ x: number; y: number } | null>(null);
  const pencilBtnRef = useRef<HTMLDivElement>(null);
  const dragOriginRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const dragRafRef    = useRef<number | null>(null);
  const prevDrawingId = useRef(drawing.id);

  const thickRef       = useRef<HTMLDivElement>(null);
  const lsRef          = useRef<HTMLDivElement>(null);
  const moreMenuRef    = useRef<HTMLDivElement>(null);
  const textBtnRef     = useRef<HTMLDivElement>(null);
  const templateBtnRef = useRef<HTMLDivElement>(null);
  usePopup("drawing-more-menu", moreMenuRef, () => setShowMore(false), showMore);

  useEffect(() => {
    if (!visible) { setShowThick(false); setShowLS(false); setShowMore(false); setShowText(false); setShowTemplate(false); setShowColorPicker(false); }
  }, [visible]);

  useEffect(() => {
    if (drawing.id !== prevDrawingId.current) {
      prevDrawingId.current = drawing.id;
      setUserPos(null);
    }
  }, [drawing.id]);

  const TW = 390, TH = 46;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = pos.x - TW / 2;
  const belowY = pos.y + 14;
  const flipsAbove = belowY + TH > vh - 8;
  let top = flipsAbove ? Math.max(8, pos.y - TH - 14) : belowY;
  left = Math.max(8, Math.min(left, vw - TW - 8));
  top  = Math.max(8, Math.min(top, vh - TH - 8));

  const finalLeft = userPos ? userPos.x : left;
  const finalTop  = userPos ? userPos.y : top;

  const isDraggingRef   = useRef(false);
  const dragElemRef     = useRef<HTMLElement | null>(null);
  const dragPointerRef  = useRef<number | null>(null);

  const onToolbarPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX - rect.left < rect.width * 0.2) {
      // Record intent but do NOT capture yet — capture only after real movement
      // so that clicks on buttons inside the left-20% zone still fire normally.
      dragOriginRef.current = { startX: e.clientX, startY: e.clientY, originX: finalLeft, originY: finalTop };
      dragElemRef.current    = e.currentTarget as HTMLElement;
      dragPointerRef.current = e.pointerId;
    }
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragOriginRef.current) return;
    const dx = e.clientX - dragOriginRef.current.startX;
    const dy = e.clientY - dragOriginRef.current.startY;
    // Only commit to drag after 4 px of movement — keeps taps / clicks working
    if (!isDraggingRef.current) {
      if (Math.hypot(dx, dy) < 4) return;
      isDraggingRef.current = true;
      dragElemRef.current?.setPointerCapture(dragPointerRef.current!);
    }
    const nx = Math.max(4, Math.min(vw - TW - 4, dragOriginRef.current.originX + dx));
    const ny = Math.max(4, Math.min(vh - TH - 4, dragOriginRef.current.originY + dy));
    if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current);
    dragRafRef.current = requestAnimationFrame(() => setUserPos({ x: nx, y: ny }));
  };
  const onDragUp = () => { dragOriginRef.current = null; isDraggingRef.current = false; dragElemRef.current = null; dragPointerRef.current = null; };

  const isMobile = useIsMobile();
  const S = drawing.style;
  const isLineTool = LINE_TOOLS.has(drawing.toolType);

  // On mobile the DrawingMiniBar inside MobileChartLayout handles editing
  if (isMobile) return null;

  return createPortal(
    <>
      <style>{`
        @keyframes tvFlipDown {
          from { opacity:0.3; transform: perspective(500px) rotateX(-90deg); }
          to   { opacity:1;   transform: perspective(500px) rotateX(0deg); }
        }
        @keyframes tvFlipUp {
          from { opacity:0.3; transform: perspective(500px) rotateX(90deg); }
          to   { opacity:1;   transform: perspective(500px) rotateX(0deg); }
        }
      `}</style>
      <div data-drawing-popup data-drawing-toolbar
        onClick={e => e.stopPropagation()}
        onPointerDown={onToolbarPointerDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        onPointerCancel={onDragUp}
        style={{
          position: "fixed", left: finalLeft, top: finalTop, zIndex: 200,
          display: "flex", alignItems: "center", gap: 2,
          background: "rgba(30,32,38,0.97)", backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10,
          padding: "5px 8px",
          boxShadow: "0 4px 24px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.04) inset",
          animation: visible ? `${flipsAbove ? "tvFlipUp" : "tvFlipDown"} .22s cubic-bezier(0.16,1,0.3,1) both` : "none",
          transformOrigin: flipsAbove ? "bottom center" : "top center",
          userSelect: "none",
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? "all" : "none",
          transition: visible ? "none" : "opacity 0.08s ease",
          willChange: "transform, opacity",
          cursor: dragOriginRef.current ? "grabbing" : "default",
          touchAction: "none",
        }}>

        {/* ── Drag handle — 2×3 grid dots + invisible wide hit-zone for left-20% */}
        <div
          title="Drag to reposition"
          style={{
            position: "relative",
            display: "flex", alignItems: "center", flexShrink: 0,
            paddingLeft: 2, paddingRight: 7, marginRight: 1,
            borderRight: "1px solid rgba(255,255,255,0.08)",
            cursor: "grab",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, padding: "2px 1px" }}>
            {[0,1,2,3,4,5].map(i => (
              <div key={i} style={{ width: 3, height: 3, borderRadius: "50%", background: "rgba(255,255,255,0.35)" }} />
            ))}
          </div>
        </div>

        {/* ── Template */}
        <div ref={templateBtnRef} style={{ display:"inline-flex" }}>
          <TvBtn title="Template" active={showTemplate} onClick={() => { setShowTemplate(v => !v); setShowText(false); setShowThick(false); setShowLS(false); setShowColorPicker(false); }}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="7" height="7" rx="1.2"/>
              <rect x="11" y="2" width="7" height="7" rx="1.2"/>
              <rect x="2" y="11" width="7" height="7" rx="1.2"/>
              <line x1="14.5" y1="11" x2="14.5" y2="18"/>
              <line x1="11" y1="14.5" x2="18" y2="14.5"/>
            </svg>
          </TvBtn>
        </div>

        <TvSep />

        {/* ── Pencil (line colour) + color swatch */}
        <div ref={pencilBtnRef} style={{ display:"inline-flex" }}>
          <TvBtn title="Line colour" active={showColorPicker} onClick={() => {
            setShowColorPicker(v => !v);
            setShowThick(false); setShowLS(false); setShowText(false); setShowTemplate(false);
          }}>
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2 }}>
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                <path d="m15 5 4 4"/>
              </svg>
              <div style={{ width:16, height:3, borderRadius:1.5, background: S.color }} />
            </div>
          </TvBtn>
        </div>

        {/* ── Text colour + swatch */}
        <div ref={textBtnRef} style={{ display:"inline-flex" }}>
          <TvBtn title="Text colour / label" active={showText} onClick={() => { setShowText(v => !v); setShowTemplate(false); setShowThick(false); setShowLS(false); setShowColorPicker(false); }}>
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2 }}>
              <span style={{ fontSize:19, fontFamily:"Georgia,'Times New Roman',serif", fontWeight:700, lineHeight:1, color:"inherit", display:"block" }}>T</span>
              <div style={{ width:16, height:3, borderRadius:1.5, background: S.color }} />
            </div>
          </TvBtn>
        </div>

        <TvSep />

        {/* ── Alert */}
        <TvBtn title="Add price alert" onClick={onAlert}>
          <img src={icoAlertUrl} width={18} height={18} draggable={false}
            style={{ display:"block", filter:"brightness(0) invert(1)", opacity:0.8, userSelect:"none", pointerEvents:"none" }} />
        </TvBtn>

        <TvSep />

        {/* ── Thickness */}
        <div ref={thickRef} style={{ display:"inline-flex" }}>
          <TvBtn wide title="Line thickness" onClick={() => { setShowThick(v => !v); setShowLS(false); }}>
            <svg width="14" height="3" viewBox="0 0 14 3">
              <rect x="0" y="0.5" width="14" height={Math.min(S.thickness, 2.5)} rx="1" fill="currentColor"/>
            </svg>
            <span style={{ fontSize:11, fontFamily:"ui-monospace,monospace", marginLeft:3, whiteSpace:"nowrap" }}>{S.thickness}px</span>
          </TvBtn>
        </div>

        {/* ── Line style */}
        <div ref={lsRef} style={{ display:"inline-flex" }}>
          <TvBtn title="Line style" onClick={() => { setShowLS(v => !v); setShowThick(false); }}>
            <svg width="24" height="8" viewBox="0 0 24 8">
              <line x1="0" y1="4" x2="24" y2="4"
                stroke="currentColor" strokeWidth="1.6"
                strokeDasharray={S.lineStyle==="dashed" ? "6 3" : S.lineStyle==="dotted" ? "1.5 3" : undefined}
                strokeLinecap="round"/>
            </svg>
          </TvBtn>
        </div>

        <TvSep />

        {/* ── Delete (bin) */}
        <TvBtn title="Delete drawing" danger onClick={onDelete}>
          <img src={icoBinUrl} width={17} height={17} draggable={false}
            style={{ display:"block", filter:"brightness(0) invert(1)", opacity:0.8, userSelect:"none", pointerEvents:"none" }} />
        </TvBtn>

        <TvSep />

        {/* ── More (3 dots) */}
        <TvBtn title="More options" active={showMore} onClick={() => setShowMore(v => !v)}>
          <img src={ico3DotsUrl} width={20} height={20} draggable={false}
            style={{ display:"block", filter:"brightness(0) invert(1)", opacity: showMore ? 1 : 0.8, userSelect:"none", pointerEvents:"none" }} />
        </TvBtn>
      </div>

      {/* Thickness popup */}
      {showThick && (
        <ThicknessPopup
          current={S.thickness}
          anchor={thickRef.current?.getBoundingClientRect() ?? null}
          onSelect={t => onUpdate({ thickness: t })}
          onClose={() => setShowThick(false)}
        />
      )}

      {/* Line style popup */}
      {showLS && (
        <LineStylePopup
          current={S.lineStyle}
          anchor={lsRef.current?.getBoundingClientRect() ?? null}
          onSelect={s => onUpdate({ lineStyle: s })}
          onClose={() => setShowLS(false)}
        />
      )}

      {/* Text label popup */}
      {showText && (
        <TextLabelPopup
          current={S.text ?? ""}
          anchor={textBtnRef.current?.getBoundingClientRect() ?? null}
          onApply={t => onUpdate({ text: t || undefined })}
          onClose={() => setShowText(false)}
        />
      )}

      {/* Template popup */}
      {showTemplate && (
        <TemplatePopup
          toolType={drawing.toolType}
          style={S}
          anchor={templateBtnRef.current?.getBoundingClientRect() ?? null}
          onApply={patch => onUpdate(patch)}
          onClose={() => setShowTemplate(false)}
        />
      )}

      {/* Pencil colour picker */}
      {showColorPicker && (
        <ColorPickerGlass
          value={S.color}
          onChange={c => onUpdate({ color: c })}
          onClose={() => setShowColorPicker(false)}
          anchorRect={pencilBtnRef.current?.getBoundingClientRect() ?? null}
        />
      )}

      {/* More menu */}
      {showMore && createPortal(
        <div ref={moreMenuRef} data-drawing-popup
          onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
          style={{
            position: "fixed", left: Math.max(8, finalLeft + TW - 168), top: finalTop - 8 - 164,
            zIndex: 220, background: "rgba(16,18,21,0.98)", backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10,
            boxShadow: "0 8px 32px rgba(0,0,0,0.75)", padding: "4px",
            minWidth: 168,
          }}>
          <button onClick={() => { onStylePanel(); setShowMore(false); }} style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px",
            background: "transparent", border: "none", cursor: "pointer", borderRadius: 7,
            color: "rgba(200,205,215,0.85)", fontSize: 12, textAlign: "left",
          }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >
            <img src={icoSettingUrl} width={14} height={14} draggable={false} style={{ filter:"brightness(0) invert(1)", opacity:0.7 }} />
            Settings
          </button>
          <button onClick={() => { onLock(); setShowMore(false); }} style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px",
            background: "transparent", border: "none", cursor: "pointer", borderRadius: 7,
            color: drawing.isLocked ? "#B7FF5A" : "rgba(200,205,215,0.85)", fontSize: 12, textAlign: "left",
          }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >
            <img src={icoLockUrl} width={14} height={14} draggable={false} style={{ filter: drawing.isLocked ? "brightness(0) saturate(100%) invert(72%) sepia(60%) saturate(500%) hue-rotate(60deg) brightness(105%)" : "brightness(0) invert(1)", opacity:0.9 }} />
            {drawing.isLocked ? "Unlock" : "Lock"}
          </button>
          <div style={{ height:1, background:"rgba(255,255,255,0.06)", margin:"2px 8px" }} />
          {[
            { label: "Duplicate drawing",   icon: "⊕" },
            { label: "Clone to all charts", icon: "⊡" },
          ].map(item => (
            <button key={item.label} onClick={() => setShowMore(false)} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px",
              background: "transparent", border: "none", cursor: "pointer", borderRadius: 7,
              color: "rgba(200,205,215,0.85)", fontSize: 12, textAlign: "left",
            }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ fontSize: 14 }}>{item.icon}</span>{item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>,
    document.body
  );
});

const DrawingStylePanel = memo(function DrawingStylePanel({ drawing, pos, onUpdate, onClose }: {
  drawing: Drawing;
  pos: { x: number; y: number };
  onUpdate: (patch: Partial<DrawingStyle>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [colorAnchor,     setColorAnchor]     = useState<DOMRect | null>(null);
  // Local opacity for instant slider feedback — committed on pointerup
  const [localOpacity, setLocalOpacity] = useState(drawing.style.opacity ?? 1);
  const opRef = useRef(drawing.style.opacity ?? 1);

  useEffect(() => {
    const newOp = drawing.style.opacity ?? 1;
    setLocalOpacity(newOp);
    opRef.current = newOp;
  }, [drawing.style.opacity]);

  // No outside-click dismiss — panel closes via X button or when drawing is deselected.
  // (An outside-click listener would incorrectly close when clicking the drawing in the SVG
  //  or inside sibling portals like ThicknessPopup / LineStylePopup.)

  const PW = 236;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = pos.x - PW / 2;
  let top  = pos.y - 300;
  left = Math.max(8, Math.min(left, vw - PW - 8));
  if (top < 8) top = pos.y + 54;
  top = Math.min(top, vh - 310);

  const th = drawing.style.thickness;
  const ls = drawing.style.lineStyle;
  const col = drawing.style.color;

  return createPortal(
    <>
    <div ref={ref} data-drawing-popup
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: "fixed", left, top, zIndex: 210,
        width: PW,
        background: "rgba(10,15,11,0.99)", backdropFilter: "blur(8px)",
        border: "1px solid rgba(140,255,120,0.16)", borderRadius: 18,
        boxShadow: "0 16px 56px rgba(0,0,0,0.88)",
        animation: "popIn .12s ease-out",
      }}>
      <style>{`@keyframes popIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px 8px" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(215,225,215,0.85)", textTransform: "uppercase", letterSpacing: ".10em" }}>Drawing Style</span>
        <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, color: "rgba(215,225,215,0.7)" }}>
          <svg width={11} height={11} viewBox="0 0 11 11" fill="none"><path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"/></svg>
        </button>
      </div>
      <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

      {/* Color section */}
      <div style={{ padding: "10px 14px 10px" }}>
        <p style={{ fontSize: 10, color: "rgba(200,215,200,0.7)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, marginBottom: 8 }}>Color</p>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Clickable swatch → opens ColorPickerGlass */}
          <button
            ref={swatchRef}
            onClick={() => {
              if (swatchRef.current) setColorAnchor(swatchRef.current.getBoundingClientRect());
              setShowColorPicker(v => !v);
            }}
            title="Pick color"
            style={{
              width: 32, height: 32, borderRadius: 9, flexShrink: 0, cursor: "pointer",
              background: col,
              border: showColorPicker ? "2px solid rgba(255,255,255,0.9)" : "1.5px solid rgba(255,255,255,0.18)",
              boxShadow: showColorPicker ? `0 0 0 2px ${col}55, 0 0 12px ${col}60` : `0 0 8px ${col}40`,
              transition: "all .15s",
            }}
          />
          {/* Hex label (read-only display) */}
          <div style={{
            flex: 1, height: 32, borderRadius: 9,
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
            display: "flex", alignItems: "center", paddingLeft: 10, gap: 4,
          }}>
            <span style={{ fontSize: 10, color: "rgba(200,200,200,0.28)", fontFamily: "monospace" }}>#</span>
            <span style={{ fontSize: 12, color: "#F3FFF3", fontFamily: "monospace", fontWeight: 700, letterSpacing: ".04em" }}>
              {col.replace(/^#/, "").toUpperCase().slice(0, 6)}
            </span>
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

      {/* Opacity */}
      <div style={{ padding: "9px 14px 8px" }}>
        <p style={{ fontSize: 10, color: "rgba(200,215,200,0.7)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, marginBottom: 8 }}>Opacity</p>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <input type="range" min={0.05} max={1} step={0.05} value={localOpacity}
            onChange={e => { const v = parseFloat(e.target.value); setLocalOpacity(v); opRef.current = v; }}
            onPointerUp={() => onUpdate({ opacity: opRef.current })}
            style={{ flex: 1, accentColor: "#B7FF5A", cursor: "pointer", height: 4, willChange: "transform" }} />
          <span style={{ fontSize: 12, color: "rgba(215,225,215,0.9)", fontFamily: "monospace", width: 32, textAlign: "right", flexShrink: 0 }}>{Math.round(localOpacity * 100)}%</span>
        </div>
      </div>

      <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

      {/* Thickness */}
      <div style={{ padding: "9px 14px 8px" }}>
        <p style={{ fontSize: 10, color: "rgba(200,215,200,0.7)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, marginBottom: 8 }}>Thickness</p>
        <div style={{ display: "flex", gap: 4 }}>
          {[1,2,3,4,5,6].map(t => {
            const act = th === t;
            return (
              <button key={t} onClick={() => onUpdate({ thickness: t })}
                style={{ flex: 1, height: 28, borderRadius: 6, cursor: "pointer", background: act ? "rgba(183,255,90,0.1)" : "rgba(30,36,31,0.9)", border: `1px solid ${act ? "rgba(183,255,90,0.5)" : "rgba(60,65,61,0.5)"}`, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .1s" }}>
                <div style={{ width: "70%", height: t, background: act ? "#B7FF5A" : "rgba(170,170,170,0.4)", borderRadius: 3 }} />
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

      {/* Line style */}
      <div style={{ padding: "9px 14px 14px" }}>
        <p style={{ fontSize: 10, color: "rgba(200,215,200,0.7)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, marginBottom: 8 }}>Line Style</p>
        <div style={{ display: "flex", gap: 4 }}>
          {(["solid","dashed","dotted"] as const).map(s => {
            const act = ls === s;
            return (
              <button key={s} onClick={() => onUpdate({ lineStyle: s })}
                style={{ flex: 1, height: 28, borderRadius: 6, cursor: "pointer", background: act ? "rgba(183,255,90,0.1)" : "rgba(30,36,31,0.9)", border: `1px solid ${act ? "rgba(183,255,90,0.5)" : "rgba(60,65,61,0.5)"}`, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .1s" }}>
                <svg width={32} height={6}>
                  <line x1={0} y1={3} x2={32} y2={3} stroke={act ? "#B7FF5A" : "rgba(170,170,170,0.5)"} strokeWidth={1.5}
                    strokeDasharray={s==="dashed"?"7 3":s==="dotted"?"1.5 3.5":undefined} strokeLinecap="round"/>
                </svg>
              </button>
            );
          })}
        </div>
      </div>

      {/* Label editor for text / note tools */}
      {(drawing.toolType === "text" || drawing.toolType === "note") && (
        <>
          <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />
          <div style={{ padding: "9px 14px 14px" }}>
            <p style={{ fontSize: 10, color: "rgba(200,215,200,0.7)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, marginBottom: 8 }}>
              {drawing.toolType === "note" ? "Note Text" : "Label"}
            </p>
            <textarea
              defaultValue={drawing.style.text ?? ""}
              rows={drawing.toolType === "note" ? 3 : 1}
              placeholder={drawing.toolType === "note" ? "Enter note…" : "Enter label…"}
              onClick={e => e.stopPropagation()}
              onPointerDown={e => e.stopPropagation()}
              onBlur={e => onUpdate({ text: e.target.value })}
              style={{
                width: "100%", boxSizing: "border-box",
                background: "rgba(18,26,19,0.9)",
                border: "1px solid rgba(183,255,90,0.2)",
                borderRadius: 8, color: "#E8F5E9",
                fontSize: 12, fontFamily: "'Inter',system-ui,sans-serif",
                padding: "6px 8px", resize: "vertical", outline: "none",
                lineHeight: 1.5,
              }}
            />
          </div>
        </>
      )}
    </div>

    {/* Unified color picker popup */}
    {showColorPicker && colorAnchor && (
      <ColorPickerGlass
        value={col}
        onChange={c => { onUpdate({ color: c }); }}
        onClose={() => setShowColorPicker(false)}
        anchorRect={colorAnchor}
      />
    )}
    </>,
    document.body
  );
});

// ── Drag state (ref-based to avoid stale closures) ─────────────────────────────
type DragKind = "move" | "anchor";
interface DragState {
  id:            number;
  kind:          DragKind;
  anchorIdx:     number;             // -1 = move whole drawing
  startPoints:   DrawingPoint[];     // world-space snapshot at drag start
  startPxPoints: (Px | null)[];      // pixel positions at drag start — cached once, never recomputed
  startClientX:  number;             // absolute pointer position at drag start
  startClientY:  number;
  overlayRect:   DOMRect;            // getBoundingClientRect() called once at drag start, never again
  toolType?:     string;
}

// ── Main DrawingOverlay ───────────────────────────────────────────────────────
interface Props {
  symbol: string;
  timeframe: string;
  onDrawingAlert?: (drawing: Drawing) => void;
  alertDrawingIds?: Set<number>;
}

const DrawingOverlay = memo(function DrawingOverlay({ symbol, timeframe, onDrawingAlert, alertDrawingIds }: Props) {
  const { chart, candle } = useChartContext();
  const {
    activeTool, setActiveTool,
    stayInDraw,
    drawings, activeStyle,
    addDrawing, resetDrawings, removeDrawing, updateDrawing, setIsDrawing,
    setSelectedDrawingId, setActiveStyle, syncActiveStyle,
  } = useDrawingStore();

  const overlayRef  = useRef<HTMLDivElement>(null);
  const [renderTick, setRenderTick] = useState(0);

  // ── Canvas2D drawing layer refs ────────────────────────────────────────────
  // All visual paths rendered imperatively at 60fps — zero React renders during pan/zoom.
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRafRef     = useRef<number | null>(null);
  const drawingsRef      = useRef(drawings);          // always-current drawings array
  const selectedIdRef    = useRef<number | null>(null); // always-current selectedId
  const chartRef         = useRef(chart);             // always-current chart instance
  const toPxRef          = useRef<((pt: DrawingPoint) => Px | null) | null>(null); // always-current toPx

  // NOTE: livePrice is intentionally NOT subscribed here.
  // Drawing coordinates (including position-tool P&L labels) are derived from
  // lastActiveBar.close (from barsRef) and coordinate transforms (chart API).
  // Subscribing to livePrice would force a full DrawingOverlay React re-render
  // on every WS tick (~60fps), causing massive unnecessary reconciliation.
  // Instead, renderTick is bumped only when coordinate transforms actually change:
  //   • time-scale pan/zoom → subscribeVisibleLogicalRangeChange
  //   • price-scale autoScale shift → pollPrice interval below
  const isMobile = useIsMobile();

  // barsRef: always-current bar buffer from CustomChart (mutated in-place by the
  // WS handler on every live tick). Reading barsRef.current at render time is the
  // TradingView-correct approach — no snapshot race with series teardown, no stale
  // candle.data() call that returns [] while the new series is being populated.
  const { barsRef, replayBarCount } = useContext(ChartBarsContext);

  // candleBars: read barsRef.current directly — no useMemo needed.
  // barsRef.current is mutated in-place by the WS handler (last bar updated),
  // so the array reference is always the same object; a memo returning the same
  // reference on every run added zero value and wasted reconciliation work.
  // DrawingShape receives this as the `bars` prop; since the reference is stable,
  // React.memo on DrawingShape won't re-render from bars alone — it re-renders
  // only when toPx changes (i.e. on renderTick from viewport/price-scale change).
  // replayBarCount is kept as an unused dep-guard in case callers use it elsewhere.
  void replayBarCount;
  const candleBars = barsRef.current as OhlcBar[];

  // Bar half-width derived from LWC's logical coordinate system.
  // Adjacent logical positions are always exactly one barSpacing apart in pixels,
  // regardless of zoom level and without requiring candleBars to be populated.
  // This eliminates the race condition where candleBars is empty on initial load
  // (toPx works before candleBars populates) causing ELX to jump left one frame later.
  const barHalfWidth = useMemo((): number => {
    if (!chart) return 0;
    try {
      const visRange = chart.timeScale().getVisibleLogicalRange();
      if (!visRange) return 0;
      const midL = Math.floor(((visRange.from as number) + (visRange.to as number)) / 2);
      const x0 = chart.timeScale().logicalToCoordinate(midL as Logical);
      const x1 = chart.timeScale().logicalToCoordinate((midL + 1) as Logical);
      if (x0 === null || x1 === null) return 0;
      return Math.abs((x1 as number) - (x0 as number)) / 2;
    } catch { return 0; }
  }, [chart]);

  // ── Drawing phase state ────────────────────────────────────────────────────
  const [phase,      setPhase]      = useState<"idle" | "dragging" | "placed_first">("idle");
  const [anchor,     setAnchor]     = useState<DrawingPoint | null>(null);
  const [mousePoint, setMousePoint] = useState<DrawingPoint | null>(null);
  const isDragging                  = useRef(false);
  // Tracks click-click phase for 2-pt tools: 0=no first point, 1=first point placed
  const clickPhaseRef               = useRef<0 | 1>(0);
  // Direct-DOM crosshair refs — updated on every mousemove without React re-renders
  const xhairHRef                   = useRef<SVGLineElement | null>(null);
  const xhairVRef                   = useRef<SVGLineElement | null>(null);

  // ── Mobile 2-point drawing refs ────────────────────────────────────────────
  // Crosshair pixel position relative to overlay (set on tool select + drag).
  // Never uses raw finger coords — all movement is relative-offset.
  const mobileDrawCrossPx    = useRef<{ x: number; y: number } | null>(null);
  // Finger + crosshair position captured at each drag start.
  const mobileDrawDragAnchor = useRef<{ fX: number; fY: number; cX: number; cY: number } | null>(null);
  // Finger position at pointerdown — used to detect tap vs drag.
  const mobilePointerStart   = useRef<{ x: number; y: number } | null>(null);

  // ── Ephemeral rulers (transient — not saved to DB) ─────────────────────────
  const [ephemeralRuler,     setEphemeralRuler]     = useState<[DrawingPoint, DrawingPoint] | null>(null);
  const [ephemeralDateRange, setEphemeralDateRange] = useState<[DrawingPoint, DrawingPoint] | null>(null);

  // ── Snap indicator (Shift+hover snaps to nearest OHLC) ────────────────────
  const [snapIndicator, setSnapIndicator] = useState<{ x: number; y: number; label: string } | null>(null);

  // ── Selection + drag (cursor mode) ────────────────────────────────────────
  const [selectedId,    setSelectedId]    = useState<number | null>(null);

  // Unified selection: syncs local state + global store + mirrors drawing style into sidebar picker
  const selectDrawing = useCallback((id: number | null) => {
    setSelectedId(id);
    setSelectedDrawingId(id);
    if (id !== null) {
      const d = useDrawingStore.getState().drawings.find(x => x.id === id);
      // Use syncActiveStyle (not setActiveStyle) so selecting a drawing never
      // overwrites the persisted per-tool defaults in localStorage.
      if (d) syncActiveStyle(d.style);
    }
  }, [setSelectedDrawingId, syncActiveStyle]);

  const [showStylePanel, setShowStylePanel] = useState(false);
  const handleCloseStylePanel = useCallback(() => setShowStylePanel(false), []);
  const handleToggleStylePanel = useCallback(() => setShowStylePanel(v => !v), []);
  // Always-current timeframe ref — used by drag handlers to normalize position-tool right-edge
  // times without needing timeframe in the drag useEffect dep array (which would restart mid-drag)
  const timeframeRef   = useRef(timeframe);
  useEffect(() => { timeframeRef.current = timeframe; }, [timeframe]);

  const dragRef        = useRef<DragState | null>(null);
  const isDragDirty    = useRef(false);  // did we actually move?
  // ── Performance: buffer live drag points in a ref; avoid Zustand updates during drag ──
  const dragLiveRef    = useRef<{ id: number; points: DrawingPoint[] } | null>(null);
  const dragRafPending = useRef(false);
  const [dragTick,     setDragTick] = useState(0);

  // ── Canvas render body — reads all values via refs, zero React involvement ────
  // Called directly from the viewport sync RAF (same frame as LWC paint) and also
  // via scheduleCanvasRender for event-driven renders (drawing added/changed/removed).
  // useCallback with [] deps keeps the reference stable for the component lifetime.
  const doCanvasRender = useCallback(() => {
    const canvas = drawingCanvasRef.current;
    if (!canvas || !chartRef.current) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W   = canvas.clientWidth;
    const H   = canvas.clientHeight;
    if (W <= 0 || H <= 0) return;
    // Resize canvas backing store when element size changes (e.g. window resize)
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    // Always-current barHalfWidth computed from live chart API
    let bhw = 0;
    try {
      const vr = chartRef.current!.timeScale().getVisibleLogicalRange();
      if (vr) {
        const mid = Math.floor(((vr.from as number) + (vr.to as number)) / 2);
        const x0  = chartRef.current!.timeScale().logicalToCoordinate(mid as Logical);
        const x1  = chartRef.current!.timeScale().logicalToCoordinate((mid + 1) as Logical);
        if (x0 !== null && x1 !== null) bhw = Math.abs((x1 as number) - (x0 as number)) / 2;
      }
    } catch { /* ok */ }
    // Skip drawing currently under DOM transform (SVG handles move-drag visuals)
    const moveDragId = dragRef.current?.kind === "move" ? dragRef.current.id : null;
    // Clip to chart plotting area only — exclude the date/time scale row at the bottom.
    let plotH = H;
    try {
      const tsH = (chartRef.current as any).timeScale().height?.() as number | undefined;
      if (typeof tsH === "number" && tsH > 0) plotH = Math.max(1, H - tsH);
    } catch { /* leave plotH = H as safe fallback */ }
    // Also update the SVG clipPath rect height directly (zero React renders).
    if (svgClipRectRef.current && svgClipRectRef.current.getAttribute("height") !== String(Math.round(plotH))) {
      svgClipRectRef.current.setAttribute("height", String(Math.round(plotH)));
    }
    renderDrawingsToCanvas(
      ctx, W, H,
      drawingsRef.current,
      toPxRef.current ?? (() => null),
      selectedIdRef.current,
      dragLiveRef.current,
      bhw,
      barsRef.current as OhlcBar[],
      dpr,
      moveDragId,
      plotH,
    );

    // ── Zero-React P&L label position sync ──────────────────────────────────
    // For every RUNNING position tool that has a registered foreignObject ref,
    // recompute the label position from live chart coords and write it directly to
    // the DOM — keeping the label attached to the position box at 60fps.
    for (const [drawingId, fo] of pnlFoRefs.current) {
      const d = drawingsRef.current.find(dr => dr.id === drawingId);
      if (!d || d.points.length < 2 || !toPxRef.current) continue;

      const pts = d.points;
      const entPx = toPxRef.current({ time: pts[0].time, price: pts[0].price });
      const tpPx  = toPxRef.current(pts[1]);
      if (!entPx || !tpPx) continue;

      const rawL  = Math.min(entPx.x, tpPx.x);
      const rawR  = Math.max(entPx.x, tpPx.x);
      const zoneW = rawR - rawL;
      const ELX   = zoneW < 20 ? entPx.x - 120 : rawL - bhw;
      const ERX   = zoneW < 20 ? entPx.x + 120 : rawR;

      const allBars       = barsRef.current as OhlcBar[];
      const toolLeftTime  = Math.min(pts[0].time, pts[1].time);
      const toolRightTime = Math.max(pts[0].time, pts[1].time);
      const barsInRange   = allBars.filter(b => b.time >= toolLeftTime && b.time <= toolRightTime);
      if (!barsInRange.length) continue;

      const lastBar   = barsInRange[barsInRange.length - 1];
      const lastBarPx = toPxRef.current({ time: lastBar.time, price: lastBar.close });
      if (!lastBarPx) continue;

      const entryPrice     = pts[0].price;
      const sp             = toPxRef.current({ time: lastBar.time, price: entryPrice });
      const profitSplitX   = sp ? Math.min(ERX, Math.max(ELX, sp.x)) : ELX;
      const activeFillEndX = Math.min(W, profitSplitX + bhw);
      const lineX1 = ELX + bhw;
      const lineY1 = entPx.y;
      const lineX2 = activeFillEndX;
      const lineY2 = lastBarPx.y;
      const LBL_W  = 150;
      const LBL_H  = 72;
      const lblX   = Math.round(Math.min(lineX2 + 10, W - LBL_W - 4));
      const lblY   = Math.round(lineY2 - LBL_H / 2);

      fo.setAttribute("x", String(lblX));
      fo.setAttribute("y", String(lblY));

      const ln = pnlLineRefs.current.get(drawingId);
      if (ln) {
        ln.setAttribute("x1", String(Math.round(lineX1)));
        ln.setAttribute("y1", String(Math.round(lineY1)));
        ln.setAttribute("x2", String(Math.round(lineX2)));
        ln.setAttribute("y2", String(Math.round(lineY2)));
      }
    }
  }, []); // stable — all state accessed via mutable refs

  // ── Canvas render scheduler — for event-driven renders ────────────────────
  // Coalesces rapid calls (new drawing added, style changed, etc.) via RAF.
  // Pan/zoom renders bypass this entirely — they call doCanvasRender() directly
  // from the viewport sync loop below so there is zero extra-frame delay.
  const scheduleCanvasRender = useCallback(() => {
    if (canvasRafRef.current !== null) return; // already queued, coalesce
    canvasRafRef.current = requestAnimationFrame(() => {
      canvasRafRef.current = null;
      doCanvasRender();
    });
  }, [doCanvasRender]);

  // ── Direct SVG DOM refs — one per drawing g-wrapper, keyed by drawing id ───
  // Used to apply transform="translate(dx,dy)" for move-drag without any React renders.
  const svgGroupsRef   = useRef<Map<number, SVGGElement>>(new Map());

  // ── P&L label DOM refs — keyed by drawing id ─────────────────────────────
  // Registered by DrawingShape via onPnlFoRef/onPnlLineRef prop callbacks.
  // scheduleCanvasRender updates their SVG attributes on every pan/zoom frame
  // so the label stays attached to the position box without any React renders.
  const pnlFoRefs   = useRef<Map<number, SVGForeignObjectElement>>(new Map());
  const pnlLineRefs = useRef<Map<number, SVGLineElement>>(new Map());

  // ── SVG clipPath rect DOM ref ─────────────────────────────────────────────
  // Updated directly from the canvas RAF (scheduleCanvasRender) to clip the SVG
  // to the chart plotting area (excluding the date-scale row at the bottom).
  const svgClipRectRef = useRef<SVGRectElement>(null);

  // ── Freehand tool state (brush / highlighter) ──────────────────────────────
  const freehandRef       = useRef<DrawingPoint[]>([]);
  const lastFreehandPxRef = useRef<{ x: number; y: number } | null>(null);
  const freehandRafRef    = useRef<number | null>(null);
  const [freehandPreview, setFreehandPreview] = useState<DrawingPoint[] | null>(null);

  // ── Viewport sync loop — renders overlay in the SAME frame as LWC ───────────
  // Replaces subscribeVisibleLogicalRangeChange + setInterval(50ms) polling.
  //
  // Why this eliminates jitter:
  //   Old approach — subscribeVisibleLogicalRangeChange fired → scheduleCanvasRender
  //   added ANOTHER requestAnimationFrame → canvas redrawed 1 frame AFTER LWC painted.
  //   Price-scale polling at 50ms = up to 3 frames lag at 60fps during vertical drag.
  //
  //   New approach — a single continuous RAF loop that reads the current chart
  //   transform every frame and calls doCanvasRender() DIRECTLY (no extra RAF delay).
  //   LWC registers its RAF before this effect runs (chart created before component
  //   mounts), so LWC paints first in each frame, then our loop reads the fresh
  //   coordinates and redraws — perfect synchronization, zero lag on:
  //     • horizontal pan/zoom (time scale)
  //     • vertical scale drag (price scale)
  //     • pinch zoom
  //     • device rotation
  useEffect(() => {
    if (!chart || !candle) return;

    let rafId: number;
    let prevFrom: number | null = null;
    let prevTo:   number | null = null;
    let prevPY:   number | null = null;

    // IMPORTANT: the chart and the drawing overlay mount independently. On a
    // navigation/remount the drawings can arrive before CustomChart finishes
    // applying its cached/fresh candle data. In that window LWC can return a
    // valid-looking coordinate system, but it is not the final data/viewport
    // coordinate system. Previously the RAF only watched viewport/price-scale
    // changes, so the first correct candle load could happen without a dirty
    // signal. The result was exactly the reported bug: rays/trendlines appeared
    // in the wrong place after Dashboard -> Charts, then snapped back into the
    // correct world position as soon as the user dragged the chart.
    //
    // Track the structural bar signature as well. A change from empty -> loaded
    // bars, a history prepend, or a new last candle forces an immediate redraw
    // and React SVG re-render. We deliberately do NOT track last-bar close/high/low
    // so live ticks do not cause a React render on every tick.
    let prevBarCount = -1;
    let prevFirstBarTime: number | null = null;
    let prevLastBarTime: number | null = null;
    let prevWidth = -1;
    let prevHeight = -1;

    const loop = () => {
      rafId = requestAnimationFrame(loop);
      let dirty = false;

      // Horizontal transform — time scale pan / zoom
      try {
        const vr = chart.timeScale().getVisibleLogicalRange();
        const f  = vr ? (vr.from as number) : null;
        const t  = vr ? (vr.to   as number) : null;
        if (f !== prevFrom || t !== prevTo) { prevFrom = f; prevTo = t; dirty = true; }
      } catch { /* chart torn down — loop will be cancelled by cleanup */ }

      // Vertical transform — price scale drag / autoScale shift
      // Sub-pixel threshold (0.5px) filters float noise without masking real moves.
      try {
        const py = candle.priceToCoordinate(0) as number | null;
        if (py !== null && (prevPY === null || Math.abs(py - prevPY) > 0.5)) {
          prevPY = py; dirty = true;
        }
      } catch { /* series removed */ }

      // Data/geometry readiness — catches the async chart-data race described
      // above. barsRef is intentionally a stable mutable ref, so React does not
      // observe these changes by itself.
      try {
        const bars = barsRef.current as OhlcBar[];
        const count = bars.length;
        const first = count > 0 ? bars[0]?.time ?? null : null;
        const last = count > 0 ? bars[count - 1]?.time ?? null : null;
        if (count !== prevBarCount || first !== prevFirstBarTime || last !== prevLastBarTime) {
          prevBarCount = count;
          prevFirstBarTime = first;
          prevLastBarTime = last;
          dirty = true;
        }
      } catch { /* chart data is temporarily unavailable */ }

      // A Dashboard -> Charts navigation can also change the chart's measured
      // pixel size one or two frames after mount. Re-render once the final size
      // is known so SVG/canvas coordinates use the same viewport as LWC.
      try {
        const w = overlayRef.current?.clientWidth ?? 0;
        const h = overlayRef.current?.clientHeight ?? 0;
        if (w !== prevWidth || h !== prevHeight) {
          prevWidth = w;
          prevHeight = h;
          dirty = true;
        }
      } catch { /* overlay may be between mounts */ }

      if (dirty) {
        doCanvasRender(); // synchronous — same browser frame as LWC paint
        // Anchor handles (selected drawing) are React SVG elements — bump renderTick
        // so React repositions them. This is fine: it's throttled to actual changes only.
        if (selectedIdRef.current !== null) setRenderTick(v => v + 1);
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [chart, candle, doCanvasRender, barsRef]);

  // ── Post-mount coordinate stabilization ───────────────────────────────────
  // CustomChart applies cached/fresh candles and restores the saved viewport
  // asynchronously. Give the drawing layer a few early frames after navigation
  // so persisted world-space points are reprojected against the final chart
  // transform even when the logical range happens to be numerically unchanged.
  useEffect(() => {
    if (!chart || !candle || drawings.length === 0) return;
    let cancelled = false;
    const timers: number[] = [];

    const refresh = () => {
      if (cancelled) return;
      scheduleCanvasRender();
      setRenderTick(v => v + 1);
    };

    // Two animation frames cover the normal React/LWC mount sequence.
    const raf1 = requestAnimationFrame(() => {
      refresh();
      const raf2 = requestAnimationFrame(refresh);
      timers.push(raf2);
    });
    timers.push(raf1);

    // Cached candles and the fresh REST response can arrive later than the first
    // paint. These are intentionally short-lived; the continuous viewport RAF
    // above takes over after stabilization.
    for (const ms of [80, 200, 500, 1000]) {
      timers.push(window.setTimeout(refresh, ms));
    }

    return () => {
      cancelled = true;
      for (const id of timers) {
        cancelAnimationFrame(id);
        clearTimeout(id);
      }
    };
  }, [chart, candle, symbol, timeframe, drawings.length, scheduleCanvasRender]);

  // ── Load drawings ──────────────────────────────────────────────────────────
  // Drawings are symbol-scoped, not timeframe-scoped. Fetch all drawings for
  // the symbol regardless of which timeframe is currently active so that a
  // trendline drawn on 1H is still visible on 5M, 4H, 1D, etc.
  useEffect(() => {
    if (!symbol) return;
    const load = async () => {
      try {
        const res = await fetch(`${BASE}/api/drawings?symbol=${encodeURIComponent(symbol)}`);
        if (res.ok) {
          const data = toArray<Drawing>(await res.json(), "DrawingOverlay.loadDrawings:/api/drawings");
          const deletedIds = getDeletedDrawingIds();
          resetDrawings(data.filter(d => !deletedIds.has(d.id)));
        }
      } catch { /* ignore */ }
    };
    void load();
  }, [symbol, resetDrawings]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPhase("idle"); setAnchor(null); setMousePoint(null); setIsDrawing(false);
        isDragging.current = false; clickPhaseRef.current = 0; selectDrawing(null); dragRef.current = null;
        setEphemeralRuler(null);
        setEphemeralDateRange(null);
        setFreehandPreview(null); freehandRef.current = []; lastFreehandPxRef.current = null;
        if (freehandRafRef.current !== null) { cancelAnimationFrame(freehandRafRef.current); freehandRafRef.current = null; }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId !== null) { void handleErase(selectedId); selectDrawing(null); }
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "z" && !e.shiftKey) { e.preventDefault(); useDrawingStore.getState().undo(); }
      if (ctrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); useDrawingStore.getState().redo(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setIsDrawing, selectedId]);

  // ── Reset in-progress drawing when tool switches ──────────────────────────
  useEffect(() => {
    setPhase("idle"); setAnchor(null); setMousePoint(null); setIsDrawing(false);
    isDragging.current = false; clickPhaseRef.current = 0;
    freehandRef.current = []; lastFreehandPxRef.current = null; setFreehandPreview(null);
    // Clear mobile state on tool change
    mobileDrawCrossPx.current    = null;
    mobileDrawDragAnchor.current = null;
    mobilePointerStart.current   = null;
    // Hide crosshair SVG lines immediately (they may still be display:"" from a
    // previous draw session when switching between 2-point tools while isDrawMode
    // stays true and the SVG group is never unmounted).
    if (xhairHRef.current) xhairHRef.current.style.display = "none";
    if (xhairVRef.current) xhairVRef.current.style.display = "none";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

  // ── Mobile: show crosshair immediately when a 2-point draw tool is selected ──
  // TradingView behavior: selecting the trendline tool shows the crosshair
  // at the chart center without requiring the user to touch the screen first.
  useEffect(() => {
    if (!isMobile) return;
    if (activeTool === "cursor" || activeTool === "eraser" || isFreehand(activeTool)) return;
    if (pointsNeeded(activeTool) !== 2) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    // Place crosshair at 40% height (slightly above center — typical chart position)
    const cx = overlay.clientWidth  / 2;
    const cy = overlay.clientHeight * 0.4;
    mobileDrawCrossPx.current = { x: cx, y: cy };
    if (xhairHRef.current) {
      xhairHRef.current.setAttribute("y1", String(cy));
      xhairHRef.current.setAttribute("y2", String(cy));
      xhairHRef.current.style.display = "";
    }
    if (xhairVRef.current) {
      xhairVRef.current.setAttribute("x1", String(cx));
      xhairVRef.current.setAttribute("x2", String(cx));
      xhairVRef.current.style.display = "";
    }
    // Seed mousePoint so the cursor dot appears immediately at chart coords
    const rect = overlay.getBoundingClientRect();
    const pt = fromPx(rect.left + cx, rect.top + cy);
    if (pt) setMousePoint(pt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, isMobile]);

  // ── Disable/re-enable chart scroll during draw mode ──────────────────────
  useEffect(() => {
    if (!chart) return;
    if (activeTool !== "cursor") {
      chart.applyOptions({ handleScroll: false, handleScale: false });
    } else {
      chart.applyOptions({
        // Must exactly mirror CustomChart createChart options — omitting any key can let LWC
        // silently revert it to default (e.g. mouseWheel:true re-enables horizontal wheel pan).
        // kineticScroll is a TOP-LEVEL option in LWC v5, not nested inside handleScroll.
        handleScroll:  { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
        kineticScroll: { mouse: false, touch: true },
        handleScale:   { mouseWheel: true, pinch: true, axisPressedMouseMove: { price: false, time: false }, axisDoubleClickReset: { price: true, time: true } },
      });
    }
  }, [chart, activeTool]);

  // ── Coordinate helpers ────────────────────────────────────────────────────
  const toPx = useCallback((pt: DrawingPoint): Px | null => {
    if (!chart || !candle) return null;
    const x = chart.timeScale().timeToCoordinate(pt.time as Time);
    const y = candle.priceToCoordinate(pt.price);

    // Point is in the future area (beyond last candle): timeToCoordinate returns null.
    // Use lightweight-charts logical-coordinate API which works everywhere, including
    // the rightOffset future-space, regardless of zoom level / bar spacing.
    if (x === null && y !== null) {
      const toSec = (t: Time) =>
        typeof t === "number" ? t : Math.floor(new Date(t as string).getTime() / 1000);

      // Primary approach: logical coordinates (robust at any zoom level)
      const visRange = chart.timeScale().getVisibleLogicalRange();
      if (visRange !== null) {
        let lastRealTime: number | null = null;
        let lastRealLogical: number | null = null;
        const searchFrom = Math.ceil(visRange.to as number);

        for (let li = searchFrom; li >= Math.max(0, searchFrom - 300); li--) {
          const coord = chart.timeScale().logicalToCoordinate(li as Logical);
          if (coord === null) continue;
          const t = chart.timeScale().coordinateToTime(coord as number);
          if (t !== null) { lastRealTime = toSec(t); lastRealLogical = li; break; }
        }

        if (lastRealTime !== null && lastRealLogical !== null) {
          let intervalSec = getIntervalSec(timeframe);
          const prevCoord = chart.timeScale().logicalToCoordinate((lastRealLogical - 1) as Logical);
          if (prevCoord !== null) {
            const prevT = chart.timeScale().coordinateToTime(prevCoord as number);
            if (prevT !== null) intervalSec = Math.max(60, lastRealTime - toSec(prevT));
          }
          if (intervalSec > 0) {
            const logicalDelta = (pt.time - lastRealTime) / intervalSec;
            const futureLogical = lastRealLogical + logicalDelta;
            const extraX = chart.timeScale().logicalToCoordinate(futureLogical as Logical);
            if (extraX !== null) return { x: extraX as number, y: y as number };
          }
        }
      }

      // Fallback: pixel scan with higher limit
      const overlayW = overlayRef.current?.clientWidth ?? 1200;
      const maxX = overlayW - 73;
      let rx1 = maxX, rt1: Time | null = null;
      for (let i = 0; i < 3000 && rt1 === null; i++, rx1--) {
        rt1 = chart.timeScale().coordinateToTime(rx1);
      }
      if (rt1 === null) return null;
      let rx2 = rx1 - 2, rt2: Time | null = null;
      for (let i = 0; i < 200 && rt2 === null; i++, rx2--) {
        rt2 = chart.timeScale().coordinateToTime(rx2);
      }
      if (rt2 === null) return null;
      const s1 = toSec(rt1), s2 = toSec(rt2);
      const dx = rx1 - rx2;
      if (dx === 0 || s1 === s2) return null;
      return { x: rx1 + (pt.time - s1) * (dx / (s1 - s2)), y: y as number };
    }

    if (x === null || y === null) return null;
    return { x: x as number, y: y as number };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, candle, timeframe]); // renderTick removed — toPx calls LWC imperative API, always current

  // ── Keep canvas refs in sync (synchronous, no cost — just ref writes) ───────
  drawingsRef.current   = drawings;
  chartRef.current      = chart;
  selectedIdRef.current = selectedId;
  toPxRef.current       = toPx;

  // ── Trigger canvas re-render when key state changes ────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { scheduleCanvasRender(); }, [drawings]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { scheduleCanvasRender(); }, [selectedId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { scheduleCanvasRender(); }, [dragTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (chart && candle) scheduleCanvasRender(); }, [chart, candle]);

  const fromPx = useCallback((clientX: number, clientY: number): DrawingPoint | null => {
    if (!chart || !candle || !overlayRef.current) return null;

    const rect = overlayRef.current.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const price = candle.coordinateToPrice(localY);
    if (price === null) return null;

    const ts = chart.timeScale();
    const toSec = (t: Time) =>
      typeof t === "number" ? t : Math.floor(new Date(t as string).getTime() / 1000);

    // Normal in-chart coordinates.
    const rawTime = ts.coordinateToTime(localX);
    if (rawTime !== null) return { time: toSec(rawTime), price };

    // Robust future/right-side projection.
    // LWC intentionally returns null outside the loaded candle coordinates. Drawing
    // handles must still be draggable into the chart's rightOffset/future area.
    // Resolve a real bar at/near the right edge, calculate seconds-per-pixel, then
    // extrapolate to the requested pointer coordinate. This also works when the
    // pointer is captured and moves over the price-scale area.
    const plotRight = Math.max(1, overlayRef.current.clientWidth);
    const sampleX = Math.min(Math.max(plotRight - 1, 1), Math.max(localX - 1, 1));

    let rightTime: number | null = null;
    let rightX = sampleX;
    for (let x = sampleX; x >= Math.max(0, sampleX - 4000); x--) {
      const t = ts.coordinateToTime(x);
      if (t !== null) {
        rightTime = toSec(t);
        rightX = x;
        break;
      }
    }

    if (rightTime !== null) {
      let prevTime: number | null = null;
      let prevX = rightX - 1;
      for (let x = rightX - 1; x >= Math.max(0, rightX - 200); x--) {
        const t = ts.coordinateToTime(x);
        if (t !== null) {
          prevTime = toSec(t);
          prevX = x;
          break;
        }
      }

      if (prevTime !== null && rightX !== prevX && rightTime !== prevTime) {
        const secPerPx = (rightTime - prevTime) / (rightX - prevX);
        return {
          time: Math.round(rightTime + (localX - rightX) * secPerPx),
          price,
        };
      }

      // Last-resort logical-bar extrapolation.
      const logical = ts.coordinateToLogical(rightX);
      if (logical !== null) {
        const interval = Math.max(60, getIntervalSec(timeframe));
        const rightLogical = Math.round(logical as number);
        const x0 = ts.logicalToCoordinate(rightLogical as Logical);
        if (x0 !== null) {
          return {
            time: Math.round(rightTime + (localX - (x0 as number)) / Math.max(1, Math.abs((ts.logicalToCoordinate((rightLogical + 1) as Logical) ?? (x0 as number) + 1) - (x0 as number))) * interval),
            price,
          };
        }
      }
    }

    // Existing logical-coordinate fallback for unusual sparse/history-loading cases.
    const logicalPos = ts.coordinateToLogical(localX);
    if (logicalPos !== null) {
      const searchFrom = Math.ceil(logicalPos as number);
      for (let li = searchFrom; li >= Math.max(0, searchFrom - 300); li--) {
        const coord = ts.logicalToCoordinate(li as Logical);
        if (coord === null) continue;
        const t = ts.coordinateToTime(coord as number);
        if (t === null) continue;

        let intervalSec = getIntervalSec(timeframe);
        const prevCoord = ts.logicalToCoordinate((li - 1) as Logical);
        if (prevCoord !== null) {
          const prevT = ts.coordinateToTime(prevCoord as number);
          if (prevT !== null) intervalSec = Math.max(60, toSec(t) - toSec(prevT));
        }
        return {
          time: Math.round(toSec(t) + ((logicalPos as number) - li) * intervalSec),
          price,
        };
      }
    }

    return null;
  }, [chart, candle, timeframe]);

  // ── Shift + OHLC snap ─────────────────────────────────────────────────────
  // When Shift is held, snaps the cursor to the nearest OHLC value of the
  // closest candle (within 24px).  Returns the snapped DrawingPoint and
  // updates the snap indicator so the SVG can render the crosshair badge.
  const snapToOHLC = useCallback((
    clientX: number,
    clientY: number,
    shiftKey: boolean
  ): DrawingPoint | null => {
    const raw = fromPx(clientX, clientY);
    if (!raw || !shiftKey || !candle || !chart || !overlayRef.current) {
      if (!shiftKey) setSnapIndicator(null);
      return raw;
    }

    const rect   = overlayRef.current.getBoundingClientRect();
    const localY = clientY - rect.top;

    // Get series OHLC data (CandlestickData[])
    type Bar = { time: Time; open: number; high: number; low: number; close: number };
    const bars = candle.data() as Bar[];
    if (!bars.length) { setSnapIndicator(null); return raw; }

    const toSec = (t: Time) =>
      typeof t === "number" ? t : Math.floor(new Date(t as string).getTime() / 1000);

    // 1. Find nearest bar to cursor time
    let nearestBar = bars[0];
    let minTimeDiff = Math.abs(toSec(bars[0].time) - raw.time);
    for (const b of bars) {
      const d = Math.abs(toSec(b.time) - raw.time);
      if (d < minTimeDiff) { minTimeDiff = d; nearestBar = b; }
    }

    // 2. Find closest OHLC price to cursor Y
    const candidates: { price: number; label: string }[] = [
      { price: nearestBar.open,  label: "O" },
      { price: nearestBar.high,  label: "H" },
      { price: nearestBar.low,   label: "L" },
      { price: nearestBar.close, label: "C" },
    ];
    let bestPrice = candidates[0].price;
    let bestLabel = candidates[0].label;
    let bestPixDist = Infinity;
    for (const c of candidates) {
      const py = candle.priceToCoordinate(c.price) as number | null;
      if (py === null) continue;
      const dist = Math.abs(py - localY);
      if (dist < bestPixDist) { bestPixDist = dist; bestPrice = c.price; bestLabel = c.label; }
    }

    // Only snap if within 24px of a known OHLC level
    if (bestPixDist > 24) { setSnapIndicator(null); return raw; }

    const snappedPx = candle.priceToCoordinate(bestPrice) as number | null;
    const timeX = chart.timeScale().timeToCoordinate(nearestBar.time as Time) as number | null;
    if (snappedPx !== null && timeX !== null) {
      setSnapIndicator({ x: timeX, y: snappedPx, label: bestLabel });
    }

    return { time: toSec(nearestBar.time), price: bestPrice };
  }, [fromPx, candle, chart]);

  // ── Eraser hit-test ───────────────────────────────────────────────────────
  const findNearPx = useCallback((clickPx: Px): Drawing | null => {
    const THRESH = 18;
    let closest: Drawing | null = null;
    let minDist = Infinity;
    for (const d of drawings) {
      const pts = d.points.map(toPx).filter(Boolean) as Px[];
      if (!pts.length) continue;
      const dist = pts.length === 1
        ? Math.hypot(clickPx.x - pts[0].x, clickPx.y - pts[0].y)
        : Math.min(...pts.slice(0, -1).map((a, i) => distToSeg(clickPx, a, pts[i + 1])));
      if (dist < THRESH && dist < minDist) { minDist = dist; closest = d; }
    }
    return closest;
  }, [drawings, toPx]);

  const handleErase = useCallback(async (id: number) => {
    try { await fetch(`${BASE}/api/drawings/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
    removeDrawing(id);
  }, [removeDrawing]);

  // ── Patch drawing points to server ────────────────────────────────────────
  const patchDrawing = useCallback(async (id: number, pts: DrawingPoint[]) => {
    try {
      await fetch(`${BASE}/api/drawings/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: pts }),
      });
    } catch { /* ignore */ }
  }, []);

  // ── Patch drawing style to server ─────────────────────────────────────────
  const patchDrawingStyle = useCallback(async (id: number, style: Partial<DrawingStyle>) => {
    try {
      await fetch(`${BASE}/api/drawings/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style }),
      });
    } catch { /* ignore */ }
  }, []);

  // ── Toggle visibility of a single drawing ─────────────────────────────────
  const handleToggleVisibility = useCallback(async (id: number) => {
    const drawing = useDrawingStore.getState().drawings.find(d => d.id === id);
    if (!drawing) return;
    const newVisible = !drawing.isVisible;
    updateDrawing(id, { isVisible: newVisible });
    try {
      await fetch(`${BASE}/api/drawings/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isVisible: newVisible }),
      });
    } catch { /* ignore */ }
  }, [updateDrawing]);

  // ── Toggle lock of a single drawing ───────────────────────────────────────
  const handleToggleLock = useCallback(async (id: number) => {
    const drawing = useDrawingStore.getState().drawings.find(d => d.id === id);
    if (!drawing) return;
    const newLocked = !drawing.isLocked;
    updateDrawing(id, { isLocked: newLocked });
    try {
      await fetch(`${BASE}/api/drawings/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isLocked: newLocked }),
      });
    } catch { /* ignore */ }
  }, [updateDrawing]);

  // ── Reverse position tool (long ↔ short) ──────────────────────────────────
  const handleReverseDrawing = useCallback(async (id: number) => {
    const drawing = useDrawingStore.getState().drawings.find(d => d.id === id);
    if (!drawing) return;
    const newType: ToolType = drawing.toolType === "position_long" ? "position_short" : "position_long";
    updateDrawing(id, { toolType: newType });
    try {
      await fetch(`${BASE}/api/drawings/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolType: newType }),
      });
    } catch { /* ignore */ }
  }, [updateDrawing]);

  // ── Duplicate (clone) a drawing ────────────────────────────────────────────
  const handleDuplicateDrawing = useCallback(async (id: number) => {
    const { addDrawing } = useDrawingStore.getState();
    const drawing = useDrawingStore.getState().drawings.find(d => d.id === id);
    if (!drawing) return;
    const offset = 5;
    const newPts = drawing.points.map(p => ({ ...p, price: p.price + offset }));
    try {
      const res = await fetch(`${BASE}/api/drawings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol:    drawing.symbol,
          timeframe: drawing.timeframe,
          toolType:  drawing.toolType,
          points:    newPts,
          style:     drawing.style,
          isLocked:  drawing.isLocked,
          isVisible: drawing.isVisible,
        }),
      });
      if (res.ok) {
        const saved = await res.json() as Drawing;
        addDrawing(saved);
      }
    } catch { /* ignore */ }
  }, []);

  // ── Global pointermove / pointerup for cursor-mode drag ───────────────────
  useEffect(() => {
    if (activeTool !== "cursor") return;

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();

      // Use absolute delta from drag-start — no incremental accumulation, no drift.
      const totalDx = e.clientX - drag.startClientX;
      const totalDy = e.clientY - drag.startClientY;
      if (Math.abs(totalDx) < 0.5 && Math.abs(totalDy) < 0.5) return;
      isDragDirty.current = true;

      if (drag.kind === "move") {
        // ── MOVE drag: direct SVG DOM transform — zero React renders ──────────
        // Apply translate to the shape's <g> wrapper directly; React never touches
        // the transform attribute so it survives reconciliation intact.
        const el = svgGroupsRef.current.get(drag.id);
        if (el) el.setAttribute("transform", `translate(${totalDx},${totalDy})`);

        // Also keep dragLiveRef updated for the final pointerup commit.
        // Uses cached startPxPoints → only fromPx called (no toPx, no getBCR).
        dragLiveRef.current = {
          id: drag.id,
          points: drag.startPoints.map((pt, i) => {
            const sp = drag.startPxPoints[i];
            if (!sp) return pt;
            return fromPx(
              sp.x + totalDx + drag.overlayRect.left,
              sp.y + totalDy + drag.overlayRect.top
            ) ?? pt;
          }),
        };
        // No setDragTick — React does NOT render during move drag.

      } else {
        // ── ANCHOR drag: update points, re-render via RAF ─────────────────────
        const i         = drag.anchorIdx;
        const isPosTool = drag.toolType === "position_long" || drag.toolType === "position_short";

        if (isPosTool) {
          // Position tool uses dedicated handle indices with strict axis locks:
          //   10 = Left Top    → TP price only     (vertical)  — needs pts[1]
          //   11 = Left Bottom → SL price only     (vertical)  — needs pts[2]
          //   12 = Left Middle → entire entry      (vertical, all prices shift equally)
          //   13 = Right Middle→ right edge time   (horizontal) — needs pts[1]
          // NOTE: each branch guards its own minimum point requirement individually.
          // Do NOT add a global length<3 guard here — it would block handles 10/12/13
          // on any drawing that is missing the SL point (pts[2]).
          const pts = drag.startPoints;
          const newPoints = pts.map(p => ({ ...p }));

          if (i === 10) {
            // Left Top — TP price only, vertical
            if (pts.length < 2) return;
            const sp = drag.startPxPoints[1];
            if (!sp) return;
            const np = fromPx(drag.overlayRect.left + sp.x, drag.overlayRect.top + sp.y + totalDy);
            if (!np) return;
            newPoints[1] = { time: pts[1].time, price: np.price };

          } else if (i === 11) {
            // Left Bottom — SL price only, vertical — requires pts[2]
            if (pts.length < 3) return;
            const sp = drag.startPxPoints[2] ?? drag.startPxPoints[0];
            if (!sp) return;
            const np = fromPx(drag.overlayRect.left + sp.x, drag.overlayRect.top + sp.y + totalDy);
            if (!np) return;
            // SL time is always locked to entry (pts[0]) time
            newPoints[2] = { time: pts[0].time, price: np.price };

          } else if (i === 12) {
            // Left Middle — shift ALL prices by same Δ, no time change
            const sp = drag.startPxPoints[0];
            if (!sp) return;
            const np = fromPx(drag.overlayRect.left + sp.x, drag.overlayRect.top + sp.y + totalDy);
            if (!np) return;
            const dPrice = np.price - pts[0].price;
            newPoints[0] = { ...pts[0], price: pts[0].price + dPrice };
            if (pts.length >= 2) newPoints[1] = { ...pts[1], price: pts[1].price + dPrice };
            if (pts.length >= 3) newPoints[2] = { ...pts[2], price: pts[2].price + dPrice };

          } else if (i === 13) {
            // Right Middle — right edge time only, no price change
            // Normalize to entry's bar boundary so the right edge never drifts.
            if (pts.length < 2) return;
            const sp = drag.startPxPoints[1];
            if (!sp) return;
            const np = fromPx(drag.overlayRect.left + sp.x + totalDx, drag.overlayRect.top + sp.y);
            if (!np) return;
            const iSec13 = getIntervalSec(timeframeRef.current);
            const normTime13 = iSec13 > 0
              ? pts[0].time + Math.round((np.time - pts[0].time) / iSec13) * iSec13
              : np.time;
            // Enforce minimum 1-bar width so the right edge can't collapse onto the entry
            const minTime13 = pts[0].time + (iSec13 > 0 ? iSec13 : 0);
            newPoints[1] = { time: Math.max(normTime13, minTime13), price: pts[1].price };

          } else {
            return; // unknown position handle index
          }

          dragLiveRef.current = { id: drag.id, points: newPoints };

        } else {
          // Generic anchor drag for all non-position tools
          const sp = drag.startPxPoints[i];
          if (!sp) return;
          const newPt = fromPx(
            sp.x + totalDx + drag.overlayRect.left,
            sp.y + totalDy + drag.overlayRect.top
          );
          if (!newPt) return;
          const newPoints = [...drag.startPoints];
          newPoints[i] = newPt;
          dragLiveRef.current = { id: drag.id, points: newPoints };
        }

        // React re-render for anchor (geometry changes, transform trick won't work)
        if (!dragRafPending.current) {
          dragRafPending.current = true;
          requestAnimationFrame(() => {
            dragRafPending.current = false;
            setDragTick(v => v + 1);
          });
        }
      }
    };

    // Normalise position-tool right edge to entry + N×interval so pan/zoom never drifts.
    // Called on both successful commit (onUp) and cancelled drag (onCancel) to keep state consistent.
    const normalisePositionPoints = (id: number, pts: DrawingPoint[]): DrawingPoint[] => {
      const d = useDrawingStore.getState().drawings.find(x => x.id === id);
      if (!d || (d.toolType !== "position_long" && d.toolType !== "position_short")) return pts;
      if (pts.length < 2) return pts;
      const iSec = getIntervalSec(timeframeRef.current);
      if (iSec <= 0) return pts;
      const rightOff = Math.round((pts[1].time - pts[0].time) / iSec);
      const normTime = pts[0].time + Math.max(1, rightOff) * iSec;
      if (normTime === pts[1].time) return pts;
      const out = [...pts];
      out[1] = { ...pts[1], time: normTime };
      return out;
    };

    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.kind === "move") {
        // Clear the DOM transform so the shape snaps to its final React-rendered position
        const el = svgGroupsRef.current.get(drag.id);
        if (el) el.removeAttribute("transform");
      }

      if (isDragDirty.current) {
        let finalPoints = dragLiveRef.current?.id === drag.id
          ? dragLiveRef.current.points
          : useDrawingStore.getState().drawings.find(d => d.id === drag.id)?.points;
        if (finalPoints) {
          finalPoints = normalisePositionPoints(drag.id, finalPoints);
          updateDrawing(drag.id, { points: finalPoints });
          void patchDrawing(drag.id, finalPoints);
        }
      }
      dragLiveRef.current = null;
      dragRef.current = null;
      isDragDirty.current = false;
    };

    // Browser (e.g. system gesture, incoming call, scroll detection) can fire pointercancel
    // instead of pointerup, which previously left dragRef stuck so all subsequent drags were broken.
    const onCancel = () => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "move") {
        const el = svgGroupsRef.current.get(drag.id);
        if (el) el.removeAttribute("transform");
      }
      // Discard in-progress changes — don't save a half-finished drag
      dragLiveRef.current = null;
      dragRef.current = null;
      isDragDirty.current = false;
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [activeTool, fromPx, updateDrawing, patchDrawing]);

  // ── Cursor-mode: shape body pressed ───────────────────────────────────────
  // wasSelected is passed from DrawingShape and reflects whether the drawing
  // was already selected BEFORE this pointer-down event fired.
  //
  // Two-phase model (TradingView behaviour):
  //   wasSelected=false → first tap/click: select only, no drag armed.
  //                        Chart pan continues to work for drag gestures.
  //   wasSelected=true  → drawing was already selected: arm the move drag.
  const onBodyDown = useCallback((e: React.PointerEvent, id: number, wasSelected: boolean) => {
    if (activeTool !== "cursor") return;
    const drawing = drawings.find(d => d.id === id);
    if (!drawing || drawing.isLocked) return;

    if (!wasSelected) {
      // Unselected: defer selection to pointerup so drag gestures (which pan the
      // chart) never auto-select the drawing. A document-level capture-phase
      // pointerup listener is used so we fire even if LWC captured the pointer.
      const startX = e.clientX, startY = e.clientY;
      const pid    = e.pointerId;
      const onUp   = (upEv: PointerEvent) => {
        if (upEv.pointerId !== pid) return;
        document.removeEventListener("pointerup", onUp, true);
        // Only select on a clean tap — ignore drags (≥ 6 px movement)
        if (Math.hypot(upEv.clientX - startX, upEv.clientY - startY) >= 6) return;
        selectDrawing(id);
        if (overlayRef.current) {
          const d2 = useDrawingStore.getState().drawings.find(x => x.id === id);
          if (d2) {
            const pts = d2.points.map(p => toPxRef.current(p)).filter(Boolean) as Px[];
            if (pts.length > 0) {
              const W2   = overlayRef.current.clientWidth;
              const cR   = Math.max(W2 - 72, W2 * 0.85);
              const avgX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
              const minY = Math.min(...pts.map(p => p.y));
              const bRect = overlayRef.current.getBoundingClientRect();
              (setToolbarPos as (v: { x: number; y: number }) => void)(
                { x: bRect.left + Math.min(avgX, cR - 20), y: bRect.top + minY }
              );
            }
          }
        }
      };
      document.addEventListener("pointerup", onUp, true);
      return;
    }

    // wasSelected=true — take control of the pointer
    e.stopPropagation();
    selectDrawing(id);
    // Compute toolbar position synchronously so it appears the same frame as the click
    if (overlayRef.current) {
      const pts = drawing.points.map(p => toPxRef.current(p)).filter(Boolean) as Px[];
      if (pts.length > 0) {
        const W2   = overlayRef.current.clientWidth;
        const cR   = Math.max(W2 - 72, W2 * 0.85);
        const avgX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const minY = Math.min(...pts.map(p => p.y));
        const bRect = overlayRef.current.getBoundingClientRect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
        (setToolbarPos as (v: { x: number; y: number }) => void)(
          { x: bRect.left + Math.min(avgX, cR - 20), y: bRect.top + minY }
        );
      }
    }
    // Cache rect + pixel positions ONCE at drag start — never call getBCR again during drag
    const overlayRect   = overlayRef.current?.getBoundingClientRect() ?? new DOMRect();
    const startPts      = [...drawing.points];
    const startPxPoints = startPts.map(p => toPxRef.current(p));
    dragRef.current = {
      id, kind: "move", anchorIdx: -1,
      startPoints:   startPts,
      startPxPoints,
      startClientX:  e.clientX,
      startClientY:  e.clientY,
      overlayRect,
      toolType: drawing.toolType,
    };
    isDragDirty.current = false;
    // Immediately schedule a canvas re-render so the drawing is erased from the canvas
    // the moment move-drag begins. Without this, the canvas retains its last frame
    // (drawing at the saved position) while the SVG DOM transform shows it at the new
    // position — creating a ghost duplicate for the entire drag duration.
    // The canvas RAF will read dragRef.current.kind === "move" and skip the drawing.
    scheduleCanvasRender();
  }, [activeTool, drawings, scheduleCanvasRender]);

  // ── Cursor-mode: anchor pressed ────────────────────────────────────────────
  const onAnchorDown = useCallback((e: React.PointerEvent, id: number, anchorIdx: number) => {
    if (activeTool !== "cursor") return;
    const drawing = drawings.find(d => d.id === id);
    if (!drawing || drawing.isLocked) return;
    // Capture on the stable overlay div — NOT on the anchor circle element.
    // The circle is destroyed and recreated every React render (setDragTick fires
    // during drag), so capturing on it releases the touch mid-drag on mobile.
    // The overlay div is always mounted and survives all re-renders.
    // pointer-events:none does NOT prevent an element from being a capture target.
    try { overlayRef.current?.setPointerCapture(e.pointerId); } catch {}
    // Cache rect + pixel positions ONCE at drag start — never call getBCR again during drag
    const overlayRect   = overlayRef.current?.getBoundingClientRect() ?? new DOMRect();
    const startPts      = [...drawing.points];
    const startPxPoints = startPts.map(p => toPxRef.current(p));
    dragRef.current = {
      id, kind: "anchor", anchorIdx,
      startPoints:   startPts,
      startPxPoints,
      startClientX:  e.clientX,
      startClientY:  e.clientY,
      overlayRect,
      toolType: drawing.toolType,
    };
    isDragDirty.current = false;
    // Pre-seed dragLiveRef with the current (un-moved) points immediately so any canvas
    // render that fires before the first pointermove (e.g. from a chart pan/autoscale event)
    // uses the correct saved position. Without this, there is a one-frame window where the
    // canvas still shows the drawing at its saved position while the React SVG re-render has
    // already moved the anchor handles — creating a visible ghost trendline.
    dragLiveRef.current = { id, points: startPts };
  }, [activeTool, drawings]);

  // ── Draw-mode pointer events ───────────────────────────────────────────────
  const isDrawMode = activeTool !== "cursor";

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!isDrawMode) return;
    e.preventDefault();

    // Right-click always cancels in-progress drawing
    if (e.button === 2) {
      setPhase("idle"); setAnchor(null); setMousePoint(null); setIsDrawing(false);
      clickPhaseRef.current = 0;
      return;
    }

    // ── Eraser ────────────────────────────────────────────────────────────
    if (activeTool === "eraser") {
      if (!overlayRef.current) return;
      const rect    = overlayRef.current.getBoundingClientRect();
      const clickPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const target  = findNearPx(clickPx);
      if (target) void handleErase(target.id);
      return;
    }

    // ── Freehand (brush / highlighter) — drag gesture ─────────────────────
    if (isFreehand(activeTool)) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const pt = fromPx(e.clientX, e.clientY);
      if (!pt) return;
      freehandRef.current = [pt];
      lastFreehandPxRef.current = { x: e.clientX, y: e.clientY };
      setFreehandPreview([pt]);
      setPhase("dragging");
      isDragging.current = true;
      setIsDrawing(true);
      return;
    }

    // ── Ephemeral drag-measure tools (ruler / price_range / date_range) ───
    if (activeTool === "ruler" || activeTool === "price_range" || activeTool === "date_range") {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      if (activeTool === "ruler" || activeTool === "price_range") setEphemeralRuler(null);
      if (activeTool === "date_range") setEphemeralDateRange(null);
      const pt = snapToOHLC(e.clientX, e.clientY, e.shiftKey);
      if (!pt) return;
      setAnchor(pt);
      setPhase("dragging");
      isDragging.current = true;
      setIsDrawing(true);
      return;
    }

    // ── 1-point tools (hline / hray / vline / text / note) ────────────────
    if (pointsNeeded(activeTool) === 1) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const pt = snapToOHLC(e.clientX, e.clientY, e.shiftKey);
      if (!pt) return;
      setAnchor(pt);
      setPhase("dragging");
      isDragging.current = true;
      setIsDrawing(true);
      return;
    }

    // ── 2-point / 3-point tools: TradingView click-click interaction ───────

    // ── Mobile: crosshair-drag model — save anchor, do NOT place point yet ─
    // Point placement happens in onPointerUp only when the lift is a tap (<10px).
    if (isMobile && pointsNeeded(activeTool) === 2 && !isFreehand(activeTool)) {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const cx = mobileDrawCrossPx.current?.x ?? (overlay.clientWidth  / 2);
      const cy = mobileDrawCrossPx.current?.y ?? (overlay.clientHeight * 0.4);
      mobileDrawDragAnchor.current = { fX: e.clientX, fY: e.clientY, cX: cx, cY: cy };
      mobilePointerStart.current   = { x: e.clientX, y: e.clientY };
      return;
    }

    const pt = snapToOHLC(e.clientX, e.clientY, e.shiftKey);
    if (!pt) return;

    if (clickPhaseRef.current === 0) {
      // FIRST click — lock the first anchor and enter preview mode immediately
      setAnchor(pt);
      setMousePoint(pt);
      setPhase("placed_first");
      setIsDrawing(true);
      clickPhaseRef.current = 1;
    } else {
      // SECOND click down — update live preview to exact cursor position
      setMousePoint(pt);
    }
  }, [isDrawMode, activeTool, snapToOHLC, findNearPx, handleErase, setIsDrawing, fromPx]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDrawMode || activeTool === "eraser") return;

    // ── Mobile 2-point crosshair drag (relative offset, zero finger-snap) ───
    // Only update crosshair while an active drag is in progress.
    // When no drag is active (finger lifted), the crosshair stays at its last
    // position — it never follows raw finger coordinates.
    if (isMobile && pointsNeeded(activeTool) === 2 && !isFreehand(activeTool)) {
      const overlay = overlayRef.current;
      const drag    = mobileDrawDragAnchor.current;
      if (overlay && drag) {
        const nx = Math.max(0, Math.min(drag.cX + (e.clientX - drag.fX), overlay.clientWidth  - 1));
        const ny = Math.max(0, Math.min(drag.cY + (e.clientY - drag.fY), overlay.clientHeight - 1));
        mobileDrawCrossPx.current = { x: nx, y: ny };
        if (xhairHRef.current) { xhairHRef.current.setAttribute("y1", String(ny)); xhairHRef.current.setAttribute("y2", String(ny)); xhairHRef.current.style.display = ""; }
        if (xhairVRef.current) { xhairVRef.current.setAttribute("x1", String(nx)); xhairVRef.current.setAttribute("x2", String(nx)); xhairVRef.current.style.display = ""; }
        const rect = overlay.getBoundingClientRect();
        const pt   = fromPx(rect.left + nx, rect.top + ny);
        if (pt) setMousePoint(pt);
      }
      return; // never let raw finger coords reach crosshair or mousePoint
    }

    // ── Direct-DOM crosshair (zero React overhead) ──────────────────────────
    if (!isFreehand(activeTool) && overlayRef.current) {
      const rect = overlayRef.current.getBoundingClientRect();
      const cx = (e.clientX - rect.left).toFixed(1);
      const cy = (e.clientY - rect.top).toFixed(1);
      if (xhairHRef.current) {
        xhairHRef.current.setAttribute("y1", cy);
        xhairHRef.current.setAttribute("y2", cy);
        xhairHRef.current.style.display = "";
      }
      if (xhairVRef.current) {
        xhairVRef.current.setAttribute("x1", cx);
        xhairVRef.current.setAttribute("x2", cx);
        xhairVRef.current.style.display = "";
      }
    }

    // Freehand stroke collection
    if (isFreehand(activeTool) && isDragging.current) {
      const pt = fromPx(e.clientX, e.clientY);
      if (pt) {
        const last = lastFreehandPxRef.current;
        const moved = last ? Math.hypot(e.clientX - last.x, e.clientY - last.y) : 4;
        if (moved >= 3) {
          lastFreehandPxRef.current = { x: e.clientX, y: e.clientY };
          freehandRef.current = [...freehandRef.current, pt];
          if (freehandRafRef.current === null) {
            freehandRafRef.current = requestAnimationFrame(() => {
              freehandRafRef.current = null;
              setFreehandPreview([...freehandRef.current]);
            });
          }
        }
      }
      return;
    }
    // Always track cursor position — drives live preview for both "dragging" and "placed_first" phases
    const pt = snapToOHLC(e.clientX, e.clientY, e.shiftKey);
    if (pt) setMousePoint(pt);
  }, [isDrawMode, activeTool, snapToOHLC, fromPx]);

  const onPointerUp = useCallback(async (e: React.PointerEvent) => {
    if (!isDrawMode || activeTool === "eraser") return;

    // ── Freehand commit ───────────────────────────────────────────────────
    if (isFreehand(activeTool)) {
      if (!isDragging.current) return;
      isDragging.current = false;
      setPhase("idle"); setIsDrawing(false); setSnapIndicator(null);
      if (freehandRafRef.current !== null) { cancelAnimationFrame(freehandRafRef.current); freehandRafRef.current = null; }
      const pts = freehandRef.current;
      freehandRef.current = []; lastFreehandPxRef.current = null;
      setFreehandPreview(null); setAnchor(null); setMousePoint(null);
      if (pts.length >= 2) await saveDrawing(pts);
      if (!useDrawingStore.getState().stayInDraw) setActiveTool("cursor");
      return;
    }

    // ── Ephemeral drag-measure tools ──────────────────────────────────────
    if (activeTool === "ruler" || activeTool === "price_range" || activeTool === "date_range") {
      if (!isDragging.current || !anchor) return;
      isDragging.current = false;
      setPhase("idle"); setIsDrawing(false); setSnapIndicator(null);
      const pt = snapToOHLC(e.clientX, e.clientY, e.shiftKey);
      if (pt) {
        const ap = toPx(anchor), bp = toPx(pt);
        const dist = ap && bp ? Math.hypot(bp.x - ap.x, bp.y - ap.y) : 0;
        if (dist >= 8) {
          if (activeTool === "date_range") setEphemeralDateRange([anchor, pt]);
          else setEphemeralRuler([anchor, pt]);
        }
      }
      setAnchor(null); setMousePoint(null); setActiveTool("cursor");
      return;
    }

    // ── 1-point tools ─────────────────────────────────────────────────────
    if (pointsNeeded(activeTool) === 1) {
      if (!isDragging.current || !anchor) return;
      isDragging.current = false;
      setPhase("idle"); setIsDrawing(false); setSnapIndicator(null);
      await saveDrawing([anchor]);
      setAnchor(null); setMousePoint(null);
      if (!useDrawingStore.getState().stayInDraw) setActiveTool("cursor");
      return;
    }

    // ── 2-point / 3-point tools: click-click commit ───────────────────────
    // This fires on EVERY pointerUp. We use distance from anchor to discriminate:
    //   • dist < 8 px  → first click released at same spot  → stay in "placed_first"
    //   • dist ≥ 8 px  → second click at a different spot   → commit the drawing

    // ── MOBILE: tap-to-place at current crosshair position ────────────────
    // Drag (≥10px movement) = reposition crosshair only, no point placed.
    // Tap  (<10px movement) = place point at CROSSHAIR coords, not finger coords.
    if (isMobile && pointsNeeded(activeTool) === 2 && !isFreehand(activeTool)) {
      const start     = mobilePointerStart.current;
      mobileDrawDragAnchor.current = null;
      mobilePointerStart.current   = null;
      const totalMove = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) : 999;
      if (totalMove >= 10) return; // drag ended — crosshair repositioned, no point placed

      // Tap: read chart coordinates from the crosshair's current pixel position
      const overlay = overlayRef.current;
      if (!overlay) return;
      const crossPx = mobileDrawCrossPx.current;
      if (!crossPx) return;
      const rect = overlay.getBoundingClientRect();
      const pt   = fromPx(rect.left + crossPx.x, rect.top + crossPx.y);
      if (!pt) return;

      if (clickPhaseRef.current === 0) {
        // First tap → place Point A
        setAnchor(pt);
        setMousePoint(pt);
        setPhase("placed_first");
        setIsDrawing(true);
        clickPhaseRef.current = 1;
        // Defensively re-assert crosshair lines visible (React re-renders may not
        // have reset them, but being explicit guarantees they stay shown).
        if (xhairHRef.current) xhairHRef.current.style.display = "";
        if (xhairVRef.current) xhairVRef.current.style.display = "";
      } else {
        // Second tap → place Point B and commit
        setSnapIndicator(null);
        if (activeTool === "position_long" || activeTool === "position_short") {
          const isLong  = activeTool === "position_long";
          const slPrice = isLong
            ? anchor!.price - Math.abs(pt.price - anchor!.price) * 0.5
            : anchor!.price + Math.abs(pt.price - anchor!.price) * 0.5;
          // eslint-disable-next-line react-hooks/exhaustive-deps
          const iSec = getIntervalSec(timeframe);
          const rightOffsetBars     = iSec > 0 ? Math.round((pt.time - anchor!.time) / iSec) : 0;
          const normalizedRightTime = anchor!.time + rightOffsetBars * iSec;
          await saveDrawing([
            { time: anchor!.time,         price: anchor!.price },
            { time: normalizedRightTime,  price: pt.price      },
            { time: anchor!.time,         price: slPrice       },
          ]);
        } else {
          await saveDrawing([anchor!, pt]);
        }
        setAnchor(null);
        setPhase("idle");
        setIsDrawing(false);
        clickPhaseRef.current = 0;
        if (useDrawingStore.getState().stayInDraw) {
          // Keep crosshair + cursor dot at Point B — user can drag immediately
          // to start the next trendline without re-selecting the tool.
          setMousePoint(pt);
          if (xhairHRef.current) xhairHRef.current.style.display = "";
          if (xhairVRef.current) xhairVRef.current.style.display = "";
        } else {
          setMousePoint(null);
          setActiveTool("cursor");
        }
      }
      return;
    }

    if (clickPhaseRef.current !== 1) return;

    const pt = snapToOHLC(e.clientX, e.clientY, e.shiftKey);
    if (!pt || !anchor) return;

    const ap   = toPx(anchor);
    const bp   = toPx(pt);
    const dist = ap && bp ? Math.hypot(bp.x - ap.x, bp.y - ap.y) : 0;

    if (dist < 8) {
      // First click released — keep "placed_first" so the user can move and click again
      return;
    }

    // ── Commit ────────────────────────────────────────────────────────────
    setSnapIndicator(null);

    if (activeTool === "position_long" || activeTool === "position_short") {
      const isLong  = activeTool === "position_long";
      const slPrice = isLong
        ? anchor.price - Math.abs(pt.price - anchor.price) * 0.5
        : anchor.price + Math.abs(pt.price - anchor.price) * 0.5;
      // Normalize right-edge time to an exact bar-count offset from entry so the
      // tool never drifts left as new candles form into what was previously future space.
      const iSec = getIntervalSec(timeframe);
      const rightOffsetBars = iSec > 0 ? Math.round((pt.time - anchor.time) / iSec) : 0;
      const normalizedRightTime = anchor.time + rightOffsetBars * iSec;
      await saveDrawing([
        { time: anchor.time,          price: anchor.price },
        { time: normalizedRightTime,  price: pt.price },
        { time: anchor.time,          price: slPrice },
      ]);
    } else {
      await saveDrawing([anchor, pt]);
    }

    setAnchor(null); setMousePoint(null);
    setPhase("idle"); setIsDrawing(false);
    clickPhaseRef.current = 0;
    if (!useDrawingStore.getState().stayInDraw) setActiveTool("cursor");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDrawMode, activeTool, fromPx, anchor, toPx, setIsDrawing, setActiveTool, snapToOHLC]);

  const saveDrawing = async (pts: DrawingPoint[]) => {
    try {
      const res = await fetch(`${BASE}/api/drawings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe, toolType: activeTool, points: pts, style: activeStyle }),
      });
      if (res.ok) {
        const saved: Drawing = await res.json();
        addDrawing(saved);
        // Auto-select the newly placed drawing so the toolbar appears immediately
        selectDrawing(saved.id);
      }
    } catch { /* ignore */ }
  };

  // ── Deselect on empty chart background click ──────────────────────────────
  // Document-level listener: in cursor mode the overlay is pointer-events:none so
  // events pass through to the chart. We still need to deselect when the user
  // clicks empty chart space. We listen on document and deselect unless the
  // target is inside a drawing SVG element, a portal (toolbar/popup), or the
  // pointer is over an unselected drawing (the hit-test selection listener handles that).
  useEffect(() => {
    if (activeTool !== "cursor") return;
    const onDocDown = (e: PointerEvent) => {
      if (isDragDirty.current) return;
      const target = e.target as Element | null;
      if (!target) return;
      // Keep selection if clicking inside the drawing overlay (a selected drawing's hit area)
      if (overlayRef.current?.contains(target)) return;
      // Keep selection if clicking on any toolbar or portal UI
      if (
        target.closest("[data-drawing-toolbar]") ||
        target.closest("[data-right-panel]") ||
        target.closest("[data-drawing-flyout]") ||
        target.closest("[data-style-panel]") ||
        target.closest("[data-drawing-popup]")
      ) return;
      // Keep selection if the click is geometrically over an unselected drawing —
      // the hit-test selection listener below will handle tap-to-select for that drawing.
      if (overlayRef.current) {
        const rect = overlayRef.current.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const bHW = barHalfWidth;
        const overDrawing = drawings.some(d =>
          !d.isLocked && d.isVisible !== false &&
          hitTestDrawingAtPx(d, cx, cy, toPxRef.current, bHW)
        );
        if (overDrawing) return;
      }
      selectDrawing(null);
      setShowStylePanel(false);
      setEphemeralRuler(null);
    };
    document.addEventListener("pointerdown", onDocDown, true);
    return () => document.removeEventListener("pointerdown", onDocDown, true);
  }, [activeTool, drawings, barHalfWidth]);

  // ── Tap-to-select for unselected drawings ─────────────────────────────────
  // Because unselected hit areas have pointerEvents:"none" (so chart panning is
  // never blocked), selection is detected here via geometric hit-testing.
  // A clean tap (pointer moves < 6px from down to up) selects the drawing.
  useEffect(() => {
    if (activeTool !== "cursor") return;
    const onDocDown = (e: PointerEvent) => {
      if (!overlayRef.current) return;
      const rect = overlayRef.current.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const bHW = barHalfWidth;
      // Find first unselected, unlocked, visible drawing under the pointer
      const hit = drawings.find(d =>
        d.id !== selectedId &&
        !d.isLocked &&
        d.isVisible !== false &&
        hitTestDrawingAtPx(d, cx, cy, toPxRef.current, bHW)
      );
      if (!hit) return;
      // Arm a pointerup listener — select only on a clean tap (< 6 px movement)
      const startX = e.clientX, startY = e.clientY;
      const pid = e.pointerId;
      const onUp = (upEv: PointerEvent) => {
        if (upEv.pointerId !== pid) return;
        document.removeEventListener("pointerup", onUp, true);
        if (Math.hypot(upEv.clientX - startX, upEv.clientY - startY) >= 6) return;
        selectDrawing(hit.id);
        // Position the floating toolbar above the drawing
        if (overlayRef.current) {
          const d2 = useDrawingStore.getState().drawings.find(x => x.id === hit.id);
          if (d2) {
            const pts = d2.points.map(p => toPxRef.current(p)).filter(Boolean) as Px[];
            if (pts.length > 0) {
              const W2   = overlayRef.current.clientWidth;
              const cR   = Math.max(W2 - 72, W2 * 0.85);
              const avgX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
              const maxY = Math.max(...pts.map(p => p.y));
              const bRect2 = overlayRef.current.getBoundingClientRect();
              (setToolbarPos as (v: { x: number; y: number }) => void)(
                { x: bRect2.left + Math.min(avgX, cR - 20), y: bRect2.top + maxY }
              );
            }
          }
        }
      };
      document.addEventListener("pointerup", onUp, true);
    };
    document.addEventListener("pointerdown", onDocDown, true);
    return () => document.removeEventListener("pointerdown", onDocDown, true);
  }, [activeTool, drawings, selectedId, barHalfWidth]);

  const onOverlayClick = useCallback((e: React.MouseEvent) => {
    if (activeTool !== "cursor") return;
    if (!isDragDirty.current) selectDrawing(null);
  }, [activeTool]);

  const W = overlayRef.current?.clientWidth  ?? 1200;
  const H = overlayRef.current?.clientHeight ?? 700;
  // Overlay now stops at right:72 (price scale excluded from overlay bounds),
  // so clientWidth already equals the drawable chart area — no further subtraction needed.
  const chartRight = W;

  const previewDrawing: Drawing | null =
    (phase === "dragging" || phase === "placed_first") && anchor && mousePoint && activeTool !== "eraser" && pointsNeeded(activeTool) === 2
      ? { id: -1, symbol, timeframe, toolType: activeTool, points: [anchor, mousePoint], style: activeStyle, isLocked: false, isVisible: true, createdAt: "" }
      : null;

  const eraserActive = activeTool === "eraser";
  const cursorMode   = activeTool === "cursor";

  // ── Compute floating toolbar position for selected drawing ─────────────────
  const selectedDrawing = selectedId !== null ? drawings.find(d => d.id === selectedId) ?? null : null;

  // Stable toolbar position — stored in state and only updated via RAF when not actively dragging
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const toolbarRafRef = useRef<number | null>(null);

  // Keep last known drawing/pos so FloatingMiniToolbar stays mounted between selections (no flicker)
  const lastDrawingRef = useRef<Drawing | null>(null);
  const lastPosRef     = useRef<{ x: number; y: number } | null>(null);
  if (selectedDrawing) lastDrawingRef.current = selectedDrawing;
  if (toolbarPos)      lastPosRef.current     = toolbarPos;

  // toPx ref so the effect can call it without being in the dep array
  const tbToPxRef = useRef(toPx);
  tbToPxRef.current = toPx;

  useEffect(() => {
    if (toolbarRafRef.current !== null) cancelAnimationFrame(toolbarRafRef.current);
    if (!selectedDrawing || !overlayRef.current) { setToolbarPos(null); return; }

    toolbarRafRef.current = requestAnimationFrame(() => {
      // Skip position update while actively dragging (not on initial click)
      if (isDragDirty.current) return;
      if (!overlayRef.current) return;
      const W2 = overlayRef.current.clientWidth;
      const cRight = Math.max(W2 - 72, W2 * 0.85);
      const pts = selectedDrawing.points.map(p => tbToPxRef.current(p)).filter(Boolean) as Px[];
      if (pts.length === 0) { setToolbarPos(null); return; }
      const avgX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const maxY = Math.max(...pts.map(p => p.y));
      const rect = overlayRef.current.getBoundingClientRect();
      setToolbarPos({ x: rect.left + Math.min(avgX, cRight - 20), y: rect.top + maxY });
    });
    return () => { if (toolbarRafRef.current !== null) cancelAnimationFrame(toolbarRafRef.current); };
  // Only re-run when the selected drawing's identity or points change, not on every renderTick
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawing?.id, selectedDrawing?.points, overlayRef.current?.clientWidth]);

  return (
    <div
      ref={overlayRef}
      style={{
        position:    "absolute",
        top:         0,
        left:        0,
        bottom:      0,
        right:       72, // never cover the price scale strip — PriceScaleTouchHandler owns that zone
        zIndex:      2,
        cursor:      !isDrawMode ? "default" : eraserActive ? "cell" : "crosshair",
        // In draw mode: capture all events. In cursor mode: pass-through except shapes handle their own events.
        pointerEvents: isDrawMode ? "all" : "none",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onOverlayClick}
      onContextMenu={e => { e.preventDefault(); setPhase("idle"); setAnchor(null); setMousePoint(null); setIsDrawing(false); clickPhaseRef.current = 0; }}
      onPointerLeave={() => {
        // On mobile, lifting a finger fires pointerleave — the crosshair must
        // stay visible throughout the entire 2-point drawing session, so skip
        // the hide. Only the activeTool reset effect is allowed to hide it.
        if (isMobile && pointsNeeded(activeTool) === 2 && !isFreehand(activeTool)) return;
        if (xhairHRef.current) xhairHRef.current.style.display = "none";
        if (xhairVRef.current) xhairVRef.current.style.display = "none";
      }}
    >
      {/* ── Canvas2D layer — all drawing visual paths rendered imperatively, zero React renders during pan/zoom ── */}
      <canvas
        ref={drawingCanvasRef}
        style={{
          position:      "absolute",
          inset:         0,
          width:         "100%",
          height:        "100%",
          pointerEvents: "none",
          willChange:    "contents",
          contain:       "strict",
        }}
      />
      <svg width="100%" height="100%" style={{ overflow: "hidden", display: "block", willChange: "transform", transform: "translate3d(0,0,0)", touchAction: "none", position: "relative" }}>
        <defs>
          <clipPath id="drawing-clip">
            {/* Inset 4px on the left so endpoint circles (r≤3.5) never form a
                partial arc on the panel border line. 4px is invisible on lines.
                height is updated directly via svgClipRectRef in scheduleCanvasRender
                to match the chart plotting area (excluding the date-scale row). */}
            <rect ref={svgClipRectRef} x={4} y={0} width={Math.max(0, chartRight - 4)} height={H} />
          </clipPath>
        </defs>
        <g clipPath="url(#drawing-clip)">
          {/* Invisible background rect — catches empty-canvas clicks in cursor mode.
              Only fires when the user clicks space NOT covered by any drawing shape.
              Drawing shapes are siblings (not ancestors) so their events never bubble here.
              Portal elements (popups, toolbars) live in document.body outside the SVG —
              they are completely immune to this rect. */}
          {cursorMode && (
            <rect
              x={0} y={0} width={chartRight} height={H}
              fill="none" pointerEvents="none"
              style={{ cursor: "default" }}
            />
          )}
          {drawings.map(d => {
            // Timeframe visibility filter: hide drawings that don't include the current timeframe
            const vt = toArray<string>(d.style.visibleTimeframes, "DrawingOverlay.render.visibleTimeframes");
            if (vt.length > 0 && !vt.includes(timeframe)) return null;

            // For MOVE drag: DOM transform handles the visual offset; DrawingShape stays
            // at original points — zero React renders during drag.
            // For ANCHOR drag: effectiveDrawing carries the updated single point so
            // DrawingShape re-renders with the correct geometry.
            const live       = dragLiveRef.current;
            const isMoveDrag = dragRef.current?.kind === "move" && dragRef.current?.id === d.id;
            const effectiveDrawing = (live && live.id === d.id && !isMoveDrag)
              ? { ...d, points: live.points }
              : d;
            return (
              <g
                key={d.id}
                ref={el => {
                  if (el) svgGroupsRef.current.set(d.id, el as SVGGElement);
                  else    svgGroupsRef.current.delete(d.id);
                }}
              >
                <DrawingShape
                  drawing={effectiveDrawing}
                  toPx={toPx}
                  W={chartRight} H={H}
                  onErase={eraserActive ? handleErase : undefined}
                  cursorMode={cursorMode}
                  isSelected={d.id === selectedId}
                  onBodyDown={onBodyDown}
                  onAnchorDown={onAnchorDown}
                  hasAlert={alertDrawingIds?.has(d.id) ?? false}
                  bars={candleBars}
                  barHalfWidth={barHalfWidth}
                  canvasOnly={!isMoveDrag}
                  onPnlFoRef={el => {
                    if (el) pnlFoRefs.current.set(d.id, el);
                    else    pnlFoRefs.current.delete(d.id);
                  }}
                  onPnlLineRef={el => {
                    if (el) pnlLineRefs.current.set(d.id, el);
                    else    pnlLineRefs.current.delete(d.id);
                  }}
                />
              </g>
            );
          })}

          {previewDrawing && <DrawingShape drawing={previewDrawing} toPx={toPx} W={chartRight} H={H} isPreview barHalfWidth={barHalfWidth} />}

          {/* Freehand stroke live preview (brush / highlighter) */}
          {freehandPreview && freehandPreview.length >= 2 && (() => {
            const pxPts = freehandPreview.map(p => toPx(p)).filter(Boolean) as Px[];
            if (pxPts.length < 2) return null;
            const d = pxPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
            const isHL = activeTool === "highlighter";
            return (
              <path d={d} stroke={activeStyle.color}
                strokeWidth={isHL ? Math.max(activeStyle.thickness * 8, 14) : activeStyle.thickness}
                fill="none" strokeLinecap="round" strokeLinejoin="round"
                opacity={isHL ? 0.38 : 0.85} />
            );
          })()}

          {/* ── Full-span crosshair (TradingView style) ─────────────────────────
              Positions are written directly via DOM refs in onPointerMove —
              zero React re-renders, silky-smooth at native frame rate.
              display:"none" until first mousemove in draw mode.               */}
          {isDrawMode && !eraserActive && !isFreehand(activeTool) && (
            <g style={{ pointerEvents: "none" }}>
              <line ref={xhairHRef} x1={0} x2="100%" y1={0} y2={0}
                stroke="rgba(160,160,160,0.45)" strokeWidth={1}
                style={{ display: "none" }} />
              <line ref={xhairVRef} x1={0} x2={0} y1={0} y2="100%"
                stroke="rgba(160,160,160,0.45)" strokeWidth={1}
                style={{ display: "none" }} />
            </g>
          )}

          {/* Moving cursor dot
              Extra condition for mobile: also show during "idle" phase so the dot
              is visible immediately after tool select (before first tap) and after
              a trendline commit with stayInDraw=true (between drawings).         */}
          {(phase === "dragging" || phase === "placed_first" ||
            (isMobile && isDrawMode && phase === "idle" &&
             !isFreehand(activeTool) && activeTool !== "eraser" && pointsNeeded(activeTool) === 2))
           && mousePoint && (() => {
            const p = toPx(mousePoint);
            return p ? <circle cx={p.x} cy={p.y} r={4} fill={activeStyle.color} opacity={0.9} style={{ willChange: "cx,cy" }} /> : null;
          })()}

          {/* Anchor dot — shows for both drag and click-click modes */}
          {(phase === "dragging" || phase === "placed_first") && anchor && (() => {
            const p = toPx(anchor);
            return p ? (
              <>
                <circle cx={p.x} cy={p.y} r={6} fill={activeStyle.color} opacity={0.18} />
                <circle cx={p.x} cy={p.y} r={3} fill={activeStyle.color} opacity={0.95} />
              </>
            ) : null;
          })()}

          {/* Eraser ring */}
          {eraserActive && mousePoint && (() => {
            const p = toPx(mousePoint);
            return p ? (
              <circle cx={p.x} cy={p.y} r={16} fill="rgba(239,68,68,0.1)"
                stroke="rgba(239,68,68,0.5)" strokeWidth={1} strokeDasharray="3 2" />
            ) : null;
          })()}

          {/* Shift+OHLC snap indicator — crosshair diamond + badge */}
          {snapIndicator && isDrawMode && !eraserActive && (() => {
            const { x, y, label } = snapIndicator;
            const d = 7; // diamond half-size
            return (
              <g style={{ pointerEvents: "none" }}>
                {/* Crosshair lines */}
                <line x1={x - 14} y1={y} x2={x + 14} y2={y} stroke="#B7FF5A" strokeWidth={1} opacity={0.7} strokeDasharray="3 2" />
                <line x1={x} y1={y - 14} x2={x} y2={y + 14} stroke="#B7FF5A" strokeWidth={1} opacity={0.7} strokeDasharray="3 2" />
                {/* Diamond shape */}
                <polygon
                  points={`${x},${y - d} ${x + d},${y} ${x},${y + d} ${x - d},${y}`}
                  fill="rgba(183,255,90,0.22)" stroke="#B7FF5A" strokeWidth={1.5}
                />
                {/* OHLC label badge */}
                <rect x={x + d + 4} y={y - 10} width={18} height={18} rx={4}
                  fill="rgba(7,17,13,0.92)" stroke="#B7FF5A" strokeWidth={1} strokeOpacity={0.7} />
                <text x={x + d + 13} y={y + 4} textAnchor="middle"
                  fontSize={10} fontWeight={800} fill="#B7FF5A"
                  fontFamily="'JetBrains Mono','Fira Code',monospace">
                  {label}
                </text>
              </g>
            );
          })()}

          {/* ── Ephemeral Measure Tool overlay (never saved to DB) ── */}
          {ephemeralRuler && (() => {
            const [pt0, pt1] = ephemeralRuler;
            const p0 = toPx(pt0);
            const p1 = toPx(pt1);
            if (!p0 || !p1) return null;

            const col       = "#B7FF5A";
            const priceDiff = Math.abs(pt1.price - pt0.price);
            const pricePct  = ((pt1.price - pt0.price) / pt0.price * 100);
            const sign      = pricePct >= 0 ? "+" : "";
            const pctStr    = `${sign}${pricePct.toFixed(2)}%`;
            const iSec      = getIntervalSec(timeframe);
            const candles   = iSec > 0 ? Math.max(1, Math.round(Math.abs((pt1.time as number) - (pt0.time as number)) / iSec)) : 0;

            // Format price diff: no trailing zeros for large numbers
            const fmtPrice  = priceDiff >= 1000 ? priceDiff.toFixed(0)
                            : priceDiff >= 10   ? priceDiff.toFixed(2)
                            : priceDiff.toFixed(4);

            const midX  = (p0.x + p1.x) / 2;
            const midY  = (p0.y + p1.y) / 2;
            const lineD = `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;

            const boxW = 154, boxH = 58;
            // Keep box within chart bounds
            const bx = Math.max(boxW / 2 + 4, Math.min(midX, chartRight - boxW / 2 - 4));
            const by = midY - boxH / 2 - 4 < 8 ? midY + 8 : midY - boxH / 2 - 4;

            return (
              <g style={{ pointerEvents: "none" }}>
                {/* Glow halo */}
                <path d={lineD} stroke={col} strokeWidth={8} fill="none" opacity={0.07} />
                {/* Main dashed line */}
                <path d={lineD} stroke={col} strokeWidth={1.5} strokeDasharray="7 4" fill="none" opacity={0.9} />
                {/* End tick marks */}
                <line x1={p0.x - 5} y1={p0.y} x2={p0.x + 5} y2={p0.y} stroke={col} strokeWidth={1.5} />
                <line x1={p1.x - 5} y1={p1.y} x2={p1.x + 5} y2={p1.y} stroke={col} strokeWidth={1.5} />
                {/* Anchor dots */}
                <circle cx={p0.x} cy={p0.y} r={4.5} fill={col} opacity={0.9} />
                <circle cx={p1.x} cy={p1.y} r={4.5} fill={col} opacity={0.9} />
                {/* Label box */}
                <rect x={bx - boxW / 2} y={by} width={boxW} height={boxH} rx={8}
                  fill="rgba(7,17,13,0.93)" stroke={col} strokeWidth={1} strokeOpacity={0.45}
                  filter="url(#rulerGlow)" />
                {/* Price diff row */}
                <text x={bx} y={by + 19} fontSize={13} fill={col}
                  fontFamily="'JetBrains Mono','Fira Code',monospace"
                  textAnchor="middle" fontWeight={700}>
                  {fmtPrice}
                </text>
                {/* Percent row */}
                <text x={bx} y={by + 35} fontSize={11} fill={pricePct >= 0 ? "#4ade80" : "#f87171"}
                  fontFamily="'JetBrains Mono','Fira Code',monospace"
                  textAnchor="middle" fontWeight={700}>
                  {pctStr}
                </text>
                {/* Candle count row */}
                <text x={bx} y={by + 51} fontSize={9.5} fill="rgba(183,255,90,0.52)"
                  fontFamily="'JetBrains Mono','Fira Code',monospace"
                  textAnchor="middle" fontWeight={600}>
                  {candles} {candles === 1 ? "candle" : "candles"} · Esc to clear
                </text>
              </g>
            );
          })()}

          {/* ── Ephemeral Date Range overlay ─────────────────────────────── */}
          {ephemeralDateRange && (() => {
            const [pt0, pt1] = ephemeralDateRange;
            const p0 = toPx(pt0);
            const p1 = toPx(pt1);
            if (!p0 || !p1) return null;

            const col    = "#38bdf8";
            const iSec   = getIntervalSec(timeframe);
            const bars   = iSec > 0 ? Math.max(1, Math.round(Math.abs((pt1.time as number) - (pt0.time as number)) / iSec)) : 0;
            const secDiff = Math.abs((pt1.time as number) - (pt0.time as number));
            const days   = Math.floor(secDiff / 86400);
            const hrs    = Math.floor((secDiff % 86400) / 3600);
            const durStr = days > 0 ? `${days}d ${hrs}h` : `${hrs}h`;
            const fmtDate = (t: number) => {
              const d = new Date(t * 1000);
              return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
            };

            const midX  = (p0.x + p1.x) / 2;
            const y     = Math.min(p0.y, p1.y) - 28;
            const boxW  = 180, boxH = 58;
            const bx    = Math.max(boxW / 2 + 4, Math.min(midX, chartRight - boxW / 2 - 4));
            const by    = y - boxH - 8 < 8 ? y + 8 : y - boxH - 8;

            return (
              <g style={{ pointerEvents: "none" }}>
                {/* Horizontal range line */}
                <line x1={p0.x} y1={y} x2={p1.x} y2={y} stroke={col} strokeWidth={1.5} strokeDasharray="7 4" opacity={0.9} />
                {/* Vertical tick at start */}
                <line x1={p0.x} y1={y - 6} x2={p0.x} y2={y + 6} stroke={col} strokeWidth={1.5} />
                {/* Vertical tick at end */}
                <line x1={p1.x} y1={y - 6} x2={p1.x} y2={y + 6} stroke={col} strokeWidth={1.5} />
                {/* Dots */}
                <circle cx={p0.x} cy={y} r={4} fill={col} opacity={0.9} />
                <circle cx={p1.x} cy={y} r={4} fill={col} opacity={0.9} />
                {/* Info box */}
                <rect x={bx - boxW / 2} y={by} width={boxW} height={boxH} rx={8}
                  fill="rgba(7,17,13,0.93)" stroke={col} strokeWidth={1} strokeOpacity={0.5}
                  filter="url(#rulerGlow)" />
                <text x={bx} y={by + 19} fontSize={12} fill={col}
                  fontFamily="'JetBrains Mono','Fira Code',monospace"
                  textAnchor="middle" fontWeight={700}>
                  {fmtDate(pt0.time as number)} → {fmtDate(pt1.time as number)}
                </text>
                <text x={bx} y={by + 35} fontSize={11} fill="rgba(255,255,255,0.85)"
                  fontFamily="'JetBrains Mono','Fira Code',monospace"
                  textAnchor="middle" fontWeight={600}>
                  {bars} {bars === 1 ? "bar" : "bars"} · {durStr}
                </text>
                <text x={bx} y={by + 51} fontSize={9.5} fill="rgba(56,189,248,0.52)"
                  fontFamily="'JetBrains Mono','Fira Code',monospace"
                  textAnchor="middle" fontWeight={600}>
                  Esc to clear
                </text>
              </g>
            );
          })()}

          {/* Glow filter for ruler box */}
          <defs>
            <filter id="rulerGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Time-scale anchor highlights — date pills only, no dashed guide lines */}
          {selectedDrawing && (() => {
            const pts = selectedDrawing.points.map(toPx).filter(Boolean) as Px[];
            if (!pts.length) return null;
            const fmtDate = (t: number) => {
              const d = new Date(t * 1000);
              const dd   = String(d.getDate()).padStart(2, "0");
              const mm   = String(d.getMonth() + 1).padStart(2, "0");
              const yyyy = d.getFullYear();
              const hh   = String(d.getHours()).padStart(2, "0");
              const min  = String(d.getMinutes()).padStart(2, "0");
              return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
            };
            const pillW = 120, pillH = 18;
            return (
              <g>
                {pts.map((p, i) => {
                  const tv = selectedDrawing.points[i]?.time;
                  const label = tv ? fmtDate(tv) : "";
                  const px = Math.max(pillW / 2 + 2, Math.min(p.x, chartRight - pillW / 2 - 2));
                  return (
                    <g key={i}>
                      {/* TV-style blue date pill — no dashed line */}
                      <rect
                        x={px - pillW / 2} y={H - pillH}
                        width={pillW} height={pillH}
                        rx={4}
                        fill="#1d4ed8" fillOpacity={0.92}
                      />
                      <text
                        x={px} y={H - pillH / 2 + 4.5}
                        textAnchor="middle"
                        fontSize={9.5} fontWeight={600}
                        fill="#e2e8f0"
                        fontFamily="ui-monospace, monospace"
                      >{label}</text>
                    </g>
                  );
                })}
              </g>
            );
          })()}
        </g>
      </svg>

      {/* ── Price scale labels for selected drawing endpoints ─────────────── */}
      {selectedDrawing && candle && overlayRef.current && (() => {
        const rect = overlayRef.current!.getBoundingClientRect();
        // Price labels sit just inside the left edge of the price scale (72px wide)
        const labelX = rect.right + 3;
        // During drag: use live-buffered points so labels update at 60fps
        const livePts = dragLiveRef.current?.id === selectedDrawing.id
          ? dragLiveRef.current.points
          : selectedDrawing.points;

        const formatPrice = (p: number) =>
          p >= 10000 ? p.toFixed(2)
          : p >= 1000 ? p.toFixed(2)
          : p >= 100  ? p.toFixed(3)
          : p >= 1    ? p.toFixed(4)
          : p.toFixed(6);

        const labels = livePts.map((pt, i) => {
          const py = candle!.priceToCoordinate(pt.price) as number | null;
          if (py === null) return null;
          const absY = rect.top + (py as number);
          // Clamp inside visible area
          if (absY < rect.top - 2 || absY > rect.bottom + 2) return null;
          return createPortal(
            <div
              key={`pslabel-${selectedDrawing.id}-${i}`}
              style={{
                position: "fixed",
                left: labelX,
                top: absY - 11,
                background: "#1d4ed8",
                color: "#e2e8f0",
                padding: "2px 7px 2px 5px",
                borderRadius: "0 3px 3px 0",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
                whiteSpace: "nowrap",
                pointerEvents: "none",
                zIndex: 200,
                userSelect: "none",
                lineHeight: "18px",
                minWidth: 52,
              }}
            >
              {formatPrice(pt.price)}
            </div>,
            document.body,
            `pslabel-${selectedDrawing.id}-${i}`
          );
        });

        return <>{labels}</>;
      })()}

      {/* ── Floating toolbar — desktop only; mobile uses DrawingMiniBar in MobileChartLayout ── */}
      {!isMobile && lastDrawingRef.current && lastPosRef.current && (() => {
        const d         = selectedDrawing ?? lastDrawingRef.current!;
        const pos       = toolbarPos ?? lastPosRef.current!;
        const isVisible = !!(toolbarPos && selectedDrawing);
        const isPosTool = d.toolType === "position_long" || d.toolType === "position_short";

        const commonUpdate = (patch: Partial<DrawingStyle>) => {
          const merged = { ...d.style, ...patch };
          updateDrawing(d.id, { style: merged });
          void patchDrawingStyle(d.id, patch);
          saveDrawingStyle(d.toolType, merged);
          useDrawingStore.getState().setActiveStyle(patch);
        };
        const commonDelete = () => {
          void handleErase(d.id);
          selectDrawing(null);
          setShowStylePanel(false);
        };

        if (isPosTool) {
          return (
            <PositionToolbar
              key={`ptb-${d.id}`}
              visible={isVisible}
              pos={pos}
              drawing={d}
              onUpdate={commonUpdate}
              onUpdatePoints={(pts) => {
                updateDrawing(d.id, { points: pts });
                void patchDrawing(d.id, pts);
              }}
              onDelete={commonDelete}
              onLock={() => { void handleToggleLock(d.id); }}
              onHide={() => { void handleToggleVisibility(d.id); }}
              onReverse={() => { void handleReverseDrawing(d.id); }}
              onDuplicate={() => { void handleDuplicateDrawing(d.id); }}
            />
          );
        }

        return (
          <FloatingMiniToolbar
            visible={isVisible}
            pos={pos}
            drawing={d}
            onStylePanel={handleToggleStylePanel}
            onAlert={() => { onDrawingAlert?.(d); }}
            onHide={() => { void handleToggleVisibility(d.id); }}
            onLock={() => { void handleToggleLock(d.id); }}
            onUpdate={commonUpdate}
            onDelete={commonDelete}
          />
        );
      })()}

      {/* ── Per-drawing settings modal ────────────────────────────────────── */}
      {showStylePanel && lastDrawingRef.current && (toolbarPos ?? lastPosRef.current) && (() => {
        const panelDrawing = selectedDrawing ?? lastDrawingRef.current!;
        const panelPos     = toolbarPos ?? lastPosRef.current!;
        return (
          <DrawingSettingsModal
            drawing={panelDrawing}
            pos={panelPos}
            onUpdate={(patch) => {
              const merged = { ...panelDrawing.style, ...patch };
              updateDrawing(panelDrawing.id, { style: merged });
              void patchDrawingStyle(panelDrawing.id, patch);
              saveDrawingStyle(panelDrawing.toolType, merged);
              useDrawingStore.getState().setActiveStyle(patch);
            }}
            onUpdatePoints={(points) => {
              updateDrawing(panelDrawing.id, { points });
              void patchDrawing(panelDrawing.id, points);
            }}
            onClose={handleCloseStylePanel}
          />
        );
      })()}
    </div>
  );
});

export default DrawingOverlay;
