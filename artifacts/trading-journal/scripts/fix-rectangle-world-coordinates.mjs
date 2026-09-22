import fs from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), "src/components/charts/DrawingOverlay.tsx");
if (!fs.existsSync(file)) throw new Error(`DrawingOverlay.tsx not found: ${file}`);

let src = fs.readFileSync(file, "utf8");

const marker = "// [chart-fix] World-space drawing coordinate interpolation for rectangles";
if (src.includes(marker) || src.includes("Future-time points: derive the mapping from the actual last loaded bar")) {
  console.log("[rectangle-world-coordinates] Compatible world-coordinate implementation already present; no changes required.");
  process.exit(0);
}

const re = /  const toPx = useCallback\(\(pt: DrawingPoint\): Px \| null => \{[\s\S]*?\n  \}, \[chart, candle, timeframe\]\); \/\/ renderTick removed \u2014 toPx calls LWC imperative API, always current/;

if (!re.test(src)) {
  throw new Error("DrawingOverlay toPx block not found; refusing unsafe replacement.");
}

const replacement = String.raw`  ${marker}
  // Always project drawing points from chart time/price space. In particular,
  // do not treat a null timeToCoordinate() as "future only": Lightweight Charts
  // can return null whenever the exact timestamp is not present on the time scale
  // (for example a drawing timestamp between 15m candles). Nearest logical-index
  // projection keeps the drawing attached to the same candle while the user pans.
  const toPx = useCallback((pt: DrawingPoint): Px | null => {
    if (!chart || !candle) return null;

    const ts = chart.timeScale();
    const y = candle.priceToCoordinate(pt.price);
    if (y === null) return null;

    const exactX = ts.timeToCoordinate(pt.time as Time);
    if (exactX !== null) return { x: exactX as number, y: y as number };

    const nearestIndex = ts.timeToIndex(pt.time as Time, true);
    if (nearestIndex !== null) {
      const nearestX = ts.logicalToCoordinate(nearestIndex as Logical);
      if (nearestX !== null) {
        const bars = barsRef.current as OhlcBar[];
        if (bars.length >= 2) {
          let lo = 0;
          let hi = bars.length - 1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (bars[mid].time < pt.time) lo = mid + 1;
            else hi = mid - 1;
          }

          const right = lo;
          const left = lo - 1;
          if (left >= 0 && right < bars.length) {
            const lt = bars[left].time;
            const rt = bars[right].time;
            if (rt > lt) {
              const lx = ts.timeToCoordinate(bars[left].time as Time);
              const rx = ts.timeToCoordinate(bars[right].time as Time);
              if (lx !== null && rx !== null) {
                const f = Math.max(0, Math.min(1, (pt.time - lt) / (rt - lt)));
                return { x: (lx as number) + ((rx as number) - (lx as number)) * f, y: y as number };
              }
            }
          }
        }
        return { x: nearestX as number, y: y as number };
      }
    }

    // Final fallback for a point outside the currently loaded data window.
    const visRange = ts.getVisibleLogicalRange();
    if (visRange !== null) {
      const toSec = (t: Time) =>
        typeof t === "number" ? t : Math.floor(new Date(t as string).getTime() / 1000);

      let lastRealTime: number | null = null;
      let lastRealLogical: number | null = null;
      const searchFrom = Math.ceil(visRange.to as number);
      for (let li = searchFrom; li >= Math.max(0, searchFrom - 300); li--) {
        const coord = ts.logicalToCoordinate(li as Logical);
        if (coord === null) continue;
        const t = ts.coordinateToTime(coord as number);
        if (t !== null) {
          lastRealTime = toSec(t);
          lastRealLogical = li;
          break;
        }
      }

      if (lastRealTime !== null && lastRealLogical !== null) {
        const prevCoord = ts.logicalToCoordinate((lastRealLogical - 1) as Logical);
        if (prevCoord !== null) {
          const prevT = ts.coordinateToTime(prevCoord as number);
          if (prevT !== null) {
            const intervalSec = Math.max(60, lastRealTime - toSec(prevT));
            const logicalDelta = (pt.time - lastRealTime) / intervalSec;
            const x = ts.logicalToCoordinate((lastRealLogical + logicalDelta) as Logical);
            if (x !== null) return { x: x as number, y: y as number };
          }
        }
      }
    }

    return null;
  }, [chart, candle, timeframe]); // renderTick intentionally omitted; chart APIs are read imperatively
`;

src = src.replace(re, replacement);
fs.writeFileSync(file, src);
console.log("[rectangle-world-coordinates] Installed.");
