/**
 * cTrader Spot Streaming routes
 *
 * POST /api/ctrader/spots/start        — start the tick engine (connect + auth)
 * POST /api/ctrader/spots/stop         — stop the tick engine
 * POST /api/ctrader/spots/subscribe    — add a symbol to the watchlist feed
 * POST /api/ctrader/spots/unsubscribe  — remove a symbol from the watchlist feed
 * GET  /api/ctrader/spots/status       — engine status + subscribed symbols
 *
 * Architecture:
 *   The engine starts with ZERO subscriptions after authentication.
 *   Subscriptions are driven exclusively by watchlist add/remove events.
 *   The full symbolMap is loaded at startup so SPOT_EVENT payloads can be decoded.
 */

import { Router } from "express";
import { ctraderTickEngine } from "../services/CtraderTickEngine.js";
import { pool } from "@workspace/db";
import { db, watchlistTable } from "@workspace/db";
import { encrypt, decrypt } from "../services/BrokerEncryption.js";
import { logger } from "../lib/logger.js";
import { fetchSymbolsViaProtoOA } from "../lib/ctraderProtoOA.js";

const CTRADER_TOKEN_URL_SPOTS = "https://openapi.ctrader.com/apps/token";

// These symbols are Delta Exchange live-tick symbols. They must never be
// subscribed to cTrader, even when cTrader happens to list the same symbol.
// Keeping the rule here makes every watchlist/startup/session-restore path use
// the same broker boundary because all of them call getCtraderSymbolRow().
const DELTA_ONLY_LIVE_TICK_SYMBOLS = new Set(["BTCUSD", "ETHUSD", "SOLUSD"]);

/** Silently refresh the stored access token using the refresh token. */
async function silentRefreshToken(): Promise<string | null> {
  const clientId     = process.env["CTRADER_CLIENT_ID"];
  const clientSecret = process.env["CTRADER_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;

  try {
    const row = await pool.query(
      "SELECT id, refresh_token_enc FROM ctrader_tokens ORDER BY id DESC LIMIT 1",
    );
    if (!row.rows.length) return null;
    const r = row.rows[0] as { id: number; refresh_token_enc: string };
    const refreshToken = decrypt(r.refresh_token_enc);
    if (!refreshToken) return null;

    const resp = await fetch(CTRADER_TOKEN_URL_SPOTS, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: refreshToken,
        client_id: clientId, client_secret: clientSecret,
      }).toString(),
    });
    type P = { access_token?: string; refresh_token?: string; expires_in?: number };
    const data = (await resp.json()) as P;
    if (!resp.ok || !data.access_token) return null;

    const expiresAt = Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
    await pool.query(
      "UPDATE ctrader_tokens SET access_token_enc=$1, refresh_token_enc=$2, expires_at=$3, updated_at=NOW() WHERE id=$4",
      [encrypt(data.access_token), encrypt(data.refresh_token ?? refreshToken), expiresAt, r.id],
    );
    logger.info({ expiresAt }, "CtraderSpots: token silently refreshed");
    return data.access_token;
  } catch (err) {
    logger.warn({ err }, "CtraderSpots: silent token refresh failed");
    return null;
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function ensureTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ctrader_tokens (
      id                SERIAL PRIMARY KEY,
      access_token_enc  TEXT NOT NULL,
      refresh_token_enc TEXT NOT NULL,
      expires_at        BIGINT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ctrader_spot_config (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      account_id BIGINT  NOT NULL,
      is_live    BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ctrader_symbols (
      symbol_id    INTEGER PRIMARY KEY,
      symbol_name  TEXT NOT NULL,
      description  TEXT NOT NULL,
      pip_position INTEGER NOT NULL,
      digits       INTEGER NOT NULL,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

/**
 * Look up a symbol by name in ctrader_symbols.
 * Returns { symbolId, symbolName } or null if not found.
 *
 * Delta-only live-tick symbols deliberately return null even if cTrader has
 * the same symbol in its catalog. This prevents duplicate broker feeds.
 */
let symbolCatalogRefreshPromise: Promise<void> | null = null;
let symbolCatalogRefreshedAt = 0;
const SYMBOL_CATALOG_REFRESH_COOLDOWN = 30_000;

async function refreshCtraderSymbolCatalog(): Promise<void> {
  const now = Date.now();
  if (symbolCatalogRefreshPromise) return symbolCatalogRefreshPromise;
  if (now - symbolCatalogRefreshedAt < SYMBOL_CATALOG_REFRESH_COOLDOWN) return;

  const creds = ctraderTickEngine.getEngineCredentials();
  if (!creds) return;

  symbolCatalogRefreshPromise = (async () => {
    try {
      const symbols = await fetchSymbolsViaProtoOA({
        ctidTraderAccountId: creds.ctidTraderAccountId,
        isLive: creds.isLive,
        accessToken: creds.accessToken,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        timeoutMs: 30_000,
      });
      await pool.query(`CREATE TABLE IF NOT EXISTS ctrader_symbols (
        symbol_id INTEGER PRIMARY KEY,
        symbol_name TEXT NOT NULL,
        description TEXT NOT NULL,
        pip_position INTEGER NOT NULL,
        digits INTEGER NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const sym of symbols) {
        await pool.query(
          `INSERT INTO ctrader_symbols
             (symbol_id,symbol_name,description,pip_position,digits,fetched_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (symbol_id) DO UPDATE SET
             symbol_name=EXCLUDED.symbol_name,
             description=EXCLUDED.description,
             pip_position=EXCLUDED.pip_position,
             digits=EXCLUDED.digits,
             fetched_at=NOW()`,
          [sym.symbolId, sym.symbolName, sym.description, sym.pipPosition, sym.digits],
        );
      }
      symbolCatalogRefreshedAt = Date.now();
      logger.info({ count: symbols.length }, "CtraderSpots: symbol catalog refreshed for market-data lookup");
    } catch (err) {
      logger.warn({ err: String(err) }, "CtraderSpots: symbol catalog refresh failed");
    } finally {
      symbolCatalogRefreshPromise = null;
    }
  })();
  return symbolCatalogRefreshPromise;
}

export async function getCtraderSymbolRow(
  symbol: string,
): Promise<{ symbolId: number; symbolName: string } | null> {
  const normalized = symbol.toUpperCase().trim();
  if (DELTA_ONLY_LIVE_TICK_SYMBOLS.has(normalized)) return null;

  const result = await pool.query(
    "SELECT symbol_id, symbol_name FROM ctrader_symbols WHERE UPPER(symbol_name) = $1 LIMIT 1",
    [normalized],
  );
  if (result.rows.length) {
    const row = result.rows[0] as { symbol_id: number; symbol_name: string };
    return { symbolId: Number(row.symbol_id), symbolName: row.symbol_name };
  }

  await refreshCtraderSymbolCatalog();
  const retry = await pool.query(
    "SELECT symbol_id, symbol_name FROM ctrader_symbols WHERE UPPER(symbol_name) = $1 LIMIT 1",
    [normalized],
  );
  if (!retry.rows.length) return null;

  const row = retry.rows[0] as { symbol_id: number; symbol_name: string };
  return { symbolId: Number(row.symbol_id), symbolName: row.symbol_name };
}

/**
 * Load credentials + full symbolMap (no subscription set — engine starts empty).
 */
async function loadEngineOpts() {
  await ensureTables();

  const clientId     = process.env["CTRADER_CLIENT_ID"];
  const clientSecret = process.env["CTRADER_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET not set");
  }

  const tokenRow = await pool.query(
    "SELECT access_token_enc FROM ctrader_tokens ORDER BY id DESC LIMIT 1",
  );
  if (!tokenRow.rows.length) throw new Error("No cTrader token stored — complete OAuth first");
  const accessToken = decrypt((tokenRow.rows[0] as { access_token_enc: string }).access_token_enc);
  if (!accessToken) throw new Error("Could not decrypt cTrader access token");

  const cfgRow = await pool.query(
    "SELECT account_id, is_live FROM ctrader_spot_config WHERE id = 1",
  );
  if (!cfgRow.rows.length) throw new Error("No account configured — wire symbols first (supply accountId)");
  const { account_id, is_live } = cfgRow.rows[0] as { account_id: number; is_live: boolean };

  const symRows = await pool.query(
    "SELECT symbol_id, symbol_name FROM ctrader_symbols ORDER BY symbol_id",
  );
  if (!symRows.rows.length) throw new Error("No symbols in DB — wire symbols first");

  const symbolMap = new Map<number, string>();
  for (const row of symRows.rows as { symbol_id: number; symbol_name: string }[]) {
    symbolMap.set(Number(row.symbol_id), row.symbol_name);
  }

  return {
    clientId, clientSecret,
    accessToken,
    ctidTraderAccountId: Number(account_id),
    isLive: Boolean(is_live),
    symbolMap,
    // symbolIds intentionally omitted — engine starts with zero subscriptions
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

export function createCtraderSpotsRouter(): Router {
  const router = Router();

  // POST /api/ctrader/spots/start
  router.post("/ctrader/spots/start", async (req, res) => {
    try {
      const current = ctraderTickEngine.getStatus();
      if (current.status === "streaming") {
        return res.json({ ok: true, message: "Already streaming", status: current });
      }

      const opts = await loadEngineOpts();

      // Allow request body to override accountId / isLive
      const body = req.body as { ctidTraderAccountId?: number; accountId?: number; isLive?: boolean };
      const overrideId = body.ctidTraderAccountId ?? body.accountId;
      if (overrideId) opts.ctidTraderAccountId = Number(overrideId);
      if (body.isLive !== undefined) opts.isLive = Boolean(body.isLive);

      ctraderTickEngine.stop();
      ctraderTickEngine.configure(opts);
      ctraderTickEngine.start();

      logger.info({
        accountId: opts.ctidTraderAccountId,
        isLive:    opts.isLive,
      }, "CtraderSpots: engine started via API (zero initial subscriptions)");

      return res.json({
        ok: true,
        message: "Engine starting — subscriptions driven by watchlist",
        accountId: opts.ctidTraderAccountId,
        isLive:    opts.isLive,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "CtraderSpots: start error");
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // POST /api/ctrader/spots/subscribe — add a symbol to the watchlist feed
  router.post("/ctrader/spots/subscribe", async (req, res) => {
    try {
      const { symbol } = req.body as { symbol?: string };
      if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

      const row = await getCtraderSymbolRow(symbol);
      if (!row) {
        return res.json({ ok: false, error: `Symbol ${symbol.toUpperCase()} not found in cTrader catalog` });
      }

      ctraderTickEngine.addSymbol(row.symbolId, row.symbolName);
      const status = ctraderTickEngine.getStatus();
      logger.info({ symbol: row.symbolName, symbolId: row.symbolId, engineStatus: status.status },
        "CtraderSpots: symbol subscribed via API");
      return res.json({ ok: true, symbol: row.symbolName, symbolId: row.symbolId, engineStatus: status.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "CtraderSpots: subscribe error");
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // POST /api/ctrader/spots/unsubscribe — remove a symbol from the watchlist feed
  router.post("/ctrader/spots/unsubscribe", async (req, res) => {
    try {
      const { symbol } = req.body as { symbol?: string };
      if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

      const row = await getCtraderSymbolRow(symbol);
      if (!row) {
        return res.json({ ok: false, error: `Symbol ${symbol.toUpperCase()} not found in cTrader catalog` });
      }

      ctraderTickEngine.removeSymbol(row.symbolId, row.symbolName);
      const status = ctraderTickEngine.getStatus();
      logger.info({ symbol: row.symbolName, symbolId: row.symbolId, engineStatus: status.status },
        "CtraderSpots: symbol unsubscribed via API");
      return res.json({ ok: true, symbol: row.symbolName, symbolId: row.symbolId, engineStatus: status.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "CtraderSpots: unsubscribe error");
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // POST /api/ctrader/spots/stop
  router.post("/ctrader/spots/stop", (_req, res) => {
    ctraderTickEngine.stop();
    logger.info("CtraderSpots: engine stopped via API");
    return res.json({ ok: true, message: "Engine stopped" });
  });

  // GET /api/ctrader/spots/status
  router.get("/ctrader/spots/status", (_req, res) => {
    const status      = ctraderTickEngine.getStatus();
    const sampleTicks = ctraderTickEngine.getAllLastTicks().slice(0, 30);
    return res.json({ ok: true, status, sampleTicks });
  });

  // ── GET /api/ctrader/session — full session state for frontend mount check ──
  router.get("/ctrader/session", async (_req, res) => {
    try {
      await ensureTables();

      const tokenRow = await pool.query(
        "SELECT access_token_enc, refresh_token_enc, expires_at FROM ctrader_tokens ORDER BY id DESC LIMIT 1",
      );
      const tokenExists = tokenRow.rows.length > 0;
      let tokenExpired = false;
      let expiresAt    = 0;
      let hasRefreshToken = false;
      if (tokenExists) {
        const r = tokenRow.rows[0] as { access_token_enc: string; refresh_token_enc: string; expires_at: number };
        tokenExpired    = r.expires_at < Math.floor(Date.now() / 1000);
        expiresAt       = r.expires_at;
        hasRefreshToken = !!decrypt(r.refresh_token_enc);
      }
      const tokenValid = tokenExists && !tokenExpired;

      const cfgRow = await pool.query(
        "SELECT account_id, is_live FROM ctrader_spot_config WHERE id = 1",
      ).catch(() => ({ rows: [] as unknown[] }));
      const accountRestored = cfgRow.rows.length > 0;
      const cfg = accountRestored ? cfgRow.rows[0] as { account_id: number; is_live: boolean } : null;

      const symRow = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM ctrader_symbols",
      ).catch(() => ({ rows: [{ cnt: 0 }] as unknown[] }));
      const symbolsRestored = Number((symRow.rows[0] as { cnt: number })?.cnt ?? 0);

      const engineStatus = ctraderTickEngine.getStatus();

      return res.json({
        sessionRestored:      tokenValid && accountRestored && symbolsRestored > 0,
        tokenValid,
        tokenExpired,
        tokenExists,
        expiresAt,
        hasRefreshToken,
        needsReauth:          tokenExpired && !hasRefreshToken,
        accountRestored,
        accountId:            cfg ? Number(cfg.account_id) : null,
        isLive:               cfg ? Boolean(cfg.is_live) : false,
        symbolsRestored,
        subscriptionsRestored: engineStatus.subscribedCount,
        engineStatus:          engineStatus.status,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "ctrader/session: error");
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── POST /api/ctrader/session-restore — silently restore persisted session ──
  router.post("/ctrader/session-restore", async (_req, res) => {
    try {
      await ensureTables();

      // 1. Load token
      const tokenRow = await pool.query(
        "SELECT access_token_enc, expires_at FROM ctrader_tokens ORDER BY id DESC LIMIT 1",
      );
      if (!tokenRow.rows.length) {
        return res.json({ ok: false, reason: "no_token", needsReauth: true });
      }
      const r = tokenRow.rows[0] as { access_token_enc: string; expires_at: number };
      const isExpired = r.expires_at < Math.floor(Date.now() / 1000);
      let tokenRefreshed = false;

      if (isExpired) {
        const refreshed = await silentRefreshToken();
        if (!refreshed) {
          return res.json({ ok: false, reason: "token_expired", needsReauth: true });
        }
        tokenRefreshed = true;
      }

      // 2. Verify account config
      const cfgRow = await pool.query(
        "SELECT account_id, is_live FROM ctrader_spot_config WHERE id = 1",
      ).catch(() => ({ rows: [] as unknown[] }));
      if (!cfgRow.rows.length) {
        return res.json({ ok: false, reason: "no_account", needsSetup: true });
      }
      const cfg = cfgRow.rows[0] as { account_id: number; is_live: boolean };

      // 3. Verify symbols cached
      const symRow = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM ctrader_symbols",
      ).catch(() => ({ rows: [{ cnt: 0 }] as unknown[] }));
      const symbolsRestored = Number((symRow.rows[0] as { cnt: number })?.cnt ?? 0);
      if (symbolsRestored === 0) {
        return res.json({ ok: false, reason: "no_symbols", needsSetup: true });
      }

      // 4. Start engine if not already streaming
      const engineBefore = ctraderTickEngine.getStatus();
      if (engineBefore.status !== "streaming") {
        try {
          const opts = await loadEngineOpts();
          ctraderTickEngine.stop();
          ctraderTickEngine.configure(opts);
          ctraderTickEngine.start();
          logger.info({ accountId: opts.ctidTraderAccountId }, "CtraderSpots: session-restore started engine");
        } catch (startErr) {
          const msg = startErr instanceof Error ? startErr.message : String(startErr);
          logger.warn({ err: msg }, "CtraderSpots: session-restore engine start failed");
          return res.json({ ok: false, reason: "engine_start_failed", error: msg });
        }
      }

      // 5. Re-subscribe watchlist symbols
      let subscriptionsRestored = 0;
      try {
        const { asc } = await import("drizzle-orm");
        const items = await db.select({ symbol: watchlistTable.symbol })
          .from(watchlistTable)
          .orderBy(asc(watchlistTable.position));
        for (const { symbol } of items) {
          const row = await getCtraderSymbolRow(symbol);
          if (row) { ctraderTickEngine.addSymbol(row.symbolId, row.symbolName); subscriptionsRestored++; }
        }
        if (subscriptionsRestored > 0) {
          logger.info({ count: subscriptionsRestored }, "CtraderSpots: session-restore subscriptions restored");
        }
      } catch { /* non-fatal */ }

      const engineFinal = ctraderTickEngine.getStatus();
      return res.json({
        ok:                    true,
        tokenRefreshed,
        accountId:             Number(cfg.account_id),
        isLive:                Boolean(cfg.is_live),
        symbolsRestored,
        subscriptionsRestored: engineFinal.subscribedCount,
        engineStatus:          engineFinal.status,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "ctrader/session-restore: error");
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  return router;
}

// ── Auto-start helper (called from index.ts after migrations) ─────────────────

export async function autoStartCtraderEngine(): Promise<void> {
  // Ensure tables exist before any DB reads
  await ensureTables().catch(() => {});

  const clientId     = process.env["CTRADER_CLIENT_ID"];
  const clientSecret = process.env["CTRADER_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    logger.info("CtraderSpots: CTRADER_CLIENT_ID/SECRET not set — skipping auto-start");
    return;
  }

  try {
    const opts = await loadEngineOpts();
    ctraderTickEngine.configure(opts);
    ctraderTickEngine.start();
    logger.info({
      accountId: opts.ctidTraderAccountId,
      isLive:    opts.isLive,
    }, "CtraderSpots: auto-started (zero initial subscriptions — waiting for watchlist)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info({ reason: msg }, "CtraderSpots: auto-start skipped (config not ready)");
  }
}

/**
 * Called at server startup (after autoStartCtraderEngine) to subscribe all
 * cTrader symbols currently in the watchlist.
 * Safe to call even if engine is not yet streaming — symbols are queued in the
 * subscribedIds Set and sent on the next ACCT_AUTH_RES.
 */
export async function subscribeWatchlistCtraderSymbols(): Promise<void> {
  // Ensure tables exist so getCtraderSymbolRow doesn't throw on first run
  await ensureTables().catch(() => {});
  try {
    const { asc } = await import("drizzle-orm");
    const items = await db.select({ symbol: watchlistTable.symbol })
      .from(watchlistTable)
      .orderBy(asc(watchlistTable.position));

    let count = 0;
    for (const { symbol } of items) {
      const row = await getCtraderSymbolRow(symbol);
      if (row) {
        ctraderTickEngine.addSymbol(row.symbolId, row.symbolName);
        count++;
      }
    }
    if (count > 0) {
      logger.info({ count }, "CtraderSpots: subscribed watchlist cTrader symbols at startup");
    }
  } catch (err) {
    logger.warn({ err }, "CtraderSpots: subscribeWatchlistCtraderSymbols failed (non-fatal)");
  }
}
