// Claude key and spend guard (owner, 24 Oct 2026).
//
// Key: the Claude for Startups key, read at run time as CLAUDE_API_KEY from
// BOT_CLAUDE_ENV_FILE (default W:/Projects/recall-engine/.env.local), or from the environment.
// It is never printed or copied. ANTHROPIC_API_KEY is deliberately ignored so no other bot's key
// (for example the threads-bot key) is ever used here.
//
// Guards (every mode, because dry runs and fixture runs also spend):
//   * at most BOT_DAILY_MODEL_CALLS (40) model calls per Cairo day;
//   * at most BOT_MONTHLY_USD (5) estimated spend per calendar month, computed from the usage
//     tokens Anthropic returns. Once either is hit, model replies are skipped (and retried later).
// The ledger is spend.json (local accounting only, no secrets).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "./config";

const ENV_FILE = process.env.BOT_CLAUDE_ENV_FILE ?? "W:/Projects/recall-engine/.env.local";
export const LEDGER = process.env.BOT_SPEND_FILE ?? join(ROOT, "spend.json");

function num(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) ? n : fallback;
}

export const DAILY_MODEL_CALLS = num("BOT_DAILY_MODEL_CALLS", 40);
export const MONTHLY_USD = num("BOT_MONTHLY_USD", 5);

// USD per million tokens. Claude Sonnet 5.5: $2 input, $10 output, cache reads $0.20,
// cache writes 1.25x input. Unknown models are priced as Opus 5.5 ($4 / $20) to stay safe.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};

let cachedKey: string | null | undefined;

/** The Claude for Startups key, or null when it is not available. Never logged. */
export function claudeKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  let key = process.env.CLAUDE_API_KEY?.trim() || "";
  if (!key && existsSync(ENV_FILE)) {
    const line = readFileSync(ENV_FILE, "utf8").split(/\r?\n/).find((l) => l.startsWith("CLAUDE_API_KEY="));
    key = (line?.slice("CLAUDE_API_KEY=".length) ?? "").trim().replace(/^["']|["']$/g, "");
  }
  cachedKey = key || null;
  return cachedKey;
}

interface Ledger {
  month: string;
  monthUsd: number;
  monthCalls: number;
  day: string;
  dayCalls: number;
}

function cairo(fmt: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.activeTz, ...fmt }).format(new Date());
}

function load(): Ledger {
  const day = cairo({ year: "numeric", month: "2-digit", day: "2-digit" });
  const month = day.slice(0, 7);
  let l: Ledger = { month, monthUsd: 0, monthCalls: 0, day, dayCalls: 0 };
  if (existsSync(LEDGER)) {
    try {
      l = { ...l, ...(JSON.parse(readFileSync(LEDGER, "utf8")) as Partial<Ledger>) };
    } catch {
      /* unreadable ledger: start a fresh one for safety below */
    }
  }
  if (l.month !== month) Object.assign(l, { month, monthUsd: 0, monthCalls: 0 });
  if (l.day !== day) Object.assign(l, { day, dayCalls: 0 });
  return l;
}

/** Null when a model call is allowed now, else the reason it is not. */
export function budgetBlock(): string | null {
  const l = load();
  if (l.dayCalls >= DAILY_MODEL_CALLS) return `daily model-call cap reached (${l.dayCalls}/${DAILY_MODEL_CALLS} today)`;
  if (l.monthUsd >= MONTHLY_USD) return `monthly spend guard reached ($${l.monthUsd.toFixed(2)} of $${MONTHLY_USD})`;
  return null;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Estimated USD for one response from its usage block. */
export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? { in: 4, out: 20 };
  const inTok = u.input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  return (inTok * p.in + write * p.in * 1.25 + read * p.in * 0.1 + (u.output_tokens ?? 0) * p.out) / 1e6;
}

/** Record one model call (counted even when the call failed, so retries cannot loop for free). */
export function recordCall(model: string, usage?: Usage): number {
  const l = load();
  const usd = usage ? costUsd(model, usage) : 0;
  l.dayCalls += 1;
  l.monthCalls += 1;
  l.monthUsd = Math.round((l.monthUsd + usd) * 1e6) / 1e6;
  writeFileSync(LEDGER, JSON.stringify(l, null, 2) + "\n");
  return usd;
}

export function ledgerSummary(): string {
  const l = load();
  return `${l.dayCalls}/${DAILY_MODEL_CALLS} model calls today, $${l.monthUsd.toFixed(4)} of $${MONTHLY_USD} this month (${l.monthCalls} calls)`;
}
