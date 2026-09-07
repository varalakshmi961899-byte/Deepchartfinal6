import { pool } from "@workspace/db";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { logger } from "../lib/logger.js";

const ALGO = "aes-256-cbc";
const LEGACY_STATIC_KEY = "tj-app-config-v1-static-protection-key";

function deriveKey(base: string): Buffer {
  return createHash("sha256").update(base).digest();
}

function encryptionKeyCandidates(): string[] {
  const candidates = [
    process.env["BROKER_ENCRYPTION_KEY"],
    process.env["ENCRYPTION_SECRET"],
    LEGACY_STATIC_KEY,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

function encryptValue(plaintext: string): string {
  const key = deriveKey(encryptionKeyCandidates()[0] ?? LEGACY_STATIC_KEY);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decryptValue(ciphertext: string): string {
  const colonIdx = ciphertext.indexOf(":");
  if (colonIdx === -1) throw new Error("Invalid ciphertext");
  const iv = Buffer.from(ciphertext.slice(0, colonIdx), "hex");
  const enc = Buffer.from(ciphertext.slice(colonIdx + 1), "hex");

  let lastError: unknown;
  for (const base of encryptionKeyCandidates()) {
    try {
      const decipher = createDecipheriv(ALGO, deriveKey(base), iv);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to decrypt configuration");
}

export const SUPPORTED_KEYS = [
  "BROKER_ENCRYPTION_KEY",
  "DELTA_API_KEY",
  "DELTA_API_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SESSION_SECRET",
  "DATABASE_URL",
  "CTRADER_CLIENT_ID",
  "CTRADER_CLIENT_SECRET",
] as const;

export type SupportedKey = typeof SUPPORTED_KEYS[number];

export class AppConfigService {
  private static cache = new Map<string, string>();
  private static tableReady = false;

  private static async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value_enc TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    this.tableReady = true;
  }

  static async get(key: string): Promise<string | undefined> {
    if (this.cache.has(key)) return this.cache.get(key);
    try {
      await this.ensureTable();
      const result = await pool.query(
        `SELECT value_enc FROM app_config WHERE key = $1`,
        [key],
      );
      if (!result.rows.length) return undefined;
      const value = decryptValue(result.rows[0].value_enc as string);
      this.cache.set(key, value);
      return value;
    } catch (err) {
      logger.warn({ key, err: String(err) }, "AppConfigService: failed to decrypt stored configuration");
      return undefined;
    }
  }

  static async set(key: string, value: string): Promise<void> {
    await this.ensureTable();
    const valueEnc = encryptValue(value);
    await pool.query(
      `INSERT INTO app_config (key, value_enc, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value_enc = $2, updated_at = NOW()`,
      [key, valueEnc],
    );
    this.cache.set(key, value);
    process.env[key] = value;
  }

  static async delete(key: string): Promise<void> {
    await this.ensureTable();
    await pool.query(`DELETE FROM app_config WHERE key = $1`, [key]);
    this.cache.delete(key);
  }

  static async getStatus(): Promise<Record<string, boolean>> {
    await this.ensureTable();
    const result = await pool.query(`SELECT key FROM app_config`);
    const storedKeys = new Set(
      (result.rows as Array<{ key: string }>).map((r) => r.key),
    );
    const status: Record<string, boolean> = {};
    for (const key of SUPPORTED_KEYS) {
      status[key] = storedKeys.has(key) || !!process.env[key];
    }
    return status;
  }

  static async injectToEnv(): Promise<void> {
    try {
      await this.ensureTable();
      const result = await pool.query(
        `SELECT key, value_enc FROM app_config`,
      );
      let injected = 0;
      let alreadySet = 0;
      let decryptFailed = 0;
      const dbKeys: string[] = [];
      for (const row of result.rows as Array<{ key: string; value_enc: string }>) {
        dbKeys.push(row.key);
        try {
          const value = decryptValue(row.value_enc);
          if (!process.env[row.key]) {
            process.env[row.key] = value;
            injected++;
          } else {
            alreadySet++;
          }
          this.cache.set(row.key, value);
        } catch (err) {
          decryptFailed++;
          logger.warn(
            { key: row.key, err: String(err) },
            "AppConfigService: decrypt failed during inject — no compatible encryption key found",
          );
        }
      }
      logger.info(
        { dbKeys, injected, alreadySet, decryptFailed, total: result.rows.length },
        "AppConfigService: injectToEnv complete",
      );
    } catch (err) {
      logger.warn({ err: String(err) }, "AppConfigService: injectToEnv failed (table may not exist yet)");
    }
  }
}
