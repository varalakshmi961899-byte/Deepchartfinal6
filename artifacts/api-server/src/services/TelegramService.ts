import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { AppConfigService } from "./AppConfigService.js";

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
    const url = `${baseUrl.replace(/\/+$/, "")}/api/telegram/webhook`;
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
    const screens: Record<string, { text: string; keyboard: unknown }> = {
      "menu:trendlines": { text: "📈 <b>TRENDLINES</b>\n\nPhase 1 connected. Existing trendline records will be shown in the next phase.", keyboard: this.backKeyboard() },
      "menu:alerts": { text: "🔔 <b>ALERTS</b>\n\nExisting alert system is connected. Controls will be wired in the next phase.", keyboard: this.backKeyboard() },
      "menu:create": { text: "➕ <b>CREATE</b>\n\nChart-linked creation will be added in the next phase.", keyboard: this.backKeyboard() },
      "menu:modify": { text: "✏️ <b>MODIFY</b>\n\nTrendline selection will be added in the next phase.", keyboard: this.backKeyboard() },
      "menu:snooze": { text: "😴 <b>SNOOZE</b>\n\nSnooze controls will be added in the next phase.", keyboard: this.backKeyboard() },
      "menu:resume": { text: "▶️ <b>RESUME</b>\n\nResume controls will be added in the next phase.", keyboard: this.backKeyboard() },
      "menu:delete": { text: "🗑 <b>DELETE</b>\n\nDelete controls will be added in the next phase.", keyboard: this.backKeyboard() },
      "menu:stats": { text: "📊 <b>STATISTICS</b>\n\nStatistics will be connected to existing alert tables in the next phase.", keyboard: this.backKeyboard() },
    };
    if (data === "menu:home") { await this.sendMainMenu(chatId); return; }
    const screen = screens[data];
    if (screen) await this.sendMessage(screen.text, chatId, true, screen.keyboard);
  }

  private mainMenuKeyboard() {
    return { inline_keyboard: [
      [{ text: "📈 Trendlines", callback_data: "menu:trendlines" }, { text: "🔔 Alerts", callback_data: "menu:alerts" }],
      [{ text: "➕ Create", callback_data: "menu:create" }, { text: "✏️ Modify", callback_data: "menu:modify" }],
      [{ text: "😴 Snooze", callback_data: "menu:snooze" }, { text: "▶️ Resume", callback_data: "menu:resume" }],
      [{ text: "🗑 Delete", callback_data: "menu:delete" }, { text: "📊 Statistics", callback_data: "menu:stats" }],
      [{ text: "🔄 Refresh", callback_data: "menu:home" }],
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
