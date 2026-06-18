// Central config. Loads ../.env regardless of cwd. Secrets are read lazily via
// requireEnv() so --sample / --dry-run (which only need the OpenAI key) work
// without the Instagram token.

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "on", "yes", "true"].includes(raw.trim().toLowerCase());
}

export const config = {
  // Brand
  handle: process.env.BOT_HANDLE ?? "@recallengine",
  // CTA destination, surfaced only as "link in bio". Placeholder until the owner confirms it.
  appUrl: process.env.BOT_APP_URL ?? "",

  // Claude model for captions / topic generation. Haiku is plenty for routine copy.
  model: process.env.BOT_MODEL ?? "claude-haiku-4-5-20251001",

  // Instagram Graph API. Token-scoped via /me/media (no separate user id needed).
  igBase: process.env.IG_GRAPH_BASE ?? "https://graph.instagram.com/v21.0",

  // Public base for slide image URLs (see .env.example). Trailing slash trimmed.
  githubRawBase: (process.env.GITHUB_RAW_BASE ?? "").replace(/\/+$/, ""),

  // --- gpt-image-2 slide generation ---
  imageModel: process.env.BOT_IMAGE_MODEL ?? "gpt-image-2",
  imageSize: process.env.BOT_IMAGE_SIZE ?? "1024x1024",
  // low | medium | high | auto. medium is the cost/quality sweet spot.
  imageQuality: process.env.BOT_IMAGE_QUALITY ?? "medium",
  // Final square px after sharp post-processing.
  slideSize: num("BOT_SLIDE_SIZE", 1080),

  // --- queue + state ---
  postsDir: process.env.BOT_POSTS_DIR ?? "./posts",
  stateFile: process.env.BOT_STATE_FILE ?? "./state.json",
  queueTarget: num("BOT_QUEUE_TARGET", 7),
  // Off = generator's NEW topics need owner review before they post. Seeded posts always post.
  autoApprove: bool("BOT_AUTO_APPROVE", false),
  // Pre-render (and let the runner commit) slides for posts due within this many hours,
  // so images are public before the publish call fetches them.
  renderLookaheadH: num("BOT_RENDER_LOOKAHEAD_H", 26),

  // Live posting safety latch. Must equal "yes".
  confirmLive: (process.env.BOT_CONFIRM_LIVE ?? "").toLowerCase() === "yes",
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}
