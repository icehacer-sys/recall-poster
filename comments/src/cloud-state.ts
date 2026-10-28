// Private state for the cloud comment bot (owner GO, 24 Oct 2026).
//
// state.json, review-queue.json, and spend.json hold commenters' usernames and texts, so they are
// never committed to the public repo. The workflow keeps them in ONE encrypted file,
// cloud-state.enc (AES-256-GCM, key derived from CLAUDE_API_KEY, so no extra secret), stored in the
// Actions cache and as a short-lived artifact. Fork PRs and anyone reading the public repo see only
// ciphertext. A lost or unreadable state is safe: before every reply the bot checks on Instagram
// whether @recallengine already replied in that thread, and daily caps are recounted from Instagram.
//
//   tsx src/cloud-state.ts pack     files -> cloud-state.enc
//   tsx src/cloud-state.ts unpack   cloud-state.enc -> files (missing or unreadable: start fresh)
//   tsx src/cloud-state.ts review   laptop: download the newest state from GitHub and print the owner list

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { config, ROOT } from "./config";
import { claudeKey, LEDGER } from "./budget";
import type { ReviewItem } from "./state";

const ENC_FILE = process.env.BOT_CLOUD_STATE ?? join(ROOT, "cloud-state.enc");
const REPO = process.env.BOT_REPO ?? "icehacer-sys/recall-poster";
// The YouTube bot (youtube-comments.yml) keeps its own files under the same scheme: yt-*.json and
// yt-cloud-state.enc, artifact "yt-comment-state", plus its YouTube quota ledger.
// `review --youtube` (npm run yt:review) reads the YouTube bot's artifact instead.
const YT = process.argv.includes("--youtube");
const WORKFLOW = process.env.BOT_STATE_WORKFLOW ?? (YT ? "youtube-comments.yml" : "comments.yml");
const ARTIFACT = process.env.BOT_STATE_ARTIFACT ?? (YT ? "yt-comment-state" : "comment-state");
const REVIEW_COPY = process.env.BOT_REVIEW_COPY ?? join(ROOT, YT ? "yt-review-queue.cloud.json" : "review-queue.cloud.json");
const FILES = (): Record<string, string> => ({
  state: config.stateFile,
  review: config.reviewFile,
  spend: LEDGER,
  ...(process.env.BOT_QUOTA_FILE ? { quota: process.env.BOT_QUOTA_FILE } : {}),
});

function key(): Buffer {
  const k = claudeKey();
  if (!k) throw new Error("CLAUDE_API_KEY not found: cannot encrypt or decrypt the cloud state.");
  return createHash("sha256").update(`recallengine-comment-state-v1:${k}`).digest();
}

export function encrypt(plain: string, k = key()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export function decrypt(blob: string, k = key()): string {
  const j = JSON.parse(blob) as { v: number; iv: string; tag: string; data: string };
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(j.iv, "base64"));
  d.setAuthTag(Buffer.from(j.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(j.data, "base64")), d.final()]).toString("utf8");
}

function pack(): void {
  const out: Record<string, string> = {};
  for (const [name, path] of Object.entries(FILES())) if (existsSync(path)) out[name] = readFileSync(path, "utf8");
  writeFileSync(ENC_FILE, encrypt(JSON.stringify({ savedAt: new Date().toISOString(), files: out })));
  console.log(`cloud state packed (${Object.keys(out).join(", ") || "nothing yet"}).`);
}

function unpack(): void {
  if (!existsSync(ENC_FILE)) {
    console.log("No saved cloud state: starting fresh. Instagram thread checks still prevent double replies.");
    return;
  }
  let parsed: { savedAt: string; files: Record<string, string> };
  try {
    parsed = JSON.parse(decrypt(readFileSync(ENC_FILE, "utf8")));
  } catch {
    console.log("Saved cloud state could not be decrypted (key changed?): starting fresh. Instagram thread checks still prevent double replies.");
    return;
  }
  for (const [name, path] of Object.entries(FILES())) if (parsed.files[name] != null) writeFileSync(path, parsed.files[name]);
  console.log(`cloud state restored from ${parsed.savedAt} (${Object.keys(parsed.files).join(", ")}).`);
}

/** Laptop: fetch the newest encrypted state artifact and print the pending owner list. */
function review(all: boolean): void {
  const gh = (...a: string[]) => spawnSync("gh", a, { encoding: "utf8" });
  const runs = gh("run", "list", "-R", REPO, "--workflow", WORKFLOW, "--limit", "30", "--json", "databaseId,createdAt");
  if (runs.status !== 0) throw new Error(`gh run list failed: ${runs.stderr}`);
  const list = JSON.parse(runs.stdout) as Array<{ databaseId: number; createdAt: string }>;
  for (const r of list) {
    const dir = mkdtempSync(join(tmpdir(), "comment-state-"));
    const dl = gh("run", "download", String(r.databaseId), "-R", REPO, "-n", ARTIFACT, "-D", dir);
    if (dl.status !== 0) continue;
    const f = readdirSync(dir).find((x) => x.endsWith(".enc"));
    if (!f) continue;
    const parsed = JSON.parse(decrypt(readFileSync(join(dir, f), "utf8"))) as { savedAt: string; files: Record<string, string> };
    const items = (JSON.parse(parsed.files.review ?? "[]") as ReviewItem[]).filter((i) => all || Date.now() - Date.parse(i.at) < 48 * 3_600_000);
    console.log(`Owner list from run ${r.databaseId} (state saved ${parsed.savedAt}), ${all ? "all items" : "last 48 h"}: ${items.length}\n`);
    for (const i of items) console.log(`- ${i.at.slice(0, 16)}Z [${i.reel}] ${i.category} @${i.username}: "${i.text.replace(/\s+/g, " ")}"\n    why: ${i.reason}`);
    if (parsed.files.spend) console.log(`\nSpend ledger: ${parsed.files.spend.replace(/\s+/g, " ")}`);
    writeFileSync(REVIEW_COPY, parsed.files.review ?? "[]");
    console.log(`\nSaved to ${basename(REVIEW_COPY)} (gitignored). Answer these ${WORKFLOW === "comments.yml" ? "on Instagram" : "in YouTube Studio"} yourself.`);
    return;
  }
  console.log(`No ${ARTIFACT} artifact found in the last 30 ${WORKFLOW} runs.`);
}

const cmd = process.argv[2];
if (cmd === "pack") pack();
else if (cmd === "unpack") unpack();
else if (cmd === "review") review(process.argv.includes("--all"));
else if (cmd !== "--lib") {
  console.error("usage: tsx src/cloud-state.ts pack|unpack|review [--all]");
  process.exit(1);
}
