// Build-time Telegram alert formatting patch: keep alert messages clean and readable.
import fs from "node:fs";

const path = "artifacts/api-server/src/services/TelegramService.ts";
let s = fs.readFileSync(path, "utf8");

const replacements = [
  ["`📊 <b>Symbol:</b> ${opts.symbol}`", "`<b>Symbol:</b> ${opts.symbol}`"],
  ["`⏱ <b>Timeframe:</b> ${opts.timeframe}`", "`<b>Timeframe:</b> ${opts.timeframe}`"],
  ["`📐 <b>Line Price:</b> $${opts.projectedPrice.toFixed(5)}`", "`<b>Line Price:</b> ${opts.projectedPrice.toFixed(5)}`"],
  ["`💹 <b>Triggered at:</b> $${opts.triggeredPrice.toFixed(5)}`", "`<b>Triggered Price:</b> ${opts.triggeredPrice.toFixed(5)}`"],
  ["`📍 <b>Event:</b> ${this.trendlineEventText(opts.condition, opts.direction)}`", "`<b>Event:</b> ${this.trendlineEventText(opts.condition, opts.direction)}`"],
  ["opts.notes ? `📝 <b>Notes:</b> ${opts.notes}` : null", "opts.notes ? `<b>Notes:</b> ${opts.notes}` : null"],
  ["`⏰ ${new Date().toUTCString()}`", "`<b>Time:</b> ${new Date().toUTCString()}`"],
  ["`🗂 <b>Zone:</b> ${zoneLabel}`", "`<b>Zone:</b> ${zoneLabel}`"],
  ["`📏 <b>Range:</b> $${opts.lowerPrice.toFixed(5)} – $${opts.upperPrice.toFixed(5)}`", "`<b>Range:</b> ${opts.lowerPrice.toFixed(5)} – ${opts.upperPrice.toFixed(5)}`"],
  ["`💹 <b>Price:</b> $${opts.triggeredPrice.toFixed(5)}`", "`<b>Price:</b> ${opts.triggeredPrice.toFixed(5)}`"],
  ["`📍 <b>Event:</b> ${eventText[opts.direction] ?? opts.direction}`", "`<b>Event:</b> ${eventText[opts.direction] ?? opts.direction}`"],
  ["`🎯 <b>Condition:</b> ${conditionLabel[opts.condition] ?? opts.condition.replace(/_/g, \" \")}`", "`<b>Condition:</b> ${conditionLabel[opts.condition] ?? opts.condition.replace(/_/g, \" \")}`"],
  ["`🎯 <b>Target:</b> $${opts.targetPrice}`", "`<b>Target:</b> ${opts.targetPrice}`"],
  ["`🗂 <b>Zone:</b> ${opts.zoneType.replace(/_/g, \" \")}`", "`<b>Zone:</b> ${opts.zoneType.replace(/_/g, \" \")}`"],
  ["`📏 <b>Range:</b> ${opts.lowerPrice} – ${opts.upperPrice}`", "`<b>Range:</b> ${opts.lowerPrice} – ${opts.upperPrice}`"],
  ["`📐 <b>Drawing:</b> ${opts.drawingType.replace(/_/g, \" \")}`", "`<b>Drawing:</b> ${opts.drawingType.replace(/_/g, \" \")}`"],
  ["`💹 <b>Triggered at:</b> $${opts.triggeredPrice}`", "`<b>Triggered Price:</b> ${opts.triggeredPrice}`"],
  ["`📝 <b>Note:</b> ${opts.message}`", "`<b>Note:</b> ${opts.message}`"],
  ["`🎯 <b>${meta.valueLabel}:</b> ${target}`", "`<b>${meta.valueLabel}:</b> ${target}`"],
  ["`${emoji} <b>Symbol:</b> ${opts.symbol}`", "`<b>Symbol:</b> ${opts.symbol}`"],
  ["`⚡ <b>Condition:</b> ${opts.conditionLabel}`", "`<b>Condition:</b> ${opts.conditionLabel}`"],
  ["`📐 <b>Line Price:</b> ${opts.projectedPrice.toFixed(5)}`", "`<b>Line Price:</b> ${opts.projectedPrice.toFixed(5)}`"],
  ["`💹 <b>Triggered at:</b> ${opts.triggeredPrice.toFixed(5)}`", "`<b>Triggered Price:</b> ${opts.triggeredPrice.toFixed(5)}`"],
  ["`⏱ <b>Timeframe:</b> ${opts.timeframe}`", "`<b>Timeframe:</b> ${opts.timeframe}`"],
];

for (const [from, to] of replacements) s = s.replaceAll(from, to);

fs.writeFileSync(path, s);
console.log("Telegram alert formatting patched for clean Telegram output — final deployment.");
