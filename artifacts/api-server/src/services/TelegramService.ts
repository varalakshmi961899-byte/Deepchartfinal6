import { db, pool, settingsTable, watchlistTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { AppConfigService } from "./AppConfigService.js";
import { ctraderTickEngine } from "./CtraderTickEngine.js";
import { getCtraderSymbolRow } from "../routes/ctrader_spots.js";

const TELEGRAM_API = "https://api.telegram.org";

const KEY_GLOBAL_ENABLED = "telegram_global_enabled";

function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 10)}...${token.slice(-4)}`;
}

export class TelegramService {
  private botToken:      string | undefined;
  private chatId:        string | undefined;
  private enabled:       boolean = false;
  private globalEnabled: boolean = true;  // global on/off toggle (does not disconnect)
  private interactionRunning = false;
  private interactionAbort?: AbortController;
  private updateOffset = 0;
  private alertEngine?: { reloadAlerts?: () => Promise<void> };

  setAlertEngine(engine: { reloadAlerts?: () => Promise<void> }): void { this.alertEngine = engine; }

  constructor() {
    this.botToken = process.env["TELEGRAM_BOT_TOKEN"];
    this.chatId   = process.env["TELEGRAM_CHAT_ID"];
    this.enabled  = !!(this.botToken && this.chatId);
  }

  async init(): Promise<void> {
    // Load global enabled flag from settings table
    try {
      const rows = await db.select().from(settingsTable)
        .where(eq(settingsTable.key, KEY_GLOBAL_ENABLED));
      if (rows[0]) {
        this.globalEnabled = rows[0].value !== "false";
      }
    } catch (err) {
      logger.warn({ err }, "TelegramService: could not load global enabled flag");
    }

    // Load encrypted credentials from AppConfigService
    try {
      const dbToken  = await AppConfigService.get("TELEGRAM_BOT_TOKEN");
      const dbChatId = await AppConfigService.get("TELEGRAM_CHAT_ID");

      if (dbToken && dbChatId) {
        this.botToken = dbToken;
        this.chatId   = dbChatId;
        this.enabled  = true;
        logger.info(
          { tokenMasked: maskToken(dbToken), chatId: dbChatId, source: "db_encrypted" },
          "TelegramService: loaded credentials from encrypted DB",
        );
        return;
      }
    } catch (err) {
      logger.warn({ err }, "TelegramService: could not load credentials from AppConfigService, using env vars");
    }

    if (this.enabled) {
      logger.info(
        { tokenMasked: maskToken(this.botToken!), chatId: this.chatId, source: "env" },
        "TelegramService: enabled from env vars",
      );
    } else {
      logger.warn("TelegramService: disabled — set credentials via UI or env vars");
    }
  }

  async configure(token: string, chatId: string): Promise<{ success: boolean; error?: string; errorType?: "invalid_token" | "invalid_chat" | "network_error" | "unknown" }> {
    // Step 1: Validate token via getMe (fast, no side-effects)
    let meRes: Response;
    try {
      meRes = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "TelegramService: getMe network error");
      return { success: false, error: `Network error — cannot reach Telegram API (${msg})`, errorType: "network_error" };
    }

    if (!meRes.ok) {
      const body = await meRes.json().catch(() => ({})) as { description?: string };
      const desc = body.description ?? `HTTP ${meRes.status}`;
      logger.warn({ status: meRes.status, desc }, "TelegramService: invalid bot token");
      return {
        success:   false,
        error:     `Invalid bot token — ${desc}. Copy it directly from @BotFather.`,
        errorType: "invalid_token",
      };
    }

    // Step 2: Validate chat ID by sending the welcome message
    let msgRes: Response;
    try {
      msgRes = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          chat_id:    chatId,
          text:       "✅ <b>TradeVault Connected!</b>\n\nYour Telegram bot is now configured and ready to receive alerts.",
          parse_mode: "HTML",
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "TelegramService: sendMessage network error");
      return { success: false, error: `Network error while sending test message (${msg})`, errorType: "network_error" };
    }

    if (!msgRes.ok) {
      const body = await msgRes.json().catch(() => ({})) as { description?: string };
      const desc = body.description ?? `HTTP ${msgRes.status}`;
      logger.warn({ status: msgRes.status, desc, chatId }, "TelegramService: invalid chat ID");
      return {
        success:   false,
        error:     `Chat ID invalid — ${desc}. Make sure you have started the bot (send /start) and the Chat ID is correct.`,
        errorType: "invalid_chat",
      };
    }

    // Step 3: Persist credentials encrypted via AppConfigService
    try {
      await AppConfigService.set("TELEGRAM_BOT_TOKEN", token);
      await AppConfigService.set("TELEGRAM_CHAT_ID", chatId);
    } catch (err) {
      logger.error({ err }, "TelegramService: failed to persist credentials to encrypted DB");
      return { success: false, error: "Failed to save credentials to database — please try again.", errorType: "unknown" };
    }

    this.botToken = token;
    this.chatId   = chatId;
    this.enabled  = true;
    await this.startInteractionListener();

    logger.info({ tokenMasked: maskToken(token), chatId }, "TelegramService: configured via UI (encrypted)");
    return { success: true };
  }

  async disconnect(): Promise<void> {
    await this.stopInteractionListener();
    try {
      await AppConfigService.delete("TELEGRAM_BOT_TOKEN");
      await AppConfigService.delete("TELEGRAM_CHAT_ID");
    } catch (err) {
      logger.warn({ err }, "TelegramService: error clearing encrypted DB config");
    }
    this.botToken = process.env["TELEGRAM_BOT_TOKEN"];
    this.chatId   = process.env["TELEGRAM_CHAT_ID"];
    this.enabled  = !!(this.botToken && this.chatId);
    logger.info("TelegramService: disconnected (encrypted credentials cleared)");
  }

  /** Global on/off toggle — does not remove credentials, just suppresses delivery. */
  async setGlobalEnabled(value: boolean): Promise<void> {
    this.globalEnabled = value;
    try {
      await db.insert(settingsTable)
        .values({ key: KEY_GLOBAL_ENABLED, value: String(value), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set:    { value: String(value), updatedAt: new Date() },
        });
      logger.info({ globalEnabled: value }, "TelegramService: global enabled flag updated");
    } catch (err) {
      logger.warn({ err }, "TelegramService: failed to persist global enabled flag");
    }
  }


  /** Start Telegram command/callback handling. Webhook if configured, otherwise getUpdates polling. */
  async startInteractionListener(): Promise<void> {
    if (!this.enabled || !this.botToken || this.interactionRunning) return;
    this.interactionRunning = true;
    this.interactionAbort = new AbortController();
    const webhookUrl = process.env["TELEGRAM_WEBHOOK_URL"]?.trim();
    if (webhookUrl) {
      await this.configureWebhook(webhookUrl);
      logger.info({ webhookUrl }, "TelegramService: webhook interaction mode enabled");
    } else {
      logger.info("TelegramService: getUpdates polling interaction mode enabled");
      void this.pollUpdates();
    }
  }

  async stopInteractionListener(): Promise<void> {
    this.interactionRunning = false;
    this.interactionAbort?.abort();
    this.interactionAbort = undefined;
  }

  private async configureWebhook(baseUrl: string): Promise<void> {
    if (!this.botToken) return;
    const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const url = `${cleanBaseUrl}/api/telegram/webhook`;
    const secret = process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim();
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.botToken}/setWebhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, ...(secret ? { secret_token: secret } : {}), allowed_updates: ["message", "callback_query"] }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) logger.error({ status: response.status, body, url }, "TelegramService: failed to configure webhook");
    } catch (err) {
      logger.error({ err, url }, "TelegramService: webhook configuration failed");
    }
  }

  async handleWebhookUpdate(update: unknown): Promise<void> {
    await this.handleTelegramUpdate(update);
  }

  private async pollUpdates(): Promise<void> {
    while (this.interactionRunning && this.botToken) {
      try {
        const query = new URLSearchParams({ timeout: "25", offset: String(this.updateOffset), allowed_updates: JSON.stringify(["message", "callback_query"]) });
        const response = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getUpdates?${query.toString()}`, { signal: this.interactionAbort?.signal });
        const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: Array<{ update_id: number; [key: string]: unknown }>; description?: string };
        if (!response.ok || !body.ok) {
          logger.warn({ status: response.status, description: body.description }, "TelegramService: getUpdates failed");
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
        for (const update of body.result ?? []) {
          this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
          await this.handleTelegramUpdate(update);
        }
      } catch (err) {
        if (!this.interactionRunning) break;
        logger.warn({ err }, "TelegramService: getUpdates polling error");
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  private async handleTelegramUpdate(update: unknown): Promise<void> {
    if (!update || typeof update !== "object") return;
    const u = update as Record<string, any>;
    const message = u.message as Record<string, any> | undefined;
    const callback = u.callback_query as Record<string, any> | undefined;
    const chatId = String(message?.chat?.id ?? callback?.message?.chat?.id ?? "");
    if (!chatId || !this.chatId || chatId !== String(this.chatId)) {
      logger.warn({ chatId }, "TelegramService: unauthorized interaction ignored");
      if (callback?.id) await this.answerCallbackQuery(String(callback.id), "Unauthorized", true);
      return;
    }
    if (message?.text === "/start" || message?.text === "/menu") {
      await this.sendMainMenu(chatId);
      return;
    }
    if (callback?.id && typeof callback?.data === "string") {
      await this.handleCallback(String(callback.id), chatId, callback.data);
    }
  }

  private async answerCallbackQuery(id: string, text?: string, showAlert = false): Promise<void> {
    if (!this.botToken) return;
    try {
      await fetch(`${TELEGRAM_API}/bot${this.botToken}/answerCallbackQuery`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: id, ...(text ? { text } : {}), show_alert: showAlert }),
      });
    } catch (err) { logger.debug({ err }, "TelegramService: answerCallbackQuery failed"); }
  }

  private async handleCallback(callbackId: string, chatId: string, data: string): Promise<void> {
    await this.answerCallbackQuery(callbackId);
    try {
      if (data === "menu:home") { await this.sendMainMenu(chatId); return; }
      if (data === "menu:trendlines" || data === "menu:modify" || data === "menu:snooze" || data === "menu:resume" || data === "menu:delete") {
        await this.sendTrendlineList(chatId, data === "menu:trendlines" ? "📈 <b>TRENDLINES</b>" : "🎛 <b>SELECT TRENDLINE</b>");
        return;
      }
      if (data === "menu:alerts") { await this.sendRecentAlerts(chatId); return; }
      if (data === "menu:scanner") { await this.sendScanner(chatId); return; }
      if (data.startsWith("sc:")) { await this.sendScannerDetail(chatId, data.slice(3)); return; }
      if (data.startsWith("scd:")) { await this.sendScannerDetail(chatId, data.slice(4)); return; }
      if (data === "menu:create") {
        await this.sendMessage("➕ <b>CREATE</b>\n\nCreation is chart-linked because the trendline coordinates come from the chart. Create the trendline in DeepChart, then use this Telegram menu to modify, snooze, resume or delete it.", chatId, true, this.backKeyboard());
        return;
      }
      if (data === "menu:stats") { await this.sendStatistics(chatId); return; }
      if (data.startsWith("tl:")) { await this.sendTrendlineDetail(chatId, Number(data.slice(3))); return; }
      if (data.startsWith("tm:")) { await this.sendModifyMenu(chatId, Number(data.slice(3))); return; }
      if (data.startsWith("tc:")) {
        const [, idText, condition] = data.split(":");
        await this.modifyTrendline(chatId, Number(idText), "condition", condition);
        return;
      }
      if (data.startsWith("tg:")) {
        await this.toggleTelegram(chatId, Number(data.slice(3)));
        return;
      }
      if (data.startsWith("ts:")) {
        await this.setTrendlineStatus(chatId, Number(data.slice(3)), "paused");
        return;
      }
      if (data.startsWith("tr:")) {
        await this.setTrendlineStatus(chatId, Number(data.slice(3)), "active");
        return;
      }
      if (data.startsWith("td:")) {
        const id = Number(data.slice(3));
        await this.sendMessage("⚠️ <b>CONFIRM DELETE</b>\n\nThis removes the existing trendline alert from the database and chart alert engine.\n\nDelete it?", chatId, true, {
          inline_keyboard: [[
            { text: "✅ Yes, Delete", callback_data: `ty:${id}` },
            { text: "❌ Cancel", callback_data: `tl:${id}` },
          ]]
        });
        return;
      }
      if (data.startsWith("ty:")) {
        await this.deleteTrendline(chatId, Number(data.slice(3)));
        return;
      }
      if (data.startsWith("tn:")) {
        await this.sendTrendlineList(chatId, "📈 <b>TRENDLINES</b>");
        return;
      }
      if (data.startsWith("ae:")) { await this.sendAlertDetail(chatId, Number(data.slice(3))); return; }
      if (data === "alerts:list") { await this.sendRecentAlerts(chatId); return; }
      if (data === "refresh:all") { await this.sendMainMenu(chatId); return; }
    } catch (err) {
      logger.error({ err, callbackData: data }, "TelegramService: phase 2 callback failed");
      await this.sendMessage("❌ <b>Action failed</b>\n\nThe operation could not be completed. Please refresh and try again.", chatId, true, this.backKeyboard());
    }
  }

  private readonly scannerTimeframes = [
    { key: "15", label: "15m" },
    { key: "60", label: "1H" },
    { key: "240", label: "4H" },
  ];

  private normalizeScannerSymbol(symbol: string): string {
    const s = String(symbol).toUpperCase().trim().replace(/\.(pro|raw|ecn|std)$/i, "");
    if (s.endsWith("USDT")) return s;
    if (s.endsWith("USD")) return s.slice(0, -3) + "USDT";
    return s + "USDT";
  }

  private calculateEma(values: number[], period: number): number | null {
    if (values.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    for (let i = period; i < values.length; i++) ema = (values[i] - ema) * multiplier + ema;
    return ema;
  }

  private async fetchScannerEma(symbol: string, interval: string): Promise<{
    symbol: string; interval: string; price: number; ema20: number; ema50: number; ema200: number;
    bullish20: boolean; bullish50: boolean; bullish200: boolean;
    trend: "STRONG BULL" | "BULL" | "MIXED" | "BEAR" | "STRONG BEAR";
  }> {
    // Use the same market-data boundary as DeepChart itself:
    // cTrader for FX/metals/indices/other non-crypto watchlist symbols,
    // Bybit linear futures for crypto symbols such as SOLUSD/BTCUSD.
    const ctraderRow = await getCtraderSymbolRow(symbol).catch(() => null);
    let closes: number[];

    if (ctraderRow) {
      // Match the same sequence used by the chart's /candles route:
      // wait for the authenticated cTrader session, make sure the symbol is
      // subscribed, then request historical trendbars on that live session.
      let status = ctraderTickEngine.getStatus();
      if (status.status !== "streaming") {
        throw new Error("cTrader market feed is not streaming (status=" + status.status + ")");
      }
      if (!status.subscribedSymbols.some((name: string) => name.toUpperCase() === ctraderRow.symbolName.toUpperCase())) {
        ctraderTickEngine.addSymbol(ctraderRow.symbolId, ctraderRow.symbolName);
        // Subscription is not required by the cTrader historical API itself,
        // but adding it keeps scanner and chart on the exact same market-data path.
      }

      let bars: Awaited<ReturnType<typeof ctraderTickEngine.fetchTrendbarsOnSession>>;
      try {
        bars = await ctraderTickEngine.fetchTrendbarsOnSession(
          ctraderRow.symbolId,
          interval,
          500,
          15_000,
        );
      } catch (firstErr) {
        // One short retry handles the race where cTrader has just transitioned
        // from account-auth/subscribing to streaming.
        status = ctraderTickEngine.getStatus();
        if (status.status !== "streaming") {
          throw firstErr;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        bars = await ctraderTickEngine.fetchTrendbarsOnSession(
          ctraderRow.symbolId,
          interval,
          500,
          15_000,
        );
      }
      if (!bars.length) throw new Error("No cTrader trendbars returned");
      closes = bars
        .slice()
        .sort((a, b) => a.time - b.time)
        .map(bar => Number(bar.close))
        .filter(Number.isFinite);
    } else {
      const normalized = this.normalizeScannerSymbol(symbol);
      const params = new URLSearchParams({ category: "linear", symbol: normalized, interval, limit: "500" });
      const response = await fetch("https://api.bybit.com/v5/market/kline?" + params.toString(), { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("Bybit HTTP " + response.status);
      const json = await response.json() as { retCode?: number; retMsg?: string; result?: { list?: string[][] } };
      if (json.retCode !== 0) throw new Error("Bybit " + json.retCode + ": " + (json.retMsg ?? "unknown error"));
      closes = (json.result?.list ?? [])
        .map(row => Number(row[4]))
        .filter(Number.isFinite)
        .reverse();
    }

    if (closes.length < 200) throw new Error("Not enough candle history for EMA200");
    const price = closes.at(-1)!;
    const ema20 = this.calculateEma(closes, 20);
    const ema50 = this.calculateEma(closes, 50);
    const ema200 = this.calculateEma(closes, 200);
    if (ema20 == null || ema50 == null || ema200 == null) throw new Error("EMA calculation failed");
    const bullish20 = price >= ema20, bullish50 = price >= ema50, bullish200 = price >= ema200;
    const strongBull = price >= ema20 && ema20 > ema50 && ema50 > ema200;
    const strongBear = price <= ema20 && ema20 < ema50 && ema50 < ema200;
    const bull = price >= ema50 && ema20 >= ema50;
    const bear = price <= ema50 && ema20 <= ema50;
    const trend = strongBull ? "STRONG BULL" : strongBear ? "STRONG BEAR" : bull ? "BULL" : bear ? "BEAR" : "MIXED";
    return { symbol, interval, price, ema20, ema50, ema200, bullish20, bullish50, bullish200, trend };
  }

  private scannerBadge(trend: string): string {
    if (trend === "STRONG BULL" || trend === "BULL") return "🟢";
    
    if (trend === "STRONG BEAR" || trend === "BEAR") return "🔴";
    
    return "🟡";
  }

  private scannerTrendLabel(trend: string): string {
    const labels: Record<string, string> = {
      "STRONG BULL": "Strong Bull",
      "BULL": "Bull",
      "MIXED": "Mixed",
      "BEAR": "Bear",
      "STRONG BEAR": "Strong Bear",
    };
    return labels[trend] ?? trend;
  }

  private formatScannerNumber(value: number): string {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (Math.abs(value) >= 1) return value.toFixed(4);
    return value.toPrecision(6);
  }

  private async sendScanner(chatId: string): Promise<void> {
    const rows = await db.select().from(watchlistTable).where(eq(watchlistTable.isFavorite, true)).orderBy(watchlistTable.position);
    if (!rows.length) {
      await this.sendMessage("<b>MARKET SCANNER</b>\n\n⚠️ Your DeepChart watchlist is empty.\nAdd coins to the app Watchlist first, then scan again.", chatId, true, this.backKeyboard());
      return;
    }
    await this.sendMessage("<b>MARKET SCANNER</b>\n\n<b>Watchlist EMA scan</b>\nTimeframes: 15m • 1H • 4H\nIndicators: EMA 20 • EMA 50 • EMA 200\n\nScanning your current Watchlist…", chatId, true);
    const results: Array<{
      symbol: string;
      details: Awaited<ReturnType<TelegramService["fetchScannerEma"]>>[];
      errors: string[];
    }> = [];
    // Keep every active Watchlist symbol in the Telegram result. A data-source
    // failure must never silently remove a symbol from the user's Watchlist.
    for (const row of rows.slice(0, 40)) {
      const details: Awaited<ReturnType<TelegramService["fetchScannerEma"]>>[] = [];
      const errors: string[] = [];
      for (const tf of this.scannerTimeframes) {
        try {
          details.push(await this.fetchScannerEma(row.symbol, tf.key));
        } catch (err) {
          const message = String(err);
          errors.push(tf.label + ": " + message);
          logger.warn({ symbol: row.symbol, timeframe: tf.label, err: message }, "TelegramService: scanner EMA fetch failed");
        }
      }
      results.push({ symbol: row.symbol, details, errors });
    }
    const lines = ["<b>Watchlist EMA Scanner</b>", "", `<b>Watchlist symbols:</b> ${results.length}`, "<b>Timeframes:</b> 15m • 1H • 4H", "<b>Indicators:</b> EMA 20 / 50 / 200", ""];
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const item of results) {
      const bull = item.details.filter(d => d.trend === "STRONG BULL" || d.trend === "BULL").length;
      const bear = item.details.filter(d => d.trend === "STRONG BEAR" || d.trend === "BEAR").length;
      const overall = item.details.length === 0
        ? "Data unavailable"
        : bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Mixed";
      lines.push("<b>" + this.escapeHtml(item.symbol) + "</b>  " + overall);
      if (item.details.length) {
        for (const d of item.details) {
          lines.push("  " + d.interval + "  " + this.scannerBadge(d.trend) + " " + this.scannerTrendLabel(d.trend));
        }
      } else {
        lines.push("  EMA data unavailable");
      }
      lines.push("");
      keyboard.push([{ text: "" + item.symbol + " — Details", callback_data: "sc:" + item.symbol.slice(0, 20) }]);
    }
    keyboard.push([{ text: "Scan Again", callback_data: "menu:scanner" }]);
    keyboard.push([{ text: "Back", callback_data: "menu:home" }]);
    await this.sendMessage(lines.join("\n"), chatId, true, { inline_keyboard: keyboard });
  }

  private async sendScannerDetail(chatId: string, rawSymbol: string): Promise<void> {
    const symbol = rawSymbol.toUpperCase().trim();
    const rows = await db.select().from(watchlistTable).where(eq(watchlistTable.isFavorite, true));
    const row = rows.find(item => item.symbol.toUpperCase() === symbol);
    if (!row) { await this.sendMessage("❌ Coin is no longer in your watchlist.", chatId, true, this.backKeyboard()); return; }
    const details: Array<Awaited<ReturnType<TelegramService["fetchScannerEma"]>> | null> = [];
    for (const tf of this.scannerTimeframes) {
      try { details.push(await this.fetchScannerEma(row.symbol, tf.key)); }
      catch (err) { logger.warn({ symbol: row.symbol, timeframe: tf.label, err: String(err) }, "TelegramService: scanner detail fetch failed"); details.push(null); }
    }
    const valid = details.filter((d): d is Awaited<ReturnType<TelegramService["fetchScannerEma"]>> => !!d);
    if (!valid.length) { await this.sendMessage("❌ No EMA data available for <b>" + this.escapeHtml(row.symbol) + "</b>.", chatId, true, this.backKeyboard()); return; }
    const blocks: string[] = ["<b>" + this.escapeHtml(row.symbol) + " — EMA Scanner</b>", "", "EMA logic: price vs EMA20/50/200 + EMA alignment.", " = price above EMA •  = price below EMA •  = mixed", "Source: " + (await getCtraderSymbolRow(row.symbol).catch(() => null) ? "cTrader" : "Bybit"), ""];
    for (const d of valid) {
      blocks.push("<b>" + d.interval + " — " + this.scannerBadge(d.trend) + " " + this.scannerTrendLabel(d.trend) + "</b>");
      blocks.push("Price: <b>" + this.formatScannerNumber(d.price) + "</b>");
      blocks.push("EMA 20: " + this.formatScannerNumber(d.ema20) + " " + (d.bullish20 ? "Bullish" : "Bearish"));
      blocks.push("EMA 50: " + this.formatScannerNumber(d.ema50) + " " + (d.bullish50 ? "Bullish" : "Bearish"));
      blocks.push("EMA 200: " + this.formatScannerNumber(d.ema200) + " " + (d.bullish200 ? "Bullish" : "Bearish"));
      blocks.push("Structure: 20 " + (d.ema20 > d.ema50 ? ">" : "<") + " 50 " + (d.ema50 > d.ema200 ? ">" : "<") + " 200", "");
    }
    blocks.push("Strong Bull: price > EMA20 > EMA50 > EMA200.");
    blocks.push("Strong Bear: price < EMA20 < EMA50 < EMA200.");
    blocks.push("Mixed: EMAs are not fully aligned.");
    await this.sendMessage(blocks.join("\n").slice(0, 3900), chatId, true, { inline_keyboard: [
      [{ text: "Refresh", callback_data: "scd:" + row.symbol.slice(0, 20) }],
      [{ text: "Scanner", callback_data: "menu:scanner" }, { text: "Menu", callback_data: "menu:home" }],
    ] });
  }
  private async sendTrendlineList(chatId: string, title: string): Promise<void> {
    const result = await pool.query(`
      SELECT id, symbol, timeframe, condition, drawing_type, alert_status, is_active, telegram_enabled, drawing_display_id
      FROM trendlines ORDER BY id DESC LIMIT 40
    `);
    const rows = result.rows as any[];
    if (!rows.length) {
      await this.sendMessage(`${title}\n\nNo trendlines found.`, chatId, true, this.backKeyboard());
      return;
    }
    const keyboard = rows.map(r => [{
      text: `${r.drawing_display_id || `DB-${r.id}`} • ${r.symbol} • ${r.alert_status}`,
      callback_data: `tl:${r.id}`,
    }]);
    keyboard.push([{ text: "⬅️ Back", callback_data: "menu:home" }]);
    await this.sendMessage(`${title}\n\nSelect an existing trendline:`, chatId, true, { inline_keyboard: keyboard });
  }

  private async sendTrendlineDetail(chatId: string, id: number): Promise<void> {
    if (!Number.isInteger(id)) return;
    const result = await pool.query(`
      SELECT id, symbol, timeframe, condition, drawing_type, alert_status, is_active, telegram_enabled,
             drawing_display_id, notes, point1_price, point1_time, point2_price, point2_time,
             triggered_price, triggered_at, repeat_mode, reminder_count
      FROM trendlines WHERE id = ${id} LIMIT 1
    `);
    const r = (result.rows as any[])[0];
    if (!r) {
      await this.sendMessage("❌ Trendline not found.", chatId, true, this.backKeyboard());
      return;
    }
    const displayId = r.drawing_display_id || `DB-${r.id}`;
    const status = r.alert_status || (r.is_active ? "active" : "paused");
    const lines = [
      `📈 <b>${displayId}</b>`,
      `📊 <b>Symbol:</b> ${r.symbol}`,
      `⏱ <b>Timeframe:</b> ${r.timeframe}`,
      `🎯 <b>Condition:</b> ${r.condition}`,
      `📐 <b>Drawing:</b> ${r.drawing_type}`,
      `⚡ <b>Status:</b> ${status}`,
      `📨 <b>Telegram:</b> ${r.telegram_enabled ? "ON" : "OFF"}`,
      r.triggered_price != null ? `💹 <b>Triggered:</b> ${r.triggered_price}` : "",
      r.notes ? `📝 <b>Notes:</b> ${this.escapeHtml(String(r.notes))}` : "",
    ].filter(Boolean).join("\n");
    const toggleText = r.telegram_enabled ? "🔕 Telegram OFF" : "🔔 Telegram ON";
    const statusButton = status === "paused" || !r.is_active
      ? { text: "▶️ Resume", callback_data: `tr:${r.id}` }
      : { text: "😴 Snooze", callback_data: `ts:${r.id}` };
    await this.sendMessage(lines, chatId, true, {
      inline_keyboard: [
        [{ text: "✏️ Modify", callback_data: `tm:${r.id}` }, statusButton],
        [{ text: toggleText, callback_data: `tg:${r.id}` }, { text: "🗑 Delete", callback_data: `td:${r.id}` }],
        [{ text: "⬅️ Trendlines", callback_data: "menu:trendlines" }],
      ]
    });
  }

  private async sendModifyMenu(chatId: string, id: number): Promise<void> {
    const conditions = ["touch","break","retest","cross_above","cross_below","breakout","atr_proximity","above_price","below_price","touch_price","enter_zone","exit_zone","rejection"];
    const result = await pool.query(`SELECT drawing_display_id, condition FROM trendlines WHERE id = ${id} LIMIT 1`);
    const r = (result.rows as any[])[0];
    if (!r) { await this.sendMessage("❌ Trendline not found.", chatId, true, this.backKeyboard()); return; }
    const buttons = [];
    for (let i=0;i<conditions.length;i+=2) {
      buttons.push(conditions.slice(i,i+2).map(c => ({ text: (c === r.condition ? "✅ " : "") + c.replace(/_/g," "), callback_data: `tc:${id}:${c}` })));
    }
    buttons.push([{ text: "⬅️ Back", callback_data: `tl:${id}` }]);
    await this.sendMessage(`✏️ <b>MODIFY ${r.drawing_display_id || `DB-${id}`}</b>\n\nChoose condition:`, chatId, true, { inline_keyboard: buttons });
  }

  private async modifyTrendline(chatId: string, id: number, field: "condition", value: string): Promise<void> {
    const allowed = new Set(["touch","break","retest","cross_above","cross_below","breakout","atr_proximity","above_price","below_price","touch_price","enter_zone","exit_zone","rejection"]);
    if (!allowed.has(value)) throw new Error("Unsupported condition");
    await pool.query(`UPDATE trendlines SET condition = ${value} WHERE id = ${id}`);
    await this.reloadAlertEngine();
    await this.sendMessage(`✅ Condition updated to <b>${value}</b>.`, chatId, true);
    await this.sendTrendlineDetail(chatId, id);
  }

  private async toggleTelegram(chatId: string, id: number): Promise<void> {
    await pool.query(`UPDATE trendlines SET telegram_enabled = NOT telegram_enabled WHERE id = ${id}`);
    await this.reloadAlertEngine();
    await this.sendTrendlineDetail(chatId, id);
  }

  private async setTrendlineStatus(chatId: string, id: number, status: "paused" | "active"): Promise<void> {
    await pool.query(`UPDATE trendlines SET alert_status = ${status}, is_active = ${status === "active"} WHERE id = ${id}`);
    await this.reloadAlertEngine();
    await this.sendTrendlineDetail(chatId, id);
  }

  private async deleteTrendline(chatId: string, id: number): Promise<void> {
    await pool.query(`DELETE FROM trendlines WHERE id = ${id}`);
    await this.reloadAlertEngine();
    await this.sendMessage(`✅ Trendline deleted.\n\nThe existing chart ID was removed from active alerts.`, chatId, true, {
      inline_keyboard: [[{ text: "📈 Trendlines", callback_data: "menu:trendlines" }, { text: "🏠 Menu", callback_data: "menu:home" }]]
    });
  }

  private async sendRecentAlerts(chatId: string): Promise<void> {
    const result = await pool.query(`
      SELECT id, symbol, timeframe, drawing_type, condition, price_at_trigger, projected_price, message, created_at
      FROM alert_events_v2 ORDER BY created_at DESC LIMIT 15
    `);
    const rows = result.rows as any[];
    if (!rows.length) {
      await this.sendMessage("🔔 <b>ALERTS</b>\n\nNo alert history found.", chatId, true, this.backKeyboard());
      return;
    }
    const keyboard = rows.map(r => [{
      text: `#${r.id} • ${r.symbol} • ${r.condition}`,
      callback_data: `ae:${r.id}`,
    }]);
    keyboard.push([{ text: "⬅️ Back", callback_data: "menu:home" }]);
    await this.sendMessage("🔔 <b>ALERTS</b>\n\nRecent alert history:", chatId, true, { inline_keyboard: keyboard });
  }

  private async sendAlertDetail(chatId: string, id: number): Promise<void> {
    const result = await pool.query(`
      SELECT id, symbol, timeframe, drawing_type, condition, price_at_trigger, projected_price, message, created_at
      FROM alert_events_v2 WHERE id = ${id} LIMIT 1
    `);
    const r = (result.rows as any[])[0];
    if (!r) { await this.sendMessage("❌ Alert event not found.", chatId, true, this.backKeyboard()); return; }
    const text = [
      `🔔 <b>ALERT #${r.id}</b>`,
      `📊 <b>Symbol:</b> ${r.symbol}`,
      `⏱ <b>Timeframe:</b> ${r.timeframe || "-"}`,
      `📐 <b>Drawing:</b> ${r.drawing_type || "-"}`,
      `🎯 <b>Condition:</b> ${r.condition}`,
      r.price_at_trigger != null ? `💹 <b>Triggered:</b> ${r.price_at_trigger}` : "",
      r.projected_price != null ? `📏 <b>Projected:</b> ${r.projected_price}` : "",
      r.message ? `📝 <b>Message:</b> ${this.escapeHtml(String(r.message))}` : "",
      r.created_at ? `⏰ ${new Date(r.created_at).toUTCString()}` : "",
    ].filter(Boolean).join("\n");
    await this.sendMessage(text, chatId, true, { inline_keyboard: [
      [{ text: "🔔 Alerts", callback_data: "menu:alerts" }],
      [{ text: "🏠 Menu", callback_data: "menu:home" }],
    ]});
  }

  private async sendStatistics(chatId: string): Promise<void> {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE alert_status = 'active' AND is_active = true)::int AS active,
        COUNT(*) FILTER (WHERE alert_status = 'paused' OR is_active = false)::int AS paused,
        COUNT(*) FILTER (WHERE alert_status = 'triggered' OR is_triggered = true)::int AS triggered,
        COUNT(*) FILTER (WHERE alert_status = 'expired')::int AS expired
      FROM trendlines
    `);
    const events = await pool.query(`SELECT COUNT(*)::int AS total FROM alert_events_v2`);
    const r = (result.rows as any[])[0] || {};
    const e = (events.rows as any[])[0] || {};
    const text = [
      "📊 <b>STATISTICS</b>",
      "",
      `📈 Total trendlines: <b>${r.total ?? 0}</b>`,
      `🟢 Active: <b>${r.active ?? 0}</b>`,
      `😴 Paused: <b>${r.paused ?? 0}</b>`,
      `🔔 Triggered: <b>${r.triggered ?? 0}</b>`,
      `⌛ Expired: <b>${r.expired ?? 0}</b>`,
      `📨 Alert events: <b>${e.total ?? 0}</b>`,
    ].join("\n");
    await this.sendMessage(text, chatId, true, this.backKeyboard());
  }

  private escapeHtml(value: string): string {
    return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  private async reloadAlertEngine(): Promise<void> {
    const engine = this.alertEngine;
    if (engine?.reloadAlerts) await engine.reloadAlerts();
  }

  private mainMenuKeyboard() {
    return { inline_keyboard: [
      [{ text: "📈 Trendlines", callback_data: "menu:trendlines" }, { text: "🔔 Alerts", callback_data: "menu:alerts" }],
      [{ text: "🔎 Scanner", callback_data: "menu:scanner" }],
      [{ text: "✏️ Modify", callback_data: "menu:modify" }],
      [{ text: "😴 Snooze", callback_data: "menu:snooze" }, { text: "▶️ Resume", callback_data: "menu:resume" }],
      [{ text: "🗑 Delete", callback_data: "menu:delete" }, { text: "📊 Statistics", callback_data: "menu:stats" }],
    ] };
  }

  private backKeyboard() {
    return { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu:home" }]] };
  }

  private async sendMainMenu(chatId: string): Promise<void> {
    await this.sendMessage("🤖 <b>DEEPCHART ALERT MANAGER</b>\n\nChoose an action:", chatId, true, this.mainMenuKeyboard());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isGlobalEnabled(): boolean {
    return this.globalEnabled;
  }

  getStatus(): {
    configured:    boolean;
    chatId:        string | null;
    tokenMasked:   string | null;
    source:        "db" | "env" | "none";
    globalEnabled: boolean;
  } {
    const hasEnv = !!(process.env["TELEGRAM_BOT_TOKEN"] && process.env["TELEGRAM_CHAT_ID"]);
    return {
      configured:    this.enabled,
      chatId:        this.chatId ?? null,
      tokenMasked:   this.botToken ? maskToken(this.botToken) : null,
      source:        this.enabled ? (hasEnv ? "env" : "db") : "none",
      globalEnabled: this.globalEnabled,
    };
  }

  async sendMessage(
    text:            string,
    chatId?:         string,
    bypassGlobal?:   boolean,
    replyMarkup?:     unknown,
  ): Promise<{ success: boolean; telegramResponse?: unknown; error?: string }> {
    if (!this.enabled || !this.botToken) {
      logger.warn("TelegramService: sendMessage SKIPPED — not configured (no bot token/chat ID). Configure via Settings → Telegram Bot.");
      return { success: false, error: "Telegram not configured" };
    }

    if (!bypassGlobal && !this.globalEnabled) {
      logger.warn("TelegramService: sendMessage SKIPPED — global toggle is OFF");
      return { success: false, error: "Telegram alerts are globally disabled" };
    }

    const target  = chatId ?? this.chatId!;
    const payload = { chat_id: target, text, parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) };

    logger.info(
      { tokenMasked: maskToken(this.botToken), targetChatId: target, payloadLength: text.length },
      "TelegramService: sending message",
    );

    try {
      const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      let responseBody: unknown;
      try { responseBody = await res.json(); }
      catch { responseBody = await res.text().catch(() => "<unreadable>"); }

      if (!res.ok) {
        logger.error({ httpStatus: res.status, telegramResponse: responseBody }, "TelegramService: delivery failed");
        return { success: false, telegramResponse: responseBody, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      logger.info({ httpStatus: res.status, targetChatId: target }, "TelegramService: delivered");
      return { success: true, telegramResponse: responseBody };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, targetChatId: target }, "TelegramService: network error");
      return { success: false, error: errorMsg };
    }
  }


  /**
   * Sends a backend-owned reminder. The backend calls this exactly once for
   * each claimed reminder slot, so reminder timing is not dependent on the
   * browser being open.
   */
  async sendAlertReminder(opts: {
    alertType: "price" | "zone" | "trendline";
    reminderNumber: number;
    totalReminders: number | null;
    symbol: string;
    condition: string;
    targetPrice?: number;
    upperPrice?: number;
    lowerPrice?: number;
    zoneType?: string;
    triggeredPrice?: number;
    message?: string;
    drawingType?: string;
  }): Promise<boolean> {
    const total = opts.totalReminders ? `/${opts.totalReminders}` : "";
    const title =
      opts.alertType === "price" ? "PRICE ALERT" :
      opts.alertType === "zone" ? "ZONE ALERT" : "TRENDLINE ALERT";

    const conditionLabel: Record<string, string> = {
      price_above: "Price Above",
      price_below: "Price Below",
      touch_price: "Price Touch",
      percent_change_up: "Percent Change Up",
      percent_change_down: "Percent Change Down",
      enter: "Entered Zone",
      touch: "Touched Zone",
      break: "Broke Zone",
      retest: "Retested Zone",
      cross_above: "Crossed Above",
      cross_below: "Crossed Below",
      breakout: "Breakout",
      atr_proximity: "ATR Proximity",
      rejection: "Rejection",
      above_price: "Above",
      below_price: "Below",
    };

    const lines = [
      `🔔 <b>REMINDER ${opts.reminderNumber}${total} — ${title}</b>`,
      ``,
      `📊 <b>Symbol:</b> ${opts.symbol}`,
      `🎯 <b>Condition:</b> ${conditionLabel[opts.condition] ?? opts.condition.replace(/_/g, " ")}`,
    ];

    if (opts.alertType === "price" && opts.targetPrice !== undefined) {
      lines.push(`🎯 <b>Target:</b> $${opts.targetPrice}`);
    }

    if (opts.alertType === "zone") {
      if (opts.zoneType) lines.push(`🗂 <b>Zone:</b> ${opts.zoneType.replace(/_/g, " ")}`);
      if (opts.lowerPrice !== undefined && opts.upperPrice !== undefined) {
        lines.push(`📏 <b>Range:</b> ${opts.lowerPrice} – ${opts.upperPrice}`);
      }
    }

    if (opts.alertType === "trendline" && opts.drawingType) {
      lines.push(`📐 <b>Drawing:</b> ${opts.drawingType.replace(/_/g, " ")}`);
    }

    if (opts.triggeredPrice !== undefined && Number.isFinite(opts.triggeredPrice)) {
      lines.push(`💹 <b>Triggered at:</b> $${opts.triggeredPrice}`);
    }

    if (opts.message) lines.push(`📝 <b>Note:</b> ${opts.message}`);
    lines.push(``, `⏰ ${new Date().toUTCString()}`);

    const result = await this.sendMessage(lines.join("\n"));
    return result.success;
  }

  async sendTestMessage(): Promise<{
    success: boolean; configured: boolean; telegramResponse?: unknown; error?: string;
  }> {
    // Test always bypasses globalEnabled so the user can verify bot connectivity
    const result = await this.sendMessage(
      "✅ <b>TradeVault Test Message</b>\n\nYour Telegram alerts are working correctly.",
      undefined,
      true,
    );
    return { ...result, configured: this.enabled };
  }

  async sendAlertTriggered(opts: {
    symbol: string; condition: string; targetPrice: number;
    triggeredPrice: number; message?: string | null;
  }): Promise<boolean> {
    const labels: Record<string, { title: string; emoji: string; valueLabel: string }> = {
      price_above:         { title: "Price Above",         emoji: "🟢", valueLabel: "Target" },
      price_below:         { title: "Price Below",         emoji: "🔴", valueLabel: "Target" },
      touch_price:         { title: "Price Touch",         emoji: "🟡", valueLabel: "Target" },
      percent_change_up:   { title: "Percent Change Up",   emoji: "🟢", valueLabel: "Change" },
      percent_change_down: { title: "Percent Change Down", emoji: "🔴", valueLabel: "Change" },
    };
    const meta = labels[opts.condition] ?? {
      title: opts.condition.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      emoji: "🔔", valueLabel: "Target",
    };
    const isPercent = opts.condition.startsWith("percent_change_");
    const target = isPercent ? `${opts.targetPrice.toFixed(2)}%` : `$${opts.targetPrice.toFixed(5)}`;
    const text = [
      `${meta.emoji} <b>PRICE ALERT — ${meta.title.toUpperCase()}</b>`,
      ``,
      `📊 <b>Symbol:</b> ${opts.symbol}`,
      `🎯 <b>${meta.valueLabel}:</b> ${target}`,
      `💹 <b>Triggered at:</b> $${opts.triggeredPrice.toFixed(5)}`,
      opts.message ? `📝 <b>Note:</b> ${opts.message}` : null,
      ``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join("\n");
    const result = await this.sendMessage(text);
    return result.success;
  }

  async sendZoneAlert(opts: {
    symbol: string; zoneType: string; condition: string;
    upperPrice: number; lowerPrice: number; triggeredPrice: number;
    direction: string; notes?: string | null;
  }): Promise<boolean> {
    const zoneEmoji: Record<string, string> = {
      supply: "🔴", demand: "🟢", support_resistance: "🔵", order_block: "🟠",
    };
    const conditionLabels: Record<string, string> = {
      enter: "Entered Zone",
      touch: "Touched Zone Boundary",
      break: "Zone Break",
      retest: "Zone Retest",
    };
    const eventText: Record<string, string> = {
      entered: "Price entered the zone",
      "touched the upper boundary of": "Price touched the upper boundary",
      "touched the lower boundary of": "Price touched the lower boundary",
      "broke above": "Price broke above the zone",
      "broke below": "Price broke below the zone",
      "returned into": "Price returned into the zone after a break",
    };
    const emoji = zoneEmoji[opts.zoneType] ?? "📦";
    const zoneLabel = opts.zoneType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const condLabel = conditionLabels[opts.condition] ?? opts.condition.replace(/_/g, " ");
    const text = [
      `${emoji} <b>ZONE ALERT — ${condLabel.toUpperCase()}</b>`,
      ``,
      `📊 <b>Symbol:</b> ${opts.symbol}`,
      `🗂 <b>Zone:</b> ${zoneLabel}`,
      `📏 <b>Range:</b> $${opts.lowerPrice.toFixed(5)} – $${opts.upperPrice.toFixed(5)}`,
      `💹 <b>Price:</b> $${opts.triggeredPrice.toFixed(5)}`,
      `📍 <b>Event:</b> ${eventText[opts.direction] ?? opts.direction}`,
      opts.notes ? `📝 <b>Notes:</b> ${opts.notes}` : null,
      ``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join("\n");
    const result = await this.sendMessage(text);
    return result.success;
  }

  async sendTrendlineAlert(opts: {
    symbol: string; timeframe: string; condition: string;
    triggeredPrice: number; projectedPrice: number; direction: string; notes?: string | null;
  }): Promise<boolean> {
    const conditionLabels: Record<string, string> = {
      touch: "Trendline Touch",
      touch_price: "Price Touch",
      break: "Trendline Break",
      breakout: "Trendline Breakout",
      retest: "Trendline Retest",
      cross_above: "Cross Above",
      cross_below: "Cross Below",
      above_price: "Above Trendline",
      below_price: "Below Trendline",
      enter_zone: "Entered Proximity",
      exit_zone: "Exited Proximity",
      rejection: "Trendline Rejection",
      atr_proximity: "ATR Proximity",
    };
    const condLabel = conditionLabels[opts.condition] ?? opts.condition.replace(/_/g, " ");
    const emoji = opts.condition.includes("below") || opts.direction.includes("below") ? "🔴" : "🟢";
    const text = [
      `${emoji} <b>TRENDLINE ALERT — ${condLabel.toUpperCase()}</b>`,
      ``,
      `📊 <b>Symbol:</b> ${opts.symbol}`,
      `⏱ <b>Timeframe:</b> ${opts.timeframe}`,
      `📐 <b>Line Price:</b> $${opts.projectedPrice.toFixed(5)}`,
      `💹 <b>Triggered at:</b> $${opts.triggeredPrice.toFixed(5)}`,
      `📍 <b>Event:</b> ${this.trendlineEventText(opts.condition, opts.direction)}`,
      opts.notes ? `📝 <b>Notes:</b> ${opts.notes}` : null,
      ``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join("\n");
    const result = await this.sendMessage(text);
    return result.success;
  }

  private trendlineEventText(condition: string, direction: string): string {
    const map: Record<string, string> = {
      touch: "Price touched the trendline",
      touch_price: "Price touched the level",
      break: direction === "above" ? "Price broke above the trendline" : "Price broke below the trendline",
      breakout: direction === "above" ? "Price broke above the trendline" : "Price broke below the trendline",
      retest: "Price returned to the trendline after a breakout",
      cross_above: "Price crossed above the trendline",
      cross_below: "Price crossed below the trendline",
      above_price: "Price crossed above the trendline",
      below_price: "Price crossed below the trendline",
      enter_zone: "Price entered the trendline proximity band",
      exit_zone: "Price exited the trendline proximity band",
      rejection: "Price touched and rejected from the trendline",
      atr_proximity: "Price entered the ATR proximity band",
    };
    return map[condition] ?? `Condition: ${condition}`;
  }

  async sendDrawingAlert(opts: {
    symbol: string; timeframe: string; drawingType: string; condition: string;
    conditionLabel: string; triggeredPrice: number; projectedPrice: number;
    direction: string; notes?: string | null;
  }): Promise<boolean> {
    const drawingEmojis: Record<string, string> = {
      trendline: "📈", ray: "📐", horizontal_line: "➡️", rectangle: "📦", channel: "🛤️",
    };
    const dtLabel = opts.drawingType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const emoji = drawingEmojis[opts.drawingType] ?? "📊";
    const text = [
      `🔔 <b>${dtLabel.toUpperCase()} ALERT — ${opts.conditionLabel.toUpperCase()}</b>`,
      ``,
      `${emoji} <b>Symbol:</b> ${opts.symbol}`,
      `⚡ <b>Condition:</b> ${opts.conditionLabel}`,
      `📐 <b>Line Price:</b> ${opts.projectedPrice.toFixed(5)}`,
      `💹 <b>Triggered at:</b> ${opts.triggeredPrice.toFixed(5)}`,
      `⏱ <b>Timeframe:</b> ${opts.timeframe}`,
      `📍 <b>Event:</b> ${this.trendlineEventText(opts.condition, opts.direction)}`,
      opts.notes ? `📝 <b>Notes:</b> ${opts.notes}` : null,
      ``,
      `⏰ ${new Date().toUTCString()}`,
    ].filter(Boolean).join("\n");
    const result = await this.sendMessage(text);
    return result.success;
  }

  async sendFeedAlert(message: string): Promise<boolean> {
    const result = await this.sendMessage(`⚠️ <b>Feed Alert</b>\n\n${message}`);
    return result.success;
  }
}
