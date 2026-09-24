import "dotenv/config";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger.js";
import type { AlertEngine } from "./services/AlertEngine.js";
import type { MarketDataService } from "./services/MarketDataService.js";
import type { FeedHealthMonitor } from "./services/FeedHealthMonitor.js";
import type { TelegramService } from "./services/TelegramService.js";
import type { DeltaService } from "./services/DeltaService.js";
import type { WSManager } from "./ws/WSManager.js";
import type { CandleAggregator } from "./services/CandleAggregator.js";
import { createRouter } from "./routes/index.js";
import { createAuthRouter, requirePinVerified } from "./routes/auth.js";

declare module "express-session" {
  interface SessionData {
    deltaOAuthState?: string;
    pendingBrokerAccount?: {
      accountId: number;
      apiToken: string;
      label: string;
    };
    pendingDeltaAccount?: {
      accountId: number;
      apiToken: string;
      label: string;
    };
  }
}

const PgSession = connectPgSimple(session);

export function createApp(deps: {
  alertEngine: AlertEngine;
  marketData: MarketDataService;
  healthMonitor: FeedHealthMonitor;
  telegram: TelegramService;
  delta: DeltaService;
  wsManager: WSManager;
  candleAggregator: CandleAggregator;
}): Express {
  const app: Express = express();

  app.set("trust proxy", 1);

  // CORS is deliberately exact-origin for Railway deployments. Set
  // CORS_ALLOWED_ORIGINS to the frontend origin(s), comma-separated.
  // The current production frontend is included explicitly so the API works
  // immediately after deployment without requiring a second CORS change.
  const allowedOrigins = new Set<string>([
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:5173",
    "https://workspacetrading-journal-production-ef57.up.railway.app",
    ...((process.env["CORS_ALLOWED_ORIGINS"] ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean)),
  ]);

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        const normalized = origin.replace(/\/+$/, "");
        cb(null, allowedOrigins.has(normalized) ? origin : false);
      },
      credentials: true,
    }),
  );

  app.use(
    session({
      secret: (() => {
        const s = process.env["SESSION_SECRET"];
        if (!s) {
          if (process.env["NODE_ENV"] === "production") {
            logger.error("SESSION_SECRET is not set — sessions are insecure in production. Add it to Railway Secrets.");
          } else {
            logger.warn("SESSION_SECRET is not set — using insecure dev fallback. Set SESSION_SECRET in Railway Secrets before deploying.");
          }
        }
        return s ?? "dev-fallback-secret-replace-in-prod";
      })(),
      resave: false,
      saveUninitialized: false,
      proxy: true,
      store: new PgSession({
        pool,
        tableName: "sessions",
        createTableIfMissing: true,
        pruneSessionInterval: 60 * 60,
      }),
      cookie: {
        secure: true,
        sameSite: "none",
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(createAuthRouter());

  // Telegram webhook is intentionally mounted before app PIN auth because
  // Telegram cannot participate in the browser session. The TelegramService
  // performs the configured-chat authentication and optional secret-token check.
  app.post("/api/telegram/webhook", async (req, res): Promise<void> => {
    const expectedSecret = process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim();
    if (expectedSecret && req.header("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret) {
      res.sendStatus(401);
      return;
    }
    try {
      await deps.telegram.handleWebhookUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      logger.error({ err }, "Telegram webhook handler failed");
      res.sendStatus(500);
    }
  });

  app.use(requirePinVerified);
  app.use("/api", createRouter(deps));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "Unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
