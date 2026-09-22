import { useState, useCallback, useEffect, memo, useRef, useImperativeHandle, forwardRef } from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "@/hooks/use-mobile";
import { AnimatePresence, motion } from "motion/react";
import {
  Bell, BellRing, Plus, Pause, Play, Trash2,
  Zap, Activity, CheckCircle2, Clock, AlertTriangle,
  TrendingUp, TrendingDown, Minus, Radio,
  ChevronDown, Filter, Info,
  Target, Layers, GitBranch, X,
  Wifi, WifiOff, Send, Settings as SettingsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toArray } from "@/lib/safeArray";
import { tweenFast, tweenStandard, TAP_TRANSITION, listItemVariants } from "@/animations/motion";
import {
  NOTIFICATION_HISTORY, TIMEFRAMES, SYMBOLS,
  type PriceAlert, type ZoneAlert, type TrendlineAlert,
  type AnyAlert, type AlertStatus, type AlertType,
} from "@/data/alertsData";
import { useAlertStore } from "@/store/alertStore";
import { useLiveMarketContext } from "@/contexts/LiveMarketContext";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  PageTransition,
  AnimatedCard,
  AnimatedPresenceList,
  AnimatedListItem,
  AnimatedButton,
  AnimatedIconButton,
  NumberCounter,
} from "@/components/animations";

// ─── Small helpers ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: AlertStatus }) {
  const cfg = {
    active:    { label: "Active",    cls: "bg-blue-500/15 text-blue-400 border-blue-500/20" },
    triggered: { label: "Triggered", cls: "bg-primary/15 text-primary border-primary/20" },
    paused:    { label: "Paused",    cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20" },
    expired:   { label: "Expired",   cls: "bg-white/10 text-white/40 border-white/10" },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cfg.cls}`}>
      {status === "active"    && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
      {status === "triggered" && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
      {status === "paused"    && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />}
      {cfg.label}
    </span>
  );
}

function TypeBadge({ type }: { type: AlertType }) {
  const cfg = {
    price:     { label: "Price",     Icon: Target,    cls: "bg-blue-500/15 text-blue-400" },
    zone:      { label: "Zone",      Icon: Layers,    cls: "bg-orange-500/15 text-orange-400" },
    trendline: { label: "Trendline", Icon: GitBranch, cls: "bg-primary/15 text-primary" },
  }[type];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold ${cfg.cls}`}>
      <cfg.Icon className="w-2.5 h-2.5" />
      {cfg.label}
    </span>
  );
}

function PulseRing({ color = "bg-primary" }: { color?: string }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color} opacity-60`} />
      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${color}`} />
    </span>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors duration-200 flex-shrink-0 ${checked ? "bg-primary" : "bg-white/[0.12]"}`}
    >
      <div
        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200"
        style={{ transform: `translateX(${checked ? 20 : 2}px)` }}
      />
    </button>
  );
}

function ConditionIcon({ cond }: { cond: string }) {
  if (cond === "above")  return <TrendingUp   className="w-3 h-3 text-foreground/50" />;
  if (cond === "below")  return <TrendingDown  className="w-3 h-3 text-red-400" />;
  if (cond === "break")  return <Zap          className="w-3 h-3 text-yellow-400" />;
  if (cond === "retest") return <Activity      className="w-3 h-3 text-blue-400" />;
  return <Minus className="w-3 h-3 text-white/50" />;
}

// ─── Notification Panel ────────────────────────────────────────────────────────
function NotificationPanel({ onClose }: { onClose: () => void }) {
  const [notifications, setNotifications] = useState(NOTIFICATION_HISTORY);
  const unread = notifications.filter(n => !n.read).length;
  const markAll = () => setNotifications(ns => ns.map(n => ({ ...n, read: true })));
  const severityColor = (s: string) =>
    s === "high"   ? "border-l-red-500 bg-red-500/5" :
    s === "medium" ? "border-l-yellow-500 bg-yellow-500/5" :
    "border-l-primary/40 bg-primary/5";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }} transition={tweenStandard}
      className="fixed right-4 top-16 w-80 z-50 rounded-2xl border border-white/[0.08] shadow-2xl overflow-hidden"
      style={{ background: "hsl(var(--card))" }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <BellRing className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-white">Notifications</span>
          {unread > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500 text-white">{unread}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {unread > 0 && (
            <button onClick={markAll} className="text-[10px] text-primary hover:text-primary/80 transition-colors">Mark all read</button>
          )}
          <button onClick={onClose} className="ml-2 w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.06] text-muted-foreground hover:text-white transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-y-auto max-h-96">
        {notifications.map(n => (
          <div
            key={n.id}
            className={cn(
              "px-4 py-3 border-b border-white/[0.04] border-l-2 cursor-pointer hover:bg-white/[0.03] transition-colors",
              severityColor(n.severity), !n.read && "bg-white/[0.02]"
            )}
            onClick={() => setNotifications(ns => ns.map(x => x.id === n.id ? { ...x, read: true } : x))}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[11px] font-bold text-white">{n.symbol}</span>
                  <TypeBadge type={n.type} />
                  {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />}
                </div>
                <p className="text-[11px] text-white/70 leading-snug">{n.message}</p>
                <p className="text-[10px] text-muted-foreground/60 mt-1">
                  {new Date(n.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ─── UTC 24-h Date/Time Picker (no AM/PM) ──────────────────────────────────────
export function UTCDateTimePicker({
  label, value, onChange, optional = false,
}: {
  label: string; value: string; onChange: (iso: string) => void; optional?: boolean;
}) {
  const toUtcParts = (iso: string) => {
    if (!iso) return { d: "", hh: "", mm: "" };
    const t = new Date(iso);
    return {
      d:  t.toISOString().slice(0, 10),
      hh: String(t.getUTCHours()).padStart(2, "0"),
      mm: String(t.getUTCMinutes()).padStart(2, "0"),
    };
  };
  const init = toUtcParts(value);
  const [date, setDate] = useState(init.d);
  const [hh, setHh]     = useState(init.hh || "00");
  const [mm, setMm]     = useState(init.mm || "00");

  // Sync picker display when the value prop changes externally (e.g. when the
  // overlay resets times on open, or a drawing auto-populates the fields).
  useEffect(() => {
    const parts = toUtcParts(value);
    if (parts.d) {
      setDate(parts.d);
      setHh(parts.hh);
      setMm(parts.mm);
    }
  }, [value]);

  const emit = (d: string, h: string, m: string) => {
    if (d && h !== "" && m !== "") {
      onChange(`${d}T${h.padStart(2, "0")}:${m.padStart(2, "0")}:00.000Z`);
    } else {
      onChange("");
    }
  };

  const applyPreset = (offsetMs: number) => {
    const t = new Date(Date.now() + offsetMs);
    const d  = t.toISOString().slice(0, 10);
    const h  = String(t.getUTCHours()).padStart(2, "0");
    const m  = String(t.getUTCMinutes()).padStart(2, "0");
    setDate(d); setHh(h); setMm(m);
    emit(d, h, m);
  };

  const preview = date && hh !== "" && mm !== ""
    ? `${date} ${hh}:${mm} UTC` : null;

  return (
    <FieldRow label={optional ? `${label} (optional)` : label}>
      <div className="space-y-2">
        <div className="flex gap-1 flex-wrap">
          {([
            { label: "Now",  ms: 0 },
            { label: "+5m",  ms: 5 * 60000 },
            { label: "+15m", ms: 15 * 60000 },
            { label: "+1H",  ms: 60 * 60000 },
          ] as const).map(p => (
            <button key={p.label} type="button" onClick={() => applyPreset(p.ms)}
              className="px-2.5 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-[10px] font-semibold text-muted-foreground hover:bg-primary/20 hover:border-primary/40 hover:text-primary transition-all">
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          <input type="date" value={date}
            onChange={e => { setDate(e.target.value); emit(e.target.value, hh, mm); }}
            className="flex-1 h-9 px-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 min-w-0"
          />
          <div className="flex items-center gap-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 h-9 flex-shrink-0">
            <input type="number" min={0} max={23} value={hh} placeholder="HH"
              onChange={e => { const v = String(Math.max(0, Math.min(23, +e.target.value))).padStart(2,"0"); setHh(v); emit(date, v, mm); }}
              className="w-7 bg-transparent text-xs text-white text-center focus:outline-none placeholder:text-muted-foreground/40"
            />
            <span className="text-muted-foreground/50 text-xs">:</span>
            <input type="number" min={0} max={59} value={mm} placeholder="MM"
              onChange={e => { const v = String(Math.max(0, Math.min(59, +e.target.value))).padStart(2,"0"); setMm(v); emit(date, hh, v); }}
              className="w-7 bg-transparent text-xs text-white text-center focus:outline-none placeholder:text-muted-foreground/40"
            />
            <span className="text-[9px] text-muted-foreground/40 ml-0.5">UTC</span>
          </div>
        </div>
        {preview && (
          <p className="text-[10px] text-primary/60 font-mono">{preview}</p>
        )}
      </div>
    </FieldRow>
  );
}

// ─── Create Price Alert Modal ──────────────────────────────────────────────────
export const CreatePriceAlertModal = memo(function CreatePriceAlertModal({
  onClose, onSave, initialSymbol,
}: {
  onClose: () => void;
  onSave: (a: PriceAlert) => void;
  initialSymbol?: string;
}) {
  const [form, setForm] = useState({
    symbol: initialSymbol ?? "NAS100", condition: "above" as "above" | "below" | "touch" | "percent_up" | "percent_down",
    targetPrice: "", notes: "", expiry: "",
  });

  const handleSave = () => {
    if (!form.targetPrice) return;
    onSave({
      id: `pa${Date.now()}`, type: "price",
      symbol: form.symbol, condition: form.condition,
      targetPrice: parseFloat(form.targetPrice),
      currentPrice: 0, notes: form.notes,
      status: "active", expiry: form.expiry || null,
      createdAt: new Date().toISOString(), triggeredAt: null,
    });
    onClose();
  };

  return (
    <ModalWrapper onClose={onClose} title="Create Price Alert" icon={<Target className="w-4 h-4 text-blue-400" />}>
      <div className="space-y-4">
        <FieldRow label="Symbol">
          <AlertSelect value={form.symbol} onChange={v => setForm(f => ({ ...f, symbol: v }))} options={SYMBOLS} />
        </FieldRow>
        <FieldRow label="Condition">
          <div className="flex gap-2">
            {([
              ["above", "Above"], ["below", "Below"], ["touch", "Touch"],
              ["percent_up", "% Up"], ["percent_down", "% Down"],
            ] as const).map(([c, label]) => (
              <AnimatedButton key={c} onClick={() => setForm(f => ({ ...f, condition: c }))}
                className={cn(
                  "flex-1 py-2 rounded-lg text-xs font-semibold capitalize border transition-all",
                  form.condition === c
                    ? "bg-primary/20 border-primary/40 text-primary"
                    : "border-white/[0.08] text-muted-foreground hover:border-white/20 hover:text-white"
                )}>
                {label}
              </AnimatedButton>
            ))}
          </div>
        </FieldRow>
        <FieldRow label={form.condition.startsWith("percent_") ? "Target Change (%)" : "Target Price"}>
          <Input type="number" step={form.condition.startsWith("percent_") ? "0.1" : undefined} placeholder={form.condition.startsWith("percent_") ? "e.g. 2.5" : "e.g. 18750"} value={form.targetPrice}
            onChange={e => setForm(f => ({ ...f, targetPrice: e.target.value }))}
            className="bg-white/[0.04] border-white/[0.08] text-white placeholder:text-muted-foreground/50 h-9" />
        </FieldRow>
        <UTCDateTimePicker
          label="Expiry" optional
          value={form.expiry}
          onChange={iso => setForm(f => ({ ...f, expiry: iso }))}
        />
        <FieldRow label="Notes">
          <textarea rows={2} placeholder="Alert notes..." value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50" />
        </FieldRow>
        <div className="flex gap-2 pt-1">
          <AnimatedButton variant="ghost" className="flex-1 h-9 text-muted-foreground hover:text-white" onClick={onClose}>Cancel</AnimatedButton>
          <AnimatedButton className="flex-1 h-9 bg-primary hover:bg-primary/90 text-white text-xs font-semibold" onClick={handleSave}>Create Alert</AnimatedButton>
        </div>
      </div>
    </ModalWrapper>
  );
});

// ─── Create Zone Alert Modal ───────────────────────────────────────────────────
export const CreateZoneAlertModal = memo(function CreateZoneAlertModal({
  onClose, onSave, initialSymbol,
}: {
  onClose: () => void;
  onSave: (a: ZoneAlert) => void;
  initialSymbol?: string;
}) {
  const [form, setForm] = useState({
    symbol: initialSymbol ?? "NAS100", zoneType: "supply" as ZoneAlert["zoneType"],
    upperPrice: "", lowerPrice: "", timeframe: "1H",
    condition: "touch" as ZoneAlert["condition"], notes: "",
  });

  const handleSave = () => {
    if (!form.upperPrice || !form.lowerPrice) return;
    onSave({
      id: `za${Date.now()}`, type: "zone",
      symbol: form.symbol, zoneType: form.zoneType,
      upperPrice: parseFloat(form.upperPrice), lowerPrice: parseFloat(form.lowerPrice),
      timeframe: form.timeframe, condition: form.condition,
      notes: form.notes, status: "active",
      createdAt: new Date().toISOString(), triggeredAt: null,
    });
    onClose();
  };

  const zoneTypes = [
    { value: "supply", label: "Supply" }, { value: "demand", label: "Demand" },
    { value: "support_resistance", label: "S/R" }, { value: "order_block", label: "Order Block" },
  ] as const;

  return (
    <ModalWrapper onClose={onClose} title="Create Zone Alert" icon={<Layers className="w-4 h-4 text-orange-400" />}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <FieldRow label="Symbol">
            <AlertSelect value={form.symbol} onChange={v => setForm(f => ({ ...f, symbol: v }))} options={SYMBOLS} />
          </FieldRow>
          <FieldRow label="Timeframe">
            <AlertSelect value={form.timeframe} onChange={v => setForm(f => ({ ...f, timeframe: v }))} options={TIMEFRAMES} />
          </FieldRow>
        </div>
        <FieldRow label="Zone Type">
          <div className="grid grid-cols-2 gap-2">
            {zoneTypes.map(z => (
              <AnimatedButton key={z.value} onClick={() => setForm(f => ({ ...f, zoneType: z.value }))}
                className={cn(
                  "py-2 rounded-lg text-xs font-semibold border transition-all",
                  form.zoneType === z.value
                    ? "bg-orange-500/20 border-orange-500/40 text-orange-400"
                    : "border-white/[0.08] text-muted-foreground hover:border-white/20 hover:text-white"
                )}>
                {z.label}
              </AnimatedButton>
            ))}
          </div>
        </FieldRow>
        <div className="grid grid-cols-2 gap-3">
          <FieldRow label="Upper Price">
            <Input type="number" placeholder="Upper" value={form.upperPrice}
              onChange={e => setForm(f => ({ ...f, upperPrice: e.target.value }))}
              className="bg-white/[0.04] border-white/[0.08] text-white placeholder:text-muted-foreground/50 h-9" />
          </FieldRow>
          <FieldRow label="Lower Price">
            <Input type="number" placeholder="Lower" value={form.lowerPrice}
              onChange={e => setForm(f => ({ ...f, lowerPrice: e.target.value }))}
              className="bg-white/[0.04] border-white/[0.08] text-white placeholder:text-muted-foreground/50 h-9" />
          </FieldRow>
        </div>
        <FieldRow label="Alert Condition">
          <div className="flex gap-2">
            {(["enter", "touch", "break", "retest"] as const).map(c => (
              <AnimatedButton key={c} onClick={() => setForm(f => ({ ...f, condition: c }))}
                className={cn(
                  "flex-1 py-2 rounded-lg text-xs font-semibold capitalize border transition-all",
                  form.condition === c
                    ? "bg-orange-500/20 border-orange-500/40 text-orange-400"
                    : "border-white/[0.08] text-muted-foreground hover:border-white/20 hover:text-white"
                )}>
                {c}
              </AnimatedButton>
            ))}
          </div>
        </FieldRow>
        <FieldRow label="Notes">
          <textarea rows={2} placeholder="Zone notes..." value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50" />
        </FieldRow>
        <div className="flex gap-2 pt-1">
          <AnimatedButton variant="ghost" className="flex-1 h-9 text-muted-foreground hover:text-white" onClick={onClose}>Cancel</AnimatedButton>
          <AnimatedButton className="flex-1 h-9 bg-primary hover:bg-primary/90 text-white text-xs font-semibold" onClick={handleSave}>Create Zone</AnimatedButton>
        </div>
      </div>
    </ModalWrapper>
  );
});

// ─── Create Trendline Alert Modal ──────────────────────────────────────────────
export const CreateTrendlineAlertModal = memo(function CreateTrendlineAlertModal({
  onClose, onSave, initialSymbol,
}: {
  onClose: () => void;
  onSave: (a: TrendlineAlert) => void;
  initialSymbol?: string;
}) {
  const [form, setForm] = useState(() => {
    const now = new Date();
    const plus1h = new Date(now.getTime() + 60 * 60 * 1000);
    return {
      symbol: initialSymbol ?? "NAS100", timeframe: "1H",
      p1Price: "", p1Time: now.toISOString(),
      p2Price: "", p2Time: plus1h.toISOString(),
      condition: "touch" as TrendlineAlert["condition"], notes: "",
    };
  });

  const timeInvalid = !!(form.p1Time && form.p2Time && new Date(form.p2Time) < new Date(form.p1Time));
  const canSave = !!(form.p1Price && form.p2Price && form.p1Time && form.p2Time && !timeInvalid);

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      id: `ta${Date.now()}`, type: "trendline",
      symbol: form.symbol, timeframe: form.timeframe,
      point1Price: parseFloat(form.p1Price), point1Time: form.p1Time,
      point2Price: parseFloat(form.p2Price), point2Time: form.p2Time,
      condition: form.condition, notes: form.notes,
      status: "active", createdAt: new Date().toISOString(), triggeredAt: null,
    });
    toast.success("Trendline alert created", {
      description: `${form.symbol} · ${form.condition} · ${form.timeframe}`,
      duration: 3000,
    });
    onClose();
  };

  const slope = form.p1Price && form.p2Price
    ? parseFloat(form.p2Price) > parseFloat(form.p1Price) ? "ascending" : "descending"
    : null;

  return (
    <ModalWrapper onClose={onClose} title="Create Trendline Alert" icon={<GitBranch className="w-4 h-4 text-primary" />}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <FieldRow label="Symbol">
            <AlertSelect value={form.symbol} onChange={v => setForm(f => ({ ...f, symbol: v }))} options={SYMBOLS} />
          </FieldRow>
          <FieldRow label="Timeframe">
            <AlertSelect value={form.timeframe} onChange={v => setForm(f => ({ ...f, timeframe: v }))} options={TIMEFRAMES} />
          </FieldRow>
        </div>
        {slope && (
          <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={tweenFast}
            className="p-3 rounded-xl bg-primary/10 border border-primary/20 flex items-center gap-3">
            {slope === "ascending"
              ? <TrendingUp className="w-5 h-5 text-primary flex-shrink-0" />
              : <TrendingDown className="w-5 h-5 text-primary flex-shrink-0" />}
            <div>
              <p className="text-xs font-semibold text-primary capitalize">{slope} Trendline</p>
              <p className="text-[10px] text-primary/60">
                Slope: {(parseFloat(form.p2Price) - parseFloat(form.p1Price)).toFixed(2)} pts
              </p>
            </div>
          </motion.div>
        )}

        {/* Point 1 */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-3">
          <p className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wider">Point 1 — Anchor</p>
          <FieldRow label="Price">
            <Input type="number" placeholder="e.g. 18500" value={form.p1Price}
              onChange={e => setForm(f => ({ ...f, p1Price: e.target.value }))}
              className="bg-white/[0.04] border-white/[0.08] text-white placeholder:text-muted-foreground/50 h-9" />
          </FieldRow>
          <UTCDateTimePicker
            label="Time (UTC)"
            value={form.p1Time}
            onChange={iso => setForm(f => ({ ...f, p1Time: iso }))}
          />
        </div>

        {/* Point 2 */}
        <div className={cn(
          "rounded-xl border p-3 space-y-3 transition-colors",
          timeInvalid ? "border-amber-500/30 bg-amber-500/[0.04]" : "border-white/[0.06] bg-white/[0.02]"
        )}>
          <p className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wider">Point 2 — Direction</p>
          <FieldRow label="Price">
            <Input type="number" placeholder="e.g. 18750" value={form.p2Price}
              onChange={e => setForm(f => ({ ...f, p2Price: e.target.value }))}
              className="bg-white/[0.04] border-white/[0.08] text-white placeholder:text-muted-foreground/50 h-9" />
          </FieldRow>
          <UTCDateTimePicker
            label="Time (UTC)"
            value={form.p2Time}
            onChange={iso => setForm(f => ({ ...f, p2Time: iso }))}
          />
        </div>

        {/* Time validation warning */}
        <AnimatePresence>
          {timeInvalid && (
            <motion.div
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={tweenFast}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
              <p className="text-[11px] text-amber-400">Point 2 time must be after Point 1</p>
            </motion.div>
          )}
        </AnimatePresence>

        <FieldRow label="Alert Condition">
          <div className="flex gap-2">
            {(["touch", "break", "retest"] as const).map(c => (
              <AnimatedButton key={c} onClick={() => setForm(f => ({ ...f, condition: c }))}
                className={cn(
                  "flex-1 py-2 rounded-lg text-xs font-semibold capitalize border transition-all",
                  form.condition === c
                    ? "bg-primary/20 border-primary/40 text-primary"
                    : "border-white/[0.08] text-muted-foreground hover:border-white/20 hover:text-white"
                )}>
                {c}
              </AnimatedButton>
            ))}
          </div>
        </FieldRow>
        <FieldRow label="Notes">
          <textarea rows={2} placeholder="Trendline notes..." value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50" />
        </FieldRow>
        <div className="flex gap-2 pt-1">
          <AnimatedButton variant="ghost" className="flex-1 h-9 text-muted-foreground hover:text-white" onClick={onClose}>Cancel</AnimatedButton>
          <AnimatedButton
            disabled={!canSave}
            className="flex-1 h-9 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleSave}>
            Create Trendline
          </AnimatedButton>
        </div>
      </div>
    </ModalWrapper>
  );
});

// ─── Unified Add Alert pill button ────────────────────────────────────────────
function AddAlertPillButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      transition={TAP_TRANSITION}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 44,
        paddingLeft: 20,
        paddingRight: 20,
        borderRadius: 9999,
        background: "#FFFFFF",
        color: "#111111",
        fontSize: 13,
        fontWeight: 600,
        border: "none",
        cursor: "pointer",
        willChange: "transform",
        WebkitTapHighlightColor: "transparent",
        flexShrink: 0,
      } as React.CSSProperties}
    >
      <Plus style={{ width: 15, height: 15, strokeWidth: 2.5 }} />
      {label}
    </motion.button>
  );
}

// Renders children on the SECOND animation frame so the modal shell paints first.
function DeferredContent({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return ready ? <>{children}</> : null;
}

// ─── Shared modal wrapper ───────────────────────────────────────────────────────
function ModalWrapper({ title, icon, onClose, children }: {
  title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode;
}) {
  const modal = (
    <>
      {/* Backdrop — NO animation. Instant black overlay so the GPU only
          composites a flat colour layer, not an animating opacity over blurs. */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.72)" }}
      />

      {/* Mobile sheet — hidden on ≥640px via CSS */}
      <div
        className="alert-modal-sheet"
        onClick={e => e.stopPropagation()}
        style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 9999,
          maxHeight: "90dvh", display: "flex", flexDirection: "column",
          background: "hsl(var(--popover))",
          borderTop: "1px solid rgba(255,255,255,0.12)",
          borderLeft: "1px solid rgba(255,255,255,0.07)",
          borderRight: "1px solid rgba(255,255,255,0.07)",
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          boxShadow: "0 -8px 48px rgba(0,0,0,0.65)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 12, paddingBottom: 4, flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.20)" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
          {icon}
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "#fff", margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ marginLeft: "auto", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "none", cursor: "pointer", color: "rgba(148,163,184,0.8)" }}>
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>
        <div style={{ padding: 20, overflowY: "auto", flex: 1, WebkitOverflowScrolling: "touch" } as React.CSSProperties}>
          <DeferredContent>{children}</DeferredContent>
        </div>
        <div style={{ height: "max(env(safe-area-inset-bottom, 0px), 12px)", flexShrink: 0 }} />
      </div>

      {/* Desktop dialog — hidden on <640px via CSS */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
        className="alert-modal-desktop-centering"
      >
        <div
          className="alert-modal-dialog"
          onClick={e => e.stopPropagation()}
          style={{
            width: "100%", maxWidth: 520, maxHeight: "90vh",
            display: "flex", flexDirection: "column", borderRadius: 20,
            background: "hsl(var(--popover))",
            border: "1px solid rgba(255,255,255,0.10)",
            borderTopColor: "rgba(255,255,255,0.18)",
            boxShadow: "0 24px 64px rgba(7,17,13,0.75), 0 0 0 1px rgba(255,255,255,0.04)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
            {icon}
            <h2 style={{ fontSize: 14, fontWeight: 600, color: "#fff", margin: 0 }}>{title}</h2>
            <button onClick={onClose} style={{ marginLeft: "auto", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, background: "transparent", border: "none", cursor: "pointer", color: "rgba(148,163,184,0.8)" }}>
              <X style={{ width: 14, height: 14 }} />
            </button>
          </div>
          <div style={{ padding: 20, overflowY: "auto", flex: 1 }}>
            <DeferredContent>{children}</DeferredContent>
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(modal, document.body);
}

export function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-semibold text-muted-foreground/80 uppercase tracking-wider">{label}</label>
      {children}
    </div>
  );
}

export function AlertSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: readonly string[] }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full h-9 px-3 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 appearance-none">
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

// ─── Alert Table Row ───────────────────────────────────────────────────────────
function AlertRow({ alert, onTogglePause, onDelete, index = 0 }: {
  alert: AnyAlert; onTogglePause: (id: string) => void; onDelete: (id: string) => void; index?: number;
}) {
  const isPaused = alert.status === "paused";
  const isActive = alert.status === "active";

  const getCondition = () => {
    if (alert.type === "price")     return alert.condition;
    if (alert.type === "zone")      return `${alert.condition} ${alert.zoneType.replace("_", "/")}`;
    if (alert.type === "trendline") return `${alert.condition} · ${alert.timeframe}`;
    return "—";
  };

  const getTarget = () => {
    if (alert.type === "price")     return `@ ${alert.targetPrice.toLocaleString()}`;
    if (alert.type === "zone")      return `${alert.lowerPrice.toLocaleString()} – ${alert.upperPrice.toLocaleString()}`;
    if (alert.type === "trendline") return `${alert.point1Price} → ${alert.point2Price}`;
    return "—";
  };

  return (
    <motion.tr
      className={cn(
        "group border-b border-white/[0.04] transition-colors",
        alert.status === "triggered" && "bg-primary/[0.03]",
        alert.status === "active"    && "hover:bg-white/[0.02]",
      )}
      variants={listItemVariants}
      custom={index}
      initial="hidden"
      animate="visible"
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {alert.status === "active"    && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />}
          {alert.status === "triggered" && <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />}
          {alert.status === "paused"    && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 flex-shrink-0" />}
          <span className="text-xs font-bold text-white">{alert.symbol}</span>
        </div>
      </td>
      <td className="px-4 py-3"><TypeBadge type={alert.type} /></td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <ConditionIcon cond={"condition" in alert ? String((alert as PriceAlert).condition) : "touch"} />
          <span className="text-[11px] text-white/70 capitalize">{getCondition()}</span>
        </div>
      </td>
      <td className="px-4 py-3"><span className="text-[11px] font-mono text-white/60">{getTarget()}</span></td>
      <td className="px-4 py-3"><StatusBadge status={alert.status} /></td>
      <td className="px-4 py-3 max-w-[200px]">
        <span className="text-[11px] text-muted-foreground/70 truncate block">{alert.notes || "—"}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-[10px] text-muted-foreground/50">
          {new Date(alert.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
      </td>
      <td className="px-4 py-3">
        {alert.triggeredAt
          ? <span className="text-[10px] text-primary/70 font-medium">{new Date(alert.triggeredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          : <span className="text-[10px] text-muted-foreground/30">—</span>}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => onTogglePause(alert.id)} title={isPaused ? "Resume" : "Pause"}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/[0.08] text-muted-foreground hover:text-white transition-colors">
            {isPaused || !isActive ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => onDelete(alert.id)} title="Delete"
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </motion.tr>
  );
}

// ─── Price Alert Card ──────────────────────────────────────────────────────────
function PriceAlertCard({ alert, onTogglePause, onDelete, index = 0 }: {
  alert: PriceAlert; onTogglePause: (id: string) => void; onDelete: (id: string) => void; index?: number;
}) {
  const pct = alert.currentPrice > 0
    ? ((alert.targetPrice - alert.currentPrice) / alert.currentPrice * 100).toFixed(2)
    : null;

  return (
    <AnimatedListItem
      index={index}
      className={cn(
        "p-4 transition-all group",
        alert.status === "triggered" ? "glass-card border-primary/30 !bg-primary/[0.06] shadow-primary/10"
        : alert.status === "paused"   ? "glass-card border-yellow-500/20 !bg-yellow-500/[0.04]"
        : "glass-card"
      )}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">{alert.symbol}</span>
          <StatusBadge status={alert.status} />
        </div>
        <div className="flex items-center gap-1">
          <AnimatedIconButton onClick={() => onTogglePause(alert.id)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/[0.08] text-muted-foreground hover:text-white transition-colors">
            {alert.status === "paused" ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </AnimatedIconButton>
          <AnimatedIconButton onClick={() => onDelete(alert.id)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </AnimatedIconButton>
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <ConditionIcon cond={alert.condition} />
        <span className="text-xs font-semibold text-white/80 capitalize">{alert.condition}</span>
        <span className="text-lg font-bold text-white ml-auto">{alert.targetPrice.toLocaleString()}</span>
      </div>
      {pct && <div className="text-[11px] text-muted-foreground/60 mb-2">Distance: <span className="text-white/70 font-mono">{pct}%</span></div>}
      {alert.notes && <p className="text-[11px] text-muted-foreground/60 border-t border-white/[0.05] pt-2.5 mt-2.5 leading-relaxed">{alert.notes}</p>}
      {alert.expiry && (
        <div className="flex items-center gap-1.5 mt-2.5 text-[10px] text-yellow-400/70">
          <Clock className="w-3 h-3" />
          Expires {new Date(alert.expiry).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </div>
      )}
    </AnimatedListItem>
  );
}

// ─── Zone Alert Card ───────────────────────────────────────────────────────────
function ZoneAlertCard({ alert, onTogglePause, onDelete, index = 0 }: {
  alert: ZoneAlert; onTogglePause: (id: string) => void; onDelete: (id: string) => void; index?: number;
}) {
  const zoneColors: Record<ZoneAlert["zoneType"], string> = {
    supply: "text-red-400", demand: "text-emerald-400",
    support_resistance: "text-blue-400", order_block: "text-orange-400",
  };
  const zoneLabels: Record<ZoneAlert["zoneType"], string> = {
    supply: "Supply Zone", demand: "Demand Zone",
    support_resistance: "S/R Zone", order_block: "Order Block",
  };

  return (
    <AnimatedListItem
      className={cn(
        "p-4 transition-all group",
        alert.status === "triggered" ? "glass-card border-primary/30 !bg-primary/[0.06] shadow-primary/10"
        : alert.status === "paused"   ? "glass-card border-yellow-500/20 !bg-yellow-500/[0.04]"
        : "glass-card"
      )}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-white">{alert.symbol}</span>
          <span className={`text-[10px] font-semibold ${zoneColors[alert.zoneType]}`}>{zoneLabels[alert.zoneType]}</span>
          <StatusBadge status={alert.status} />
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <AnimatedIconButton onClick={() => onTogglePause(alert.id)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/[0.08] text-muted-foreground hover:text-white transition-colors">
            {alert.status === "paused" ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </AnimatedIconButton>
          <AnimatedIconButton onClick={() => onDelete(alert.id)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </AnimatedIconButton>
        </div>
      </div>
      <div className="relative h-10 rounded-lg bg-white/[0.03] border border-white/[0.05] mb-3 flex items-center overflow-hidden">
        <div className={cn(
          "absolute inset-y-0 left-1/4 right-1/4 opacity-20 rounded",
          alert.zoneType === "supply"            ? "bg-red-500" :
          alert.zoneType === "demand"            ? "bg-emerald-500" :
          alert.zoneType === "order_block"       ? "bg-orange-500" : "bg-blue-500"
        )} />
        <div className="relative z-10 w-full px-3 flex items-center justify-between text-xs">
          <span className="font-mono text-white/70">{alert.lowerPrice.toLocaleString()}</span>
          <span className="text-[10px] text-white/40">Zone Range</span>
          <span className="font-mono text-white/70">{alert.upperPrice.toLocaleString()}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60">
        <div className="flex items-center gap-1"><ConditionIcon cond={alert.condition} /><span className="capitalize">{alert.condition}</span></div>
        <span className="w-1 h-1 rounded-full bg-white/20" />
        <span>{alert.timeframe}</span>
      </div>
      {alert.notes && <p className="text-[11px] text-muted-foreground/60 border-t border-white/[0.05] pt-2.5 mt-2.5 leading-relaxed">{alert.notes}</p>}
    </AnimatedListItem>
  );
}

// ─── Trendline Alert Card ──────────────────────────────────────────────────────
function TrendlineAlertCard({ alert, onTogglePause, onDelete }: {
  alert: TrendlineAlert; onTogglePause: (id: string) => void; onDelete: (id: string) => void;
}) {
  const isAscending = alert.point2Price > alert.point1Price;
  return (
    <AnimatedListItem
      className={cn(
        "p-4 transition-all group",
        alert.status === "triggered" ? "glass-card border-primary/30 !bg-primary/[0.06] shadow-primary/10"
        : alert.status === "paused"   ? "glass-card border-yellow-500/20 !bg-yellow-500/[0.04]"
        : "glass-card"
      )}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">{alert.symbol}</span>
          <span className="text-[10px] text-muted-foreground/60">{alert.timeframe}</span>
          <StatusBadge status={alert.status} />
        </div>
        <div className="flex items-center gap-1">
          <AnimatedIconButton onClick={() => onTogglePause(alert.id)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/[0.08] text-muted-foreground hover:text-white transition-colors">
            {alert.status === "paused" ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </AnimatedIconButton>
          <AnimatedIconButton onClick={() => onDelete(alert.id)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </AnimatedIconButton>
        </div>
      </div>
      <div className="relative h-12 rounded-lg bg-white/[0.02] border border-white/[0.04] mb-3 overflow-hidden">
        <svg viewBox="0 0 200 48" className="absolute inset-0 w-full h-full">
          <defs>
            <linearGradient id={`tl-${alert.id}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%"   stopColor={isAscending ? "#22c55e" : "#ef4444"} stopOpacity="0.3" />
              <stop offset="100%" stopColor={isAscending ? "#22c55e" : "#ef4444"} stopOpacity="0.8" />
            </linearGradient>
          </defs>
          <line x1="10" y1={isAscending ? 38 : 10} x2="190" y2={isAscending ? 10 : 38}
            stroke={`url(#tl-${alert.id})`} strokeWidth="1.5"
            strokeDasharray={alert.status === "paused" ? "4 3" : "0"} />
          <circle cx="10"  cy={isAscending ? 38 : 10} r="2.5" fill={isAscending ? "#22c55e" : "#ef4444"} />
          <circle cx="190" cy={isAscending ? 10 : 38} r="2.5" fill={isAscending ? "#22c55e" : "#ef4444"} />
        </svg>
        <div className="absolute inset-x-0 bottom-1 flex justify-between px-2 text-[9px] text-muted-foreground/40 font-mono">
          <span>{alert.point1Price}</span>
          <span>{isAscending ? "↗" : "↘"}</span>
          <span>{alert.point2Price}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60">
        <div className="flex items-center gap-1"><ConditionIcon cond={alert.condition} /><span className="capitalize">{alert.condition}</span></div>
        <span className="w-1 h-1 rounded-full bg-white/20" />
        <span className={isAscending ? "text-foreground/50" : "text-red-400/70"}>{isAscending ? "Ascending" : "Descending"}</span>
      </div>
      {alert.notes && <p className="text-[11px] text-muted-foreground/60 border-t border-white/[0.05] pt-2.5 mt-2.5 leading-relaxed">{alert.notes}</p>}
    </AnimatedListItem>
  );
}

// ─── Read-only Connection Status Widget ───────────────────────────────────────
type ConnStatus = { label: string; ok: boolean; color: string; icon: React.ElementType };

function ConnectionStatusWidget() {
  const [deltaOk, setDeltaOk]       = useState<boolean | null>(null);
  const [telegramOk, setTelegramOk] = useState<boolean | null>(null);
  const [, setLocation] = useLocation();

  useEffect(() => {
    const load = async () => {
      try {
        const [dl, tg] = await Promise.all([
          fetch("/api/delta/status").then(r => r.json())   as Promise<{ connected: boolean }>,
          fetch("/api/telegram/status").then(r => r.json()).catch(() => fetch("/api/telegram/config").then(r => r.json())) as Promise<{ enabled?: boolean; configured?: boolean }>,
        ]);
        setDeltaOk(dl.connected);
        setTelegramOk(!!(tg.enabled ?? tg.configured));
      } catch { /* ignore */ }
    };
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const conns: ConnStatus[] = [
    { label: "Delta",    ok: deltaOk    ?? false, color: "#8B5CF6", icon: Activity },
    { label: "Telegram", ok: telegramOk ?? false, color: "#2CA5E0", icon: Send },
  ];

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-bold text-white">Connections</span>
        </div>
        <button
          onClick={() => setLocation("/settings")}
          className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors font-semibold"
        >
          <SettingsIcon className="w-3 h-3" />
          Manage
        </button>
      </div>

      <div className="space-y-2">
        {conns.map(c => {
          const loaded = c.label === "Delta" ? deltaOk !== null
            : telegramOk !== null;
          return (
            <div key={c.label} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <c.icon className="w-3.5 h-3.5" style={{ color: c.color }} />
                <span className="text-[11px] text-muted-foreground/80">{c.label}</span>
              </div>
              {!loaded ? (
                <span className="text-[10px] text-muted-foreground/30">…</span>
              ) : c.ok ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  Live
                </span>
              ) : (
                <span className="text-[10px] font-semibold text-muted-foreground/40">Off</span>
              )}
            </div>
          );
        })}
      </div>

      <button
        onClick={() => setLocation("/settings")}
        className="w-full h-7 rounded-lg text-[11px] font-semibold border border-white/[0.08] text-muted-foreground hover:text-white hover:bg-white/[0.05] transition-all flex items-center justify-center gap-1.5"
      >
        <SettingsIcon className="w-3 h-3" />
        Open Settings
      </button>
    </div>
  );
}

// ─── API ↔ Frontend type converters ───────────────────────────────────────────
function getTypeAndNumericId(id: string): { type: "price" | "zone" | "trendline"; numId: string } {
  if (id.startsWith("p_")) return { type: "price",     numId: id.slice(2) };
  if (id.startsWith("z_")) return { type: "zone",      numId: id.slice(2) };
  if (id.startsWith("t_")) return { type: "trendline", numId: id.slice(2) };
  return { type: "price", numId: id };
}

function apiAlertToPriceAlert(a: Record<string, unknown>): PriceAlert {
  const condMap: Record<string, PriceAlert["condition"]> = {
    price_above: "above", price_below: "below", touch_price: "touch",
    percent_change_up: "percent_up", percent_change_down: "percent_down",
  };
  return {
    id: `p_${a["id"]}`, type: "price",
    symbol: a["symbol"] as string,
    condition: condMap[a["condition"] as string] ?? "above",
    targetPrice: a["targetPrice"] as number,
    currentPrice: 0,
    notes: (a["message"] as string) ?? "",
    status: a["isTriggered"] ? "triggered" : a["isActive"] ? "active" : "paused",
    expiry: null,
    createdAt: a["createdAt"] as string,
    triggeredAt: (a["triggeredAt"] as string | null) ?? null,
  };
}

function apiZoneToZoneAlert(z: Record<string, unknown>): ZoneAlert {
  return {
    id: `z_${z["id"]}`, type: "zone",
    symbol: z["symbol"] as string,
    zoneType: (z["zoneType"] as ZoneAlert["zoneType"]) ?? "support_resistance",
    upperPrice: z["upperPrice"] as number,
    lowerPrice: z["lowerPrice"] as number,
    timeframe: (z["timeframe"] as string) ?? "1H",
    condition: (z["condition"] as ZoneAlert["condition"]) ?? "touch",
    notes: (z["notes"] as string) ?? "",
    status: z["isTriggered"] ? "triggered" : z["isActive"] ? "active" : "paused",
    createdAt: z["createdAt"] as string,
    triggeredAt: (z["triggeredAt"] as string | null) ?? null,
  };
}

function apiTrendlineToTrendlineAlert(t: Record<string, unknown>): TrendlineAlert {
  return {
    id: `t_${t["id"]}`, type: "trendline",
    symbol: t["symbol"] as string,
    timeframe: (t["timeframe"] as string) ?? "1H",
    point1Price: t["point1Price"] as number,
    point1Time:  t["point1Time"]  as string,
    point2Price: t["point2Price"] as number,
    point2Time:  t["point2Time"]  as string,
    condition: (t["condition"] as TrendlineAlert["condition"]) ?? "break",
    drawingDisplayId: (t["drawingDisplayId"] as string | undefined) ?? `TL-${t["id"]}`,
    notes: (t["notes"] as string) ?? "",
    status: t["isTriggered"] ? "triggered" : t["isActive"] ? "active" : "paused",
    createdAt: t["createdAt"] as string,
    triggeredAt: (t["triggeredAt"] as string | null) ?? null,
  };
}

async function loadAllAlerts() {
  const [pa, za, ta, dr] = await Promise.all([
    fetch("/api/alerts").then(r => r.json()),
    fetch("/api/zones").then(r => r.json()),
    fetch("/api/trendlines").then(r => r.json()),
    fetch("/api/drawings").then(r => r.ok ? r.json() : []).catch(() => []),
  ]);

  // Reconcile older trendline alerts with the chart's persistent TL-NNN drawing ID.
  // Newer alerts already carry drawingDisplayId; this also repairs older alerts
  // by matching symbol/timeframe and the two chart anchor points.
  const drawings = toArray<Record<string, unknown>>(dr, "alerts.loadAllAlerts.drawings");
  const trendlineWithDrawingId = toArray<Record<string, unknown>>(
    ta, "alerts.loadAllAlerts.trendlineAlerts"
  ).map(t => {
    const alert = apiTrendlineToTrendlineAlert(t);
    const match = drawings.find(d => {
      if (String(d["symbol"] ?? "").toUpperCase() !== String(alert.symbol).toUpperCase()) return false;
      if (String(d["timeframe"] ?? "") !== String(alert.timeframe ?? "")) return false;
      const tool = String(d["toolType"] ?? "");
      if (!["trendline", "ray", "extended"].includes(tool)) return false;
      const points = Array.isArray(d["points"]) ? d["points"] as Array<Record<string, unknown>> : [];
      if (points.length < 2) return false;
      const p1 = points[0], p2 = points[1];
      const t1 = typeof p1["time"] === "number" ? p1["time"] * 1000 : new Date(String(p1["time"] ?? "")).getTime();
      const t2 = typeof p2["time"] === "number" ? p2["time"] * 1000 : new Date(String(p2["time"] ?? "")).getTime();
      return Number.isFinite(t1) && Number.isFinite(t2)
        && Math.abs(t1 - new Date(alert.point1Time).getTime()) <= 1500
        && Math.abs(t2 - new Date(alert.point2Time).getTime()) <= 1500
        && Math.abs(Number(p1["price"]) - Number(alert.point1Price)) < 1e-8
        && Math.abs(Number(p2["price"]) - Number(alert.point2Price)) < 1e-8;
    });
    if (!match) return alert;
    const displayId = typeof match["displayId"] === "string" && match["displayId"]
      ? match["displayId"]
      : "TL-" + String(match["id"] ?? "").padStart(3, "0");
    return { ...alert, drawingDisplayId: displayId };
  });

  return {
    priceAlerts: toArray<Record<string, unknown>>(pa, "alerts.loadAllAlerts.priceAlerts").map(apiAlertToPriceAlert),
    zoneAlerts: toArray<Record<string, unknown>>(za, "alerts.loadAllAlerts.zoneAlerts").map(apiZoneToZoneAlert),
    trendlineAlerts: trendlineWithDrawingId,
  };
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
type Tab = "price" | "zone" | "trendline" | "table";
type CreateModal = "price" | "zone" | "trendline";

interface AlertModalControllerHandle {
  open: (type: CreateModal) => void;
}

const AlertModalController = forwardRef<AlertModalControllerHandle, {
  onSavePriceAlert: (a: PriceAlert) => void;
  onSaveZoneAlert: (a: ZoneAlert) => void;
  onSaveTrendlineAlert: (a: TrendlineAlert) => void;
}>(function AlertModalController({ onSavePriceAlert, onSaveZoneAlert, onSaveTrendlineAlert }, ref) {
  const [createModal, setCreateModal] = useState<CreateModal | null>(null);

  useImperativeHandle(ref, () => ({
    open: (type) => {
      // Synchronous DOM mutations BEFORE React schedules the render.
      // Disables all glass-card backdrop-filters on the alerts page so the
      // GPU isn't compositing 17+ blur layers during the first animation frames.
      document.body.style.overflow = "hidden";
      document.body.classList.add("tj-modal-open");
      setCreateModal(type);
    },
  }), []);

  const handleClose = useCallback(() => {
    document.body.style.overflow = "";
    document.body.classList.remove("tj-modal-open");
    setCreateModal(null);
  }, []);

  const handleSavePrice = useCallback((a: PriceAlert) => {
    handleClose();
    onSavePriceAlert(a);
  }, [handleClose, onSavePriceAlert]);

  const handleSaveZone = useCallback((a: ZoneAlert) => {
    handleClose();
    onSaveZoneAlert(a);
  }, [handleClose, onSaveZoneAlert]);

  const handleSaveTrendline = useCallback((a: TrendlineAlert) => {
    handleClose();
    onSaveTrendlineAlert(a);
  }, [handleClose, onSaveTrendlineAlert]);

  return (
    <>
      {createModal === "price" && (
        <CreatePriceAlertModal onClose={handleClose} onSave={handleSavePrice} />
      )}
      {createModal === "zone" && (
        <CreateZoneAlertModal onClose={handleClose} onSave={handleSaveZone} />
      )}
      {createModal === "trendline" && (
        <CreateTrendlineAlertModal onClose={handleClose} onSave={handleSaveTrendline} />
      )}
    </>
  );
});

export default function Alerts() {
  const isMobile = useIsMobile();
  const [tab, setTab]               = useState<Tab>("price");
  const [showNotifications, setShowNotifications] = useState(false);
  const modalRef = useRef<AlertModalControllerHandle>(null);
  const [filterStatus, setFilterStatus]           = useState<AlertStatus | "all">("all");

  const { alerts, addAlert, updateAlert, deleteAlert: storeDeleteAlert, setAlerts } = useAlertStore();
  const priceAlerts     = alerts.filter((a): a is PriceAlert     => a.type === "price");
  const zoneAlerts      = alerts.filter((a): a is ZoneAlert      => a.type === "zone");
  const trendlineAlerts = alerts.filter((a): a is TrendlineAlert => a.type === "trendline");

  const { alertEvents: wsAlertEvents } = useLiveMarketContext();

  // ── Hydrate from DB on first mount ────────────────────────────────────────────
  // Replaces any stale localStorage data with the real DB state so that zone
  // alerts created from the Dashboard flow (which persists to DB) appear here.
  useEffect(() => {
    loadAllAlerts()
      .then(({ priceAlerts: pa, zoneAlerts: za, trendlineAlerts: ta }) => {
        setAlerts([...pa, ...za, ...ta]);
      })
      .catch(() => { /* keep localStorage data if API is unreachable */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allAlerts: AnyAlert[] = alerts;
  const totalActive    = allAlerts.filter(a => a.status === "active").length;
  const totalTriggered = allAlerts.filter(a => a.status === "triggered").length;
  const totalPaused    = allAlerts.filter(a => a.status === "paused").length;
  const unreadCount    = wsAlertEvents.length;

  const togglePause = useCallback((id: string) => {
    const { type, numId } = getTypeAndNumericId(id);
    const current = alerts.find(a => a.id === id);
    const isCurrentlyPaused = current?.status === "paused";
    updateAlert(id, { status: (isCurrentlyPaused ? "active" : "paused") as AlertStatus });
    const endpoint = type === "price" ? "/api/alerts" : type === "zone" ? "/api/zones" : "/api/trendlines";
    fetch(`${endpoint}/${numId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: isCurrentlyPaused }),
    }).catch(() => {});
  }, [alerts, updateAlert]);

  const deleteAlert = useCallback((id: string) => {
    // useAlertStore.deleteAlert() is the single DB delete path.
    // Keeping another fetch here caused duplicate DELETE requests.
    storeDeleteAlert(id);
  }, [storeDeleteAlert]);

  const handleSavePriceAlert = useCallback(async (a: PriceAlert) => {
    try {
      const res = await fetch("/api/alerts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: a.symbol,
          condition:
            a.condition === "above" ? "price_above" :
            a.condition === "below" ? "price_below" :
            a.condition === "touch" ? "touch_price" :
            a.condition === "percent_up" ? "percent_change_up" :
            "percent_change_down",
          targetPrice: a.targetPrice,
          message: a.notes || undefined,
          telegramEnabled: true,
        }),
      });
      if (res.ok) { const saved = await res.json(); addAlert(apiAlertToPriceAlert(saved as Record<string, unknown>)); }
      else addAlert(a);
    } catch { addAlert(a); }
  }, [addAlert]);

  const handleSaveZoneAlert = useCallback(async (a: ZoneAlert) => {
    try {
      const res = await fetch("/api/zones", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: a.symbol, upperPrice: a.upperPrice, lowerPrice: a.lowerPrice,
          zoneType: a.zoneType, timeframe: a.timeframe, condition: a.condition,
          notes: a.notes || undefined, telegramEnabled: true,
        }),
      });
      if (res.ok) { const saved = await res.json(); addAlert(apiZoneToZoneAlert(saved as Record<string, unknown>)); }
      else addAlert(a);
    } catch { addAlert(a); }
  }, [addAlert]);

  const handleSaveTrendlineAlert = useCallback(async (a: TrendlineAlert) => {
    try {
      const res = await fetch("/api/trendlines", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: a.symbol, timeframe: a.timeframe,
          point1Price: a.point1Price, point1Time: a.point1Time,
          point2Price: a.point2Price, point2Time: a.point2Time,
          condition: a.condition, notes: a.notes || undefined, telegramEnabled: true,
        }),
      });
      if (res.ok) { const saved = await res.json(); addAlert(apiTrendlineToTrendlineAlert(saved as Record<string, unknown>)); }
      else addAlert(a);
    } catch { addAlert(a); }
  }, [addAlert]);

  const filteredTable = filterStatus === "all" ? allAlerts : allAlerts.filter(a => a.status === filterStatus);

  const tabs: { key: Tab; label: string; Icon: React.ElementType; count: number; color: string }[] = [
    { key: "price",     label: "Price Alerts",    Icon: Target,    count: priceAlerts.length,     color: "text-blue-400" },
    { key: "zone",      label: "Zone Alerts",      Icon: Layers,    count: zoneAlerts.length,      color: "text-orange-400" },
    { key: "trendline", label: "Trendline Alerts", Icon: GitBranch, count: trendlineAlerts.length, color: "text-primary" },
    { key: "table",     label: "All Alerts",       Icon: Filter,    count: allAlerts.length,       color: "text-white/60" },
  ];

  const createBtnLabel = tab === "price" ? "Price Alert"
    : tab === "zone" ? "Zone Alert"
    : tab === "trendline" ? "Trendline Alert"
    : null;

  return (
    <PageTransition fill={false}>
      <div className="space-y-5">
        {/* ── Header ──────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Alerts Center</h1>
          <p className="text-sm text-muted-foreground/60 mt-0.5">Monitor price levels, zones, and trendlines across all assets</p>
        </div>
        <div className="flex items-center gap-2">
          <AnimatedIconButton
            onClick={() => setShowNotifications(v => !v)}
            className="relative h-9 w-9 flex items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] text-muted-foreground hover:text-white transition-all"
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white border border-background">
                {unreadCount}
              </span>
            )}
          </AnimatedIconButton>
          {createBtnLabel && (
            <AddAlertPillButton
              label={createBtnLabel}
              onClick={() => modalRef.current?.open(tab as CreateModal)}
            />
          )}
        </div>
      </div>

      <AnimatePresence>
        {showNotifications && <NotificationPanel onClose={() => setShowNotifications(false)} />}
      </AnimatePresence>

      {/* ── Stats strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Active Alerts",   value: totalActive,    icon: Activity, color: "text-blue-400",    bg: "bg-blue-400/10",    dot: "bg-blue-400",    animated: true },
          { label: "Triggered Today", value: totalTriggered, icon: Zap,      color: "text-primary",     bg: "bg-primary/10",     dot: "bg-primary",     animated: false },
          { label: "Paused Alerts",   value: totalPaused,    icon: Pause,    color: "text-yellow-400",  bg: "bg-yellow-400/10",  dot: "bg-yellow-400",  animated: false },
          { label: "Total Alerts",    value: allAlerts.length, icon: Bell,   color: "text-blue-400",    bg: "bg-blue-400/10",    dot: "bg-blue-400",    animated: false },
        ].map((w, idx) => (
          <AnimatedCard key={w.label} index={idx} className="glass-card p-4 flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl ${w.bg} flex items-center justify-center flex-shrink-0`}>
              <w.icon className={`w-4 h-4 ${w.color}`} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-semibold truncate">{w.label}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-lg font-bold text-white"><NumberCounter value={w.value} /></span>
                {w.animated && (
                  <span className="relative flex h-2 w-2">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${w.dot} opacity-60`} />
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${w.dot}`} />
                  </span>
                )}
              </div>
            </div>
          </AnimatedCard>
        ))}
      </div>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-5">
        {/* Left: Tabs + Alerts */}
        <div className="space-y-4">
          {/* Tab bar */}
          <div className="flex gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06] w-full overflow-x-auto">
            {tabs.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-all flex-1 justify-center",
                  tab === t.key ? "bg-white/[0.08] text-white shadow-sm" : "text-muted-foreground hover:text-white"
                )}>
                <t.Icon className={cn("w-3.5 h-3.5", tab === t.key ? t.color : "")} />
                <span className="hidden sm:inline">{t.label}</span>
                <span className={cn(
                  "text-[10px] font-bold px-1.5 py-0.5 rounded-full",
                  tab === t.key ? "bg-primary/20 text-primary" : "bg-white/[0.08] text-muted-foreground"
                )}>{t.count}</span>
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            {/* Price Alerts */}
            {tab === "price" && (
              <motion.div key="price" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={tweenFast}>
                <AnimatedPresenceList className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {priceAlerts.map(a => <PriceAlertCard key={a.id} alert={a} onTogglePause={togglePause} onDelete={deleteAlert} />)}
                  <div className="rounded-xl border border-dashed border-white/[0.1] flex items-center justify-center min-h-[120px]">
                    <AddAlertPillButton label="Price Alert" onClick={() => modalRef.current?.open("price")} />
                  </div>
                </AnimatedPresenceList>
              </motion.div>
            )}

            {/* Zone Alerts */}
            {tab === "zone" && (
              <motion.div key="zone" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={tweenFast}>
                <AnimatedPresenceList className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {zoneAlerts.map(a => <ZoneAlertCard key={a.id} alert={a} onTogglePause={togglePause} onDelete={deleteAlert} />)}
                  <div className="rounded-xl border border-dashed border-white/[0.1] flex items-center justify-center min-h-[120px]">
                    <AddAlertPillButton label="Zone Alert" onClick={() => modalRef.current?.open("zone")} />
                  </div>
                </AnimatedPresenceList>
              </motion.div>
            )}

            {/* Trendline Alerts */}
            {tab === "trendline" && (
              <motion.div key="trendline" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={tweenFast}>
                <AnimatedPresenceList className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {trendlineAlerts.map(a => <TrendlineAlertCard key={a.id} alert={a} onTogglePause={togglePause} onDelete={deleteAlert} />)}
                  <div className="rounded-xl border border-dashed border-white/[0.1] flex items-center justify-center min-h-[120px]">
                    <AddAlertPillButton label="Trendline Alert" onClick={() => modalRef.current?.open("trendline")} />
                  </div>
                </AnimatedPresenceList>
              </motion.div>
            )}

            {/* All Alerts Table */}
            {tab === "table" && (
              <motion.div key="table" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={tweenFast}>
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  {(["all", "active", "triggered", "paused"] as const).map(f => (
                    <button key={f} onClick={() => setFilterStatus(f)}
                      className={cn(
                        "px-3 py-1 rounded-full text-xs font-semibold capitalize border transition-all",
                        filterStatus === f
                          ? "bg-primary/20 border-primary/40 text-primary"
                          : "border-white/[0.08] text-muted-foreground hover:border-white/20 hover:text-white"
                      )}>
                      {f} {f === "all" ? `(${allAlerts.length})` : `(${allAlerts.filter(a => a.status === f).length})`}
                    </button>
                  ))}
                </div>
                <div className="rounded-xl border border-white/[0.06] overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                          {["Symbol", "Type", "Condition", "Target", "Status", "Notes", "Created", "Triggered", "Actions"].map(h => (
                            <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <AnimatePresence>
                          {filteredTable.map(a => <AlertRow key={a.id} alert={a} onTogglePause={togglePause} onDelete={deleteAlert} />)}
                        </AnimatePresence>
                        {filteredTable.length === 0 && (
                          <tr>
                            <td colSpan={9} className="px-4 py-10 text-center text-xs text-muted-foreground/50">
                              No alerts found for this filter
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right: Sidebar */}
        <div className="space-y-4">
          {/* Read-only connection status */}
          <ConnectionStatusWidget />

          {/* Recent Triggers */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2 mb-3">
              <BellRing className="w-4 h-4 text-primary" />
              <h3 className="text-xs font-semibold text-white">Recent Triggers</h3>
              {unreadCount > 0 && (
                <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/20">{unreadCount} new</span>
              )}
            </div>
            <div className="space-y-2">
              {wsAlertEvents.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/40 text-center py-4">No alerts triggered yet</p>
              ) : (
                wsAlertEvents.slice().reverse().slice(0, 4).map((ev, i) => (
                  <div key={`${ev.alertId}-${i}`} className={cn(
                    "flex items-start gap-2.5 p-2.5 rounded-lg border-l-2 transition-colors",
                    ev.alertType === "trendline" ? "border-l-primary/60 bg-primary/5" :
                    ev.alertType === "zone"      ? "border-l-orange-400 bg-orange-500/5" :
                    "border-l-blue-400 bg-blue-500/5"
                  )}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[11px] font-bold text-white">{ev.symbol}</span>
                        <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                      </div>
                      <p className="text-[10px] text-muted-foreground/60 leading-relaxed truncate">{ev.message}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Alert Stats */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <h3 className="text-xs font-semibold text-white mb-3 flex items-center gap-2">
              <Info className="w-3.5 h-3.5 text-muted-foreground/60" />
              Alert Stats
            </h3>
            <div className="space-y-2.5">
              {[
                { label: "Price Alerts", val: priceAlerts.length,     color: "bg-blue-400" },
                { label: "Zone Alerts",  val: zoneAlerts.length,      color: "bg-orange-400" },
                { label: "Trendlines",   val: trendlineAlerts.length, color: "bg-primary" },
              ].map(s => (
                <div key={s.label} className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${s.color} flex-shrink-0`} />
                  <span className="text-[11px] text-muted-foreground/70 flex-1">{s.label}</span>
                  <span className="text-xs font-bold text-white">{s.val}</span>
                  <div className="w-16 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className={`h-full rounded-full ${s.color} opacity-60`}
                      style={{ width: allAlerts.length > 0 ? `${(s.val / allAlerts.length) * 100}%` : "0%" }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <AlertModalController
        ref={modalRef}
        onSavePriceAlert={handleSavePriceAlert}
        onSaveZoneAlert={handleSaveZoneAlert}
        onSaveTrendlineAlert={handleSaveTrendlineAlert}
      />
    </div>
    </PageTransition>
  );
}
