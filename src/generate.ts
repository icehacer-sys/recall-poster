// Queue top-up. Keeps BOT_QUEUE_TARGET un-posted posts ahead by asking Claude for new
// high-yield topics in the Recall Engine voice. New topics are written as draft posts the
// owner reviews; they only go live once `draft` is removed/false. BOT_AUTO_APPROVE controls
// whether the GENERATOR writes them pre-approved (draft:false) — it never affects publishing.
//
// Run standalone: `npm run generate`.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, requireEnv } from "./config.js";
import { loadPosts } from "./posts.js";
import type { Post, SlidePoint } from "./types.js";

const DAY_MS = 86_400_000;
const POST_HOUR_UTC = 19; // 22:00 Africa/Cairo (UTC+3 in summer)

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function pad5(n: number): string {
  return String(n).padStart(5, "0");
}

/** Next 19:00 UTC slot strictly after the latest scheduled post (or after now). */
function nextSlot(latest: Date): string {
  const base = new Date(Math.max(latest.getTime(), Date.now()));
  const d = new Date(base.getTime() + DAY_MS);
  d.setUTCHours(POST_HOUR_UTC, 0, 0, 0);
  return d.toISOString();
}

interface Draft {
  subject: string;
  title: string;
  hook: string;
  points: SlidePoint[];
  cta: string;
  caption: string;
  hashtags: string[];
}

const SYSTEM =
  "You write high-yield Instagram carousel content for @recallengine, a medical exam-revision brand for " +
  "medical students (SBAs, MCQs, OSCEs; UK/PLAB and USMLE). Voice: authoritative, high-yield, " +
  "confidence-building, clear. No 'guess the diagnosis' game, no 'not medical advice' disclaimer, no emoji " +
  "spam. Every clinical fact MUST be correct and exam-standard; if unsure, pick a safer, well-established " +
  "topic. Each post is 6 slides: a hook, exactly 4 value slides, and a CTA. The CTA drives to the Recall " +
  "Engine app (turn any lecture into questions, flashcards, and notes).";

function userPrompt(n: number, existingTitles: string[]): string {
  return (
    `Propose ${n} NEW carousel topics. Avoid anything close to these existing titles:\n` +
    existingTitles.map((t) => `- ${t}`).join("\n") +
    `\n\nReturn ONLY a JSON array of ${n} objects, each exactly:\n` +
    `{"subject": string, "title": string, "hook": string, ` +
    `"points": [{"heading": string, "body": string} x4], "cta": string, ` +
    `"caption": string, "hashtags": [string x15 without '#']}\n` +
    `Keep each point body to 2-3 short sentences. Keep the title under 50 characters. Output the array only.`
  );
}

/** Parse a JSON array from model output: try the whole string, then an outer-bracket slice. */
function extractJson(text: string): Draft[] {
  const tryParse = (s: string): Draft[] | null => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? (v as Draft[]) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (sliced) return sliced;
  }
  throw new Error(`No JSON array in model output:\n${text.slice(0, 300)}`);
}

async function main(): Promise<void> {
  const posts = loadPosts();
  const pending = posts.filter((p) => p.postAt && new Date(p.postAt) >= new Date());
  const need = config.queueTarget - pending.length;
  if (need <= 0) {
    console.log(`Queue healthy: ${pending.length} upcoming >= target ${config.queueTarget}. Nothing to do.`);
    return;
  }

  console.log(`Queue low (${pending.length}/${config.queueTarget}); asking Claude for ${need} topic(s)...`);
  const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  const res = await client.messages.create({
    model: config.model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: userPrompt(need, posts.map((p) => p.title)) }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const drafts = extractJson(text);

  let number = posts.reduce((m, p) => Math.max(m, p.number ?? 0), 0);
  let latest = posts.reduce((d, p) => (p.postAt && new Date(p.postAt) > d ? new Date(p.postAt) : d), new Date(0));

  let added = 0;
  for (const draft of drafts.slice(0, need)) {
    number += 1;
    const slug = `${pad5(number)}-${slugify(draft.title)}`;
    const dir = join(config.postsDir, slug);
    if (existsSync(join(dir, "post.json"))) continue;
    mkdirSync(dir, { recursive: true });
    const postAt = nextSlot(latest);
    latest = new Date(postAt);
    const post: Post = {
      slug,
      number,
      subject: draft.subject,
      title: draft.title,
      hook: draft.hook,
      points: draft.points,
      cta: draft.cta,
      caption: draft.caption,
      hashtags: draft.hashtags,
      postAt,
      // Pre-approved only if BOT_AUTO_APPROVE is on; otherwise a draft the owner must approve.
      draft: !config.autoApprove,
    };
    writeFileSync(join(dir, "post.json"), JSON.stringify(post, null, 2) + "\n");
    console.log(`  + drafted ${slug} for ${postAt}${post.draft ? " (draft)" : ""}`);
    added += 1;
  }
  console.log(`Done: ${added} topic(s) added. Review drafts and set "draft": false to schedule them.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
