import {
  useEffect, useRef, useCallback, memo, useState, useMemo, useLayoutEffect,
  type ReactNode,
} from "react";
import { activatePanRange, updatePanRange, subscribePanRange, getPanRange } from "./chartPanState";
import type { RefObject } from "react";
import {
  createChart,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  PriceScaleMode,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  BarSeries,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type IPriceLine,
  type Time,
} from "lightweight-charts";
import { useChartStore, type OHLCBar, type ChartType, type IndicatorState } from "@/store/chartStore";
import { useLiveMarketContext, fmtPrice, fmtTickAge } from "@/contexts/LiveMarketContext";
import { useMarketSession, type MarketType } from "@/lib/marketSession";
import { SYMBOL_CATALOG } from "@/contexts/WatchlistContext";
import { emitCrosshair, resetCrosshair } from "@/lib/crosshairState";
import { RealtimeTradeAggregator, toSec } from "@/lib/realtimeTradeAggregator";
import { ChartContext, type ChartContextValue } from "@/contexts/ChartContext";
import { ChartBarsContext } from "@/contexts/ChartBarsContext";
import type { ChartSettings } from "@/components/charts/chartSettingsTypes";
import { chartApiRef } from "@/lib/chartApiRef";
import { sheetDragState } from "@/lib/sheetDragState";
import { getCachedCandles, setCachedCandles } from "@/lib/candleCache";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const UP_COLOR   = "#B7FF5A";
const DOWN_COLOR = "#ef4444";
const UP_WICK    = "#7CBF4B";
const DOWN_WICK  = "#dc2626";
const CHART_BG   = "#07110D";
const GRID_COLOR = "rgba(13,28,22,0.7)";
const TEXT_COLOR = "#A7B8A9";

const EMA_COLORS: Record<keyof IndicatorState, string> = {
  ema9:   "#f59e0b",
  ema21:  "#38bdf8",
  ema50:  "#a78bfa",
  ema200: "#f87171",
  vwap:   "#60a5fa",
};

const EMA_PERIODS: Record<keyof IndicatorState, number> = {
  ema9: 9, ema21: 21, ema50: 50, ema200: 200, vwap: 0,
};

interface ChartMsg {
  type:      string;
  symbol?:   string;
  interval?: string;
  bar?:      OHLCBar;
}

// ── EMA calculation ───────────────────────────────────────────────────────────
function calcEMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
    } else if (i === period - 1) {
      ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
      out.push(ema);
    } else {
      const k = 2 / (period + 1);
      ema = values[i] * k + ema! * (1 - k);
      out.push(ema);
    }
  }
  return out;
}

function calcVWAP(bars: OHLCBar[]): (number | null)[] {
  const out: (number | null)[] = [];
  let cumPV = 0, cumV = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumPV += tp * b.volume;
    cumV  += b.volume;
    out.push(cumV > 0 ? cumPV / cumV : null);
  }
  return out;
}

// ── Bar safety helpers ─────────────────────────────────────────────────────────
/**
 * Defensively sort + dedup a bar array before passing to Lightweight Charts.
 * LWC asserts strictly ascending time order and throws if violated.
 * Dedup keeps the LATEST bar for any duplicate timestamp.
 * Returns a new array; never mutates the input.
 */
function safeSortDedup(bars: OHLCBar[]): OHLCBar[] {
  if (bars.length < 2) return bars;
  // Dedup: Map keeps last write per key → latest bar wins
  const deduped = [...new Map(bars.map(b => [b.time, b])).values()];
  deduped.sort((a, b) => a.time - b.time);
  const dupCount = bars.length - deduped.length;
  let outOfOrder = false;
  for (let i = 1; i < deduped.length; i++) {
    if (deduped[i].time <= deduped[i - 1].time) { outOfOrder = true; break; }
  }
  if (dupCount > 0 || outOfOrder) {
    console.warn(`[Chart] safeSortDedup: fixed ${dupCount} duplicate(s)${outOfOrder ? " + ordering issue" : ""} in ${bars.length} bars`);
  }
  return deduped;
}

/**
 * Validate a single bar's timestamp for series.update().
 * Returns false (and warns) if the timestamp is invalid.
 */
function isValidBarTime(barTime: number, lastBarTime: number, context: string): boolean {
  if (!Number.isFinite(barTime) || barTime <= 0) {
    console.warn(`[Chart] ${context}: invalid bar.time=${barTime} — skipped`);
    return false;
  }
  if (barTime < lastBarTime) {
    console.warn(`[Chart] ${context}: out-of-order bar skipped (bar=${barTime}, last=${lastBarTime})`);
    return false;
  }
  return true;
}

// ── Series helpers ─────────────────────────────────────────────────────────────
function makeSeries(chart: IChartApi, ct: ChartType, settings?: ChartSettings): ISeriesApi<SeriesType> {
  // lastValueVisible: false — we render our own combined live-price+countdown box
  switch (ct) {
    case "bars":
      return chart.addSeries(BarSeries, { upColor: UP_COLOR, downColor: DOWN_COLOR, openVisible: true, lastValueVisible: false });
    case "line": {
      const color = settings?.lineColor ?? UP_COLOR;
      const opacity = settings?.lineOpacity ?? 1;
      const width = settings?.lineWidth ?? 2;
      return chart.addSeries(LineSeries, { color: hexToRgba(color, opacity), lineWidth: width, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, lastValueVisible: false });
    }
    case "line_with_markers": {
      const color = settings?.lineColor ?? UP_COLOR;
      const opacity = settings?.lineOpacity ?? 1;
      const width = settings?.lineWidth ?? 2;
      return chart.addSeries(LineSeries, { color: hexToRgba(color, opacity), lineWidth: width, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, pointMarkersVisible: true, pointMarkersRadius: 3, lastValueVisible: false });
    }
    case "area":
      return chart.addSeries(AreaSeries, { lineColor: UP_COLOR, topColor: "rgba(183,255,90,0.22)", bottomColor: "rgba(183,255,90,0.01)", lineWidth: 2, lastValueVisible: false });
    default:
      return chart.addSeries(CandlestickSeries, { upColor: UP_COLOR, downColor: DOWN_COLOR, borderUpColor: UP_COLOR, borderDownColor: DOWN_COLOR, wickUpColor: UP_WICK, wickDownColor: DOWN_WICK, lastValueVisible: false });
  }
}

function toHeikinAshi(bars: OHLCBar[]): OHLCBar[] {
  const out: OHLCBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen = i === 0
      ? (b.open + b.close) / 2
      : (out[i - 1].open + out[i - 1].close) / 2;
    const haHigh = Math.max(b.high, haOpen, haClose);
    const haLow  = Math.min(b.low,  haOpen, haClose);
    out.push({ time: b.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: b.volume });
  }
  return out;
}

function applyBars(series: ISeriesApi<SeriesType>, ct: ChartType, bars: OHLCBar[]) {
  if (bars.length === 0) return;
  // Always sort + dedup before setData() — LWC asserts ascending order
  const safe = safeSortDedup(bars);
  if (ct === "candles") {
    (series as ISeriesApi<"Candlestick">).setData(safe.map(b => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
  } else if (ct === "heikin_ashi") {
    const ha = toHeikinAshi(safe);
    (series as ISeriesApi<"Candlestick">).setData(ha.map(b => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
  } else if (ct === "bars") {
    (series as ISeriesApi<"Bar">).setData(safe.map(b => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
  } else if (ct === "line" || ct === "line_with_markers") {
    (series as ISeriesApi<"Line">).setData(safe.map(b => ({ time: b.time as Time, value: b.close })));
  } else {
    (series as ISeriesApi<"Line">).setData(safe.map(b => ({ time: b.time as Time, value: b.close })));
  }
}

function updateBar(series: ISeriesApi<SeriesType>, ct: ChartType, b: OHLCBar, lastBarTime = 0) {
  // Validate timestamp before passing to LWC — out-of-order bars crash with assertion
  if (!isValidBarTime(b.time, lastBarTime, "updateBar")) return;
  try {
    if (ct === "candles") {
      (series as ISeriesApi<"Candlestick">).update({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close });
    } else if (ct === "bars") {
      (series as ISeriesApi<"Bar">).update({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close });
    } else {
      (series as ISeriesApi<"Line">).update({ time: b.time as Time, value: b.close });
    }
  } catch {
    // LWC throws "Cannot update oldest data" when the bar timestamp is older than
    // the last bar already in the series (e.g. drag-end flush of a stale pending
    // bar, or a late-arriving candle_update). Silently ignore — next tick will
    // be current and succeed.
  }
}

// ── LineStyle mapping ─────────────────────────────────────────────────────────
function toLineStyle(s: string): LineStyle {
  if (s === "dashed") return LineStyle.Dashed;
  if (s === "dotted") return LineStyle.Dotted;
  return LineStyle.Solid;
}

// ── PriceScaleMode mapping ────────────────────────────────────────────────────
function toPriceScaleMode(m?: string): PriceScaleMode {
  if (m === "log")     return PriceScaleMode.Logarithmic;
  if (m === "percent") return PriceScaleMode.Percentage;
  if (m === "indexed") return PriceScaleMode.IndexedTo100;
  return PriceScaleMode.Normal;
}

// ── Candle-close countdown helpers ────────────────────────────────────────────
function calcCd(iv: string): string {
  const now = Date.now();
  let rem: number;
  if (iv === "W") {
    const d = new Date();
    const dl = d.getUTCDay() === 0 ? 1 : 8 - d.getUTCDay();
    rem = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dl) - now;
  } else if (iv === "D" || iv === "1D") {
    const d = new Date();
    rem = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
  } else {
    const ms = parseInt(iv, 10) * 60_000;
    rem = ms - (now % ms);
  }
  const s = Math.max(0, Math.floor(rem / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
}

// ── Dynamic price-scale helpers ───────────────────────────────────────────────
// Returns the LWC priceFormat precision + minMove for a given reference price.
// Must match fmtPrice() in LiveMarketContext so scale labels align with the
// live-price label we draw in LivePriceBox.
function pricePrecision(price: number): { precision: number; minMove: number } {
  if (!price || !isFinite(price) || price <= 0)
    return { precision: 2, minMove: 0.01 };
  if (price >= 10_000) return { precision: 2, minMove: 0.01 };
  if (price >= 1_000)  return { precision: 2, minMove: 0.01 };
  if (price >= 100)    return { precision: 3, minMove: 0.001 };
  if (price >= 10)     return { precision: 3, minMove: 0.001 };
  if (price >= 1)      return { precision: 5, minMove: 0.00001 };
  if (price >= 0.1)    return { precision: 5, minMove: 0.00001 };
  if (price >= 0.01)   return { precision: 6, minMove: 0.000001 };
  if (price >= 0.001)  return { precision: 7, minMove: 0.0000001 };
  if (price >= 0.0001) return { precision: 8, minMove: 0.00000001 };
  if (price >= 0.00001) return { precision: 8, minMove: 0.00000001 };
  return { precision: 10, minMove: 0.0000000001 };
}

// Human-readable timeframe label from internal interval string.
// "60" → "1H", "240" → "4H", "15" → "15M", "D" → "1D", etc.
function fmtIntervalLabel(iv: string): string {
  if (iv === "D" || iv === "1D") return "1D";
  if (iv === "W" || iv === "1W") return "1W";
  const mins = parseInt(iv, 10);
  if (!mins) return iv.toUpperCase();
  if (mins < 60)  return `${mins}M`;
  if (mins < 1440) return `${mins / 60}H`;
  return `${mins / 1440}D`;
}

// Pixel width for the live-price label box (and the touch-handler overlay).
// Derived from how many characters fmtPrice produces for the given price.
// ~8 px per monospace char + 20 px label-box padding, minimum 75 px.
function calcPriceScaleW(price: number, sym: string): number {
  if (!price || !isFinite(price)) return 75;
  const sample = fmtPrice(price, sym);
  if (sample === "—") return 75;
  const charCount = sample.replace(/,/g, "").length; // strip locale commas
  return Math.max(75, charCount * 8 + 20);
}

const PRICE_SCALE_TOUCH_W = 130; // generous max — covers even sub-micro meme coins
const DEFAULT_VISIBLE_BARS   = 90; // TradingView-style default: show ~150 recent bars on fresh load
const MIN_FUTURE_BARS        = 12;  // always keep 50 bars of future space on the right
const HISTORY_PREFETCH_BARS  = 150; // trigger history fetch when within this many bars of the left edge
const MAX_TOTAL_BARS         = 10_000; // stop loading when we reach this many bars (matches cTrader/TradingView limit)

// ── Price-scale touch/mouse handler — unlimited exponential zoom + kinetic ────
//
// KEY DESIGN: scaleMargins top+bottom must sum to < 1.0 — that is a hard LWC
// physical limit that creates the "dead stop" the user sees. Instead, we use
// series.autoscaleInfoProvider to set an explicit visible price range with NO
// boundaries. The zoom is exponential (ratio = e^(dy/h * sensitivity)) so the
// feel is the same regardless of current zoom level. Kinetic scroll uses the
// same path, so momentum also scales infinitely.
//
// STATE: zoomStateRef holds the last active {min, max}. It is reset to null on
// symbol change (useEffect) and on each fresh drag-start (so coordinateToPrice
// re-snapshots the actual current screen range). The autoscaleInfoProvider on
// the series persists after the finger lifts — TradingView style, the scale
// stays where you left it. Double-tap clears it and re-engages autoScale.
function PriceScaleTouchHandler({
  chartRef,
  containerRef,
  mainRef,
  overrideWidth,
}: {
  chartRef:        RefObject<IChartApi | null>;
  containerRef:    RefObject<HTMLDivElement | null>;
  mainRef:         RefObject<ISeriesApi<SeriesType> | null>;
  overrideWidth?:  number;
}) {
  // Width must exactly match the live-price label so the overlay never bleeds
  // into the chart canvas and steals the capture-phase vert-pan listener.
  const livePrice = useChartStore(s => s.livePrice);
  const symbol    = useChartStore(s => s.symbol);
  const touchW    = overrideWidth ?? calcPriceScaleW(livePrice ?? 1, symbol);

  const handlerRef    = useRef<HTMLDivElement>(null);
  const lastTapRef    = useRef<number>(0);

  // Active price range being maintained on the series via autoscaleInfoProvider.
  // null → no lock, LWC autoScale is in effect.
  const zoomRef = useRef<{ min: number; max: number } | null>(null);

  type DragState = {
    lastY:     number;
    rafId:     number | null;
    pointerId: number;
  };
  const dragRef = useRef<DragState | null>(null);

  // ── clear locked zoom on symbol change ───────────────────────────────────
  useEffect(() => {
    // Cancel any pending drag rAF, then clear zoom + autoscaleInfoProvider.
    const d = dragRef.current;
    if (d?.rafId != null) {
      cancelAnimationFrame(d.rafId);
      d.rafId = null;
    }
    dragRef.current   = null;
    zoomRef.current   = null;
    try {
      mainRef.current?.applyOptions({ autoscaleInfoProvider: () => null });
    } catch { /* ok */ }
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── core zoom helper ─────────────────────────────────────────────────────
  // dy > 0 (drag down) → zoom OUT (range grows)
  // dy < 0 (drag up)   → zoom IN  (range shrinks)
  // No min/max clamps — the range can grow or shrink without bound, limited
  // only by floating-point (guarded below).
  const applyZoom = useCallback((dy: number) => {
    const series    = mainRef.current;
    const container = containerRef.current;
    if (!series || !container) return;
    const h = container.clientHeight || 1;

    // Snapshot current visible range when starting a fresh zoom gesture.
    // coordinateToPrice(0) = screen top price; (h) = screen bottom price.
    // These are SCREEN range values that include the chart's scaleMargins
    // {top:0.07, bottom:0.25}. autoscaleInfoProvider expects the DATA range,
    // so we invert the margin formula to avoid a zoom-out jump on first apply:
    //   D_max = S_max - 0.07 * span,  D_min = S_min + 0.25 * span
    if (!zoomRef.current) {
      try {
        const pTop = series.coordinateToPrice(0) as number | null;
        const pBot = series.coordinateToPrice(h) as number | null;
        if (
          pTop == null || pBot == null ||
          !isFinite(pTop) || !isFinite(pBot) ||
          pTop === pBot
        ) return;
        const sMax = Math.max(pTop, pBot);
        const sMin = Math.min(pTop, pBot);
        const span = sMax - sMin;
        zoomRef.current = {
          min: sMin + 0.25 * span, // data bottom (margin-compensated)
          max: sMax - 0.07 * span, // data top   (margin-compensated)
        };
      } catch { return; }
    }

    const z = zoomRef.current;

    // Exponential scale factor:  e^(sensitivity * dy/h)
    // sensitivity=2.5 → full-height drag ≈ 12× range change (comparable to TradingView).
    const sensitivity = 2.5;
    const ratio  = Math.exp((dy / h) * sensitivity);
    const center = (z.min + z.max) / 2;
    const half   = ((z.max - z.min) / 2) * ratio;

    // Guard against degenerate ranges (meme coins → underflow; huge ranges → overflow)
    if (!isFinite(half) || half < 1e-15 || half > 1e15) return;

    z.min = center - half;
    z.max = center + half;
    const minVal = z.min, maxVal = z.max;

    try {
      series.applyOptions({
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: minVal, maxValue: maxVal },
        }),
      });
    } catch { /* chart disposed during HMR */ }
  }, [mainRef, containerRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── event handlers ────────────────────────────────────────────────────────
  const onDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const chart = chartRef.current;
    if (!chart) return;
    e.preventDefault();
    e.stopPropagation();

    // Double-tap: clear zoom lock and restore autoScale + default margins
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      zoomRef.current = null;
      try {
        mainRef.current?.applyOptions({ autoscaleInfoProvider: () => null });
        chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.07, bottom: 0.25 } });
      } catch { }
      dragRef.current = null;
      return;
    }
    lastTapRef.current = now;

    // Reset zoom snapshot so applyZoom re-reads the current screen range.
    // This means each new drag starts from exactly what is currently visible,
    // correctly picking up any prior pan or zoom without stale state.
    zoomRef.current = null;

    try { handlerRef.current?.setPointerCapture(e.pointerId); } catch { }
    dragRef.current = {
      lastY:     e.clientY,
      rafId:     null,
      pointerId: e.pointerId,
    };
  }, [chartRef, mainRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const dy   = e.clientY - drag.lastY;
    drag.lastY = e.clientY;

    if (dy === 0 || drag.rafId !== null) return;

    drag.rafId = requestAnimationFrame(() => {
      const d = dragRef.current;
      if (!d) return;
      d.rafId = null;
      applyZoom(dy);
    });
  }, [applyZoom]);

  const onUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    if (drag.rafId !== null) cancelAnimationFrame(drag.rafId);
    dragRef.current = null;
    try { handlerRef.current?.releasePointerCapture(e.pointerId); } catch { }
    // zoomRef.current intentionally kept — zoom persists after lift (TradingView style). Double-tap clears it.
  }, []);

  return (
    <div
      ref={handlerRef}
      style={{
        position:      "absolute",
        top:           0,
        right:         0,
        bottom:        0,
        width:         touchW,
        zIndex:        25,
        touchAction:   "none",
        cursor:        "ns-resize",
        background:    "transparent",
        pointerEvents: "auto",
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  );
}

// ── Hex color → rgba helper ───────────────────────────────────────────────────
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full  = clean.length === 3
    ? clean.split("").map(c => c + c).join("")
    : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(0,0,0,${alpha})`;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Tick-rate overlay — market-aware, pure DOM mutations, no React state ────────
// Shows:
//   • "Market Closed · last Xm ago"  — when exchange session is closed
//   • "N t/s"                        — live ticks flowing
//   • "0 t/s · last Xm ago"          — market open but no recent ticks
function TickRateOverlay({
  tickCountRef,
  lastTickTimeRef,
  isMarketOpen: isOpen,
  mktType,
}: {
  tickCountRef:    React.MutableRefObject<number>;
  lastTickTimeRef: React.MutableRefObject<number>;
  isMarketOpen:    boolean;
  mktType:         MarketType;
}) {
  const wrapRef   = useRef<HTMLDivElement>(null);
  const dotRef    = useRef<HTMLSpanElement>(null);
  const txtRef    = useRef<HTMLSpanElement>(null);

  // Keep a ref in sync with the prop so the setInterval closure always
  // reads the current session state without stale capture.
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const mktTypeRef = useRef(mktType);
  mktTypeRef.current = mktType;

  useEffect(() => {
    let prev = tickCountRef.current;

    const id = setInterval(() => {
      const cur  = tickCountRef.current;
      const tps  = cur - prev;
      prev = cur;

      const wrap = wrapRef.current;
      const dot  = dotRef.current;
      const txt  = txtRef.current;
      if (!wrap || !dot || !txt) return;

      const open   = isOpenRef.current;
      const lastTs = lastTickTimeRef.current;

      if (!open) {
        // ── Market closed ──────────────────────────────────────────────────
        const ageStr = lastTs > 0 ? ` · last ${fmtTickAge(lastTs)}` : "";
        txt.textContent      = `Market Closed${ageStr}`;
        dot.style.background = "rgba(239,68,68,0.85)";
        dot.style.boxShadow  = "none";
        wrap.style.opacity   = "0.85";
        return;
      }

      // ── Market open ────────────────────────────────────────────────────
      // lastTs === 0 means no tick has ever arrived for this chart — provider offline.
      const hasLiveFeed = lastTs > 0;

      if (!hasLiveFeed) {
        // Provider offline (cTrader not connected, or Delta WS down)
        txt.textContent      = "Feed Offline";
        dot.style.background = "#6b7280";
        dot.style.boxShadow  = "none";
        wrap.style.opacity   = "0.55";
        return;
      }

      const ageStr = tps === 0 ? ` · ${fmtTickAge(lastTs)}` : "";
      txt.textContent = tps > 0 ? `${tps} t/s` : `0 t/s${ageStr}`;

      if (tps > 0) {
        dot.style.background = "#22c55e";
        dot.style.boxShadow  = "0 0 5px #22c55e";
        wrap.style.opacity   = "1";
      } else {
        dot.style.background = "#6b7280";
        dot.style.boxShadow  = "none";
        wrap.style.opacity   = "0.45";
      }
    }, 1000);

    return () => clearInterval(id);
  }, [tickCountRef, lastTickTimeRef]);

  return (
    <div
      ref={wrapRef}
      style={{
        display:    "flex",
        alignItems: "center",
        gap:        4,
        marginLeft: 8,
        flexShrink: 0,
        opacity:    isOpen ? 0.45 : 0.85,
        transition: "opacity 0.4s",
        userSelect: "none",
      }}
    >
      <span
        ref={dotRef}
        style={{
          width:        6,
          height:       6,
          borderRadius: "50%",
          background:   isOpen ? "#6b7280" : "rgba(239,68,68,0.85)",
          flexShrink:   0,
          display:      "inline-block",
        }}
      />
      <span
        ref={txtRef}
        style={{
          fontFamily:    "ui-monospace, 'SF Mono', Menlo, monospace",
          fontSize:      11,
          color:         "rgba(255,255,255,0.75)",
          letterSpacing: "0.02em",
          lineHeight:    1,
          whiteSpace:    "nowrap",
        }}
      >
        {isOpen ? "0 t/s" : "Market Closed"}
      </span>
    </div>
  );
}

// ── Combined live-price + countdown box (replaces all native axis labels) ─────
function LivePriceBox({
  chart: _chart, series, interval,
  upColor = UP_COLOR, downColor = DOWN_COLOR,
  textColor = "#ffffff", boxWidth, boxWidthRef, tickDataRef, lastTickTimeRef,
  symbolOverride, slotMode = false, isMarketOpen = true,
}: {
  chart:        IChartApi | null;
  series:       ISeriesApi<SeriesType> | null;
  interval:     string;
  upColor?:     string;
  downColor?:   string;
  textColor?:   string;
  boxWidth?:    number;
  /** Shared mutable ref updated immediately on resize/rotation — bypasses React render lag */
  boxWidthRef?: React.MutableRefObject<number>;
  /** Zero-latency tick data — written by WS handler, read by RAF loop without React cycle */
  tickDataRef?: React.MutableRefObject<{ price: number | null; open: number | null }>;
  /** Wall-clock ms of the most recent accepted tick — 0 means no live feed exists for this symbol */
  lastTickTimeRef?: React.MutableRefObject<number>;
  /** Per-pane symbol override — must be set for every slot so fmtPrice uses correct decimals */
  symbolOverride?: string;
  /** When true (slot mode), never fall back to global Zustand livePrice/liveOpen */
  slotMode?: boolean;
  /** When false, freeze the candle countdown — market is closed, no new bars form */
  isMarketOpen?: boolean;
}) {
  const storeLivePrice = useChartStore(s => s.livePrice);
  const storeLiveOpen  = useChartStore(s => s.liveOpen);
  const storeSymbol    = useChartStore(s => s.symbol);

  // In slot mode, use only the per-pane tickDataRef — never the global store.
  // The global store only tracks the main chart; reading it in secondary panes
  // would show BTC's price/open on every slot regardless of its own symbol.
  const livePrice = slotMode ? null : storeLivePrice;
  const liveOpen  = slotMode ? null : storeLiveOpen;
  const symbol    = symbolOverride ?? storeSymbol;

  // DOM element refs — the RAF loop mutates these directly at 60 fps,
  // bypassing React's scheduler entirely for all hot-path updates.
  const wrapRef      = useRef<HTMLDivElement>(null);
  const innerRef     = useRef<HTMLDivElement>(null);
  const triRef       = useRef<HTMLDivElement>(null);
  const priceSpanRef = useRef<HTMLSpanElement>(null);
  const cdSpanRef    = useRef<HTMLSpanElement>(null);

  // Single mutable bag — written on every render, read inside RAF loop.
  // Using one object avoids closure staleness without listing every dependency.
  const rc = useRef({
    price:           livePrice,
    open:            liveOpen,
    symbol,
    slotMode,
    series,
    interval,
    upColor,
    downColor,
    textColor,
    boxWidth,
    boxWidthRef,
    tickDataRef,
    lastTickTimeRef,
    isMarketOpen,
    // Change-detection cache (skip redundant DOM writes)
    _col: "" as string,
    _tc:  "" as string,
    _w:   0  as number,
    _px:  "" as string,
  });
  // Sync props/state → ref every render (runs before RAF reads them)
  rc.current.price            = livePrice;
  rc.current.open             = liveOpen;
  rc.current.symbol           = symbol;
  rc.current.slotMode         = slotMode;
  rc.current.series           = series;
  rc.current.interval         = interval;
  rc.current.upColor          = upColor;
  rc.current.downColor        = downColor;
  rc.current.textColor        = textColor;
  rc.current.boxWidth         = boxWidth;
  rc.current.boxWidthRef      = boxWidthRef;
  rc.current.tickDataRef      = tickDataRef;
  rc.current.lastTickTimeRef  = lastTickTimeRef;
  rc.current.isMarketOpen     = isMarketOpen;

  // ── RAF loop — 60 fps, pure DOM mutations, zero React scheduler overhead ──
  useEffect(() => {
    let rafId: number;

    const tick = () => {
      const r    = rc.current;
      const wrap  = wrapRef.current;
      const inner = innerRef.current;
      const tri   = triRef.current;
      const pEl   = priceSpanRef.current;
      if (!wrap || !inner || !pEl) { rafId = requestAnimationFrame(tick); return; }

      // ── Zero-latency price read ─────────────────────────────────────────────
      // Prefer tickDataRef (written synchronously by the WS handler, bypassing
      // Zustand setState → React re-render → rc.current) so the box tracks the
      // live candle on the very same frame the LWC canvas updates.
      // In slot mode, NEVER fall back to the global Zustand store price —
      // the store only tracks the main chart, so the fallback would show BTC's
      // price on every secondary pane.  Show hidden instead (null → hides box).
      const tickPrice = r.tickDataRef?.current.price ?? null;
      const tickOpen  = r.tickDataRef?.current.open  ?? null;
      const price = tickPrice ?? (r.slotMode ? null : r.price);
      const open  = tickOpen  ?? (r.slotMode ? null : r.open);

      // Debug log — throttled to only fire when values change (not every 60fps frame)
      const _src = tickPrice != null ? "tickDataRef" : r.slotMode ? "hidden(slot)" : "zustand-store";
      if (_src !== (r as any)._dbgSrc || price !== (r as any)._dbgPx) {
        (r as any)._dbgSrc = _src; (r as any)._dbgPx = price;
        console.log("[PRICE LABEL]", { symbol: r.symbol, slotMode: r.slotMode, displayedPrice: price, dataSource: _src });
      }

      // ── Show / hide ────────────────────────────────────────────────────────
      if (price == null || !r.series) {
        if (wrap.style.visibility !== "hidden") wrap.style.visibility = "hidden";
        rafId = requestAnimationFrame(tick);
        return;
      }
      if (wrap.style.visibility === "hidden") wrap.style.visibility = "visible";

      // ── Y position (every frame — smooth during pan / zoom / scale) ────────
      try {
        const y = r.series.priceToCoordinate(price);
        if (y != null && Number.isFinite(y as number))
          wrap.style.transform = `translateY(calc(${Math.round(y as number)}px - 50%))`;
      } catch { /* series disposed during HMR — skip frame */ }

      // ── Price text ─────────────────────────────────────────────────────────
      const px = fmtPrice(price, r.symbol);
      if (px !== r._px) { r._px = px; pEl.textContent = px; }

      // ── Color (only recalculate when bull/bear flips or settings change) ───
      const bull = open == null || price >= open;
      const col  = bull ? r.upColor : r.downColor;
      if (col !== r._col || r.textColor !== r._tc) {
        r._col = col; r._tc = r.textColor;
        const glo = hexToRgba(col, 0.55);
        const brd = hexToRgba(col, 0.9);
        inner.style.background   = col;
        inner.style.boxShadow    = `0 0 8px ${glo}, 0 0 18px ${hexToRgba(col, 0.28)}`;
        inner.style.borderTop    = `1px solid ${brd}`;
        inner.style.borderRight  = `1px solid ${brd}`;
        inner.style.borderBottom = `1px solid ${brd}`;
        if (tri) {
          tri.style.borderRight = `5px solid ${col}`;
          tri.style.filter      = `drop-shadow(-1px 0 1px ${hexToRgba(col, 0.45)})`;
        }
        pEl.style.color = r.textColor;
        const cEl = cdSpanRef.current;
        if (cEl) cEl.style.color = r.textColor;
      }

      // ── Width ──────────────────────────────────────────────────────────────
      // Prefer the mutable ref (updated instantly on resize/rotation, no React cycle)
      // over the React prop (arrives after a render); fall back to a computed estimate.
      const w = (r.boxWidthRef?.current ?? r.boxWidth) || calcPriceScaleW(price, r.symbol);
      if (w !== r._w) { r._w = w; wrap.style.width = `${w}px`; }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []); // intentionally empty — all values read via rc ref

  // ── Countdown — 500 ms is plenty of precision for a seconds counter ───────
  // Frozen to "—" when:
  //   • market is closed (no new candles will form), OR
  //   • no live tick has ever arrived (provider offline — cTrader or Delta down)
  // rc.current fields are synced on every render so the setInterval closure
  // always reads current state without stale capture.
  useEffect(() => {
    const tick = () => {
      const el = cdSpanRef.current;
      if (!el) return;
      const marketOpen  = rc.current.isMarketOpen ?? true;
      const hasLiveFeed = (rc.current.lastTickTimeRef?.current ?? 0) > 0;
      el.textContent = (marketOpen && hasLiveFeed)
        ? calcCd(rc.current.interval)
        : "—";
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []); // intentionally empty — reads interval + isMarketOpen + lastTickTimeRef via rc ref

  // ── Initial paint values (before first RAF fires) ─────────────────────────
  const initBull   = liveOpen == null || (livePrice ?? 0) >= (liveOpen ?? 0);
  const initCol    = initBull ? upColor : downColor;
  const initBorder = hexToRgba(initCol, 0.9);
  const initW      = boxWidth ?? calcPriceScaleW(livePrice ?? 1, symbol);

  return (
    <div
      ref={wrapRef}
      style={{
        position:       "absolute",
        right:          0,
        top:            0,
        width:          initW,
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "stretch",
        justifyContent: "center",
        pointerEvents:  "none",
        zIndex:         20,
        overflow:       "visible",
        visibility:     livePrice == null ? "hidden" : "visible",
        willChange:     "transform",
      }}
    >
      <div
        ref={innerRef}
        style={{
          position:       "relative",
          background:     initCol,
          color:          textColor,
          borderRadius:   "0 3px 3px 0",
          padding:        "3px 6px 3px 4px",
          borderTop:      `1px solid ${initBorder}`,
          borderRight:    `1px solid ${initBorder}`,
          borderBottom:   `1px solid ${initBorder}`,
          borderLeft:     "none",
          boxShadow:      `0 0 8px ${hexToRgba(initCol, 0.55)}, 0 0 18px ${hexToRgba(initCol, 0.28)}`,
          display:        "flex",
          flexDirection:  "column",
          alignItems:     "center",
          justifyContent: "center",
          minWidth:       60,
          width:          "100%",
          transition:     "background 0.1s ease-out, box-shadow 0.1s ease-out",
        }}
      >
        {/* Left-pointing triangle — hooks box to the price scale border */}
        <div
          ref={triRef}
          style={{
            position:     "absolute",
            right:        "100%",
            top:          "50%",
            transform:    "translateY(-50%)",
            width:        0,
            height:       0,
            borderTop:    "5px solid transparent",
            borderBottom: "5px solid transparent",
            borderRight:  `5px solid ${initCol}`,
            filter:       `drop-shadow(-1px 0 1px ${hexToRgba(initCol, 0.45)})`,
          }}
        />
        <span
          ref={priceSpanRef}
          style={{
            fontSize:      13,
            fontWeight:    700,
            lineHeight:    "16px",
            fontFamily:    "monospace",
            letterSpacing: "0.02em",
            whiteSpace:    "nowrap",
            textShadow:    "0 1px 3px rgba(0,0,0,0.45)",
            color:         textColor,
          }}
        >
          {livePrice != null ? fmtPrice(livePrice, symbol) : ""}
        </span>
        <span
          ref={cdSpanRef}
          style={{
            fontSize:      11,
            fontWeight:    700,
            lineHeight:    "13px",
            fontFamily:    "monospace",
            opacity:       0.9,
            marginTop:     2,
            letterSpacing: "0.04em",
            textShadow:    "0 1px 2px rgba(0,0,0,0.35)",
            color:         textColor,
          }}
        >
          {calcCd(interval)}
        </span>
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────
const CustomChart = memo(function CustomChart({
  children, settings, replayBars,
  symbol: propSymbol, interval: propInterval, chartType: propChartType,
}: {
  children?: ReactNode; settings?: ChartSettings; replayBars?: OHLCBar[] | null;
  /** Slot mode: when provided, overrides global Zustand symbol so each grid slot shows its own market */
  symbol?: string;
  /** Slot mode: when provided, overrides global Zustand interval */
  interval?: string;
  /** Slot mode: when provided, overrides global Zustand chartType */
  chartType?: string;
}) {
  // Use individual selectors so re-renders only happen when these specific
  // values change — not on every crosshair move (which updates crosshairInfo).
  const storeSymbol    = useChartStore(s => s.symbol);
  const storeInterval  = useChartStore(s => s.interval);
  const storeChartType = useChartStore(s => s.chartType);
  const indicators     = useChartStore(s => s.indicators);
  const storeSetLivePrice  = useChartStore(s => s.setLivePrice);
  const storeSetLiveOpen   = useChartStore(s => s.setLiveOpen);
  const storeSetBarsLoaded = useChartStore(s => s.setBarsLoaded);
  const { subscribeToMessages, sendMessage } = useLiveMarketContext();

  // Slot mode: symbol prop present → this instance is a layout grid slot.
  // Each slot reads its own symbol/interval instead of the shared store.
  const isSlotRef   = useRef(propSymbol != null);
  isSlotRef.current = propSymbol != null;
  const symbol    = propSymbol    ?? storeSymbol;
  const interval  = propInterval  ?? storeInterval;
  const chartType = (propChartType as typeof storeChartType) ?? storeChartType;

  // In slot mode: do NOT overwrite the main chart's global live-price / barsLoaded.
  // Zustand action refs are always stable so these callbacks never change identity.
  const setLivePrice  = useCallback((p: number | null) => { if (!isSlotRef.current) storeSetLivePrice(p);  }, [storeSetLivePrice]);  // eslint-disable-line
  const setLiveOpen   = useCallback((p: number | null) => { if (!isSlotRef.current) storeSetLiveOpen(p);   }, [storeSetLiveOpen]);   // eslint-disable-line
  const setBarsLoaded = useCallback((v: boolean)        => { if (!isSlotRef.current) storeSetBarsLoaded(v); }, [storeSetBarsLoaded]); // eslint-disable-line

  const containerRef        = useRef<HTMLDivElement>(null);
  const futureCrossCanvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  const mainRef       = useRef<ISeriesApi<SeriesType> | null>(null);
  const priceLineRef  = useRef<IPriceLine | null>(null);
  const emaRefs       = useRef<Partial<Record<keyof IndicatorState, ISeriesApi<"Line">>>>({});
  const barsRef       = useRef<OHLCBar[]>([]);
  const mountedRef      = useRef(true);
  const [replayBarCount, setReplayBarCount] = useState(0);
  const livePxRef       = useRef<number | null>(null);
  // Measured actual LWC price scale width — used by LivePriceBox and PriceScaleTouchHandler.
  // priceScaleWRef is a mutable ref updated immediately (no React render delay) so the
  // LivePriceBox RAF loop gets the new width on the very next frame after a resize/rotation.
  const priceScaleWRef  = useRef(75);
  const [priceScaleW, setPriceScaleW] = useState(75);

  // ── Zero-latency tick path ─────────────────────────────────────────────────
  // Written directly by the WS handler (synchronous, before any setState).
  // The LivePriceBox RAF loop reads this ref every frame — no Zustand/React cycle.
  const tickDataRef     = useRef<{ price: number | null; open: number | null }>({ price: null, open: null });
  // Throttle Zustand setState to ≤1 per rAF frame so other consumers (header
  // ticker, watchlist) get updates but we don't trigger React renders every tick.
  const statePendingRef = useRef(false);

  // ── Unified realtime chart-update buffer ───────────────────────────────────
  // ALL series.update() calls (tick path + candle_update path) funnel through
  // one pendingChartBarRef. A single RAF flush renders the LATEST bar once per
  // frame — updates are never suppressed, even during user interaction.
  //
  // Mobile devices additionally cap rendering at 30 fps (33 ms minimum interval)
  // to avoid flooding LWC's internal timescale/layout recalculation path which
  // is the direct cause of drag lag at high websocket tick rates.
  const pendingChartBarRef  = useRef<import("../../lib/realtimeTradeAggregator").AggBar | null>(null);
  const chartUpdateRafRef   = useRef<number | null>(null);
  const lastRenderMsRef     = useRef<number>(0);
  // Detect coarse-pointer (touch) devices once — used for 30 fps cap logic.
  const isTouchDeviceRef    = useRef(
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches
  );

  // ── Incremental EMA/VWAP cache ─────────────────────────────────────────────
  // Replaces O(n) full-array recalculation per tick with O(1) incremental update.
  // emaPrevRef[key] = EMA of the bar BEFORE the current live bar (stable until a
  //   new bar opens). emaCurrRef[key] = computed EMA for the current live bar.
  // vwapCumRef      = cumulative TP×vol / vol for all closed bars (excludes live bar).
  // emaLastBarTimeRef = bar.time of the current live bar — detects new-bar events.
  const emaPrevRef         = useRef<Partial<Record<keyof IndicatorState, number>>>({});
  const emaCurrRef         = useRef<Partial<Record<keyof IndicatorState, number>>>({});
  const vwapCumRef         = useRef({ cumPV: 0, cumV: 0 });
  const emaLastBarTimeRef  = useRef<number | null>(null);

  // ── Tick-rate counter (incremented synchronously on every WS tick) ─────────
  // TickRateOverlay samples this once per second to display ticks/s.
  const tickCountRef = useRef(0);

  // ── Market session tracking ────────────────────────────────────────────────
  // lastTickTimeRef: wall-clock ms of the most recent accepted tick for this
  //   symbol; written in the tick handler, read by TickRateOverlay each second.
  // isMarketOpenRef: synced every render from useMarketSession() so the tick-
  //   handler closure (which cannot safely call hooks) always sees the current
  //   session state without stale capture.
  const lastTickTimeRef  = useRef<number>(0);
  const isMarketOpenRef  = useRef<boolean>(true);
  const { isOpen: mktIsOpen, type: mktType } = useMarketSession(symbol);
  isMarketOpenRef.current = mktIsOpen; // sync on every render — safe, not in a conditional

  // ── Real-time OHLC aggregator — builds live candle from raw price ticks ────
  // MT5/TradingView pattern: historical bars come from REST; the live bar is
  // updated client-side on every `tick` message, bypassing candle_update latency.
  const tradeAggRef = useRef<RealtimeTradeAggregator | null>(null);

  // ── Viewport persistence debounce timer ───────────────────────────────────
  const vpSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── TradingView-style auto-follow state ────────────────────────────────────
  // nearRealtimeRef: true when the viewport's right edge is at/near the latest bar.
  //   Set by the subscribeVisibleLogicalRangeChange handler each time the range changes.
  //   When true, each new bar triggers a smooth right-shift to keep latest bar visible.
  const nearRealtimeRef  = useRef(true);

  // ── Infinite history loading state ─────────────────────────────────────────
  // oldestBarTimeRef: Unix-second timestamp of the oldest bar currently in barsRef.
  //   Used as the ?before= cursor when fetching older pages.
  // isLoadingMoreRef: guards against concurrent history fetches.
  // hasMoreHistoryRef: set false when the exchange returns 0 bars (history exhausted).
  // loadMoreHistRef: stable ref to the loadMoreHistory fn so onRangeChange
  //   (inside the chart-init useEffect closure) can always call the current version.
  const oldestBarTimeRef   = useRef<number | null>(null);
  const isLoadingMoreRef   = useRef(false);
  const hasMoreHistoryRef  = useRef(true);
  const loadMoreHistRef    = useRef<() => void>(() => {});
  const histLoadingDivRef  = useRef<HTMLDivElement | null>(null);

  // ── scheduleChartUpdate — the ONLY entry point for series.update() ─────────
  // Call this whenever the live bar changes (tick path OR candle_update path).
  // Rules:
  //   • If on a touch device and last render < 33 ms ago: skip (30 fps cap).
  //   • Otherwise: schedule one RAF that calls updateBar() with the latest bar.
  // Using useCallback with [] deps is safe because every value it reads is a ref.
  const scheduleChartUpdate = useCallback((forceImmediate = false) => {
    // Sheet drag lock: suppress chart canvas repaint while a BottomSheet is being
    // dragged. The pending bar is preserved in pendingChartBarRef and will be
    // flushed immediately when drag ends via sheetDragState.flush().
    if (sheetDragState.active) return;
    // Already scheduled for this frame — frame-coalescing is working
    if (chartUpdateRafRef.current !== null) return;
    // Keep the normal 30 fps touch cap for continuous ticks, but NEVER delay
    // the first tick of a newly opened candle. That boundary event must render
    // on the next animation frame so the new candle appears immediately.
    if (!forceImmediate && isTouchDeviceRef.current) {
      const elapsed = performance.now() - lastRenderMsRef.current;
      if (elapsed < 33) return; // continuous tick rendering remains capped
    }
    chartUpdateRafRef.current = requestAnimationFrame(() => {
      chartUpdateRafRef.current = null;
      if (!mountedRef.current) return;
      const b = pendingChartBarRef.current;
      const s = mainRef.current;
      if (!b || !s) return;
      lastRenderMsRef.current = performance.now();
      pendingChartBarRef.current = null;
      // Pass last known bar time so updateBar can reject out-of-order updates
      const lastTime = barsRef.current[barsRef.current.length - 1]?.time ?? 0;
      updateBar(s, ctRef.current, b, lastTime);
    });
  }, []); // all deps are refs — stable forever

  // Register scheduleChartUpdate as the sheet drag flush target.
  // When a BottomSheet drag ends it calls sheetDragState.flush() to
  // immediately process any tick bar that was buffered during suppression.
  useEffect(() => {
    sheetDragState.flush = scheduleChartUpdate;
    return () => { if (sheetDragState.flush === scheduleChartUpdate) sheetDragState.flush = null; };
  }, [scheduleChartUpdate]);

  // Track current values in refs so callbacks don't close over stale state
  const symRef      = useRef(symbol);
  const ivRef       = useRef(interval);
  const ctRef       = useRef(chartType);
  const indRef      = useRef(indicators);
  const lineClrRef  = useRef(settings?.priceLabelLineColor ?? "rgba(255,255,255,0.4)");
  const sendMsgRef  = useRef(sendMessage);
  symRef.current     = symbol;
  ivRef.current      = interval;
  ctRef.current      = chartType;
  indRef.current     = indicators;
  lineClrRef.current = settings?.priceLabelLineColor ?? "rgba(255,255,255,0.4)";
  sendMsgRef.current = sendMessage;

  const [chartCtx, setChartCtx] = useState<{ chart: IChartApi; candle: ISeriesApi<SeriesType>; } | null>(null);

  // ── Price line helper (stable ref) ────────────────────────────────────────
  const doUpdatePriceLine = useCallback((price: number, sym: string, series?: ISeriesApi<SeriesType> | null) => {
    const cs = series ?? mainRef.current;
    if (!cs) return;
    // Update in-place on the hot path (every tick) — avoids remove+create per tick.
    // Fall back to create only when the line doesn't exist yet, or the series changed
    // (series recreation nulls priceLineRef.current, or applyOptions throws).
    if (priceLineRef.current) {
      try {
        priceLineRef.current.applyOptions({ price, color: lineClrRef.current });
        return;
      } catch {
        // Series was recreated under us — fall through to create a fresh line
        priceLineRef.current = null;
      }
    }
    try {
      priceLineRef.current = cs.createPriceLine({
        price, color: lineClrRef.current, lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: false, title: "",
      });
    } catch { /* ok — chart may be disposing */ }
  }, []);

  // ── Indicator fill helper ─────────────────────────────────────────────────
  // Also seeds the incremental EMA/VWAP cache so subsequent tick updates are O(1).
  const fillIndicator = useCallback((s: ISeriesApi<"Line">, key: keyof IndicatorState, bars: OHLCBar[]) => {
    if (bars.length === 0) return;
    const closes = bars.map(b => b.close);
    const values = key === "vwap" ? calcVWAP(bars) : calcEMA(closes, EMA_PERIODS[key]);
    const data = bars
      .map((b, i) => values[i] !== null ? { time: b.time as Time, value: values[i] as number } : null)
      .filter(Boolean) as { time: Time; value: number }[];
    if (data.length > 0) s.setData(data);

    // Seed incremental cache so WS tick updates are O(1) instead of O(n)
    const n = bars.length;
    if (n >= 2) {
      if (key === "vwap") {
        // Cache cumulative TP×vol / vol for all bars EXCEPT the live (last) one
        let cumPV = 0, cumV = 0;
        for (let i = 0; i < n - 1; i++) {
          const b = bars[i];
          const tp = (b.high + b.low + b.close) / 3;
          cumPV += tp * b.volume;
          cumV  += b.volume;
        }
        vwapCumRef.current = { cumPV, cumV };
      } else {
        // Cache EMA of the penultimate bar (prev) and the current live bar (curr)
        const prev = values[n - 2];
        const curr = values[n - 1];
        if (prev != null) emaPrevRef.current[key] = prev as number;
        if (curr != null) emaCurrRef.current[key] = curr as number;
      }
    }
    if (n > 0) emaLastBarTimeRef.current = bars[n - 1].time;
  }, []);

  // ── Infinite history loader ───────────────────────────────────────────────
  // Called by onRangeChange when the user pans near the left edge of loaded data.
  // Fetches the next older page of 500 bars from the API using the oldest loaded
  // bar's timestamp as a cursor (?before=...), prepends them to barsRef, and
  // restores the viewport by shifting the logical range right by the count of
  // newly added bars so the user stays on the same candles with no jump.
  const loadMoreHistory = useCallback(async () => {
    if (isLoadingMoreRef.current || !hasMoreHistoryRef.current) return;
    const oldestTime = oldestBarTimeRef.current;
    if (!oldestTime) return;
    const sym = symRef.current;
    const iv  = ivRef.current;

    isLoadingMoreRef.current = true;
    // Show the loading indicator (direct DOM — no React re-render)
    if (histLoadingDivRef.current) histLoadingDivRef.current.style.display = "flex";

    try {
      const resp = await fetch(`${BASE}/api/candles/${sym}/${iv}?before=${oldestTime}`);
      if (!resp.ok || !mountedRef.current) return;
      if (symRef.current !== sym || ivRef.current !== iv) return; // symbol/interval changed during fetch

      const newBars: OHLCBar[] = await resp.json();
      if (!Array.isArray(newBars) || newBars.length < 2) {
        // Exchange returned nothing — we've reached the start of available history
        hasMoreHistoryRef.current = false;
        return;
      }

      const existing         = barsRef.current;
      const earliestExisting = existing[0]?.time ?? Infinity;

      // Only keep bars strictly older than what we already have (strict dedup by time)
      const fresh = newBars.filter(b => b.time < earliestExisting);
      if (fresh.length === 0) {
        hasMoreHistoryRef.current = false;
        return;
      }

      // Merge: prepend fresh bars, dedup by time key, sort ascending
      const merged = [
        ...new Map([...fresh, ...existing].map(b => [b.time, b])).values(),
      ].sort((a, b) => a.time - b.time);

      const numAdded = merged.length - existing.length;
      if (numAdded <= 0) { hasMoreHistoryRef.current = false; return; }

      // Stop loading once we hit the 10,000 bar ceiling
      if (merged.length >= MAX_TOTAL_BARS) hasMoreHistoryRef.current = false;

      barsRef.current          = merged;
      oldestBarTimeRef.current = merged[0].time;

      const chart  = chartRef.current;
      const series = mainRef.current;
      if (!chart || !series || !mountedRef.current) return;

      // Snapshot the visible logical range BEFORE calling setData().
      // After setData() with N new bars prepended, every bar's logical index
      // shifts right by numAdded — we compensate by adding numAdded to both
      // edges, keeping the user viewing exactly the same candles with no jump.
      const beforeRange = chart.timeScale().getVisibleLogicalRange();

      applyBars(series, ctRef.current, merged);

      // Rebuild indicator series over the full expanded dataset.
      // Done before restoring the range so LWC only repaints once.
      for (const [key, s] of Object.entries(emaRefs.current) as [keyof IndicatorState, ISeriesApi<"Line">][]) {
        fillIndicator(s, key, merged);
      }

      // Restore viewport in a RAF so LWC has fully processed setData() before
      // we programmatically set the range (avoids a frame where LWC shows
      // fitContent-style all-bars view before our compensation takes effect).
      if (beforeRange) {
        requestAnimationFrame(() => {
          if (!mountedRef.current) return;
          try {
            chart.timeScale().setVisibleLogicalRange({
              from: (beforeRange.from as number) + numAdded,
              to:   (beforeRange.to   as number) + numAdded,
            });
          } catch { /* LWC may reject if chart was disposed — ignore */ }
        });
      }
    } catch (err) {
      console.warn("[loadMoreHistory] fetch error — will retry on next scroll:", err);
      // Don't set hasMoreHistoryRef = false on network errors — allow retry
    } finally {
      isLoadingMoreRef.current = false;
      if (histLoadingDivRef.current) histLoadingDivRef.current.style.display = "none";
    }
  }, [fillIndicator]);

  // Keep the ref in sync so the chart-init useEffect's onRangeChange closure
  // always calls the current version without needing to be recreated.
  loadMoreHistRef.current = loadMoreHistory;

  // ── Apply settings reactively ────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    const main  = mainRef.current;
    if (!chart || !settings) return;

    const gridBoth = settings.gridStyle === "both";
    const gridVert = settings.gridStyle === "vertical";
    const gridHorz = settings.gridStyle === "horizontal";

    chart.applyOptions({
      layout: {
        background:  { color: settings.bgColor },
        textColor:   settings.textColor,
        fontSize:    settings.fontSize,
      },
      grid: {
        vertLines: { color: settings.gridColor ?? settings.linesColor, visible: gridBoth || gridVert },
        horzLines: { color: settings.gridColor ?? settings.linesColor, visible: gridBoth || gridHorz },
      },
      crosshair: {
        mode:     settings.crosshair === "magnet" ? CrosshairMode.Magnet : CrosshairMode.Normal,
        vertLine: {
          color: settings.crosshairColor, width: settings.crosshairWidth as 1|2|3,
          style: toLineStyle(settings.crosshairStyle),
          labelBackgroundColor: settings.bgColor,
        },
        horzLine: {
          color: settings.crosshairColor, width: settings.crosshairWidth as 1|2|3,
          style: toLineStyle(settings.crosshairStyle),
          labelBackgroundColor: settings.bgColor,
        },
      },
      rightPriceScale: {
        borderColor:   settings.borderColor ?? settings.linesColor,
        borderVisible: settings.bordersVisible ?? true,
        mode:          toPriceScaleMode(settings.scaleMode),
        autoScale:     settings.priceScaleAutoScale ?? true,
      },
      timeScale: {
        borderColor:   settings.borderColor ?? settings.linesColor,
        borderVisible: settings.bordersVisible ?? true,
      },
    });

    if (main && (ctRef.current === "line" || ctRef.current === "line_with_markers")) {
      try {
        (main as ISeriesApi<"Line">).applyOptions({
          color: hexToRgba(settings.lineColor, settings.lineOpacity),
          lineWidth: settings.lineWidth,
          pointMarkersVisible: ctRef.current === "line_with_markers",
        });
      } catch { /* chart type may not be line */ }
    } else if (main && ctRef.current === "candles") {
      try {
        (main as ISeriesApi<"Candlestick">).applyOptions({
          upColor:         settings.upColor,
          downColor:       settings.downColor,
          borderUpColor:   settings.upBorderColor,
          borderDownColor: settings.downBorderColor,
          wickUpColor:     settings.upWickColor,
          wickDownColor:   settings.downWickColor,
        });
      } catch { /* chart type may not be candlestick */ }
    } else if (main) {
      try {
        (main as ISeriesApi<"Bar">).applyOptions({
          upColor: settings.upColor, downColor: settings.downColor,
        });
      } catch { /* ignore */ }
    }
  }, [settings, chartCtx]); // eslint-disable-line react-hooks/exhaustive-deps

  // (cursor hint removed — PriceScaleTouchHandler provides ns-resize cursor over the scale strip)

  // ── Create chart ONCE ────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    const container = containerRef.current;
    if (!container) return;

    performance.mark("tj:lwc:init:start");

    const chart = createChart(container, {
      width:  container.clientWidth  || 800,
      height: container.clientHeight || 600,
      layout: {
        background: { color: CHART_BG },
        textColor:  TEXT_COLOR,
        fontFamily: "'Inter','SF Pro Display',system-ui,sans-serif",
        fontSize:   11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      crosshair: {
        mode:     CrosshairMode.Normal,
        vertLine: { color: "rgba(183,255,90,0.38)", labelBackgroundColor: "#0D2A1A" },
        horzLine: { color: "rgba(183,255,90,0.38)", labelBackgroundColor: "#0D2A1A" },
      },
      rightPriceScale: {
        borderColor:   "rgba(57,91,67,0.35)",
        scaleMargins:  { top: 0.07, bottom: 0.25 },
        autoScale:     true,
        entireTextOnly: true,
      },
      timeScale: {
        borderColor:     "rgba(57,91,67,0.35)",
        timeVisible:     true,
        secondsVisible:  false,
        rightOffset:     10,
        // Lightweight Charts 5.2: conflate only when bars are below the
        // renderable pixel density. This keeps large-history charts responsive
        // while preserving full-resolution data and exact indicator values.
        enableConflation: true,
        // Keep 1m candles physically readable on mobile instead of allowing
        // hundreds of loaded bars to collapse into 1px dash/wick marks.
        // Users can still zoom further out/in with the time-scale controls.
        barSpacing:      8,
        minBarSpacing:   4,
        fixLeftEdge:     false,
        fixRightEdge:    false,
        tickMarkFormatter: (time: number, type: TickMarkType) => {
          const d    = new Date(time * 1000);
          const hh   = String(d.getHours()).padStart(2, "0");
          const min  = String(d.getMinutes()).padStart(2, "0");
          const day  = d.getDate();
          const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const mon  = MONTHS[d.getMonth()];
          const yyyy = d.getFullYear();
          // Hierarchy exactly like TradingView:
          //   Year       → "2026"
          //   Month      → "Jan"  (month boundary within a year)
          //   DayOfMonth → "13"   (day boundary within a month)
          //   Time       → "09:00" (intra-day tick)
          switch (type) {
            case TickMarkType.Year:        return String(yyyy);
            case TickMarkType.Month:       return mon;
            case TickMarkType.DayOfMonth:  return `${day} ${mon}`;
            case TickMarkType.Time:        return `${hh}:${min}`;
            default:                       return `${hh}:${min}`;
          }
        },
      },
      handleScroll: {
        // ROOT CAUSE FIX #1: In LWC v5, handleScroll.mouseWheel enables horizontal pan via
        // wheel deltaX. On macOS trackpads, even hovering generates tiny deltaX that LWC
        // interprets as chart pan — the "hover moves chart" bug. Setting false eliminates it.
        // Zoom via wheel still works via handleScale.mouseWheel (independent option).
        mouseWheel:       false,
        pressedMouseMove: false, // we implement threshold-based mouse drag pan below
        horzTouchDrag:    false, // we implement touch drag pan below
        vertTouchDrag:    false, // we implement touch vert pan below
      },
      // kineticScroll is a TOP-LEVEL option in LWC v5 (not nested under handleScroll)
      // touch: false — we own ALL touch gesture handling; letting LWC run its own
      // kinetic scroll after pinch-zoom ends conflicts with our custom pan engine.
      kineticScroll: { mouse: false, touch: false },
      handleScale: {
        mouseWheel:           true,  // vertical wheel → zoom (independent of handleScroll.mouseWheel)
        pinch:                false, // we implement pinch-to-zoom ourselves in onTouchStart/onTouchMove
        // ROOT CAUSE FIX #2: axisPressedMouseMove.time: true makes LWC apply its own
        // time-axis pan while our engine is in CROSSHAIR mode (below threshold, no
        // stopPropagation) — LWC and our engine both pan concurrently causing jitter.
        // time: false → our gesture engine owns all horizontal pan exclusively.
        // price: false → native LWC price-axis drag is disabled; dedicated PriceScaleTouchHandler owns Y-scaling.
        axisPressedMouseMove: { time: false, price: false },
        axisDoubleClickReset: { time: true, price: true },
      },
    });

    const main = makeSeries(chart, ctRef.current, settings);

    chart.subscribeCrosshairMove(param => {
      if (!param.point || !param.time) {
        emitCrosshair({ time: null, open: null, high: null, low: null, close: null, volume: null });
        return;
      }
      const cs  = mainRef.current;
      if (!cs) return;
      const bar = param.seriesData.get(cs) as { open?: number; high?: number; low?: number; close?: number; value?: number } | undefined;
      if (bar) {
        const close = bar.close ?? bar.value ?? null;
        const open  = bar.open ?? close;
        emitCrosshair({ time: typeof param.time === "number" ? param.time : null, open, high: bar.high ?? close, low: bar.low ?? close, close, volume: null });
      }
    });

    chartRef.current  = chart;
    mainRef.current   = main;
    chartApiRef.current = chart;

    performance.mark("tj:lwc:init:end");
    try {
      const m = performance.measure("LWC init", "tj:lwc:init:start", "tj:lwc:init:end");
      console.debug(`[PERF] LWC createChart: ${m.duration.toFixed(1)} ms`);
    } catch { /* ok — Safari < 16.4 throws if marks are missing */ }

    // Provide context (candle = main candlestick series for price↔coord mapping)
    setChartCtx({ chart, candle: main });

    // Guard against "Object is disposed" — ro.disconnect() doesn't cancel callbacks
    // that are already queued in the microtask/macrotask queue. A queued callback
    // firing after chart.remove() would throw; the flag lets us bail early.
    let chartDisposed = false;

    const ro = new ResizeObserver(entries => {
      if (chartDisposed) return;
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      try { chart.applyOptions({ width: w, height: h }); } catch { return; }
      // Keep the future-crosshair canvas in sync with the chart size
      const fc = futureCrossCanvasRef.current;
      if (fc) { fc.width = w; fc.height = h; }
    });
    ro.observe(container);

    // Size the future-crosshair canvas immediately (ResizeObserver fires async)
    const fcInit = futureCrossCanvasRef.current;
    if (fcInit) { fcInit.width = container.clientWidth; fcInit.height = container.clientHeight; }

    // Clear future crosshair when mouse leaves the chart area
    const onMouseLeave = () => {
      const fc = futureCrossCanvasRef.current;
      if (!fc) return;
      const ctx = fc.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, fc.width, fc.height);
    };
    container.addEventListener('mouseleave', onMouseLeave);

    // ── Viewport persistence — save visible range + price lock to localStorage ─
    // Keyed per symbol+interval (exactly like TradingView) so each instrument
    // remembers its own scroll position, zoom level, and vertical pan range.
    const doSaveVp = () => {
      const ch = chartRef.current;
      if (!ch) return;
      try {
        const range = ch.timeScale().getVisibleLogicalRange();
        if (!range) return;
        const pr = getPanRange();
        const vp: Record<string, number> = { from: range.from, to: range.to };
        if (pr) { vp.priceMin = pr.lo; vp.priceMax = pr.hi; }
        localStorage.setItem(`tv_vp_v2_${symRef.current}_${ivRef.current}`, JSON.stringify(vp));
      } catch { /* ok */ }
    };
    const schedSaveVp = () => {
      if (vpSaveTimerRef.current) clearTimeout(vpSaveTimerRef.current);
      vpSaveTimerRef.current = setTimeout(doSaveVp, 600);
    };
    // onRangeChange: triple purpose — save viewport + track nearRealtime + trigger history load.
    // Fires on every visible range change (manual pan, zoom, or our own setVisibleLogicalRange).
    const onRangeChange = (range: import("lightweight-charts").LogicalRange | null) => {
      if (range) {
        const lastIdx = barsRef.current.length - 1;
        // "near realtime" = viewport right edge is within the last ~3 bars of the data.
        // Using -3 (not 0) gives a small buffer so a new bar forming just off-screen
        // still triggers auto-follow rather than requiring a full re-scroll first.
        nearRealtimeRef.current = lastIdx < 0 || (range.to as number) >= lastIdx - 3;

        // Infinite history: when the left edge of the viewport comes within
        // HISTORY_PREFETCH_BARS of bar 0, fetch the next older page.
        // loadMoreHistRef.current always points to the latest loadMoreHistory
        // closure even though this onRangeChange is defined once in the
        // chart-init useEffect (avoiding a stale-closure bug).
        if (
          (range.from as number) < HISTORY_PREFETCH_BARS &&
          !isLoadingMoreRef.current &&
          hasMoreHistoryRef.current
        ) {
          void loadMoreHistRef.current();
        }
      }
      schedSaveVp();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
    const unsubPanVp = subscribePanRange(schedSaveVp);

    // ── Chart Interaction State Machine ──────────────────────────────────────
    //
    // Exclusive interaction modes — ONLY ONE may be active at any time.
    //
    //   IDLE              No pointer down. Mouse hover: LWC crosshair works naturally.
    //
    //   CROSSHAIR         Mouse-only. Button down, pan threshold not yet exceeded.
    //                     LWC updates crosshair via hover events; no chart transforms.
    //
    //   PENDING           Touch-only. Finger down, waiting for long-press (500 ms).
    //                     Finger moves > PAN_THRESHOLD before timer → CHART_PAN (no crosshair).
    //                     Timer fires without movement → CROSSHAIR_LOCKED.
    //
    //   CROSSHAIR_LOCKED  Long-press confirmed. Crosshair pinned at finger position.
    //                     Subsequent drag enters CROSSHAIR_DRAG. Chart does NOT pan.
    //
    //   CROSSHAIR_DRAG    Finger dragging after long-press. Only crosshair moves;
    //                     chart position is frozen. LWC touch events are blocked.
    //
    //   CHART_PAN         Touch moved before long-press, or mouse threshold exceeded.
    //                     We own all transforms. No crosshair shown.
    //
    //   PINCH_ZOOM        Second finger arrived. LWC native pinch handler takes over.

    type IMode = 'IDLE' | 'CROSSHAIR' | 'PENDING' | 'CROSSHAIR_LOCKED' | 'CROSSHAIR_DRAG' | 'CHART_PAN' | 'PINCH_ZOOM' | 'TIME_SCALE_DRAG';

    type IGesture = {
      mode:       IMode;
      pointerId:  number;
      startX:     number;
      startY:     number;
      lastX:      number;
      lastY:      number;
      lastT:      number;
      isTouch:    boolean;
      // CHART_PAN fields
      velY:         number;
      hRafId:       number | null;
      vRafId:       number | null;
      panMin:       number | null;
      panMax:       number | null;
      pricePerPx:   number | null;
      panActivated: boolean; // true after the first vertical frame activates pan-range
      // PINCH_ZOOM fields — incremental: compare current span to previous frame
      pinchPrevSpan:          number | null;
      // Horizontal pan input accumulated between display frames. Keeping this
      // in the gesture state lets high-frequency Android pointer events collapse
      // into one timeScale update per animation frame without losing movement.
      hPendingDx:              number;
    };

    const PAN_THRESHOLD = 10; // px — minimum travel before CROSSHAIR → CHART_PAN

    let ig:          IGesture | null = null;
    let momentumRaf: number   | null = null;
    let pressCount               = 0; // live pointer count for pinch detection
    let touchCount               = 0; // live touch count (e.touches.length) — ground truth for two-finger detection
    let lastTsDownT              = 0; // timestamp of last pointerdown in the time-scale zone
    let crosshairLocked          = false; // crosshair pinned after touch lift
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    // Last position set via setCrosshairPosition — used to re-apply after LWC's
    // touchend handler clears the crosshair before our pointerup fires.
    let lockedCrosshairPos: { price: number; time: Time } | null = null;
    // Pixel coords of the crosshair when it is in the future (blank) area.
    // LWC cannot render there so we use the canvas overlay; this lets us
    // redraw after LWC clears the crosshair on touchend.
    let lockedFutureCrossPixel: { x: number; y: number } | null = null;
    // Pixel coords of the crosshair at the moment the long-press fires.
    // Used to compute relative drag offset so the crosshair never jumps.
    let lockedCrosshairPixel: { x: number; y: number } | null = null;
    // Anchor saved at the first drag frame: finger + crosshair pixel positions.
    // Every subsequent CROSSHAIR_DRAG frame applies the delta from these refs.
    let crosshairDragAnchor: { fingerX: number; fingerY: number; crossX: number; crossY: number } | null = null;

    const cancelIg = () => {
      if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (!ig) return;
      if (ig.hRafId !== null) cancelAnimationFrame(ig.hRafId);
      if (ig.vRafId !== null) cancelAnimationFrame(ig.vRafId);
      // CRITICAL: release pointer capture so the browser doesn't hold a stale
      // capture for a pointer ID that will never receive pointerup/cancel.
      // Releasing a capture the element doesn't hold is a safe no-op.
      // Skip for PINCH_ZOOM (pointerId = -1 sentinel; no setPointerCapture was called).
      if (ig.pointerId >= 0) {
        try { container.releasePointerCapture(ig.pointerId); } catch { /* ok */ }
      }
      ig = null;
    };

    // ── coordinateToTimeOrExtrapolate ────────────────────────────────────────
    // LWC's coordinateToTime() returns null for x positions beyond the last
    // candle (the "future area"). This helper scans leftward from x to find
    // the last two distinct bar times, computes a time-per-pixel ratio, and
    // extrapolates so the crosshair works in empty future space as well.
    const coordinateToTimeOrExtrapolate = (ch: typeof chartRef.current, x: number): Time | null => {
      if (!ch) return null;
      const ts = ch.timeScale();

      // Fast path: point is over a real candle
      const direct = ts.coordinateToTime(x);
      if (direct !== null) return direct;

      // Slow path: scan left to find the last two distinct bar times
      let lastT: number | null = null;
      let lastX = 0;
      let prevT: number | null = null;
      let prevX = 0;

      for (let px = Math.floor(x) - 1; px >= 0; px--) {
        const candidate = ts.coordinateToTime(px);
        if (candidate === null || typeof candidate !== 'number') continue;
        if (lastT === null) {
          lastT = candidate as number;
          lastX = px;
        } else if (candidate !== lastT) {
          prevT = candidate as number;
          prevX = px;
          break;
        }
      }

      if (lastT === null) return null;          // no data at all
      if (prevT === null) return lastT as unknown as Time; // only one bar

      // Extrapolate: compute time/px slope from the two reference points
      const timePerPx = (lastT - prevT) / (lastX - prevX);
      const extrapolated = Math.round(lastT + (x - lastX) * timePerPx);
      return extrapolated as unknown as Time;
    };

    // ── drawCanvasCrosshair ───────────────────────────────────────────────────
    // Draws crosshair lines + time label on the futureCrossCanvasRef overlay.
    // Used for both mouse-hover and touch CROSSHAIR_DRAG in the future (blank) area
    // where LWC's setCrosshairPosition cannot render a visible crosshair.
    // Pass x=null to just clear the canvas (crosshair dismissed).
    const PRICE_SCALE_W_CONST = 72;
    const TIME_SCALE_H_CONST  = 35;
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const drawCanvasCrosshair = (x: number | null, y: number) => {
      const fc  = futureCrossCanvasRef.current;
      const ch  = chartRef.current;
      if (!fc) return;
      const ctx = fc.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, fc.width, fc.height);
      if (x === null) return;
      const copts = (ch?.options() as any)?.crosshair ?? {};
      const vLine = copts.vertLine ?? {};
      const hLine = copts.horzLine ?? {};
      const color = vLine.color ?? '#888888';
      const lw    = vLine.width ?? 1;
      const ls    = vLine.style ?? 0;
      const dash  =
        ls === 1 ? [2, 2]   :
        ls === 2 ? [6, 3]   :
        ls === 3 ? [12, 5]  :
        ls === 4 ? [2, 6]   :
        [];
      const hColor = hLine.color ?? color;
      const hLw    = hLine.width ?? lw;
      const hLs    = hLine.style ?? ls;
      const hDash  =
        hLs === 1 ? [2, 2]   :
        hLs === 2 ? [6, 3]   :
        hLs === 3 ? [12, 5]  :
        hLs === 4 ? [2, 6]   :
        [];
      const cw  = fc.width;
      const ch2 = fc.height;
      const cx  = Math.round(x) + 0.5;
      const cy  = Math.round(y) + 0.5;
      // Vertical line — full height above time scale
      ctx.strokeStyle = color;
      ctx.lineWidth   = lw;
      ctx.setLineDash(dash);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, ch2 - TIME_SCALE_H_CONST);
      ctx.stroke();
      // Horizontal line — full width left of price scale
      ctx.strokeStyle = hColor;
      ctx.lineWidth   = hLw;
      ctx.setLineDash(hDash);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(cw - PRICE_SCALE_W_CONST, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      // ── Time label pill in the time-scale strip ──────────────────────────
      // LWC normally draws this; we must do it ourselves in the future area.
      const ts = ch ? coordinateToTimeOrExtrapolate(ch, x) : null;
      if (ts !== null && typeof ts === 'number') {
        const d     = new Date((ts as number) * 1000);
        const mon   = MONTHS[d.getMonth()];
        const day   = String(d.getDate()).padStart(2, '0');
        const hr    = String(d.getHours()).padStart(2, '0');
        const mn    = String(d.getMinutes()).padStart(2, '0');
        const label = `${mon} ${day}  ${hr}:${mn}`;
        const fontSize = 11;
        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        const tw  = ctx.measureText(label).width;
        const pH  = 6, pV = 3;
        const bw  = tw + pH * 2;
        const bh  = fontSize + pV * 2;
        // Center under the vertical line, clamped to drawable area
        const rawBx = x - bw / 2;
        const bx    = Math.max(0, Math.min(cw - PRICE_SCALE_W_CONST - bw, rawBx));
        const by    = ch2 - TIME_SCALE_H_CONST + Math.floor((TIME_SCALE_H_CONST - bh) / 2);
        // Background fill — use crosshair color with slight opacity adjustment
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        const r = 3;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + bw - r, by);
        ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
        ctx.lineTo(bx + bw, by + bh - r);
        ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
        ctx.lineTo(bx + r, by + bh);
        ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        // Label text — dark on the coloured pill
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + pH, by + bh / 2);
        ctx.textBaseline = 'alphabetic';
      }
    };

    // ── pointerdown ──────────────────────────────────────────────────────────
    const TIME_SCALE_H = 35; // px — height of LWC time scale strip at chart bottom
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return; // right/middle click — ignore
      if (e.target instanceof SVGElement) return;              // drawing anchor — DrawingOverlay handles it

      const rect = container.getBoundingClientRect();

      // ── Price-scale zone (mouse only): dedicated handler owns the scale ─────
      // The price scale strip is the rightmost ~72px (matches DrawingOverlay's
      // right:72 cutout and PriceScaleTouchHandler's touch zone).
      // LWC axisPressedMouseMove.price is disabled. PriceScaleTouchHandler owns
      // the price-scale gesture, so keep `ig` null and do not compete with it.
      if (e.pointerType === 'mouse' && rect.right - e.clientX <= 72) {
        e.preventDefault(); // block text-selection but keep ig=null so LWC owns it
        return;
      }

      // NOTE: we do NOT disable autoScale here. The vertical pan mechanism relies
      // on autoscaleInfoProvider, which LWC only calls when autoScale:true.
      // autoScale:false is applied lazily in the horizontal-pan block (first dx frame)
      // and re-enabled immediately when vertical pan starts (first dy frame).

      // ── Time-scale zone (mouse + touch): custom horizontal zoom ──────────
      // The time scale strip is the bottom ~35px of the chart container.
      // LWC's axisPressedMouseMove.time is false so we own this interaction.
      // Drag left → zoom out (more bars visible); drag right → zoom in.
      // We cancel any running ig/momentum and start a dedicated TIME_SCALE_DRAG
      // mode — no CROSSHAIR threshold, no vertical pan, no kinetic coast.
      if (e.clientY >= rect.bottom - TIME_SCALE_H) {
        e.preventDefault();
        e.stopPropagation();

        // ── Double-tap/click → fit all bars on screen ─────────────────────
        const now = performance.now();
        if (now - lastTsDownT < 350) {
          lastTsDownT = 0;
          cancelIg(); // clear any ig left over from the first tap of the double-tap
          try { container.releasePointerCapture(e.pointerId); } catch { /* ok */ }
          try { chartRef.current?.timeScale().fitContent(); } catch { /* ok */ }
          return;
        }
        lastTsDownT = now;

        if (momentumRaf !== null) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
        cancelIg();
        // Snapshot the current time range so onMove can use start-anchored
        // exponential zoom (total-dx from startX, not per-frame delta).
        // panMin = right edge (to), panMax = bars visible at drag start.
        const tsRange = chartRef.current?.timeScale().getVisibleLogicalRange();
        const tsTo    = tsRange ? (tsRange.to   as number) : null;
        const tsBars  = tsRange ? ((tsRange.to as number) - (tsRange.from as number)) : null;
        ig = {
          mode: 'TIME_SCALE_DRAG',
          pointerId:  e.pointerId,
          startX:     e.clientX,
          startY:     e.clientY,
          lastX:      e.clientX,
          lastY:      e.clientY,
          lastT:      performance.now(),
          isTouch:    e.pointerType !== 'mouse',
          velY: 0, hRafId: null, vRafId: null,
          panMin: tsTo,    // right edge anchor
          panMax: tsBars,  // bars-visible at drag start
          pricePerPx: null,
          panActivated: false,
          pinchPrevSpan: null,
          hPendingDx: 0,
        };
        // Pointer capture ensures onUp fires even if pointer leaves container
        try { container.setPointerCapture(e.pointerId); } catch { /* ok */ }
        return;
      }

      // Prevent browser text-selection / native image-drag from stealing the pointer
      e.preventDefault();

      // ── Stale-state guard (touch only) ────────────────────────────────────
      // If a previous touch's pointerup/cancel was missed (OS interrupt, home
      // swipe, notification), ig still holds the old pointerId and pressCount
      // may be > 0. Reset both before treating this as a fresh gesture so we
      // don't falsely enter PINCH_ZOOM on a single-finger drag.
      //
      // IMPORTANT: skip this guard when already in PINCH_ZOOM mode.
      // onTouchStart sets ig.pointerId = -1 (a sentinel meaning "no single
      // tracked pointer"). When the second finger's pointerdown then arrives,
      // ig.pointerId (-1) !== e.pointerId (real ID) would trigger this guard,
      // resetting pressCount to 0 and cancelling the PINCH_ZOOM that
      // onTouchStart just established — causing spurious single-finger panning.
      if (e.pointerType !== 'mouse' && ig && ig.mode !== 'PINCH_ZOOM' && ig.pointerId !== e.pointerId) {
        cancelIg();
        pressCount = 0;
      }

      // ── pressCount sanity reset (touch only) ──────────────────────────────
      // If ig is null but pressCount is still positive, a previous pointer's
      // cleanup was missed (missed pointerup, OS interrupt, or the double-count
      // from onTouchStart + pointerdown firing for the same finger). Reset to 0
      // so this fresh touch always starts from a clean slate. The window between
      // onTouchEnd (which nulls ig) and onUp (which decrements pressCount) is
      // too small for a new pointerdown to arrive, so this reset is safe.
      if (e.pointerType !== 'mouse' && ig === null && pressCount > 0) {
        pressCount = 0;
      }

      // ── onTouchStart PINCH_ZOOM fast-path ────────────────────────────────
      // onTouchStart already entered PINCH_ZOOM with pointerId=-1 (sentinel for
      // "no single tracked pointer, using e.touches[]"). When the corresponding
      // pointerdown for the second finger now arrives we must NOT run the full
      // PINCH_ZOOM setup again (which would call cancelIg() + pressCount++ and
      // corrupt the count). Just update the tracking ID and return.
      if (e.pointerType !== 'mouse' && ig?.mode === 'PINCH_ZOOM' && ig.pointerId === -1) {
        // onTouchStart already established PINCH_ZOOM (pointerId=-1 sentinel).
        // The second finger's pointerdown arrives here. Update the tracking ID,
        // increment pressCount (pointer events own this counter), and return
        // without re-running the PINCH_ZOOM setup block. This keeps pressCount
        // accurate (=2 while both fingers are down, =1 after first lifts) so
        // autoScale is only restored when the last finger actually leaves.
        ig.pointerId     = e.pointerId;
        ig.pinchPrevSpan = null; // re-seed span on next touchmove
        try { container.setPointerCapture(e.pointerId); } catch { /* ok */ }
        pressCount++;
        return;
      }

      // Do NOT dismiss locked crosshair here — wait to see if this touch
      // is a tap (dismiss) or a drag (keep). Decision made in onUp.

      pressCount++;

      // ── PINCH_ZOOM: second (or later) finger arrived ─────────────────────
      // Cancel our single-finger state immediately. We implement pinch-to-zoom
      // ourselves in the onTouchMove capture listener using e.touches[].
      // Do NOT stopPropagation here — LWC should still see this pointerdown.
      //
      // GUARD: require touchCount >= 2 (ground truth from e.touches.length) in
      // addition to pressCount >= 2. This prevents a drifted pressCount from
      // falsely entering PINCH_ZOOM when only one finger is actually on screen.
      if (pressCount >= 2 && touchCount >= 2) {
        // IMPORTANT: release pointer capture on the first finger BEFORE cancelIg()
        // clears ig. The container captured pointer 1 on first touch (line below);
        // if we don't release it, LWC never sees pointer 1 events.
        const firstPointerId = ig?.pointerId;
        cancelIg();
        if (firstPointerId !== undefined) {
          try { container.releasePointerCapture(firstPointerId); } catch { /* ok */ }
        }
        ig = {
          mode: 'PINCH_ZOOM', pointerId: e.pointerId,
          startX: e.clientX, startY: e.clientY,
          lastX: e.clientX,  lastY: e.clientY,
          lastT: performance.now(), isTouch: true,
          velY: 0, hRafId: null, vRafId: null,
          panMin: null, panMax: null, pricePerPx: null, panActivated: false,
          pinchPrevSpan: null,
          hPendingDx: 0, // initialized on first touchmove
        };
        return;
      }

      // CRITICAL: stop propagation for single-finger gestures so LWC's
      // internal handlers (pane separator resize, per-pane price-scale drag)
      // never fire — even during the CROSSHAIR/PENDING window before CHART_PAN.
      // Price-scale zone (mouse) and pinch already returned above.
      e.stopPropagation();

      // Kill any running vertical kinetic coast so a new touch starts clean.
      // Also clear the shared pan-range so indicator series restore auto-scale.
      if (momentumRaf !== null) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = null;
        activatePanRange(null);
        try { mainRef.current?.applyOptions({ autoscaleInfoProvider: () => null }); } catch { /* ok */ }
      }

      // Mouse → CROSSHAIR (threshold-based pan detection, LWC handles hover crosshair)
      // Touch → PENDING  (wait for long-press timer before showing crosshair)
      const newIg: IGesture = {
        mode:       e.pointerType === 'mouse' ? 'CROSSHAIR' : 'PENDING',
        pointerId:  e.pointerId,
        startX:     e.clientX,
        startY:     e.clientY,
        lastX:      e.clientX,
        lastY:      e.clientY,
        lastT:      performance.now(),
        isTouch:      e.pointerType !== 'mouse',
        velY:         0,
        hRafId:       null,
        vRafId:       null,
        panMin:       null,
        panMax:       null,
        pricePerPx:   null,
        panActivated: false,
        pinchPrevSpan: null,
          hPendingDx: 0,
      };
      ig = newIg;
      // Capture the pointer so pointerup fires even if the cursor leaves the
      // container during a fast drag (prevents stuck ig / ghost-pan state).
      try { container.setPointerCapture(e.pointerId); } catch { /* ok */ }

      // Touch only: 500 ms long-press timer. If finger stays within PAN_THRESHOLD,
      // lock the crosshair and enter CROSSHAIR_LOCKED. Otherwise onMove cancels it.
      if (e.pointerType !== 'mouse') {
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (!ig || ig.mode !== 'PENDING') return;
          const ch     = chartRef.current;
          const series = mainRef.current;
          if (!ch || !series) return;
          try {
            const rect     = container.getBoundingClientRect();
            const x        = ig.lastX - rect.left;
            const y        = ig.lastY - rect.top;
            const time     = coordinateToTimeOrExtrapolate(ch, x);
            const price    = series.coordinateToPrice(y);
            if (time !== null && price !== null) {
              lockedCrosshairPos   = { price: price as number, time };
              lockedCrosshairPixel = { x, y };
              crosshairDragAnchor  = null; // reset so the next drag starts fresh
              const isFuture = ch.timeScale().coordinateToTime(x) === null;
              if (isFuture) {
                // Future area — canvas only. Clear LWC's crosshair first so the
                // stale line from the last data-area position doesn't ghost behind
                // the canvas draw, and so LWC stops fighting with us at 60fps.
                try { ch.clearCrosshairPosition(); } catch { /* ok */ }
                lockedFutureCrossPixel = { x, y };
                drawCanvasCrosshair(x, y);
              } else {
                lockedFutureCrossPixel = null;
                ch.setCrosshairPosition(price as number, time, series);
              }
              ig.mode = 'CROSSHAIR_LOCKED';
            }
          } catch { /* ok */ }
        }, 500);
      }
    };

    // ── pointermove ──────────────────────────────────────────────────────────
    const onMove = (e: PointerEvent) => {
      // ── Stale-state guard (mouse only) ────────────────────────────────────
      // If the mouse is moving with no button held but ig is still set, the
      // pointerup was missed (context-menu steal, window-blur, OS gesture, etc).
      // Clear immediately so the chart doesn't ghost-pan on hover.
      if (e.pointerType === 'mouse' && e.buttons === 0 && ig) {
        cancelIg();
        pressCount = 0;
        return;
      }

      // ── IDLE mouse hover in the blank future area ─────────────────────────
      // LWC's native crosshair only renders where bar data exists. In the blank
      // area to the right of the last candle, coordinateToTime() returns null and
      // LWC shows nothing. We intercept those hover events and draw the crosshair
      // lines ourselves on a transparent canvas overlay.
      if (e.pointerType === 'mouse' && e.buttons === 0 && !ig) {
        const ch  = chartRef.current;
        if (ch) {
          const rect = container.getBoundingClientRect();
          const x    = e.clientX - rect.left;
          const y    = e.clientY - rect.top;
          if (ch.timeScale().coordinateToTime(x) === null) {
            drawCanvasCrosshair(x, y);
          } else {
            drawCanvasCrosshair(null, 0);
          }
        }
        return;
      }

      // ── Two-finger guard: block ALL pointer moves during a pinch ────────────
      // touchCount is the ground-truth number of fingers from e.touches.length,
      // updated in onTouchStart/onTouchEnd. It can never drift out of sync the
      // way pressCount can (pressCount is reset by the stale-state guard in onDown
      // when ig.pointerId = -1, causing it to under-count during the iOS
      // onTouchStart → pointerdown sequence). Using touchCount ensures that
      // every pointermove from either finger is blocked while two fingers are
      // on screen, preventing LWC from interpreting the pinch as a horizontal pan.
      if (touchCount >= 2) {
        e.stopPropagation();
        return;
      }

      const g = ig;
      if (!g || g.pointerId !== e.pointerId) return;

      // Block LWC from processing pointer moves while we own the gesture.
      // Without this, LWC's per-pane scroll / price-scale drag can fire
      // during the CROSSHAIR/PENDING threshold window before we enter CHART_PAN.
      e.stopPropagation();

      // ── PINCH_ZOOM: we own the zoom via onTouchMove — nothing else to do ──
      if (g.mode === 'PINCH_ZOOM') return;

      // ── TIME_SCALE_DRAG: horizontal drag zooms the time axis ─────────────
      // Uses start-anchored exponential formula so the zoom is proportional
      // to total displacement from drag start — no per-frame drift.
      // Right edge (panMin) stays fixed; only left edge moves.
      // drag left → zoom out (more bars); drag right → zoom in (fewer bars).
      if (g.mode === 'TIME_SCALE_DRAG') {
        e.stopPropagation();
        e.preventDefault();
        if (g.panMin === null || g.panMax === null || g.panMax <= 0) return;
        const ch = chartRef.current;
        const w  = container.clientWidth;
        if (!ch || w <= 0) return;
        // Applied directly on every event — no RAF coalescing.
        // LWC batches canvas repaints to its internal RAF loop so calling
        // setVisibleLogicalRange on each pointermove is zero-overhead.
        // Exponential: full-width drag (w px) changes range by ~32× in either direction.
        const totalDx   = e.clientX - g.startX;
        const toEdge    = g.panMin;
        const startBars = g.panMax;
        const newBars   = startBars * Math.pow(2, totalDx / (w * 0.2));
        const safeBars  = Math.max(3, Math.min(500_000, newBars));
        try {
          ch.timeScale().setVisibleLogicalRange({ from: toEdge - safeBars, to: toEdge });
        } catch { /* ignore LWC range-clamp errors */ }
        return;
      }

      const now = performance.now();
      const dt  = now - g.lastT;
      const dx  = e.clientX - g.lastX;
      const dy  = e.clientY - g.lastY;
      g.lastX   = e.clientX;
      g.lastY   = e.clientY;
      g.lastT   = now;

      // Accumulate velocity while panning (used by kinetic coast on lift)
      if (g.isTouch && g.mode === 'CHART_PAN' && dt > 0) {
        g.velY = g.velY * 0.3 + (dy / dt) * 0.7;
      }

      // ── PENDING (touch long-press window) ────────────────────────────────
      // Finger moved past PAN_THRESHOLD before timer fired → cancel long-press.
      // If crosshairLocked: enter CROSSHAIR_DRAG (only crosshair moves, chart frozen).
      // Otherwise: enter CHART_PAN (normal pan, no crosshair).
      if (g.mode === 'PENDING') {
        const totalH = Math.abs(e.clientX - g.startX);
        const totalV = Math.abs(e.clientY - g.startY);
        if (Math.max(totalH, totalV) < PAN_THRESHOLD) return;
        if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (crosshairLocked && lockedCrosshairPixel) {
          // Save anchor so relative drag starts from where the crosshair is pinned.
          crosshairDragAnchor = {
            fingerX: e.clientX, fingerY: e.clientY,
            crossX:  lockedCrosshairPixel.x, crossY: lockedCrosshairPixel.y,
          };
        }
        g.mode = crosshairLocked ? 'CROSSHAIR_DRAG' : 'CHART_PAN';
      }

      // ── CROSSHAIR (mouse only): check pan threshold ───────────────────────
      if (g.mode === 'CROSSHAIR') {
        const totalH = Math.abs(e.clientX - g.startX);
        const totalV = Math.abs(e.clientY - g.startY);
        if (Math.max(totalH, totalV) < PAN_THRESHOLD) return;
        g.mode = 'CHART_PAN';
      }

      // ── CROSSHAIR_LOCKED / CROSSHAIR_DRAG: move crosshair only, no pan ───
      // Chart position must NOT change. We block LWC touch events via the
      // onTouchMove capture listener as well.
      if (g.mode === 'CROSSHAIR_LOCKED' || g.mode === 'CROSSHAIR_DRAG') {
        e.stopPropagation();
        e.preventDefault();

        // First frame of CROSSHAIR_LOCKED → CROSSHAIR_DRAG transition:
        // save the drag anchor so all subsequent frames apply relative offset
        // instead of snapping to the current finger position.
        if (g.mode === 'CROSSHAIR_LOCKED' && lockedCrosshairPixel) {
          crosshairDragAnchor = {
            fingerX: e.clientX, fingerY: e.clientY,
            crossX:  lockedCrosshairPixel.x, crossY: lockedCrosshairPixel.y,
          };
        }
        g.mode = 'CROSSHAIR_DRAG';

        const ch     = chartRef.current;
        const series = mainRef.current;
        if (ch && series) {
          try {
            const rect = container.getBoundingClientRect();

            // ── Relative positioning (TradingView-style) ─────────────────────
            // Compute pixel position from the crosshair's original location plus
            // the delta the finger has travelled, NOT from the raw finger position.
            // This prevents the crosshair from jumping when the drag starts.
            let x: number;
            let y: number;
            if (crosshairDragAnchor) {
              x = crosshairDragAnchor.crossX + (e.clientX - crosshairDragAnchor.fingerX);
              y = crosshairDragAnchor.crossY + (e.clientY - crosshairDragAnchor.fingerY);
              // Clamp to chart bounds so crosshair can't escape the container
              x = Math.max(0, Math.min(x, container.clientWidth  - 1));
              y = Math.max(0, Math.min(y, container.clientHeight - 1));
            } else {
              // Fallback (anchor not yet set — should not normally happen)
              x = e.clientX - rect.left;
              y = e.clientY - rect.top;
            }

            const time  = coordinateToTimeOrExtrapolate(ch, x);
            const price = series.coordinateToPrice(y);
            if (time !== null && price !== null) {
              lockedCrosshairPos   = { price: price as number, time };
              lockedCrosshairPixel = { x, y };
              const isFuture = ch.timeScale().coordinateToTime(x) === null;
              if (isFuture) {
                // Future (blank) area — canvas only. Clear LWC's crosshair so the
                // stale line from the last real-bar position doesn't ghost behind
                // the canvas draw, and LWC stops fighting the canvas at 60fps.
                try { ch.clearCrosshairPosition(); } catch { /* ok */ }
                lockedFutureCrossPixel = { x, y };
                drawCanvasCrosshair(x, y);
              } else {
                // Data area — clear canvas, let LWC own the crosshair
                lockedFutureCrossPixel = null;
                drawCanvasCrosshair(null, 0);
                ch.setCrosshairPosition(price as number, time, series);
              }
            }
          } catch { /* ok */ }
        }
        return; // no chart pan
      }

      // ── CHART_PAN mode: we own all transforms ─────────────────────────────
      // stopPropagation prevents LWC from seeing this event — no double
      // kineticScroll, no crosshair interference, no price-scale drift.
      e.stopPropagation();
      e.preventDefault();

      // ── Horizontal pan (mouse + touch) ────────────────────────────────────
      // Applied directly on every event — no RAF coalescing.
      // Dropping events (old approach: skip if hRafId pending) caused up to 5× less
      // movement applied per display frame, making the chart feel sluggish and laggy.
      if (dx !== 0) {
        // Disable autoScale on the first horizontal frame so LWC doesn't jump
        // the Y-axis to fit newly visible candles while the user scrolls left/right.
        // Only apply when vertical pan hasn't started — vertical pan re-enables it.
        if (!g.panActivated) {
          try { chartRef.current?.priceScale("right").applyOptions({ autoScale: false }); } catch { /* ok */ }
        }
        const ch = chartRef.current;
        const range = ch?.timeScale().getVisibleLogicalRange();
        if (ch && range) {
          const w = container.clientWidth;
          const barsVisible = (range.to as number) - (range.from as number);
          if (w > 0 && barsVisible > 0) {
            const pxPerBar = w / barsVisible;
            try {
              ch.timeScale().setVisibleLogicalRange({
                from: (range.from as number) - dx / pxPerBar,
                to:   (range.to   as number) - dx / pxPerBar,
              });
            } catch { /* chart disposed */ }
          }
        }
      }

      // ── Vertical pan (mouse + touch) ─────────────────────────────────────
      // Mouse: 360° drag works in chart area. Price-scale zone is excluded in
      // onDown because PriceScaleTouchHandler owns that gesture exclusively.
      if (dy === 0) return;

      // Lazy price-range snapshot on the first vertical pan frame.
      // coordinateToPrice(0/h) gives the SCREEN range (includes scaleMargins).
      // We invert the margin formula to avoid a jump on pan start:
      //   data_max = screen_max − TOP_MARGIN × span   (TOP_MARGIN  = 0.07)
      //   data_min = screen_min + BOT_MARGIN × span   (BOT_MARGIN  = 0.25)
      //
      // IMPORTANT: use the main pane height only (panes()[0].getHeight()), NOT
      // container.clientHeight. When indicator panes are present (WaveTrend, RSI…)
      // container.clientHeight includes ALL panes, so coordinateToPrice(fullHeight)
      // lands in an indicator pane where the main series has no coordinate — LWC
      // returns null there and vertical pan silently breaks.
      if (g.panMin === null) {
        const series = mainRef.current;
        const mainPaneH = (() => {
          try {
            const panes = chartRef.current?.panes();
            if (panes && panes.length > 0) return panes[0].getHeight();
          } catch { /* ok */ }
          return container.clientHeight;
        })();
        const h = mainPaneH || 1;
        if (series) {
          try {
            const sTop = series.coordinateToPrice(0) as number | null;
            const sBot = series.coordinateToPrice(h) as number | null;
            if (sTop !== null && sBot !== null && isFinite(sTop) && isFinite(sBot) && sTop !== sBot) {
              const sMax = Math.max(sTop, sBot);
              const sMin = Math.min(sTop, sBot);
              const span = sMax - sMin;
              g.panMax     = sMax - 0.07 * span;
              g.panMin     = sMin + 0.25 * span;
              g.pricePerPx = span / h;
            }
          } catch { /* series not ready */ }
        }
      }
      if (g.panMin === null || g.panMax === null || g.pricePerPx === null) return;

      // Screen Y grows downward; price grows upward.
      // Drag down (dy > 0) → shift range UP so candles follow the finger.
      const isFirstVertFrame = !g.panActivated;
      if (isFirstVertFrame) g.panActivated = true;

      const shift = dy * g.pricePerPx;
      g.panMin += shift;
      g.panMax += shift;
      const lo = g.panMin, hi = g.panMax;

      // Synchronize the shared pan-range module so ALL pane-0 series (candlestick
      // + EMA/SMA overlays) lock to the same range for LWC's price-scale union.
      // Without this, LWC unions the candlestick's locked range with EMA/SMA's
      // natural data range and the chart fights back, limiting vertical pan range.
      // First frame: notify subscribers → they install live autoscaleInfoProvider
      //   on each indicator series. Subsequent frames: silent update only — the
      //   per-frame applyOptions below triggers LWC to re-call all providers which
      //   then read the updated getPanRange() value.
      if (isFirstVertFrame) {
        // Re-enable autoScale so LWC calls our autoscaleInfoProvider.
        // The horizontal pan block may have disabled it — restore it now so the
        // vertical pan range is actually applied (autoScale:false = LWC ignores
        // autoscaleInfoProvider entirely).
        try { chartRef.current?.priceScale("right").applyOptions({ autoScale: true }); } catch { /* ok */ }
        activatePanRange({ lo, hi });
      } else {
        updatePanRange(lo, hi);
      }

      // Applied directly on every event — no RAF coalescing.
      // Each applyOptions call forces LWC to re-evaluate the price scale
      // and re-call all autoscaleInfoProviders with the latest pan range.
      const series = mainRef.current;
      if (series) {
        const curLo = lo, curHi = hi;
        try {
          series.applyOptions({
            autoscaleInfoProvider: () => ({ priceRange: { minValue: curLo, maxValue: curHi } }),
          });
        } catch { /* chart disposed */ }
      }
    };

    // ── pointerup / pointercancel ─────────────────────────────────────────────
    const onUp = (e: PointerEvent) => {
      pressCount = Math.max(0, pressCount - 1);
      // Clear interaction flag when all pointers are lifted
      if (pressCount === 0) {
        // Re-enable autoScale after interaction ends so LWC resumes normal auto-fitting
        try { chartRef.current?.priceScale("right").applyOptions({ autoScale: true }); } catch { /* ok */ }
      }

      const g = ig;
      if (!g || g.pointerId !== e.pointerId) return;

      // Let the pending horizontal-pan frame finish so the last finger movement
      // is not dropped when the user lifts their finger.
      if (g.vRafId !== null) cancelAnimationFrame(g.vRafId);
      // Release pointer capture for all modes — TIME_SCALE_DRAG and the main
      // chart path (CROSSHAIR / PENDING / CHART_PAN) both use setPointerCapture.
      try { container.releasePointerCapture(e.pointerId); } catch { /* ok */ }

      // TIME_SCALE_DRAG lift → clean up, no kinetic coast
      if (g.mode === 'TIME_SCALE_DRAG') {
        ig = null;
        return;
      }

      // ── PENDING lift: finger up before long-press fired → this was a tap ───
      // A tap on blank area dismisses the locked crosshair (if any).
      // A drag would have already transitioned to CHART_PAN, so reaching here
      // means the finger never moved past PAN_THRESHOLD — confirmed tap.
      if (g.mode === 'PENDING') {
        if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (crosshairLocked) {
          crosshairLocked = false;
          lockedCrosshairPos    = null;
          lockedFutureCrossPixel = null;
          lockedCrosshairPixel  = null;
          crosshairDragAnchor   = null;
          drawCanvasCrosshair(null, 0);
          try { chartRef.current?.clearCrosshairPosition(); } catch { /* ok */ }
        }
        ig = null;
        return;
      }

      // ── CROSSHAIR_LOCKED / CROSSHAIR_DRAG lift: keep crosshair pinned ─────
      // LWC's touchend fires BEFORE our pointerup and clears the crosshair.
      // Re-apply the last known position in the next animation frame so it
      // appears after LWC has finished its touchend cleanup.
      // When in the future area we use the canvas overlay instead of LWC.
      if (g.mode === 'CROSSHAIR_LOCKED' || g.mode === 'CROSSHAIR_DRAG') {
        crosshairLocked = true;
        ig = null;
        const pos    = lockedCrosshairPos;
        const futPx  = lockedFutureCrossPixel;
        if (futPx) {
          // Future area: LWC clears its crosshair on touchend → redraw canvas
          requestAnimationFrame(() => {
            if (!crosshairLocked) return;
            drawCanvasCrosshair(futPx.x, futPx.y);
          });
        } else if (pos) {
          requestAnimationFrame(() => {
            if (!crosshairLocked || !pos) return;
            const ch     = chartRef.current;
            const series = mainRef.current;
            if (!ch || !series) return;
            try { ch.setCrosshairPosition(pos.price, pos.time, series); } catch { /* ok */ }
          });
        }
        return;
      }

      // ── CROSSHAIR (mouse tap) or PINCH_ZOOM lift → just reset ────────────
      if (g.mode !== 'CHART_PAN') {
        ig = null;
        return;
      }

      // Mouse lift after vertical pan: restore autoscale immediately (no kinetic coast)
      if (!g.isTouch) {
        if (g.panMin !== null) {
          // Re-enable LWC autoscale — () => null clears the locked range (undefined does not)
          try { mainRef.current?.applyOptions({ autoscaleInfoProvider: () => null }); } catch { /* ok */ }
          // Notify indicator series to restore their autoscale too
          activatePanRange(null);
        }
        ig = null;
        return;
      }

      // Touch CHART_PAN lift: LWC's touchend fires before our pointerup and
      // clears the crosshair. Re-apply the locked position in the next frame.
      // If the locked position is in the future area, redraw the canvas instead.
      if (crosshairLocked) {
        const futPx = lockedFutureCrossPixel;
        const pos   = lockedCrosshairPos;
        if (futPx) {
          requestAnimationFrame(() => {
            if (!crosshairLocked) return;
            drawCanvasCrosshair(futPx.x, futPx.y);
          });
        } else if (pos) {
          requestAnimationFrame(() => {
            if (!crosshairLocked || !pos) return;
            const ch = chartRef.current;
            const s  = mainRef.current;
            if (!ch || !s) return;
            try { ch.setCrosshairPosition(pos.price, pos.time, s); } catch { /* ok */ }
          });
        }
      }

      // Touch with no vertical pan data → no coast needed
      if (g.panMin === null || g.pricePerPx === null) { ig = null; return; }

      // ── Vertical kinetic momentum ─────────────────────────────────────────
      // Convert smoothed velocity (px/ms) → px/frame at ~60 fps, then coast
      // with an exponential friction factor until velocity drops to noise level.
      const FRICTION = 0.88;
      const MIN_PX   = 0.12;
      let vel  = g.velY * 16.67;
      let pMin = g.panMin!;
      let pMax = g.panMax!;
      const ppp = g.pricePerPx!;
      ig = null; // release so new touches work immediately during coast

      const series = mainRef.current;
      const coast = () => {
        if (Math.abs(vel) < MIN_PX) {
          momentumRaf = null;
          // Coast ended — restore autoscale on main series and notify indicator series
          try { series?.applyOptions({ autoscaleInfoProvider: () => null }); } catch { /* ok */ }
          activatePanRange(null);
          return;
        }
        const s = vel * ppp;
        pMin += s; pMax += s;
        const lo = pMin, hi = pMax;
        updatePanRange(lo, hi); // keep shared state in sync for indicator providers
        try {
          series?.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: lo, maxValue: hi } }) });
        } catch { momentumRaf = null; activatePanRange(null); return; }
        vel *= FRICTION;
        momentumRaf = requestAnimationFrame(coast);
      };
      if (Math.abs(vel) > 0.5 && series) {
        momentumRaf = requestAnimationFrame(coast);
      } else {
        // Velocity too low (or no series) — no coast, clear pan state immediately
        try { series?.applyOptions({ autoscaleInfoProvider: () => null }); } catch { /* ok */ }
        activatePanRange(null);
      }
    };

    // Prevent browser native drag (text selection, image drag) from firing
    // dragstart mid-pan → which drops pointer capture → stuck pan state.
    const preventDragStart = (e: DragEvent) => e.preventDefault();

    // ── Wheel interceptor ────────────────────────────────────────────────────
    // ROOT CAUSE: handleScroll.mouseWheel is now false (LWC cannot horizontal-pan via
    // wheel deltaX), but we still want intentional trackpad horizontal swipes to pan.
    // Intercept all wheel events in capture phase:
    //   • |deltaX| dominant → we apply horizontal pan via setVisibleLogicalRange
    //   • |deltaY| dominant → let LWC handle for zoom (handleScale.mouseWheel: true)
    let wheelRaf = 0;
    const onWheel = (e: WheelEvent) => {
      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);

      if (absX > absY && absX > 1) {
        // Horizontal trackpad swipe — pan ourselves, block LWC entirely
        e.preventDefault();
        e.stopPropagation();
        cancelAnimationFrame(wheelRaf);
        wheelRaf = requestAnimationFrame(() => {
          const ch = chartRef.current;
          if (!ch) return;
          try {
            const range = ch.timeScale().getVisibleLogicalRange();
            if (!range) return;
            const w = container.clientWidth;
            const barsVisible = (range.to as number) - (range.from as number);
            if (w <= 0 || barsVisible <= 0) return;
            const pxPerBar = w / barsVisible;
            const delta = e.deltaX / pxPerBar;
            ch.timeScale().setVisibleLogicalRange({
              from: (range.from as number) + delta,
              to:   (range.to   as number) + delta,
            });
          } catch { /* ignore range-clamp errors */ }
        });
      }
      // Vertical wheel: fall through to LWC for zoom
    };

    // ── Helper: apply pinch zoom from a TouchEvent with 2+ touches ──────────
    // Uses an INCREMENTAL approach: each frame compares the current finger span
    // to the PREVIOUS frame's span and applies the delta ratio to the current
    // visible range. This avoids reference-frame drift from the start-anchored
    // approach and feels native on both iOS and Android.
    // The anchor is the current midpoint between the two fingers (in logical bar
    // space), recomputed each frame so zoom follows the user's hands naturally.
    const applyPinchZoom = (t0: Touch, t1: Touch) => {
      if (!ig || ig.mode !== 'PINCH_ZOOM') return;

      // Use Euclidean distance so vertically-aligned same-hand fingers
      // (near-zero X delta but large Y delta) still produce a valid span.
      const span = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      if (span < 1) return; // ignore true degenerate overlap only

      // ── First call: seed prevSpan, nothing to compare yet ────────────────
      if (ig.pinchPrevSpan === null) {
        ig.pinchPrevSpan = span;
        return;
      }

      const prevSpan = ig.pinchPrevSpan;
      ig.pinchPrevSpan = span; // always update for next frame

      if (prevSpan === span) return; // no change this frame

      const ch = chartRef.current;
      const range = ch?.timeScale().getVisibleLogicalRange();
      if (!ch || !range) return;

      // ── Incremental zoom ratio ────────────────────────────────────────────
      // prevSpan / span > 1 → fingers spread → zoom IN (fewer bars)
      // prevSpan / span < 1 → fingers pinched → zoom OUT (more bars)
      const currentBars = (range.to as number) - (range.from as number);
      const ratio       = prevSpan / span;
      const newBars     = Math.max(3, Math.min(500_000, currentBars * ratio));

      // ── Zoom limit guard ─────────────────────────────────────────────────
      // If newBars equals currentBars the clamp absorbed the entire gesture
      // (already at min or max zoom). Skip setVisibleLogicalRange completely —
      // even though newBars didn't change, the anchor-midpoint calculation
      // below can produce a slightly different newFrom, which manifests as
      // unwanted horizontal drift when pinching at the zoom boundary.
      if (newBars === currentBars) return;

      // ── Anchor: live midpoint of the two fingers in logical bar space ─────
      const rect   = container.getBoundingClientRect();
      const midX   = ((t0.clientX + t1.clientX) / 2) - rect.left;
      const anchor = ch.timeScale().coordinateToLogical(midX)
                     ?? (((range.from as number) + (range.to as number)) / 2);

      const leftFrac = (anchor - (range.from as number)) / currentBars;
      const newFrom  = anchor - newBars * leftFrac;
      const newTo    = newFrom + newBars;
      try {
        ch.timeScale().setVisibleLogicalRange({ from: newFrom, to: newTo });
      } catch { /* ignore range-clamp errors */ }
    };

    // ── touchstart capture — detect 2nd finger on iOS ────────────────────────
    // iOS Safari does NOT reliably fire a second pointerdown for multi-touch.
    // The pointerdown-based pressCount++ therefore never reaches 2 on iOS, so
    // PINCH_ZOOM mode is never entered via the pointer path. We fix this by
    // listening to touchstart in capture phase: whenever e.touches.length >= 2
    // we force-enter PINCH_ZOOM, cancelling any single-finger gesture state.
    const onTouchStart = (e: TouchEvent) => {
      touchCount = e.touches.length; // always track ground-truth touch count
      if (e.touches.length < 2) return;

      // Two or more fingers on screen — enter PINCH_ZOOM regardless of whether
      // the pointerdown path already did it.  If already PINCH_ZOOM just reset
      // the start state so the new finger layout is used as the new reference.
      if (ig && ig.mode === 'PINCH_ZOOM') {
        // Reset prevSpan so applyPinchZoom re-seeds from fresh touch coords
        ig.pinchPrevSpan = null;
        return;
      }

      // Cancel any running single-finger gesture (PENDING, CHART_PAN, etc.)
      const firstPointerId = ig?.pointerId;
      cancelIg();
      // Do NOT modify pressCount here. pressCount is owned exclusively by pointer
      // events (pointerdown → ++, pointerup/cancel → --). onTouchStart is a touch
      // event; if we also set pressCount here the subsequent pointerdown for the
      // second finger increments it again, causing a persistent +1 drift that
      // makes single-finger drags falsely enter PINCH_ZOOM after every pinch.
      // The onDown fast-path below handles the second pointerdown correctly.
      if (firstPointerId !== undefined) {
        try { container.releasePointerCapture(firstPointerId); } catch { /* ok */ }
      }

      ig = {
        mode: 'PINCH_ZOOM', pointerId: -1, // no single tracking ID; we use e.touches
        startX: 0, startY: 0, lastX: 0, lastY: 0,
        lastT: performance.now(), isTouch: true,
        velY: 0, hRafId: null, vRafId: null,
        panMin: null, panMax: null, pricePerPx: null, panActivated: false,
        pinchPrevSpan: null,
          hPendingDx: 0,
      };
    };

    // ── touchend capture — clean up PINCH_ZOOM when fingers lift ─────────────
    // When the user lifts all fingers after a pinch, reset ig so single-finger
    // gestures can start fresh on the next touch.
    //
    // NOTE: do NOT set pressCount here. The corresponding pointer event (pointerup
    // or pointercancel → onUp) fires immediately after touchend and does
    // pressCount-- correctly. Manually setting pressCount here causes an
    // off-by-one: e.g. when going 2→1 fingers, setting pressCount=1 here then
    // onUp decrements to 0 — making the remaining finger invisible to the
    // pointer-event path and breaking any subsequent single-finger pan.
    const onTouchEnd = (e: TouchEvent) => {
      touchCount = e.touches.length; // always track ground-truth touch count
      if (ig?.mode !== 'PINCH_ZOOM') return;
      if (e.touches.length <= 1) {
        // All or all-but-one fingers lifted — clear pinch state.
        // onUp (pointer event) will decrement pressCount for the lifted finger.
        ig = null;
      }
    };

    // ── touchcancel capture — OS-level gesture interruption ───────────────────
    // touchcancel fires when the OS takes over the touch (orientation change,
    // home-button swipe, incoming call, notification banner). It is distinct
    // from touchend: no corresponding pointerup may ever arrive (iOS drops it
    // during rotation). We therefore do a FULL gesture reset here rather than
    // relying on the pointer-event path.
    //
    // When ALL touches are gone (e.touches.length === 0), reset every piece of
    // mutable state — same as onPageHide but also handles partial cancels.
    // If pointercancel does arrive afterward, onUp safely no-ops because
    // pressCount is already 0 and ig is null.
    //
    // NOTE: do NOT use this path for touchend (normal lift). onTouchEnd handles
    // PINCH_ZOOM cleanup; normal single-finger lift is handled by onUp.
    const onTouchCancel = (e: TouchEvent) => {
      touchCount = e.touches.length;
      if (e.touches.length === 0) {
        // All touches cancelled — full reset. cancelIg() now also releases
        // pointer capture, so no stale capture survives to the next gesture.
        cancelIg();
        pressCount = 0;
        if (momentumRaf !== null) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
        activatePanRange(null);
        // Clear crosshair lock — locked pixel coords are meaningless in the
        // new layout that follows an orientation change.
        if (crosshairLocked) {
          crosshairLocked        = false;
          lockedCrosshairPos     = null;
          lockedFutureCrossPixel = null;
          lockedCrosshairPixel   = null;
          crosshairDragAnchor    = null;
          try { chartRef.current?.clearCrosshairPosition(); } catch { /* ok */ }
          drawCanvasCrosshair(null, 0);
        }
      } else if (ig?.mode === 'PINCH_ZOOM') {
        // Partial cancel (some fingers remain): same logic as onTouchEnd
        ig = null;
        // Sync pressCount to the remaining touch count so the next gesture
        // doesn't start with a stale elevated count and falsely enter PINCH_ZOOM.
        pressCount = e.touches.length;
      }
    };

    // ── touchmove capture — custom pinch zoom + block LWC during pan ─────────
    // LWC uses TOUCH events (not pointer events) internally. Our pointer-event
    // stopPropagation has zero effect on LWC's touchmove handler, which keeps
    // repositioning the crosshair even while we own CHART_PAN. This capture-
    // phase touchmove listener fires before LWC's child-element listener.
    //
    // PINCH_ZOOM: custom implementation using e.touches[] — always reflects
    // all active touches regardless of pointer capture or iOS quirks.
    const onTouchMove = (e: TouchEvent) => {
      // ── Two-finger pinch: enter PINCH_ZOOM if we aren't already ──────────
      // Fallback for iOS where the second pointerdown may never fire.
      if (e.touches.length >= 2) {
        if (!ig || ig.mode !== 'PINCH_ZOOM') {
          // Transition any existing single-finger state to PINCH_ZOOM
          const firstPointerId = ig?.pointerId;
          cancelIg();
          pressCount = e.touches.length;
          if (firstPointerId !== undefined && firstPointerId >= 0) {
            try { container.releasePointerCapture(firstPointerId); } catch { /* ok */ }
          }
          ig = {
            mode: 'PINCH_ZOOM', pointerId: -1,
            startX: 0, startY: 0, lastX: 0, lastY: 0,
            lastT: performance.now(), isTouch: true,
            velY: 0, hRafId: null, vRafId: null,
            panMin: null, panMax: null, pricePerPx: null, panActivated: false,
            pinchPrevSpan: null,
          hPendingDx: 0,
          };
        }
        // Block LWC from double-handling, then apply our zoom
        e.stopPropagation();
        applyPinchZoom(e.touches[0], e.touches[1]);
        return;
      }

      if (!ig) return;

      if (ig.mode === 'CHART_PAN') {
        e.stopPropagation();
        // Only clear the crosshair if there is no locked crosshair to preserve.
        // When crosshairLocked is true the user is panning while a crosshair is
        // pinned — it should stay visible at its locked bar throughout the pan.
        if (!crosshairLocked) {
          try { chartRef.current?.clearCrosshairPosition(); } catch { /* ok */ }
        }
      } else if (ig.mode === 'CROSSHAIR_LOCKED' || ig.mode === 'CROSSHAIR_DRAG') {
        e.stopPropagation(); // prevent LWC from panning the chart
      } else if (ig.mode === 'PENDING') {
        // Block LWC from scrolling/panning during the long-press window.
        // Without this LWC's own touchmove handler can move the chart while
        // we're still deciding between CHART_PAN and CROSSHAIR_LOCKED,
        // causing the chart position to jump when we finally take over.
        e.stopPropagation();
      }
    };

    // ── Page-hide / focus-loss recovery ──────────────────────────────────────
    // OS interruptions (home swipe, notification, app switch, incoming call) can
    // consume the pointer without delivering pointerup/cancel to our handler.
    // Reset all gesture state so the next touch starts completely fresh.
    const onPageHide = () => {
      cancelIg();
      pressCount = 0;
      touchCount = 0;
      if (momentumRaf !== null) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
    };
    window.addEventListener('blur',               onPageHide);
    document.addEventListener('visibilitychange', onPageHide);

    // ── Orientation-change / resize full recovery ─────────────────────────────
    // ROOT CAUSE of "chart stuck after rotation":
    //
    //   1. iOS does NOT reliably fire pointercancel during orientation change,
    //      so ig / pressCount / touchCount can remain set from the pre-rotation
    //      session. The next pointerdown enters the stale-state guard but the
    //      guard only fires when ig.pointerId ≠ new pointerId — on some OS versions
    //      the pointer ID is recycled and the guard silently skips.
    //
    //   2. We stopPropagation touchmove during CHART_PAN, so LWC receives touchstart
    //      but never the matching touchcancel. LWC's internal "touch active" flag
    //      stays set and its internal pane-interaction state machine is stuck.
    //
    //   3. chart.applyOptions({width,height}) fires async via ResizeObserver. Until
    //      that callback runs, LWC's internal canvas coordinate system is the
    //      pre-rotation size. Touches fall in the wrong internal zones (e.g. the
    //      new bottom 35px maps to the old middle of the chart).
    //
    // Fix: intercept orientationchange AND resize INSIDE this closure (where both
    // the gesture state variables and chartRef live). Immediately reset every
    // piece of mutable state to IDLE and force LWC to update its coordinate
    // system with three resize passes (covers fast reflows + slow CSS transitions).
    //
    // This runs in addition to the measureRobust() in useEffect([chartCtx]) which
    // handles the price-scale DOM measurement — both are needed.
    const resetAllGestureState = () => {
      // Release crosshair lock BEFORE cancelIg so drawCanvasCrosshair uses fresh
      // state (cancelling ig does not touch crosshairLocked / lockedCrosshair*).
      if (crosshairLocked) {
        crosshairLocked         = false;
        lockedCrosshairPos      = null;
        lockedFutureCrossPixel  = null;
        lockedCrosshairPixel    = null;
        crosshairDragAnchor     = null;
        try { chartRef.current?.clearCrosshairPosition(); } catch { /* ok */ }
        drawCanvasCrosshair(null, 0);
      }
      cancelIg();          // clears ig, longPressTimer, hRafId, vRafId
      pressCount = 0;
      touchCount = 0;
      if (momentumRaf !== null) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
      activatePanRange(null); // clear any locked vertical pan range
    };

    const resizeLwcNow = () => {
      if (chartDisposed) return;
      const ch = chartRef.current;
      const ct = containerRef.current;
      if (!ch || !ct) return;
      const w = ct.clientWidth;
      const h = ct.clientHeight;
      if (w > 0 && h > 0) {
        try { ch.applyOptions({ width: w, height: h }); } catch { /* ok */ }
      }
      // Re-applying handleScroll/handleScale/kineticScroll forces LWC to
      // tear down and re-register its internal touch/pointer event handlers
      // with a fresh state — clearing any stuck "pressed/panning" flag in
      // LWC's internal pane interaction state machine.
      try {
        ch.applyOptions({
          handleScroll:  { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
          handleScale:   { mouseWheel: true,  pinch: false, axisPressedMouseMove: { time: false, price: false }, axisDoubleClickReset: { time: true, price: true } },
          kineticScroll: { mouse: false, touch: false },
        });
      } catch { /* ok — chart may have been disposed between the two calls */ }
    };

    const onOrientationReset = () => {
      resetAllGestureState();
      // Four-pass resize so LWC's coordinate system is correct regardless of
      // how long the browser's orientation animation takes:
      //   pass 1 — immediate (catches instantaneous reflow on Android Chrome)
      //   pass 2 — next animation frame (post-paint; LWC DOM settled)
      //   pass 3 — 300 ms safety (iOS rotation animation ~250 ms)
      //   pass 4 — 500 ms belt-and-suspenders for very slow devices
      resizeLwcNow();
      requestAnimationFrame(resizeLwcNow);
      setTimeout(resizeLwcNow, 300);
      setTimeout(resizeLwcNow, 500);
    };
    // IMPORTANT: only orientationchange triggers gesture state reset.
    // window 'resize' fires for soft-keyboard show/hide, browser-chrome
    // animation, and DevTools open/close — resetting gesture state on those
    // would interrupt live touch gestures unrelated to rotation.
    // LWC canvas resizing on all resizes is already handled by the
    // ResizeObserver registered above (line: ro.observe(container)).
    window.addEventListener('orientationchange', onOrientationReset);

    // ── DEV diagnostics — event trace for interaction debugging ──────────────
    // Logs the 6 key events with gesture state snapshots so stuck-state bugs
    // can be reproduced from console output. Compiled away in production.
    let diagEnabled = import.meta.env.DEV;
    const diagLog = (label: string, extra?: Record<string, unknown>) => {
      if (!diagEnabled) return;
      console.debug(`[chart-diag] ${label}`, {
        ig:         ig ? `${ig.mode}/${ig.pointerId}` : 'null',
        pressCount,
        touchCount,
        momentum:   momentumRaf !== null,
        locked:     crosshairLocked,
        ...extra,
      });
    };
    // Window-level listeners so we catch events that never reach the container
    // (e.g. after pointer capture is released, or during rotation).
    const diagPointerDown   = (e: PointerEvent) => diagLog('pointerdown',   { pid: e.pointerId, type: e.pointerType, x: Math.round(e.clientX), y: Math.round(e.clientY) });
    const diagPointerUp     = (e: PointerEvent) => diagLog('pointerup',     { pid: e.pointerId });
    const diagPointerCancel = (e: PointerEvent) => diagLog('pointercancel', { pid: e.pointerId });
    const diagTouchStart    = (e: TouchEvent)   => diagLog('touchstart',    { touches: e.touches.length });
    const diagTouchEnd      = (e: TouchEvent)   => diagLog('touchend',      { touches: e.touches.length });
    const diagTouchCancel   = (e: TouchEvent)   => diagLog('touchcancel',   { touches: e.touches.length });
    if (diagEnabled) {
      window.addEventListener('pointerdown',   diagPointerDown,   { capture: true, passive: true });
      window.addEventListener('pointerup',     diagPointerUp,     { capture: true, passive: true });
      window.addEventListener('pointercancel', diagPointerCancel, { capture: true, passive: true });
      window.addEventListener('touchstart',    diagTouchStart,    { capture: true, passive: true });
      window.addEventListener('touchend',      diagTouchEnd,      { capture: true, passive: true });
      window.addEventListener('touchcancel',   diagTouchCancel,   { capture: true, passive: true });
    }

    container.addEventListener('pointerdown',   onDown,          { capture: true });
    container.addEventListener('pointermove',   onMove,          { capture: true });
    container.addEventListener('pointerup',     onUp,            { capture: true });
    container.addEventListener('pointercancel', onUp,            { capture: true });
    container.addEventListener('touchstart',    onTouchStart,    { capture: true, passive: true });
    container.addEventListener('touchmove',     onTouchMove,     { capture: true, passive: true });
    container.addEventListener('touchend',      onTouchEnd,      { capture: true, passive: true });
    container.addEventListener('touchcancel',   onTouchCancel,   { capture: true, passive: true });
    container.addEventListener('dragstart',     preventDragStart);
    container.addEventListener('wheel',         onWheel,         { capture: true, passive: false });

    return () => {
      mountedRef.current = false;
      ro.disconnect();
      if (momentumRaf !== null) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
      cancelAnimationFrame(wheelRaf);
      cancelIg();
      window.removeEventListener('blur',               onPageHide);
      document.removeEventListener('visibilitychange', onPageHide);
      window.removeEventListener('orientationchange', onOrientationReset);
      if (diagEnabled) {
        window.removeEventListener('pointerdown',   diagPointerDown,   { capture: true });
        window.removeEventListener('pointerup',     diagPointerUp,     { capture: true });
        window.removeEventListener('pointercancel', diagPointerCancel, { capture: true });
        window.removeEventListener('touchstart',    diagTouchStart,    { capture: true });
        window.removeEventListener('touchend',      diagTouchEnd,      { capture: true });
        window.removeEventListener('touchcancel',   diagTouchCancel,   { capture: true });
        diagEnabled = false;
      }
      activatePanRange(null); // clear any locked range so indicator series restore auto-scale
      // Flush any pending viewport save before chart is torn down
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      unsubPanVp();
      if (vpSaveTimerRef.current) {
        clearTimeout(vpSaveTimerRef.current);
        vpSaveTimerRef.current = null;
        doSaveVp(); // flush final state synchronously
      }
      container.removeEventListener('mouseleave',    onMouseLeave);
      container.removeEventListener('pointerdown',   onDown,          { capture: true });
      container.removeEventListener('pointermove',   onMove,          { capture: true });
      container.removeEventListener('pointerup',     onUp,            { capture: true });
      container.removeEventListener('pointercancel', onUp,            { capture: true });
      container.removeEventListener('touchstart',    onTouchStart,    { capture: true });
      container.removeEventListener('touchmove',     onTouchMove,     { capture: true });
      container.removeEventListener('touchend',      onTouchEnd,      { capture: true });
      container.removeEventListener('touchcancel',   onTouchCancel,   { capture: true });
      container.removeEventListener('dragstart',     preventDragStart);
      container.removeEventListener('wheel',         onWheel,         { capture: true });
      // Set flag before removal so any already-queued ro callbacks bail immediately
      chartDisposed = true;
      try { chart.remove(); } catch { /* already disposed (HMR double-unmount) */ }
      chartRef.current  = null;
      mainRef.current   = null;
      emaRefs.current   = {};
      priceLineRef.current = null;
      resetCrosshair();
      setChartCtx(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live-update price line color when settings change ─────────────────────
  useEffect(() => {
    const pl = priceLineRef.current;
    if (!pl) return;
    try { pl.applyOptions({ color: settings?.priceLabelLineColor ?? "rgba(255,255,255,0.4)" }); } catch { /* disposed */ }
  }, [settings?.priceLabelLineColor]);

  // ── tj:chart-reset — fit all bars when the ⋯ menu "Reset Chart" is tapped ──
  useEffect(() => {
    const onReset = () => {
      try { chartRef.current?.timeScale().fitContent(); } catch { /* disposed */ }
    };
    window.addEventListener("tj:chart-reset", onReset);
    return () => window.removeEventListener("tj:chart-reset", onReset);
  }, []);

  // ── Measure actual LWC price scale width from DOM ─────────────────────────
  // LWC v5 renders a <table>; the last <td> in the first <tr> is the right price scale.
  // priceScaleWRef is written first (zero React overhead) so the LivePriceBox RAF loop
  // can use the fresh width on the very next frame. setPriceScaleW keeps React state in
  // sync for PriceScaleTouchHandler (which needs the value as a prop).
  //
  // Resize / orientation-change strategy:
  //   - ResizeObserver is deferred one rAF frame so LWC finishes its DOM layout pass
  //     before we read offsetWidth (reading synchronously returns stale values).
  //   - window 'resize' fires after the actual layout change; we measure immediately
  //     AND schedule a 250 ms safety pass for slow/animated orientation transitions.
  //   - window 'orientationchange' fires BEFORE the resize; the setTimeout(300) ensures
  //     we still catch the final layout once the rotation animation has settled.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !chartCtx) return;

    const measure = () => {
      const td = container.querySelector('table tr:first-child td:last-child') as HTMLElement | null;
      const w = td?.offsetWidth;
      if (w && w > 20) {
        priceScaleWRef.current = w;   // instant — no React cycle
        setPriceScaleW(w);            // keeps PriceScaleTouchHandler in sync
      }
    };

    // One-rAF deferral: waits for LWC DOM layout to finish before reading offsetWidth
    const measureDeferred = () => requestAnimationFrame(measure);

    // Robust multi-pass: immediate + after-paint + safety timeout for orientation
    const measureRobust = () => {
      measure();
      requestAnimationFrame(measure);
      setTimeout(measure, 300);
    };

    measure();
    const t = setTimeout(measure, 120); // belt-and-suspenders for initial mount

    // Defer ResizeObserver so LWC finishes its layout before we sample offsetWidth
    const ro = new ResizeObserver(measureDeferred);
    ro.observe(container);

    // Capture orientation change and generic window resize
    window.addEventListener('resize',            measureRobust);
    window.addEventListener('orientationchange', measureRobust);

    return () => {
      clearTimeout(t);
      ro.disconnect();
      window.removeEventListener('resize',            measureRobust);
      window.removeEventListener('orientationchange', measureRobust);
    };
  }, [chartCtx]);

  // ── Swap main series when chartType changes (skip initial mount) ──────────
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    const chart = chartRef.current;
    const old   = mainRef.current;
    if (!chart || !old) return;

    // Remove old price line before removing series
    priceLineRef.current = null;
    chart.removeSeries(old);

    const newS = makeSeries(chart, chartType, settings);
    mainRef.current = newS;

    // Load data onto the new series BEFORE updating context.
    // Mirrors the invariant in loadCandles: setChartCtx is always called AFTER
    // applyBars so DrawingOverlay never receives an empty series.
    // Calling setChartCtx first would cause priceToCoordinate() to return null
    // on every drawing point for one render frame, collapsing position tools.
    const rawBars = barsRef.current;
    // Defensive sort: barsRef is normally ascending-sorted, but a stale
    // candle_update could push an out-of-order bar if the WS sends a late
    // revision.  Sort once here to prevent LWC's "data must be asc ordered"
    // assertion from crashing the chart on type switches.
    const bars = rawBars.length > 1 ? [...rawBars].sort((a, b) => a.time - b.time) : rawBars;
    if (bars.length > 0) {
      // Snapshot current viewport BEFORE applyBars so we can restore it after —
      // do NOT call fitContent() which would zoom all the way out (losing the user's zoom).
      const savedRange = chart.timeScale().getVisibleLogicalRange();
      applyBars(newS, chartType, bars);
      // Re-apply priceFormat on the new series (makeSeries creates without it)
      const lastClose = bars[bars.length - 1]?.close ?? 1;
      const fmt = pricePrecision(lastClose);
      try { newS.applyOptions({ priceFormat: { type: 'price', precision: fmt.precision, minMove: fmt.minMove } }); } catch { }
      // Restore viewport; fall back to TradingView default if no saved range
      if (savedRange) {
        try { chart.timeScale().setVisibleLogicalRange(savedRange); } catch { /* ok */ }
      } else {
        const lastIdx = bars.length - 1;
        try {
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, lastIdx - DEFAULT_VISIBLE_BARS + 1),
            to:   lastIdx + MIN_FUTURE_BARS,
          });
        } catch { /* ok */ }
      }
      const last = bars[bars.length - 1];
      if (last) {
        livePxRef.current = last.close;
        setLivePrice(last.close);
        setLiveOpen(last.open);
        doUpdatePriceLine(last.close, symRef.current, newS);
      }
    }

    // Update context AFTER series has data — coordinate APIs now return valid values
    setChartCtx({ chart, candle: newS });
  }, [chartType]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync indicator series when indicators toggle ──────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const keys: (keyof IndicatorState)[] = ["ema9", "ema21", "ema50", "ema200", "vwap"];
    const bars = barsRef.current;
    for (const key of keys) {
      const enabled  = indicators[key];
      const existing = emaRefs.current[key];
      if (enabled && !existing) {
        const s = chart.addSeries(LineSeries, {
          color: EMA_COLORS[key], lineWidth: 1,
          priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false,
        });
        emaRefs.current[key] = s;
        fillIndicator(s, key, bars);
      } else if (!enabled && existing) {
        chart.removeSeries(existing);
        delete emaRefs.current[key];
      }
    }
  }, [indicators, fillIndicator]);

  // ── Load candles from API ─────────────────────────────────────────────────
  // ── Apply a bar array to the chart (shared by cache-hit and fetch-success) ──
  // Extracted here so loadCandles can call it twice: once for cached bars
  // (instant) and once for fresh server bars (background update).
  const applyBarArray = useCallback((
    bars: OHLCBar[],
    sym:  string,
    iv:   string,
  ) => {
    // Ensure bars are sorted + deduped before storing — guards cache-hit path
    // which returns bars directly without re-sorting.
    const safeBars = safeSortDedup(bars);
    if (safeBars.length !== bars.length) {
      console.warn(`[Chart] applyBarArray(${sym}/${iv}): removed ${bars.length - safeBars.length} duplicate(s), ${safeBars.length} bars remaining`);
    }

    // Cancel any pending tick bar from the PREVIOUS symbol before we tear down
    // the series. Without this, a queued RAF from the old symbol fires on the
    // new series with an out-of-order timestamp → LWC assertion crash.
    pendingChartBarRef.current = null;
    if (chartUpdateRafRef.current !== null) {
      cancelAnimationFrame(chartUpdateRafRef.current);
      chartUpdateRafRef.current = null;
    }

    barsRef.current = safeBars;

    // Reset infinite-history state for this new symbol/interval
    oldestBarTimeRef.current  = safeBars[0]?.time ?? null;
    hasMoreHistoryRef.current = true;
    isLoadingMoreRef.current  = false;

    const oldSeries = mainRef.current;
    const chart     = chartRef.current;
    if (!oldSeries || !chart) return;

    priceLineRef.current = null;
    try { chart.removeSeries(oldSeries); } catch { /* HMR double-unmount */ }

    const cs = makeSeries(chart, ctRef.current, settings);
    mainRef.current = cs;

    try {
      chart.priceScale("right").applyOptions({
        scaleMargins: { top: 0.07, bottom: 0.25 },
        autoScale:    true,
      });
    } catch { }

    applyBars(cs, ctRef.current, safeBars);

    const lastClose = safeBars[safeBars.length - 1]?.close ?? 1;
    const fmt       = pricePrecision(lastClose);
    try { cs.applyOptions({ priceFormat: { type: 'price', precision: fmt.precision, minMove: fmt.minMove } }); } catch { }

    const last = safeBars[safeBars.length - 1];
    if (last) {
      livePxRef.current = last.close;
      tickDataRef.current = { price: last.close, open: last.open };
      setLivePrice(last.close);
      setLiveOpen(last.open);
      doUpdatePriceLine(last.close, sym, cs);
      if (tradeAggRef.current) tradeAggRef.current.seed(last);
    }

    for (const [key, s] of Object.entries(emaRefs.current) as [keyof IndicatorState, ISeriesApi<"Line">][]) {
      fillIndicator(s, key, safeBars);
    }

    activatePanRange(null);

    const lastBarIdx = safeBars.length - 1;
    const vpKey      = `tv_vp_v2_${sym}_${iv}`;
    const defaultRange = {
      from: Math.max(0, lastBarIdx - DEFAULT_VISIBLE_BARS + 1),
      to:   lastBarIdx + MIN_FUTURE_BARS,
    };
    try {
      const saved = JSON.parse(localStorage.getItem(vpKey) ?? "null") as
        { from: number; to: number; priceMin?: number; priceMax?: number } | null;
      if (saved && typeof saved.from === "number" && typeof saved.to === "number") {
        const wasNearRealtime = saved.to >= lastBarIdx - 5;
        if (wasNearRealtime) {
          const savedWidth   = saved.to - saved.from;
          const adjustedTo   = lastBarIdx + MIN_FUTURE_BARS;
          const adjustedFrom = adjustedTo - savedWidth;
          chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, adjustedFrom), to: adjustedTo });
        } else {
          const savedAge = lastBarIdx - saved.to;
          if (savedAge > DEFAULT_VISIBLE_BARS * 3) {
            chart.timeScale().setVisibleLogicalRange(defaultRange);
          } else {
            chart.timeScale().setVisibleLogicalRange({ from: saved.from, to: saved.to });
          }
        }
        if (typeof saved.priceMin === "number" && typeof saved.priceMax === "number") {
          activatePanRange({ lo: saved.priceMin, hi: saved.priceMax });
          cs.applyOptions({
            autoscaleInfoProvider: () => ({
              priceRange: { minValue: saved.priceMin!, maxValue: saved.priceMax! },
            }),
          });
        }
      } else {
        chart.timeScale().setVisibleLogicalRange(defaultRange);
      }
    } catch {
      chart.timeScale().setVisibleLogicalRange(defaultRange);
    }

    nearRealtimeRef.current = true;
    setChartCtx({ chart, candle: cs });
  }, [setLivePrice, doUpdatePriceLine, fillIndicator]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCandles = useCallback(async (sym: string, iv: string) => {
    performance.mark("tj:candles:start");

    // ── Fast path: show cached bars instantly ──────────────────────────────
    // If we have bars from a previous load of this sym+iv, display them
    // immediately so the chart is usable while the fresh fetch runs in the
    // background. This makes symbol/interval switches feel instant.
    const cached = getCachedCandles(sym, iv);
    if (cached && cached.length > 0) {
      applyBarArray(cached, sym, iv);
      setBarsLoaded(true);
      // Don't return — still fetch fresh data below to update trailing candles.
    } else {
      setBarsLoaded(false);
    }

    try {
      const resp = await fetch(`${BASE}/api/candles/${sym}/${iv}`);
      if (!resp.ok || !mountedRef.current) return;
      const raw: OHLCBar[] = await resp.json();
      if (!mountedRef.current || !Array.isArray(raw) || raw.length === 0) return;

      const bars = [...new Map(raw.map(b => [b.time, b])).values()].sort((a, b) => a.time - b.time);

      // Cache the fresh bars for future instant loads
      setCachedCandles(sym, iv, bars);

      try {
        const m = performance.measure("candles fetch+apply", "tj:candles:start");
        console.debug(`[PERF] candles ${sym}/${iv}: ${m.duration.toFixed(0)} ms (${bars.length} bars${cached ? ", cache-hit shortcut" : ""})`);
      } catch { /* ok */ }

      // Only re-apply bars if they differ from what was already shown from cache.
      // Comparing the last bar's time+close is enough: if the most-recent candle
      // hasn't changed, the user would see a needless series teardown flash.
      const lastCached = cached?.[cached.length - 1];
      const lastFresh  = bars[bars.length - 1];
      const sameData   = lastCached && lastFresh &&
                         lastCached.time  === lastFresh.time &&
                         lastCached.close === lastFresh.close &&
                         lastCached.high  === lastFresh.high;

      if (!sameData) {
        applyBarArray(bars, sym, iv);
      }
      setBarsLoaded(true);
    } catch (err) {
      console.error("[CustomChart] loadCandles error:", err);
    }
  }, [setBarsLoaded, applyBarArray]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (replayBars != null) return; // skip fetch during replay
    void loadCandles(symbol, interval);
  }, [symbol, interval, loadCandles, replayBars]);

  // ── Apply replay bars when they change ────────────────────────────────────
  const prevReplayLenRef = useRef<number>(0);
  useEffect(() => {
    if (replayBars == null) {
      prevReplayLenRef.current = 0;
      // Reset replay bar count so ChartBarsContext signals a clean post-replay
      // state. loadCandles will set barsLoaded false→true which re-triggers
      // IndicatorRenderer, but resetting replayBarCount here ensures no stale
      // context value lingers between replay exit and live data arriving.
      setReplayBarCount(0);
      return;
    }
    const cs = mainRef.current;
    if (!cs) return;

    const prevLen = prevReplayLenRef.current;
    prevReplayLenRef.current = replayBars.length;

    if (replayBars.length === 0) return;

    if (prevLen > 0 && replayBars.length === prevLen + 1) {
      // Step forward by one bar — incremental update
      const newBar = replayBars[replayBars.length - 1];
      updateBar(cs, ctRef.current, newBar);
      for (const [key, s] of Object.entries(emaRefs.current) as [keyof IndicatorState, ISeriesApi<"Line">][]) {
        const closes = replayBars.map(b => b.close);
        const vals = key === "vwap" ? calcVWAP(replayBars) : calcEMA(closes, EMA_PERIODS[key]);
        const lastVal = vals[vals.length - 1];
        if (lastVal !== null && lastVal !== undefined) {
          s.update({ time: newBar.time as Time, value: lastVal });
        }
      }
    } else {
      // Full set (initial apply, step back, or jump)
      applyBars(cs, ctRef.current, replayBars);
      if (prevLen === 0) {
        chartRef.current?.timeScale().fitContent();
      }
      for (const [key, s] of Object.entries(emaRefs.current) as [keyof IndicatorState, ISeriesApi<"Line">][]) {
        fillIndicator(s, key, replayBars);
      }
    }

    // Always sync barsRef so IndicatorRenderer reads the correct slice
    barsRef.current = replayBars;
    setReplayBarCount(replayBars.length);

    const last = replayBars[replayBars.length - 1];
    if (last) {
      livePxRef.current = last.close;
      setLivePrice(last.close);
      setLiveOpen(last.open);
      doUpdatePriceLine(last.close, symRef.current, cs);
    }
    setBarsLoaded(true);
  }, [replayBars, setLivePrice, setLiveOpen, doUpdatePriceLine, fillIndicator, setBarsLoaded]);

  // ── Live WS candle updates ────────────────────────────────────────────────
  useEffect(() => {
    if (replayBars != null) return; // disable live updates during replay
    return subscribeToMessages((raw: unknown) => {
      const msg = raw as ChartMsg;
      // Re-subscribe when WS reconnects — server sends "welcome" on each new connection.
      // This ensures the per-client candle subscription survives reconnects.
      if (msg.type === "welcome") {
        sendMsgRef.current({ type: "subscribe_candles", symbol: symRef.current, interval: ivRef.current });
        return;
      }

      // ── Ultra-fast tick path — instant live-bar update (zero CandleAggregator wait) ──
      // Fires on EVERY raw price tick from the backend (Delta all_trades, cTrader, etc.)
      // before candle_update is assembled.  We update the chart series directly so the
      // user sees price movement the moment the exchange reports it — MT5/TradingView style.
      // ctrader_tick has the same {symbol, price, timestamp} fields as tick — handled identically.
      if (msg.type === "tick" || msg.type === "ctrader_tick") {
        const t = msg as unknown as { symbol?: string; price?: number; volume?: number; timestamp?: number };
        if (!t.symbol || t.symbol !== symRef.current || typeof t.price !== "number") return;

        // ── Market session guard — FIRST thing, before any processing ──────────
        // Discard ticks entirely when the exchange is closed (e.g. weekend for
        // EURUSD/NAS100).  Guard is at the top so no chart update, no bar ingest,
        // and no tick counter increment can occur during a closed session.
        if (!isMarketOpenRef.current) return;

        const agg = tradeAggRef.current;
        if (!agg) return;

        const price  = t.price;
        const volume = t.volume ?? 1;
        const tsSec  = t.timestamp != null ? toSec(t.timestamp) : Math.floor(Date.now() / 1000);

        // ── Input validation — guard against malformed ticks ──
        if (!Number.isFinite(price) || price <= 0) return;
        if (!Number.isFinite(tsSec) || tsSec < 1_000_000_000 || tsSec > Date.now() / 1000 + 300) return;

        // Snapshot last known bar time BEFORE ingest (to detect new-bar opening)
        const prevTickBarTime = barsRef.current[barsRef.current.length - 1]?.time ?? 0;

        const result = agg.ingest(price, volume, tsSec);
        if (!result) return; // identical consecutive price — skip

        const { bar, isNewBar } = result;
        const cs = mainRef.current;
        if (!cs) return;

        // ── EMA/VWAP realtime update — tick path ───────────────────────────
        // The previous implementation updated indicators only from
        // candle_update. That can lag the raw price feed by one or more
        // websocket events, making EMA lines appear frozen/jumpy while the
        // candles move. Update the active indicator series from the same
        // client-side aggregated bar used by the candle renderer.
        if (isNewBar) {
          for (const key of Object.keys(emaRefs.current) as (keyof IndicatorState)[]) {
            if (key !== "vwap") {
              const curr = emaCurrRef.current[key];
              if (curr !== undefined) emaPrevRef.current[key] = curr;
            }
          }
          emaLastBarTimeRef.current = bar.time;
        }

        for (const [key, s] of Object.entries(emaRefs.current) as [keyof IndicatorState, ISeriesApi<"Line">][]) {
          let value: number | undefined;

          if (key === "vwap") {
            const tp = (bar.high + bar.low + bar.close) / 3;
            const cv = vwapCumRef.current.cumV + bar.volume;
            value = cv > 0
              ? (vwapCumRef.current.cumPV + tp * bar.volume) / cv
              : undefined;
          } else {
            const prev = emaPrevRef.current[key];
            if (prev !== undefined) {
              const k = 2 / (EMA_PERIODS[key] + 1);
              const ema = bar.close * k + prev * (1 - k);
              emaCurrRef.current[key] = ema;
              value = ema;
            }
          }

          if (value !== undefined) {
            try {
              // Equal timestamps replace the current indicator point;
              // a new timestamp appends the new point.
              s.update({ time: bar.time as Time, value });
            } catch { /* chart may be recreating during symbol switch */ }
          }
        }

        // ── Frame-coalescing chart update — tick path ─────────────────────
        // Store latest bar only (discards all intermediate ticks in same frame).
        // NO series.update() is called synchronously — zero LWC work per tick.
        // RAF flush renders the single latest bar; suppressed while dragging.
        pendingChartBarRef.current = bar;

        // Commit the new candle to the local ring immediately. The client tick
        // path is authoritative for the opening tick; waiting for the server's
        // candle_update would add an unnecessary network/event-loop delay.
        if (isNewBar) {
          const stored = barsRef.current;
          const last = stored[stored.length - 1];
          if (!last || bar.time > last.time) {
            stored.push(bar);
            if (stored.length > 6000) stored.shift();
            oldestBarTimeRef.current ??= stored[0]?.time ?? bar.time;
          }
        }

        // Boundary events bypass the touch-device 30 fps cap so the new candle
        // is painted on the very next frame. Continuous ticks keep the cap.
        scheduleChartUpdate(isNewBar);

        // ── Auto-follow for tick-driven new-bar events ─────────────────────
        // When the trade aggregator opens a new bar (e.g. first tick of a new
        // 1-minute candle), it may arrive via the tick path before candle_update.
        // Slide the viewport right so the new bar doesn't disappear off-screen.
        if (bar.time > prevTickBarTime && nearRealtimeRef.current) {
          const ch = chartRef.current;
          if (ch) {
            requestAnimationFrame(() => {
              try {
                const range = ch.timeScale().getVisibleLogicalRange();
                if (!range) return;
                // barsRef is updated by candle_update, so estimate latest index.
                // The new bar isn't in barsRef yet; use length (not length-1) as proxy.
                const estLatestIdx = barsRef.current.length;
                const width        = (range.to as number) - (range.from as number);
                ch.timeScale().setVisibleLogicalRange({
                  from: estLatestIdx - width + MIN_FUTURE_BARS,
                  to:   estLatestIdx + MIN_FUTURE_BARS,
                });
              } catch { /* ok */ }
            });
          }
        }

        // Tick counter for the TickRateOverlay
        tickCountRef.current++;
        lastTickTimeRef.current = Date.now();

        // Zero-latency price ref (read by LivePriceBox RAF loop every frame)
        tickDataRef.current.price = bar.close;
        tickDataRef.current.open  = bar.open;

        // Throttle Zustand setState to ≤1 per rAF frame
        if (!statePendingRef.current) {
          statePendingRef.current = true;
          requestAnimationFrame(() => {
            statePendingRef.current = false;
            if (!mountedRef.current) return;
            const d = tickDataRef.current;
            setLiveOpen(d.open);
            if (d.price !== null && d.price !== livePxRef.current) {
              livePxRef.current = d.price;
              setLivePrice(d.price);
              doUpdatePriceLine(d.price, symRef.current);
            }
          });
        }
        return;
      }

      if (msg.type !== "candle_update" || msg.symbol !== symRef.current || msg.interval !== ivRef.current || !msg.bar) return;

      // Market session gate — discard candle updates when the exchange is closed
      // (belt-and-suspenders: the server shouldn't send updates without ticks,
      // but stale cached messages can still arrive on reconnect).
      if (!isMarketOpenRef.current) return;

      const bar = msg.bar;
      const cs  = mainRef.current;
      if (!cs) return;

      // ── Open-price guard: use client aggregator's open, never the server's ──
      // The server's CandleAggregator seeds its open from the first tick it
      // receives, which may be mid-candle (e.g. after server restart or engine
      // reconnect). The client aggregator is seeded from the historical REST
      // fetch, so its open is always the true candle open. We keep all other
      // fields (high, low, close, volume) from the server bar — it sees every
      // tick — but override open with the client's tracked value.
      //
      // Without this fix the RAF sometimes flushes the candle_update bar
      // (which arrives before ctrader_tick on the wire) and the chart shows
      // the server's mid-candle open for one frame, causing visible flicker on
      // every incoming tick.
      const agg = tradeAggRef.current;
      const aggCurrentBar = agg?.getCurrentBar();
      const liveOpen: number = (aggCurrentBar && aggCurrentBar.time === bar.time)
        ? aggCurrentBar.open   // always use client-tracked open for current bar
        : bar.open;            // new bar not yet seen by aggregator — server open is fine
      const barForChart = liveOpen !== bar.open
        ? { ...bar, open: liveOpen }
        : bar;

      const stored   = barsRef.current;
      const lastTime = stored.length > 0 ? stored[stored.length - 1].time : 0;
      const isNewBar = bar.time !== emaLastBarTimeRef.current;

      // Guard: reject bars with invalid or out-of-order timestamps before touching barsRef
      if (!Number.isFinite(bar.time) || bar.time <= 0) {
        console.warn(`[Chart] candle_update: invalid bar.time=${bar.time} — discarded`);
      } else if (bar.time < lastTime) {
        // Out-of-order bar from server (can happen when multiple symbols share a WS connection)
        console.warn(`[Chart] candle_update: out-of-order bar skipped in barsRef (bar=${bar.time}, last=${lastTime})`);
        // Still queue a series.update() — LWC may handle it or the try/catch in updateBar will absorb it
      } else {
        // Update the bars ring buffer with the open-corrected bar
        if (stored.length > 0 && stored[stored.length - 1].time === bar.time) {
          stored[stored.length - 1] = barForChart;
        } else {
          stored.push(barForChart);
          if (stored.length > 6000) stored.shift();
        }
      }

      // ── Candle / line series update — buffered via scheduleChartUpdate ──────
      // Funnel through the same RAF path as the tick handler so both paths share
      // one series.update() per frame and respect the drag-pause contract.
      pendingChartBarRef.current = barForChart;
      scheduleChartUpdate();

      // ── Auto-follow: slide viewport right when a new bar forms ────────────
      // Only fires when: (a) a genuinely new bar opened (not just a tick update),
      // (b) the user was already near the right edge (nearRealtimeRef).
      if (isNewBar && nearRealtimeRef.current) {
        const ch = chartRef.current;
        if (ch) {
          requestAnimationFrame(() => {
            try {
              const range = ch.timeScale().getVisibleLogicalRange();
              if (!range) return;
              const latestIdx = barsRef.current.length - 1;
              const width     = (range.to as number) - (range.from as number);
              // Maintain current zoom (same width), slide right to keep latest
              // bar at the right edge with MIN_FUTURE_BARS of empty space.
              ch.timeScale().setVisibleLogicalRange({
                from: latestIdx - width + MIN_FUTURE_BARS,
                to:   latestIdx + MIN_FUTURE_BARS,
              });
            } catch { /* ok — chart may be in teardown */ }
          });
        }
      }

      // ── Indicator updates — O(1) incremental EMA/VWAP per tick ────────────
      // When a new bar opens, the previous bar's final EMA becomes the new "prev"
      // from which all future ticks on the new bar derive their values.
      if (isNewBar) {
        for (const key of Object.keys(emaRefs.current) as (keyof IndicatorState)[]) {
          if (key !== "vwap") emaPrevRef.current[key] = emaCurrRef.current[key];
        }
        if (emaRefs.current.vwap) {
          // Add the just-closed bar's contribution to the cumulative VWAP sum
          const closedBar = stored[stored.length - 2];
          if (closedBar) {
            const tp = (closedBar.high + closedBar.low + closedBar.close) / 3;
            vwapCumRef.current.cumPV += tp * closedBar.volume;
            vwapCumRef.current.cumV  += closedBar.volume;
          }
        }
        emaLastBarTimeRef.current = bar.time;
      }

      for (const [key, s] of Object.entries(emaRefs.current) as [keyof IndicatorState, ISeriesApi<"Line">][]) {
        let val: number | undefined;
        if (key === "vwap") {
          const tp = (bar.high + bar.low + bar.close) / 3;
          const cv = vwapCumRef.current.cumV + bar.volume;
          val = cv > 0 ? (vwapCumRef.current.cumPV + tp * bar.volume) / cv : undefined;
        } else {
          const prev = emaPrevRef.current[key];
          if (prev !== undefined) {
            const k   = 2 / (EMA_PERIODS[key] + 1);
            const ema = bar.close * k + prev * (1 - k);
            emaCurrRef.current[key] = ema;
            val = ema;
          }
        }
        if (val !== undefined) s.update({ time: bar.time as Time, value: val });
      }

      // ── Price — write directly to tickDataRef (zero React overhead) ────────
      // Note: tickCountRef is now incremented by the tick handler above so
      // the TickRateOverlay reflects raw arrival rate, not candle_update rate.
      // The LivePriceBox RAF loop reads this every frame without waiting for
      // Zustand setState → React re-render → rc.current to propagate.
      tickDataRef.current.price = bar.close;
      tickDataRef.current.open  = liveOpen; // always client-aggregator open

      // ── Throttle Zustand setState to ≤1 per rAF frame (~60 fps) ───────────
      // This keeps the header ticker, watchlist, and other React consumers
      // updated at display rate without triggering a re-render per tick.
      if (!statePendingRef.current) {
        statePendingRef.current = true;
        requestAnimationFrame(() => {
          statePendingRef.current = false;
          if (!mountedRef.current) return;
          const d = tickDataRef.current;
          setLiveOpen(d.open);
          if (d.price !== null && d.price !== livePxRef.current) {
            livePxRef.current = d.price;
            setLivePrice(d.price);
            doUpdatePriceLine(d.price, symRef.current);
          }
        });
      }
    });
  }, [subscribeToMessages, setLivePrice, setLiveOpen, doUpdatePriceLine, replayBars]);

  // ── Per-client candle subscription ────────────────────────────────────────
  // Tells the server to send candle_update ONLY for this symbol:interval,
  // eliminating ~89% of candle_update WS traffic (server previously broadcast
  // all 9 intervals on every tick). Re-fires on symbol/interval change so the
  // server subscription stays in sync. The welcome handler above handles
  // re-subscription after WS reconnects.
  //
  // Also creates a fresh RealtimeTradeAggregator for the new interval so
  // the tick handler builds OHLC at the correct candle boundary.
  // Seeding from historical bars happens in loadCandles after the REST fetch.
  useEffect(() => {
    if (replayBars != null) return;
    // Fresh aggregator for the new symbol/interval — seeded by loadCandles
    tradeAggRef.current = new RealtimeTradeAggregator(interval);
    sendMsgRef.current({ type: "subscribe_candles", symbol, interval });
  }, [symbol, interval, replayBars]);

  const chartBarsCtxValue = useMemo(
    () => ({ barsRef, replayBarCount }),
    [replayBarCount] // barsRef is a stable ref — only replayBarCount can change
  );

  return (
    <ChartBarsContext.Provider value={chartBarsCtxValue}>
      <ChartContext.Provider value={(chartCtx ?? { chart: null, candle: null }) as ChartContextValue}>
        <div style={{ position: "absolute", inset: 0, touchAction: "none", overscrollBehavior: "none", willChange: "transform", transform: "translate3d(0,0,0)" }}>
          <div ref={containerRef} style={{ position: "absolute", inset: 0, touchAction: "none", willChange: "transform" }} />
          <canvas ref={futureCrossCanvasRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1 }} />
          {/* History loading indicator — shown/hidden via direct DOM (no React re-render) */}
          <div
            ref={histLoadingDivRef}
            style={{
              display:        "none",
              position:       "absolute",
              top:            8,
              left:           "50%",
              transform:      "translateX(-50%)",
              alignItems:     "center",
              gap:            6,
              background:     "rgba(18,24,38,0.82)",
              border:         "1px solid rgba(255,255,255,0.10)",
              borderRadius:   6,
              padding:        "4px 10px",
              fontSize:       11,
              color:          "rgba(255,255,255,0.65)",
              pointerEvents:  "none",
              zIndex:         10,
              backdropFilter: "blur(4px)",
              whiteSpace:     "nowrap",
            }}
          >
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.4)", borderTopColor: "rgba(255,255,255,0.85)", animation: "spin 0.7s linear infinite" }} />
            Loading history…
          </div>
          {/* ── Symbol · Timeframe · TickRate overlay — top-left, flex row, pointer-events:none ── */}
          <div style={{
            position:      "absolute",
            top:           8,
            left:          8,
            pointerEvents: "none",
            zIndex:        5,
            display:       "flex",
            alignItems:    "center",
            minWidth:      0,
            maxWidth:      "calc(100% - 120px)",
            userSelect:    "none",
          }}>
            <span style={{
              fontSize:      12,
              fontWeight:    600,
              color:         "rgba(255,255,255,0.82)",
              letterSpacing: "0.02em",
              lineHeight:    1,
              overflow:      "hidden",
              textOverflow:  "ellipsis",
              whiteSpace:    "nowrap",
              flexShrink:    1,
              minWidth:      0,
            }}>
              {SYMBOL_CATALOG[symbol]?.badge ?? symbol}
            </span>
            <span style={{
              fontSize:      10,
              fontWeight:    500,
              color:         "rgba(255,255,255,0.38)",
              letterSpacing: "0.01em",
              lineHeight:    1,
              flexShrink:    0,
              whiteSpace:    "nowrap",
              marginLeft:    5,
            }}>
              · {fmtIntervalLabel(interval)}
            </span>
            <TickRateOverlay
              tickCountRef={tickCountRef}
              lastTickTimeRef={lastTickTimeRef}
              isMarketOpen={mktIsOpen}
              mktType={mktType}
            />
          </div>
          <LivePriceBox
            chart={chartCtx?.chart ?? null}
            series={chartCtx?.candle ?? null}
            interval={interval}
            upColor={settings?.priceLabelBullColor ?? settings?.upColor ?? UP_COLOR}
            downColor={settings?.priceLabelBearColor ?? settings?.downColor ?? DOWN_COLOR}
            textColor={settings?.priceLabelTextColor ?? "#ffffff"}
            boxWidth={priceScaleW}
            boxWidthRef={priceScaleWRef}
            tickDataRef={tickDataRef}
            lastTickTimeRef={lastTickTimeRef}
            symbolOverride={symbol}
            slotMode={propSymbol != null}
            isMarketOpen={mktIsOpen}
          />
          {children}
          {/* Price scale touch handler — highest z, covers rightmost strip for both mouse and touch drag */}
          <PriceScaleTouchHandler chartRef={chartRef} containerRef={containerRef} mainRef={mainRef} overrideWidth={priceScaleW} />
        </div>
      </ChartContext.Provider>
    </ChartBarsContext.Provider>
  );
});

export default CustomChart;
