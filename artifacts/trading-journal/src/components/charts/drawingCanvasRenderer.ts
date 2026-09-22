/**
 * Imperative Canvas2D renderer for all drawing visual paths.
 * Called directly from a RAF loop — zero React involvement during pan/zoom.
 * Position tools (position_long/short) are rendered in SVG (too complex for canvas).
 */
import type { Drawing, DrawingPoint, DrawingStyle } from "@/types/drawing";

export type Px = { x: number; y: number };
export type ToPxFn = (pt: DrawingPoint) => Px | null;

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

function hexToRgba(hex: string, alpha: number): string {
  const h = (hex || "#089981").replace("#", "").slice(0, 6).padEnd(6, "0");
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

function setDash(ctx: CanvasRenderingContext2D, s: string) {
  if (s === "dashed") ctx.setLineDash([8, 5]);
  else if (s === "dotted") ctx.setLineDash([2, 5]);
  else ctx.setLineDash([]);
}

function extendBothEnds(a: Px, b: Px, W: number, H: number): [Px, Px] {
  if (Math.abs(b.x - a.x) < 0.5) return [{ x: a.x, y: -20 }, { x: a.x, y: H + 20 }];
  const slope = (b.y - a.y) / (b.x - a.x);
  return [
    { x: -20,    y: a.y + slope * (-20 - a.x) },
    { x: W + 20, y: a.y + slope * (W + 20 - a.x) },
  ];
}

function extendRight(a: Px, b: Px, W: number): [Px, Px] {
  if (Math.abs(b.x - a.x) < 0.5) return [a, { x: a.x, y: 0 }];
  const slope = (b.y - a.y) / (b.x - a.x);
  return [a, { x: W + 20, y: a.y + slope * (W + 20 - a.x) }];
}

function extendLeft(a: Px, b: Px): [Px, Px] {
  if (Math.abs(b.x - a.x) < 0.5) return [{ x: a.x, y: 9999 }, b];
  const slope = (b.y - a.y) / (b.x - a.x);
  return [{ x: -20, y: a.y + slope * (-20 - a.x) }, b];
}

function parallelOffset(a: Px, b: Px, dist: number): [Px, Px] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * dist, ny = dx / len * dist;
  return [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }];
}

function drawLine(ctx: CanvasRenderingContext2D, a: Px, b: Px) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

type OhlcBar = { time: number; open: number; high: number; low: number; close: number };

function fmtPrice(p: number): string {
  if (p >= 10000) return p.toFixed(2);
  if (p >= 100)   return p.toFixed(3);
  if (p >= 1)     return p.toFixed(5);
  return p.toFixed(6);
}

/**
 * Liang-Barsky line clipping — returns the midpoint of the visible segment,
 * or null if the segment is entirely outside [margin, W-margin] × [margin, H-margin].
 */
function visibleMidpoint(a: Px, b: Px, W: number, H: number): Px | null {
  const M = 6; // margin from canvas edge
  const xmin = M, xmax = W - M, ymin = M, ymax = H - M;
  if (xmax <= xmin || ymax <= ymin) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-10) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else       { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!clip(-dx, a.x - xmin)) return null;
  if (!clip( dx, xmax - a.x)) return null;
  if (!clip(-dy, a.y - ymin)) return null;
  if (!clip( dy, ymax - a.y)) return null;
  const tMid = (t0 + t1) / 2;
  return { x: a.x + tMid * dx, y: a.y + tMid * dy };
}

/**
 * Draws a small semi-transparent pill label (e.g. "TL-003") at the visible
 * midpoint of the line from a→b.  No-op if the line is entirely off-canvas.
 */
function renderIdPill(
  ctx: CanvasRenderingContext2D,
  a: Px, b: Px,
  W: number, H: number,
  label: string,
  isSelected: boolean,
) {
  const mid = visibleMidpoint(a, b, W, H);
  if (!mid) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.shadowBlur  = 0;
  ctx.shadowColor = "transparent";
  const fs = 10;
  ctx.font = `600 ${fs}px "Inter",system-ui,sans-serif`;
  const tw = ctx.measureText(label).width;
  const pH = 15, pW = tw + 10, r = 3.5;
  const M2 = 4;
  // Centre the pill on mid, then clamp it fully inside the canvas
  const rx = Math.max(M2, Math.min(mid.x - pW / 2, W - pW - M2));
  const ry = Math.max(M2, Math.min(mid.y - pH / 2, H - pH - M2));
  ctx.globalAlpha   = 1;
  ctx.fillStyle     = isSelected ? "rgba(183,255,90,0.18)"   : "rgba(7,17,13,0.85)";
  ctx.strokeStyle   = isSelected ? "rgba(183,255,90,0.70)"   : "rgba(183,255,90,0.38)";
  ctx.lineWidth     = isSelected ? 1.2 : 0.8;
  ctx.beginPath();
  ctx.moveTo(rx + r, ry);
  ctx.lineTo(rx + pW - r, ry);
  ctx.arcTo(rx + pW, ry, rx + pW, ry + r, r);
  ctx.lineTo(rx + pW, ry + pH - r);
  ctx.arcTo(rx + pW, ry + pH, rx + pW - r, ry + pH, r);
  ctx.lineTo(rx + r, ry + pH);
  ctx.arcTo(rx, ry + pH, rx, ry + pH - r, r);
  ctx.lineTo(rx, ry + r);
  ctx.arcTo(rx, ry, rx + r, ry, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle    = isSelected ? "#B7FF5A" : "rgba(255,255,255,0.92)";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, rx + pW / 2, ry + pH / 2);
  ctx.restore();
}

function renderLineLabelCanvas(
  ctx: CanvasRenderingContext2D,
  p0: Px, p1: Px,
  style: DrawingStyle,
  col: string, sw: number
) {
  if (!style.text?.trim()) return;
  const label  = style.text.trim();
  const tCol   = style.textColor ?? col;
  const tSize  = style.fontSize  ?? 13;
  const tWt    = style.fontBold   ? "700" : "500";
  const tSt    = style.fontItalic ? "italic" : "normal";
  const [lp, rp] = p0.x <= p1.x ? [p0, p1] : [p1, p0];
  const ldx = rp.x - lp.x, ldy = rp.y - lp.y;
  const ang = Math.atan2(ldy, ldx);
  const tRatio = style.textAlignH === "right" ? 0.8 : style.textAlignH === "center" ? 0.5 : 0.2;
  const tx = lp.x + ldx * tRatio, ty = lp.y + ldy * tRatio;
  const gap = sw / 2 + tSize * 0.6 + 3;
  const dy  = style.textAlignV === "bottom" ? gap : style.textAlignV === "middle" ? 0 : -gap;
  ctx.save();
  ctx.translate(tx, ty);
  ctx.rotate(ang);
  ctx.font = `${tSt} ${tWt} ${tSize}px 'Inter','SF Pro Display',system-ui,sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign    = style.textAlignH === "right" ? "end" : style.textAlignH === "center" ? "center" : "start";
  ctx.strokeStyle  = "rgba(7,17,13,0.85)";
  ctx.lineWidth    = 3.5;
  ctx.setLineDash([]);
  ctx.strokeText(label, 0, dy);
  ctx.fillStyle = tCol;
  ctx.fillText(label, 0, dy);
  ctx.restore();
}

function renderPositionTool(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  toPx: ToPxFn,
  bars: OhlcBar[],
  barHalfWidth: number,
  W: number,
  isSelected: boolean,
) {
  const { points, style } = drawing;
  if (points.length < 2) return;
  const isLong     = drawing.toolType === "position_long";
  const entryPrice = points[0].price;
  const tpPrice    = points[1].price;
  const slPrice    = points.length >= 3
    ? points[2].price
    : isLong
      ? entryPrice - Math.abs(tpPrice - entryPrice) * 0.5
      : entryPrice + Math.abs(tpPrice - entryPrice) * 0.5;

  const entPx  = toPx(points[0]);
  const tpPx   = toPx(points[1]);
  const slPxPt = toPx({ time: points[0].time, price: slPrice });
  if (!entPx || !tpPx || !slPxPt) return;

  const entY = entPx.y, tpY = tpPx.y, slY = slPxPt.y;

  const rawL  = Math.min(entPx.x, tpPx.x);
  const rawR  = Math.max(entPx.x, tpPx.x);
  const zoneW = Math.max(0, rawR - rawL);
  const ELX   = zoneW < 20 ? entPx.x - 120 : rawL - barHalfWidth;
  const ERX   = zoneW < 20 ? entPx.x + 120  : rawR;
  const ZW    = Math.max(0, ERX - ELX);

  const profitHex = style.profitColor ?? "#089981";
  const stopHex   = style.stopColor   ?? "#f23645";

  const profitTop = Math.min(entY, tpY);
  const profitH   = Math.abs(tpY - entY);
  const lossTop   = Math.min(entY, slY);
  const lossH     = Math.abs(slY - entY);

  // Scan bars to find TP/SL hits and the last active bar
  let profitSplitX   = ELX;
  let lastActiveBar: OhlcBar | null = null;
  let tpWasHit       = false;
  let slWasHit       = false;

  if (bars.length > 0) {
    const toolLeftTime  = Math.min(points[0].time, points[1].time);
    const toolRightTime = Math.max(points[0].time, points[1].time);
    const barsInRange   = bars.filter(b => b.time >= toolLeftTime && b.time <= toolRightTime);
    let tpHitTime: number | null = null, slHitTime: number | null = null;
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
    const lastBarTime   = barsInRange.length > 0 ? barsInRange[barsInRange.length - 1].time : null;
    const firstHitTime  = Math.min(tpHitTime ?? Infinity, slHitTime ?? Infinity);
    let limitTime: number | null = lastBarTime;
    if (firstHitTime !== Infinity) {
      tpWasHit  = tpHitTime !== null && tpHitTime <= (slHitTime ?? Infinity);
      slWasHit  = slHitTime !== null && slHitTime <  (tpHitTime ?? Infinity);
      limitTime = limitTime !== null ? Math.min(limitTime, firstHitTime) : firstHitTime;
    }
    if (limitTime !== null) {
      lastActiveBar = barsInRange.filter(b => b.time <= limitTime!).pop() ?? null;
      const sp = toPx({ time: limitTime, price: entryPrice });
      if (sp) profitSplitX = Math.min(ERX, Math.max(ELX, sp.x));
    }
  }

  const tradeStatus  = tpWasHit ? "TP_HIT" : slWasHit ? "SL_HIT" : "RUNNING";
  const activeFillW  = Math.max(0, profitSplitX - ELX);

  ctx.save();

  // ── Profit zone ───────────────────────────────────────────────────────────
  // Always draw dim background covering the full zone.
  ctx.fillStyle = hexToRgba(profitHex, 0.32);
  ctx.fillRect(ELX, profitTop, ZW, profitH);

  if (tradeStatus === "TP_HIT" && activeFillW > 0) {
    // TP hit: horizontal bright fill up to the hit candle
    ctx.fillStyle = hexToRgba(profitHex, 0.55);
    ctx.fillRect(ELX, profitTop, activeFillW, profitH);
  } else if (tradeStatus === "RUNNING" && lastActiveBar) {
    // Running: vertical bright fill from entry price → current close price
    const inProfitSide = isLong
      ? lastActiveBar.close >= entryPrice
      : lastActiveBar.close <= entryPrice;
    if (inProfitSide) {
      const closePx = toPx({ time: lastActiveBar.time, price: lastActiveBar.close });
      if (closePx) {
        const liveTop = Math.min(entY, closePx.y);
        const liveH   = Math.abs(closePx.y - entY);
        if (liveH > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(ELX, profitTop, ZW, profitH);
          ctx.clip();
          ctx.fillStyle = hexToRgba(profitHex, 0.55);
          ctx.fillRect(ELX, liveTop, ZW, liveH);
          ctx.restore();
        }
      }
    }
  }

  // ── Loss zone ─────────────────────────────────────────────────────────────
  // Always draw dim background covering the full zone.
  ctx.fillStyle = hexToRgba(stopHex, 0.32);
  ctx.fillRect(ELX, lossTop, ZW, lossH);

  if (tradeStatus === "SL_HIT" && activeFillW > 0) {
    // SL hit: horizontal bright fill up to the hit candle
    ctx.fillStyle = hexToRgba(stopHex, 0.55);
    ctx.fillRect(ELX, lossTop, activeFillW, lossH);
  }

  // Boundary lines
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = hexToRgba(profitHex, 1);
  ctx.beginPath(); ctx.moveTo(ELX, tpY); ctx.lineTo(ERX, tpY); ctx.stroke();
  ctx.strokeStyle = hexToRgba(stopHex, 1);
  ctx.beginPath(); ctx.moveTo(ELX, slY); ctx.lineTo(ERX, slY); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.setLineDash([7, 4]);
  ctx.beginPath(); ctx.moveTo(ELX, entY); ctx.lineTo(ERX, entY); ctx.stroke();
  ctx.setLineDash([]);

  // Labels — PnL % is always calculated relative to direction:
  // Long:  TP profit = (tpPrice - entry) / entry;  SL loss = (entry - slPrice) / entry
  // Short: TP profit = (entry - tpPrice) / entry;  SL loss = (slPrice - entry) / entry
  if (profitH >= 28 && ZW >= 60) {
    const reward   = Math.abs(tpPrice - entryPrice);
    const risk     = Math.abs(slPrice  - entryPrice);
    const rrStr    = risk > 0 ? (reward / risk).toFixed(2) : "∞";
    const tpPnlPct = isLong
      ? ((tpPrice - entryPrice) / entryPrice * 100)
      : ((entryPrice - tpPrice) / entryPrice * 100);
    const tpPct    = Math.abs(tpPnlPct).toFixed(2);
    const tpSign   = tpPnlPct >= 0 ? "+" : "-";
    const LBL_H = 26;
    const tpBarY = isLong ? tpY : tpY - LBL_H;
    ctx.fillStyle = hexToRgba(profitHex, 0.95);
    ctx.fillRect(ELX, tpBarY, ZW, LBL_H);
    ctx.font = "700 11px 'Inter',system-ui,sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`Target: ${fmtPrice(tpPrice)}  (${tpSign}${tpPct}%)  R:R ${rrStr}`, ELX + 8, tpBarY + LBL_H / 2);
  }
  if (lossH >= 28 && ZW >= 60) {
    const slPnlPct = isLong
      ? ((entryPrice - slPrice) / entryPrice * 100)
      : ((slPrice - entryPrice) / entryPrice * 100);
    const slPct    = Math.abs(slPnlPct).toFixed(2);
    const slSign   = slPnlPct >= 0 ? "-" : "+";
    const LBL_H = 26;
    const slBarY = isLong ? slY - LBL_H : slY;
    ctx.fillStyle = hexToRgba(stopHex, 0.95);
    ctx.fillRect(ELX, slBarY, ZW, LBL_H);
    ctx.font = "700 11px 'Inter',system-ui,sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`Stop: ${fmtPrice(slPrice)}  (${slSign}${slPct}%)`, ELX + 8, slBarY + LBL_H / 2);
  }

  // Selection glow
  if (isSelected) {
    const totalTop = Math.min(tpY, slY);
    const totalH   = Math.abs(tpY - slY);
    ctx.strokeStyle = "rgba(37,99,235,0.38)";
    ctx.lineWidth = 1.2;
    ctx.strokeRect(ELX, totalTop, ZW, Math.max(totalH, 20));
  }

  ctx.restore();
}

export function renderDrawingsToCanvas(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  drawings: Drawing[],
  toPx: ToPxFn,
  selectedId: number | null,
  dragLive: { id: number; points: DrawingPoint[] } | null,
  barHalfWidth: number,
  bars: OhlcBar[],
  dpr: number,
  moveDragId: number | null = null, // drawing currently being move-dragged (SVG DOM transform handles it)
  clipH: number = H,               // chart plotting area height (excludes date/time scale)
) {
  ctx.clearRect(0, 0, W * dpr, H * dpr);
  if (W <= 0 || H <= 0) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  // Clip to chart plotting area — excludes date scale at bottom and never overflows price scale.
  // clipH is passed from the caller as H - chart.timeScale().height() so drawings never paint
  // over the date scale or other UI regions outside the candlestick pane.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, clipH > 0 ? clipH : H);
  ctx.clip();

  // Drawings being anchor-dragged: skip in the main loop and render AFTER so they always
  // appear on top and are guaranteed to render exactly once at the live (dragged) position.
  // This prevents the one-frame ghost that appears when the React SVG re-render (moving the
  // anchor handles) races ahead of the canvas RAF (still showing the saved position).
  const anchorDragId = (dragLive !== null && moveDragId === null) ? dragLive.id : null;

  for (const drawing of drawings) {
    if (!drawing.isVisible) continue;
    if (drawing.id === moveDragId) continue; // SVG DOM transform handles visual during move-drag
    if (drawing.id === anchorDragId) continue; // rendered separately after the loop (live points)

    const isSelected = drawing.id === selectedId;
    const pts        = drawing.points;
    const { style, toolType } = drawing;
    const col = style.color || "#B7FF5A";
    const sw  = style.thickness || 1;
    const op  = style.opacity ?? 1;
    if (op <= 0) continue;

    const px = pts.map(toPx).filter(Boolean) as Px[];

    ctx.save();
    ctx.globalAlpha = op;
    ctx.strokeStyle = col;
    ctx.fillStyle   = col;
    ctx.lineWidth   = sw;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    setDash(ctx, style.lineStyle || "solid");

    // Selection glow via shadow (applied to visual paths below)
    if (isSelected && toolType !== "position_long" && toolType !== "position_short") {
      ctx.shadowColor  = col;
      ctx.shadowBlur   = 8;
    }

    if (toolType === "position_long" || toolType === "position_short") {
      renderPositionTool(ctx, { ...drawing, points: pts }, toPx, bars, barHalfWidth, W, isSelected);
      ctx.restore();
      continue;
    }

    switch (toolType) {
      case "trendline": {
        if (px.length < 2) break;
        const extL = style.extendLeft  ?? false;
        const extR = style.extendRight ?? false;
        let a = px[0], b = px[1];
        if (extL && extR) [a, b] = extendBothEnds(px[0], px[1], W, H);
        else if (extL)    [a, b] = extendLeft(px[0], px[1]);
        else if (extR)    [a, b] = extendRight(px[0], px[1], W);
        if (isSelected) {
          ctx.save();
          ctx.shadowBlur  = 0;
          ctx.strokeStyle = col;
          ctx.lineWidth   = sw + 7;
          ctx.globalAlpha *= 0.2;
          drawLine(ctx, a, b);
          ctx.restore();
        }
        drawLine(ctx, a, b);
        if (!extL) dot(ctx, px[0].x, px[0].y, 3.5, col);
        if (!extR) dot(ctx, px[1].x, px[1].y, 3.5, col);
        if (style.showPriceLabels) {
          ctx.save();
          ctx.shadowBlur = 0;
          ctx.setLineDash([]);
          ctx.font = '600 10px "JetBrains Mono","Fira Code",monospace';
          ctx.fillStyle = col;
          if (!extL) { ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText(fmtPrice(pts[0].price), px[0].x + 5, px[0].y - 6); }
          if (!extR) { ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText(fmtPrice(pts[1].price), px[1].x + 5, px[1].y - 6); }
          ctx.restore();
        }
        if (style.text?.trim()) renderLineLabelCanvas(ctx, px[0], px[1], style, col, sw);
        if (drawing.displayId) renderIdPill(ctx, a, b, W, clipH > 0 ? clipH : H, drawing.displayId, isSelected);
        break;
      }

      case "extended": {
        if (px.length < 2) break;
        const [a, b] = extendBothEnds(px[0], px[1], W, H);
        if (isSelected) { ctx.save(); ctx.shadowBlur = 0; ctx.lineWidth = sw + 7; ctx.globalAlpha *= 0.2; drawLine(ctx, a, b); ctx.restore(); }
        drawLine(ctx, a, b);
        dot(ctx, px[0].x, px[0].y, 3, col);
        dot(ctx, px[1].x, px[1].y, 3, col);
        if (style.text?.trim()) renderLineLabelCanvas(ctx, px[0], px[1], style, col, sw);
        if (drawing.displayId) renderIdPill(ctx, a, b, W, clipH > 0 ? clipH : H, drawing.displayId, isSelected);
        break;
      }

      case "ray": {
        if (px.length < 2) break;
        const [a, b] = extendRight(px[0], px[1], W);
        if (isSelected) { ctx.save(); ctx.shadowBlur = 0; ctx.lineWidth = sw + 7; ctx.globalAlpha *= 0.2; drawLine(ctx, a, b); ctx.restore(); }
        drawLine(ctx, a, b);
        dot(ctx, px[0].x, px[0].y, 3.5, col);
        if (style.text?.trim()) renderLineLabelCanvas(ctx, px[0], px[1], style, col, sw);
        if (drawing.displayId) renderIdPill(ctx, a, b, W, clipH > 0 ? clipH : H, drawing.displayId, isSelected);
        break;
      }

      case "hline":
      case "hray": {
        if (px.length < 1) break;
        const xEnd = toolType === "hray" ? W : W;
        const xStart = toolType === "hray" ? px[0].x : 0;
        ctx.beginPath();
        ctx.moveTo(xStart, px[0].y);
        ctx.lineTo(xEnd, px[0].y);
        ctx.stroke();
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);
        ctx.font = '11px "JetBrains Mono","Fira Code",monospace';
        ctx.fillStyle = col;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText(pts[0].price.toFixed(pts[0].price > 1000 ? 2 : 5), W - 6, px[0].y - 2);
        ctx.restore();
        break;
      }

      case "vline": {
        if (px.length < 1) break;
        ctx.beginPath(); ctx.moveTo(px[0].x, 0); ctx.lineTo(px[0].x, H); ctx.stroke();
        break;
      }

      case "rect": {
        if (px.length < 2) break;
        const rawLeft = Math.min(px[0].x, px[1].x), rawRight = Math.max(px[0].x, px[1].x);
        const rx = style.extendLeft ? -20 : rawLeft;
        const rectRight = style.extendRight ? W + 20 : rawRight;
        const ry = Math.min(px[0].y, px[1].y);
        const rw = Math.max(1, rectRight - rx), rh = Math.abs(px[1].y - px[0].y);
        if ((style.fillOpacity ?? 0) > 0) {
          ctx.save();
          ctx.shadowBlur = 0;
          ctx.fillStyle = hexToRgba(col, style.fillOpacity ?? 0);
          ctx.fillRect(rx, ry, rw, rh);
          ctx.restore();
        }
        ctx.strokeRect(rx, ry, rw, rh);
        break;
      }

      case "ellipse": {
        if (px.length < 2) break;
        const cx = (px[0].x + px[1].x) / 2, cy = (px[0].y + px[1].y) / 2;
        const erx = Math.abs(px[1].x - px[0].x) / 2, ery = Math.abs(px[1].y - px[0].y) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(erx, 0.1), Math.max(ery, 0.1), 0, 0, Math.PI * 2);
        if ((style.fillOpacity ?? 0) > 0) {
          ctx.save(); ctx.shadowBlur = 0;
          ctx.fillStyle = hexToRgba(col, style.fillOpacity ?? 0);
          ctx.fill(); ctx.restore();
        }
        ctx.stroke();
        break;
      }

      case "arrow": {
        if (px.length < 2) break;
        drawLine(ctx, px[0], px[1]);
        const sz  = Math.max(8, sw * 4);
        const ang = Math.atan2(px[1].y - px[0].y, px[1].x - px[0].x);
        ctx.beginPath();
        ctx.moveTo(px[1].x, px[1].y);
        ctx.lineTo(px[1].x + sz * Math.cos(ang + Math.PI * 0.75), px[1].y + sz * Math.sin(ang + Math.PI * 0.75));
        ctx.moveTo(px[1].x, px[1].y);
        ctx.lineTo(px[1].x + sz * Math.cos(ang - Math.PI * 0.75), px[1].y + sz * Math.sin(ang - Math.PI * 0.75));
        ctx.stroke();
        dot(ctx, px[0].x, px[0].y, 3, col);
        break;
      }

      case "brush": {
        if (pts.length < 2) break;
        const bPts = pts.map(toPx).filter(Boolean) as Px[];
        if (bPts.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(bPts[0].x, bPts[0].y);
        for (let i = 1; i < bPts.length; i++) ctx.lineTo(bPts[i].x, bPts[i].y);
        ctx.stroke();
        break;
      }

      case "highlighter": {
        if (pts.length < 2) break;
        const hPts = pts.map(toPx).filter(Boolean) as Px[];
        if (hPts.length < 2) break;
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.globalAlpha *= 0.38;
        ctx.lineWidth = Math.max(sw * 8, 14);
        ctx.beginPath();
        ctx.moveTo(hPts[0].x, hPts[0].y);
        for (let i = 1; i < hPts.length; i++) ctx.lineTo(hPts[i].x, hPts[i].y);
        ctx.stroke();
        ctx.restore();
        break;
      }

      case "path": {
        if (px.length < 2) break;
        drawLine(ctx, px[0], px[1]);
        dot(ctx, px[0].x, px[0].y, 3, col);
        dot(ctx, px[1].x, px[1].y, 3, col);
        break;
      }

      case "curve": {
        if (px.length < 2) break;
        const midX = (px[0].x + px[1].x) / 2, midY = (px[0].y + px[1].y) / 2;
        const dxL = px[1].x - px[0].x, dyL = px[1].y - px[0].y;
        const len = Math.hypot(dxL, dyL) || 1;
        ctx.beginPath();
        ctx.moveTo(px[0].x, px[0].y);
        ctx.quadraticCurveTo(midX - (dyL / len) * len * 0.25, midY + (dxL / len) * len * 0.25, px[1].x, px[1].y);
        ctx.stroke();
        dot(ctx, px[0].x, px[0].y, 3, col);
        dot(ctx, px[1].x, px[1].y, 3, col);
        break;
      }

      case "channel": {
        if (px.length < 2) break;
        const dx = px[1].x - px[0].x, dy = px[1].y - px[0].y;
        const len = Math.hypot(dx, dy) || 1;
        const cW = px.length >= 3 ? ((px[2].x-px[0].x)*(-dy)+(px[2].y-px[0].y)*dx)/len : Math.min(H*0.12,60);
        const [c0, c1] = parallelOffset(px[0], px[1], cW);
        const [a1, b1] = extendBothEnds(px[0], px[1], W, H);
        const [a2, b2] = extendBothEnds(c0, c1, W, H);
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.globalAlpha *= (style.fillOpacity ?? 0.1) * 0.5;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(a1.x, a1.y); ctx.lineTo(b1.x, b1.y);
        ctx.lineTo(b2.x, b2.y); ctx.lineTo(a2.x, a2.y);
        ctx.closePath(); ctx.fill();
        ctx.restore();
        drawLine(ctx, a1, b1);
        ctx.save(); ctx.shadowBlur = 0; ctx.globalAlpha *= 0.6; drawLine(ctx, a2, b2); ctx.restore();
        dot(ctx, px[0].x, px[0].y, 3.5, col);
        dot(ctx, px[1].x, px[1].y, 3.5, col);
        if (px.length >= 3) dot(ctx, px[2].x, px[2].y, 3.5, col);
        break;
      }

      case "fib": {
        if (px.length < 2 || pts.length < 2) break;
        const pDiff = pts[1].price - pts[0].price;
        const x0 = Math.min(px[0].x, px[1].x), x1 = Math.max(px[0].x, px[1].x);
        ctx.shadowBlur = 0;
        for (const { level, label, opacity } of FIB_LEVELS) {
          const price = pts[0].price + pDiff * level;
          const yp = toPx({ time: pts[0].time, price });
          if (!yp) continue;
          ctx.save();
          ctx.globalAlpha *= opacity;
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(x0, yp.y); ctx.lineTo(x1, yp.y); ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = '600 11px "JetBrains Mono","Fira Code",monospace';
          ctx.fillStyle = col;
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(label, x1 + 4, yp.y);
          ctx.textAlign = "right";
          ctx.fillText(price.toFixed(price > 1000 ? 2 : 5), x0 - 4, yp.y);
          ctx.restore();
        }
        dot(ctx, px[0].x, px[0].y, 3, col);
        dot(ctx, px[1].x, px[1].y, 3, col);
        break;
      }

      case "fib_ext": {
        if (px.length < 2 || pts.length < 2) break;
        const pDiff2 = pts[1].price - pts[0].price;
        const x0e = Math.min(px[0].x, px[1].x), x1e = Math.max(px[0].x, px[1].x);
        ctx.shadowBlur = 0;
        for (const { level, label } of FIB_EXT_LEVELS) {
          const price = pts[0].price + pDiff2 * level;
          const yp = toPx({ time: pts[0].time, price });
          if (!yp) continue;
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(x0e, yp.y); ctx.lineTo(x1e, yp.y); ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = '600 11px "JetBrains Mono","Fira Code",monospace';
          ctx.fillStyle = col;
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(label, x1e + 4, yp.y);
          ctx.textAlign = "right";
          ctx.fillText(price.toFixed(price > 1000 ? 2 : 5), x0e - 4, yp.y);
        }
        dot(ctx, px[0].x, px[0].y, 3, col);
        dot(ctx, px[1].x, px[1].y, 3, col);
        break;
      }

      case "fib_channel": {
        if (px.length < 2) break;
        const chH = Math.abs(px[1].y - px[0].y) || H * 0.15;
        const fibChLvls = [
          { level: 0,     label: "0",     fop: 1.0 }, { level: 0.236, label: "0.236", fop: 0.7 },
          { level: 0.382, label: "0.382", fop: 0.85}, { level: 0.5,   label: "0.5",   fop: 0.9 },
          { level: 0.618, label: "0.618", fop: 0.85}, { level: 0.786, label: "0.786", fop: 0.7 },
          { level: 1.0,   label: "1",     fop: 1.0 }, { level: 1.618, label: "1.618", fop: 0.6 },
        ];
        ctx.shadowBlur = 0;
        for (const { level, label, fop } of fibChLvls) {
          const [fa, fb] = parallelOffset(px[0], px[1], chH * level);
          const [ea, eb] = extendBothEnds(fa, fb, W, H);
          ctx.save();
          ctx.globalAlpha *= fop;
          ctx.lineWidth = (level === 0 || level === 1) ? sw : 1;
          if (level !== 0 && level !== 1) ctx.setLineDash([5, 4]);
          drawLine(ctx, ea, eb);
          ctx.setLineDash([]);
          const mx = (fa.x + fb.x) / 2, my = (fa.y + fb.y) / 2;
          ctx.font = '600 10px "JetBrains Mono","Fira Code",monospace';
          ctx.fillStyle = col;
          ctx.textAlign = "left"; ctx.textBaseline = "bottom";
          ctx.fillText(label, mx + 4, my - 3);
          ctx.restore();
        }
        dot(ctx, px[0].x, px[0].y, 3.5, col);
        dot(ctx, px[1].x, px[1].y, 3.5, col);
        break;
      }

      case "text": {
        if (px.length < 1) break;
        const label  = style.text ?? "Text";
        const tCol   = style.textColor ?? col;
        const tSize  = style.fontSize  ?? 13;
        const tWt    = style.fontBold   ? "700" : "600";
        const tSt    = style.fontItalic ? "italic" : "normal";
        const approxW = label.length * (tSize * 0.6) + 10;
        const offX   = style.textAlignH === "right" ? approxW : style.textAlignH === "center" ? approxW / 2 : 0;
        const offY   = style.textAlignV === "bottom" ? 0 : style.textAlignV === "middle" ? -tSize / 2 : -tSize;
        ctx.save();
        ctx.shadowBlur = 0;
        if (isSelected) {
          ctx.fillStyle   = hexToRgba(tCol, 0.13);
          ctx.strokeStyle = tCol;
          ctx.lineWidth   = 1;
          ctx.setLineDash([]);
          ctx.fillRect(px[0].x - 4 - offX, px[0].y - tSize - 4 + offY, approxW + 8, tSize + 8);
          ctx.strokeRect(px[0].x - 4 - offX, px[0].y - tSize - 4 + offY, approxW + 8, tSize + 8);
        }
        ctx.font = `${tSt} ${tWt} ${tSize}px 'Inter','SF Pro Display',system-ui,sans-serif`;
        const tAlignMap: CanvasTextAlign = style.textAlignH === "right" ? "right" : style.textAlignH === "center" ? "center" : "left";
        ctx.textAlign    = tAlignMap;
        ctx.textBaseline = "top";
        ctx.strokeStyle  = "rgba(7,17,13,0.8)";
        ctx.lineWidth    = 3;
        ctx.setLineDash([]);
        ctx.strokeText(label, px[0].x, px[0].y + offY);
        ctx.fillStyle = tCol;
        ctx.fillText(label, px[0].x, px[0].y + offY);
        ctx.restore();
        break;
      }

      case "note": {
        if (px.length < 1) break;
        const noteText = style.text ?? "Note";
        const tCol  = style.textColor ?? col;
        const tSize = style.fontSize  ?? 12;
        const tWt   = style.fontBold   ? "700" : "500";
        const tSt   = style.fontItalic ? "italic" : "normal";
        const lines = noteText.split("\n");
        const lineH = Math.max(tSize + 4, 16);
        const padX = 10, padY = 8;
        const bW = Math.max(...lines.map(l => l.length * (tSize * 0.6))) + padX * 2 + 12;
        const bH = lines.length * lineH + padY * 2 + 10;
        const bx = px[0].x + 10, by = px[0].y - bH - 4;
        const tailH = 8;
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash([]);
        ctx.fillStyle = hexToRgba(col, 0.13);
        ctx.beginPath();
        (ctx as any).roundRect?.(bx, by, bW, bH, 6) ?? ctx.rect(bx, by, bW, bH);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = hexToRgba(col, 0.18);
        ctx.beginPath();
        (ctx as any).roundRect?.(bx, by, bW, tailH + 2, 6) ?? ctx.rect(bx, by, bW, tailH + 2);
        ctx.fill();
        ctx.font = `${tSt} ${tWt} ${tSize}px 'Inter','SF Pro Display',system-ui,sans-serif`;
        ctx.fillStyle = tCol;
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i] || " ", bx + padX, by + padY + tailH + lineH * i);
        }
        ctx.restore();
        break;
      }

      case "ruler":
      case "price_range": {
        if (px.length < 2 || pts.length < 2) break;
        drawLine(ctx, px[0], px[1]);
        ctx.save(); ctx.shadowBlur = 0; ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(px[0].x - 4, px[0].y); ctx.lineTo(px[0].x + 4, px[0].y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px[1].x - 4, px[1].y); ctx.lineTo(px[1].x + 4, px[1].y); ctx.stroke();
        const midX = (px[0].x + px[1].x) / 2, midY = (px[0].y + px[1].y) / 2;
        const pDiffR = Math.abs(pts[1].price - pts[0].price);
        const pctR   = ((pts[1].price - pts[0].price) / pts[0].price * 100).toFixed(2);
        const lbl    = `${pDiffR.toFixed(2)} (${pctR}%)`;
        ctx.fillStyle = "rgba(9,18,14,0.9)"; ctx.strokeStyle = col; ctx.lineWidth = 1;
        ctx.beginPath();
        (ctx as any).roundRect?.(midX - 48, midY - 13, 96, 24, 5) ?? ctx.rect(midX - 48, midY - 13, 96, 24);
        ctx.fill(); ctx.stroke();
        ctx.font = '700 11px "JetBrains Mono","Fira Code",monospace';
        ctx.fillStyle = col; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(lbl, midX, midY);
        ctx.restore();
        break;
      }

      default: {
        if (px.length >= 2) drawLine(ctx, px[0], px[px.length - 1]);
        break;
      }
    }

    ctx.restore();
  }

  // ── Anchor-drag drawing: render last with live points (guaranteed single render, on top) ──
  if (anchorDragId !== null && dragLive !== null) {
    const d = drawings.find(dr => dr.id === anchorDragId);
    if (d && d.isVisible) {
      const isSelected = d.id === selectedId;
      const pts        = dragLive.points;
      const { style, toolType } = d;
      const col = style.color || "#B7FF5A";
      const sw  = style.thickness || 1;
      const op  = style.opacity ?? 1;
      if (op > 0) {
        const px = pts.map(toPx).filter(Boolean) as Px[];
        ctx.save();
        ctx.globalAlpha = op;
        ctx.strokeStyle = col;
        ctx.fillStyle   = col;
        ctx.lineWidth   = sw;
        ctx.lineCap     = "round";
        ctx.lineJoin    = "round";
        setDash(ctx, style.lineStyle || "solid");
        if (isSelected && toolType !== "position_long" && toolType !== "position_short") {
          ctx.shadowColor = col;
          ctx.shadowBlur  = 8;
        }
        if (toolType === "position_long" || toolType === "position_short") {
          renderPositionTool(ctx, { ...d, points: pts }, toPx, bars, barHalfWidth, W, isSelected);
        } else {
          // Re-use the full switch by calling a minimal inline version for the anchor-dragged drawing.
          // Only the most common anchor-draggable types are listed here.
          switch (toolType) {
            case "trendline": {
              if (px.length < 2) break;
              const extL = style.extendLeft  ?? false;
              const extR = style.extendRight ?? false;
              let a = px[0], b = px[1];
              if (extL && extR) [a, b] = extendBothEnds(px[0], px[1], W, H);
              else if (extL)    [a, b] = extendLeft(px[0], px[1]);
              else if (extR)    [a, b] = extendRight(px[0], px[1], W);
              if (isSelected) {
                ctx.save(); ctx.shadowBlur = 0; ctx.strokeStyle = col;
                ctx.lineWidth = sw + 7; ctx.globalAlpha *= 0.2;
                drawLine(ctx, a, b); ctx.restore();
              }
              drawLine(ctx, a, b);
              if (!extL) dot(ctx, px[0].x, px[0].y, 3.5, col);
              if (!extR) dot(ctx, px[1].x, px[1].y, 3.5, col);
              if (d.displayId) renderIdPill(ctx, a, b, W, clipH > 0 ? clipH : H, d.displayId, isSelected);
              break;
            }
            case "extended": {
              if (px.length < 2) break;
              const [ea, eb] = extendBothEnds(px[0], px[1], W, H);
              if (isSelected) { ctx.save(); ctx.shadowBlur = 0; ctx.lineWidth = sw + 7; ctx.globalAlpha *= 0.2; drawLine(ctx, ea, eb); ctx.restore(); }
              drawLine(ctx, ea, eb);
              dot(ctx, px[0].x, px[0].y, 3, col);
              dot(ctx, px[1].x, px[1].y, 3, col);
              if (d.displayId) renderIdPill(ctx, ea, eb, W, clipH > 0 ? clipH : H, d.displayId, isSelected);
              break;
            }
            case "ray": {
              if (px.length < 2) break;
              const [ra, rb] = extendRight(px[0], px[1], W);
              if (isSelected) { ctx.save(); ctx.shadowBlur = 0; ctx.lineWidth = sw + 7; ctx.globalAlpha *= 0.2; drawLine(ctx, ra, rb); ctx.restore(); }
              drawLine(ctx, ra, rb);
              dot(ctx, px[0].x, px[0].y, 3.5, col);
              if (d.displayId) renderIdPill(ctx, ra, rb, W, clipH > 0 ? clipH : H, d.displayId, isSelected);
              break;
            }
            case "hline": {
              if (px.length < 1) break;
              ctx.beginPath(); ctx.moveTo(0, px[0].y); ctx.lineTo(W, px[0].y); ctx.stroke();
              break;
            }
            case "hray": {
              if (px.length < 1) break;
              ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y); ctx.lineTo(W, px[0].y); ctx.stroke();
              break;
            }
            case "vline": {
              if (px.length < 1) break;
              ctx.beginPath(); ctx.moveTo(px[0].x, 0); ctx.lineTo(px[0].x, H); ctx.stroke();
              break;
            }
            case "rect": {
              if (px.length < 2) break;
              const rawLeft = Math.min(px[0].x, px[1].x), rawRight = Math.max(px[0].x, px[1].x);
              const rx = style.extendLeft ? -20 : rawLeft;
              const rectRight = style.extendRight ? W + 20 : rawRight;
              const ry = Math.min(px[0].y, px[1].y);
              const rw = Math.max(1, rectRight - rx), rh = Math.abs(px[1].y - px[0].y);
              if ((style.fillOpacity ?? 0) > 0) {
                ctx.save(); ctx.shadowBlur = 0;
                ctx.fillStyle = hexToRgba(col, style.fillOpacity ?? 0);
                ctx.fillRect(rx, ry, rw, rh); ctx.restore();
              }
              ctx.strokeRect(rx, ry, rw, rh);
              break;
            }
            case "ellipse": {
              if (px.length < 2) break;
              const cx = (px[0].x + px[1].x) / 2, cy = (px[0].y + px[1].y) / 2;
              const erx = Math.abs(px[1].x - px[0].x) / 2, ery = Math.abs(px[1].y - px[0].y) / 2;
              ctx.beginPath();
              ctx.ellipse(cx, cy, Math.max(erx, 0.1), Math.max(ery, 0.1), 0, 0, Math.PI * 2);
              if ((style.fillOpacity ?? 0) > 0) {
                ctx.save(); ctx.shadowBlur = 0;
                ctx.fillStyle = hexToRgba(col, style.fillOpacity ?? 0);
                ctx.fill(); ctx.restore();
              }
              ctx.stroke();
              break;
            }
            default: {
              if (px.length >= 2) drawLine(ctx, px[0], px[px.length - 1]);
              if (px.length >= 1) dot(ctx, px[0].x, px[0].y, 3.5, col);
              if (px.length >= 2) dot(ctx, px[1].x, px[1].y, 3.5, col);
              break;
            }
          }
        }
        ctx.restore();
      }
    }
  }

  ctx.restore(); // inner clip save
  ctx.restore(); // outer dpr scale save
}
