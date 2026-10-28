// Comment replies under the Recall Engine YouTube Shorts (owner, 28 Oct 2026). Same pipeline as the
// Instagram bot: rules, approved templates, the model on the reel's vetted facts, and the guards.
//
//   npm run yt:dry     Read-only: prints what it would do. Writes nothing. Needs the YouTube secrets.
//   npm run yt:draft   The cloud default: drafts replies and saves them, with the owner list, in the
//                      encrypted state (npm run yt:review on the laptop). Posts nothing.
//   npm run yt:live    Posts replies. Needs BOT_CONFIRM_LIVE=yes, which youtube-comments.yml sets only
//                      while the repository variables YT_BOTS is "on" AND YT_REPLIES is "live".
//
// YouTube rules that differ from Instagram (developers.google.com/youtube/terms/developer-policies and
// the spam policy): replies only under the channel's own videos, never a link (Shorts comment links are
// dead text and repeated link replies are comment spam), never "subscribe" asks or comment-for-reward
// prompts, held and likely-spam comments are never approved by the bot. At most one reply per thread,
// BOT_MAX_REPLIES_PER_RUN per run, the daily caps, and the same spend guard.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "./config";
import { loadReels, type ReelFacts } from "./reels";
import type { Decision } from "./reply";
import { State, cairoDate } from "./state";
import { claudeKey, ledgerSummary } from "./budget";
import { decide, loadTemplates, type Ctx } from "./decide";
import { channelThreads, myChannel, ownReplyInThread, quotaUsed, QuotaError, replyToComment, ytSecretsMissing, type YtThread } from "./youtube";

type Mode = "dry-run" | "draft" | "live";

const POSTER_DIR = process.env.BOT_POSTER_REELS_DIR ?? join(ROOT, "..", "reels");
const YT_STATE = process.env.BOT_YT_STATE ?? join(POSTER_DIR, "youtube-state.json");
const MAX_PER_RUN = Number(process.env.BOT_MAX_REPLIES_PER_RUN) || 5;
/** App template replies ("the link is on our channel page") per Cairo day: more reads as channel spam. */
const APP_DAILY = Number(process.env.BOT_APP_DAILY_CAP) || 5;
// YouTube comment data is kept at most 30 days (API Developer Policies III.E.4). State reads it lazily.
process.env.BOT_RETENTION_DAYS ||= "30";
/** Our replies come back with the right-to-left wrap: compare without it. */
const unwrap = (s: string) => s.replace(/[\u202A-\u202E\u2066-\u2069]/g, "").trim();

/** videoId -> reel slug, from the uploader's public state file. */
function videoSlugs(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(YT_STATE)) return out;
  const s = JSON.parse(readFileSync(YT_STATE, "utf8")) as Record<string, { videoId?: string }>;
  for (const [k, v] of Object.entries(s)) if (k.startsWith("yt:") && v.videoId) out.set(v.videoId, k.slice(3));
  return out;
}

/** The vetted facts for a reel slug: same slug, else the one facts entry with the reel's story day. */
function factsFor(slug: string, facts: ReelFacts[]): ReelFacts | undefined {
  const exact = facts.find((f) => f.slug === slug);
  if (exact) return exact;
  const f = join(POSTER_DIR, slug, "reel.json");
  if (!existsSync(f)) return undefined;
  const day = (JSON.parse(readFileSync(f, "utf8")) as { storyDay?: string }).storyDay;
  const same = facts.filter((x) => day && x.storyDay === day);
  return same.length === 1 ? same[0] : undefined;
}

function withinActiveHours(): boolean {
  const hh = Number(new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: config.activeTz }).format(new Date())) % 24;
  return config.activeWindows.some(([a, b]) => (a <= b ? hh >= a && hh < b : hh >= a || hh < b));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function printRow(slug: string, t: YtThread, d: Decision): void {
  if (config.publicLog) {
    // Public run log: no names, comment texts, or reply texts. They are in the encrypted state.
    console.log(`  [${slug}] ${d.category} ${d.decision} ${d.language} ${d.source}${d.ownerReview ? " OWNER LIST" : ""}${d.retry ? " (retry later)" : ""}`);
    return;
  }
  console.log(`  [${slug}] [${d.category.padEnd(16)} ${d.decision.padEnd(5)} ${d.language} ${d.source}] "${oneLine(t.text).slice(0, 70)}"`);
  if (d.decision === "reply") console.log(`        -> "${d.reply_text}"`);
  else console.log(`        (skip${d.ownerReview ? ", OWNER LIST" : ""}: ${oneLine(d.reason)})`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode: Mode = argv.includes("--live") ? "live" : argv.includes("--draft") ? "draft" : "dry-run";
  const offline = argv.includes("--offline") || !claudeKey();
  const channelId = (process.env.YT_CHANNEL_ID ?? "").trim();
  if (mode === "live" && !config.confirmLive) throw new Error("LIVE refused: set BOT_CONFIRM_LIVE=yes to allow replies (the workflow does this only with YT_REPLIES=live).");
  if (mode === "live" && offline) throw new Error("LIVE refused: live replies need the model (CLAUDE_API_KEY not found, or --offline was given).");
  if (ytSecretsMissing().length) throw new Error(`missing ${ytSecretsMissing().join(", ")}: the owner runs node scripts/youtube-auth.mjs. Nothing read.`);
  if (!channelId) throw new Error("YT_CHANNEL_ID is not set. Nothing read.");
  if (mode === "live" && !withinActiveHours()) {
    console.log(`Outside the active window (${config.activeWindows.map(([a, b]) => `${a}-${b}`).join(", ")} ${config.activeTz}). Nothing to do.`);
    return;
  }

  const me = await myChannel();
  if (me.id !== channelId) throw new Error(`the token belongs to channel ${me.id}, not YT_CHANNEL_ID ${channelId}. Nothing read or posted.`);
  const state = new State(mode !== "dry-run");
  const templates = loadTemplates();
  const facts = loadReels().reels;
  const slugs = videoSlugs();
  const ctx: Ctx = { offline, modelCalls: 0, recentReplies: [], n: 0, boundaries: new Set<string>(state.boundaryKeys()), lastVariant: -1, platform: "youtube", templates };
  if (mode !== "dry-run") state.prune();
  // App template lines, to recount app replies from YouTube itself (lost state stays safe).
  const appLines = new Set(
    (["en", "ar"] as const).flatMap((l) => {
      const t = templates.youtube_app_question?.[l];
      return t ? [...t.price, ...t.where].map(unwrap) : [];
    }),
  );

  const threads = (await channelThreads(channelId)).filter((t) => !t.publishedAt || Date.now() - Date.parse(t.publishedAt) <= config.windowHours * 3_600_000);
  // Held and likely-spam comments: listed for the owner (Studio > Comments), never approved or answered by the bot.
  let held = 0;
  for (const status of ["heldForReview", "likelySpam"]) {
    try {
      for (const t of await channelThreads(channelId, status)) {
        held++;
        if (mode !== "dry-run") state.addReview({ at: new Date().toISOString(), reel: slugs.get(t.videoId) ?? t.videoId, mediaId: t.videoId, commentId: t.id, username: t.author, text: t.text, category: status, reason: "held by YouTube: review it in YouTube Studio > Comments. The bot never approves held comments." });
      }
    } catch (e) {
      console.log(`  (could not count ${status} comments: ${(e as Error).message})`);
    }
  }

  const ours = (c: { authorChannelId?: string }) => c.authorChannelId === me.id;
  const today = cairoDate();
  const ytToday = (slug?: string) =>
    threads.filter((t) => !slug || slugs.get(t.videoId) === slug).reduce((n, t) => n + t.replies.filter((r) => ours(r) && r.publishedAt && cairoDate(Date.parse(r.publishedAt)) === today).length, 0);
  console.log(`\n${mode === "live" ? "LIVE" : mode === "draft" ? "DRAFT (nothing posted, drafts saved for the owner)" : "DRY-RUN (read-only)"}: ${me.title}${me.customUrl ? ` ${me.customUrl}` : ""}, ${threads.length} recent thread(s), ${held} held for review. Caps: ${MAX_PER_RUN}/run, ${config.perReelDailyCap}/video/day, ${config.dailyCap}/day, 1/thread. Today so far: ${Math.max(state.repliesToday(), ytToday())}.\n`);

  let replies = 0;
  const postedHere = new Map<string, number>();
  let appHere = 0;
  const appGivenHere = new Set<string>();
  const isApp = (r: { text: string; authorChannelId?: string }) => ours(r) && appLines.has(unwrap(r.text));
  const appToday = () => threads.reduce((n, t) => n + t.replies.filter((r) => isApp(r) && r.publishedAt && cairoDate(Date.parse(r.publishedAt)) === today).length, 0);
  const appAlreadyFor = (videoId: string, who: string) => appGivenHere.has(`${videoId}|${who}`) || threads.some((x) => x.videoId === videoId && (x.authorChannelId ?? x.author) === who && x.replies.some(isApp));
  // A boundary line that did not actually post must not count as given.
  const boundaryKind: Record<string, string> = { personal_medical: "personal", scan: "scan", urgent: "urgent" };
  const ungive = (slug: string, who: string, d: Decision) => {
    if (d.source === "template" && boundaryKind[d.category]) ctx.boundaries.delete(`${slug}|${who}|${boundaryKind[d.category]}`);
  };
  for (const t of [...threads].sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""))) {
    const slug = slugs.get(t.videoId);
    const reel = slug ? factsFor(slug, facts) : undefined;
    if (!slug || !reel) {
      if (!config.publicLog) console.log(`  video ${t.videoId}: ${slug ? `no vetted facts for ${slug}` : "not one of our uploaded Shorts"}, skipped.`);
      continue;
    }
    if (ours(t) || state.handled(t.id) || (mode === "draft" && state.drafted(t.id))) continue;
    if (t.replies.some(ours)) {
      if (mode === "live") state.markHandled(t.id);
      continue; // already answered in this thread
    }
    if (!t.canReply) {
      if (mode === "live") state.markHandled(t.id);
      continue;
    }
    // Caps first: a comment that could not be answered anyway is left for a later run before any paid model call.
    const usedVideo = Math.max(state.repliesToday(slug), ytToday(slug)) + (mode === "live" ? 0 : postedHere.get(slug) ?? 0);
    const usedDay = Math.max(state.repliesToday(), ytToday()) + (mode === "live" ? 0 : replies);
    if (replies >= MAX_PER_RUN || usedDay >= config.dailyCap) {
      console.log(`  ${replies >= MAX_PER_RUN ? "run" : "daily"} cap reached: the rest waits for a later run (retry later).`);
      break;
    }
    if (usedVideo >= config.perReelDailyCap) continue;
    const who = t.authorChannelId ?? t.author;
    ctx.recentReplies = threads.filter((x) => x.videoId === t.videoId).flatMap((x) => x.replies.filter(ours).map((r) => r.text)).slice(-20);
    const d = await decide({ reel, username: who }, t.text, ctx);
    let row = d;
    if (d.decision === "reply" && d.category === "app_question") {
      const appUsed = appToday() + (mode === "live" ? 0 : appHere);
      if (appAlreadyFor(t.videoId, who) || appUsed >= APP_DAILY) {
        row = { ...d, decision: "skip", reply_text: "", reason: appUsed >= APP_DAILY ? `app reply limit: ${APP_DAILY} a day (more reads as channel spam)` : "app reply limit: this commenter already got one under this Short", ownerReview: true };
      }
    }
    printRow(slug, t, row);
    if (row.ownerReview && mode !== "dry-run") {
      state.addReview({ at: new Date().toISOString(), reel: slug, mediaId: t.videoId, commentId: t.id, username: t.author, text: t.text, category: row.category, reason: row.reason });
    }
    if (row.decision !== "reply") {
      if (!row.retry && mode === "live") state.markHandled(t.id);
      if (!row.retry && mode === "draft") state.markDrafted(t.id);
      continue;
    }
    if (mode !== "live") {
      if (mode === "draft") {
        state.addReview({ at: new Date().toISOString(), reel: slug, mediaId: t.videoId, commentId: t.id, username: t.author, text: t.text, category: "proposed_reply", reason: `draft (${row.category}, ${row.source}): "${row.reply_text}"` });
        state.markDrafted(t.id);
      }
      replies++;
      postedHere.set(slug, (postedHere.get(slug) ?? 0) + 1);
      if (row.category === "app_question") {
        appHere++;
        appGivenHere.add(`${t.videoId}|${who}`);
      }
      continue;
    }
    try {
      if (await ownReplyInThread(t.id, me.id)) {
        console.log(`    thread already has our reply on YouTube: skipped.`);
        ungive(reel.slug, t.authorChannelId ?? t.author, row);
        state.markHandled(t.id);
        continue;
      }
      await replyToComment(t.id, row.reply_text);
      if (row.category === "app_question") appGivenHere.add(`${t.videoId}|${who}`);
      replies++;
      state.countReply(slug);
      state.saveBoundaries(ctx.boundaries);
      state.markHandled(t.id);
      t.replies.push({ id: `local-${t.id}`, text: row.reply_text, author: me.title, authorChannelId: me.id, publishedAt: new Date().toISOString() });
    } catch (e) {
      console.error(`    ! reply failed (retried next run): ${(e as Error).message}`);
      ungive(reel.slug, t.authorChannelId ?? t.author, row);
      if (e instanceof QuotaError) break;
    }
  }
  const q = quotaUsed();
  console.log(`\nDone. ${mode === "live" ? "Posted" : mode === "draft" ? "Drafted" : "Would post"} ${replies} replies. Owner list pending: ${state.pendingReview().length}. Model calls: ${ctx.modelCalls}. Budget: ${ledgerSummary()}. YouTube quota (Pacific ${q.day}): ${q.units} units.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
