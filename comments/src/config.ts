// Central configuration for the @recallengine reel comment bot. Tunables come from env vars
// with deliberately LOW defaults (owner order 24 Oct: start very low). Secrets are read lazily
// via requireEnv() so the offline fixture run needs no keys at all.

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(ROOT, ".env"), quiet: true });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function onOff(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "on", "yes", "true"].includes(raw);
}

// Active windows as [startHour, endHour) pairs in activeTz, e.g. "19-2" (wraps past midnight).
function parseActiveWindows(): Array<[number, number]> {
  const raw = (process.env.BOT_ACTIVE_WINDOWS ?? "19-2").trim();
  const out: Array<[number, number]> = [];
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out.length ? out : [[0, 24]];
}

export const config = {
  // Quality model for guess grading and drafting (same family the Threads bot uses).
  model: process.env.BOT_MODEL ?? "claude-sonnet-5-5",
  // Hard ceiling on model calls in one run (dry or live), so a run can never surprise the bill.
  maxModelCalls: num("BOT_MAX_MODEL_CALLS", 40),

  // Which media to scan: the newest N posts from the last windowHours.
  maxPostsScanned: num("BOT_MAX_POSTS", 5),
  windowHours: num("BOT_WINDOW_HOURS", 72),

  // Caps. Owner: start very low.
  perReelDailyCap: num("BOT_PER_REEL_DAILY_CAP", 20), // replies per reel per Cairo day
  dailyCap: num("BOT_DAILY_CAP", 40), // all reels together per Cairo day
  perThreadCap: num("BOT_PER_THREAD_CAP", 1), // replies to one account in one comment thread
  minCommentLength: num("BOT_MIN_COMMENT_LEN", 2),

  // Approved templates only in live mode. A template marked "approved": false is never posted:
  // the comment goes to the owner review list instead.
  templatesFile: process.env.BOT_TEMPLATES_FILE ?? join(ROOT, "data", "templates.json"),
  reelsFile: process.env.BOT_REELS_FILE ?? join(ROOT, "data", "reels.json"),
  // Optional: the poster's state.json, to map reel slugs to published media ids.
  // In the recall-poster repo the reel publisher keeps its state in ../reels/state.json.
  posterStateFile: process.env.BOT_POSTER_STATE ?? join(ROOT, "..", "reels", "state.json"),

  activeTz: process.env.BOT_ACTIVE_TZ ?? "Africa/Cairo",
  activeWindows: parseActiveWindows(),

  graphBase: process.env.IG_GRAPH_BASE ?? "https://graph.instagram.com/v21.0",
  stateFile: process.env.BOT_STATE_FILE ?? join(ROOT, "state.json"),
  reviewFile: process.env.BOT_REVIEW_FILE ?? join(ROOT, "review-queue.json"),

  // Live posting safety latch. Must equal "yes". Nothing else enables posting.
  confirmLive: (process.env.BOT_CONFIRM_LIVE ?? "").toLowerCase() === "yes",
  // Cloud runs log to a PUBLIC GitHub Actions page: hide commenters' names, comment texts, and reply texts.
  publicLog: onOff("BOT_PUBLIC_LOG", false),
  // Educational replies (wrong-guess nudges and case questions). Off = those go to the owner list.
  educational: onOff("BOT_EDUCATIONAL", true),
  // Questions about the case. On by default like threads-bot ("teach": answer a genuine question
  // from the supplied facts, skip for the owner when they do not cover it). Off = every drafted
  // answer goes to the owner list instead.
  caseQuestions: onOff("BOT_CASE_QUESTIONS", true),
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}
