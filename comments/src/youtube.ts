// Thin YouTube Data API v3 client for the comment bot (Recall Engine channel, owner 28 Oct 2026).
// OAuth: YT_CLIENT_ID, YT_CLIENT_SECRET, and YT_REFRESH_TOKEN (scope youtube.force-ssl) give a
// short-lived access token. Tokens are only ever sent in the Authorization header, never logged.
// It reads comment threads under the channel's OWN videos and replies there only (the API
// Developer Policies allow automated comments only with the user's consent: his channel, nothing else).
// replyToComment (comments.insert) is the ONLY write call and yt-run.ts calls it only in live mode.
// Quota: every call is charged to a ledger (Pacific day) BEFORE it is made, and refused when it would
// pass this bot's share of the project's 10,000 daily units (YT_COMMENT_UNIT_BUDGET, default 3,000).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config";

const API = (process.env.YT_API_BASE ?? "https://www.googleapis.com").replace(/\/+$/, "");
const TOKEN_URL = process.env.YT_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
export const QUOTA_FILE = process.env.BOT_QUOTA_FILE ?? join(ROOT, "yt-quota.json");
const BUDGET = Number(process.env.YT_COMMENT_UNIT_BUDGET) || 3000;

export const COST = { list: 1, reply: 50 };

export interface YtReply {
  id: string;
  text: string;
  author: string;
  authorChannelId?: string;
  publishedAt?: string;
}

export interface YtThread {
  /** Thread id = the top-level comment id (the parentId for a reply). */
  id: string;
  videoId: string;
  text: string;
  author: string;
  authorChannelId?: string;
  publishedAt?: string;
  canReply: boolean;
  totalReplyCount: number;
  replies: YtReply[];
}

export class QuotaError extends Error {}

function pacificDay(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function quotaUsed(): { day: string; units: number } {
  const day = pacificDay();
  try {
    const q = existsSync(QUOTA_FILE) ? (JSON.parse(readFileSync(QUOTA_FILE, "utf8")) as { day: string; units: number }) : null;
    return q && q.day === day ? q : { day, units: 0 };
  } catch {
    return { day, units: 0 };
  }
}

function charge(units: number): void {
  const q = quotaUsed();
  if (q.units + units > BUDGET) throw new QuotaError(`YouTube quota: ${q.units} + ${units} units would pass this bot's budget of ${BUDGET} for ${q.day} (Pacific)`);
  writeFileSync(QUOTA_FILE, JSON.stringify({ day: q.day, units: q.units + units }) + "\n");
}

let accessToken: string | null = null;

export function ytSecretsMissing(): string[] {
  return ["YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"].filter((n) => !(process.env[n] ?? "").trim());
}

async function token(): Promise<string> {
  if (accessToken) return accessToken;
  const missing = ytSecretsMissing();
  if (missing.length) throw new Error(`missing ${missing.join(", ")} (the owner runs node scripts/youtube-auth.mjs)`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.YT_CLIENT_ID!.trim(), client_secret: process.env.YT_CLIENT_SECRET!.trim(), refresh_token: process.env.YT_REFRESH_TOKEN!.trim(), grant_type: "refresh_token" }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !j.access_token) throw new Error(`YouTube OAuth refresh failed (${res.status}${j.error ? ` ${j.error}` : ""})${j.error === "invalid_grant" ? ": the owner reruns node scripts/youtube-auth.mjs" : ""}`);
  accessToken = j.access_token;
  return accessToken;
}

async function call<T>(method: "GET" | "POST", path: string, query: Record<string, string | number>, units: number, body?: unknown): Promise<T> {
  charge(units);
  const u = new URL(`${API}/youtube/v3/${path}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  const res = await fetch(u, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { "Content-Type": "application/json; charset=UTF-8" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
  if (!res.ok) {
    const reason = json.error?.errors?.[0]?.reason;
    throw new Error(`YouTube API ${method} ${path} -> ${res.status}${reason ? ` ${reason}` : ""}: ${(json.error?.message ?? "").slice(0, 160)}`);
  }
  return json as T;
}

/** channels.list mine=true (1 unit). */
export async function myChannel(): Promise<{ id: string; title: string; customUrl?: string }> {
  const j = await call<{ items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string } }> }>("GET", "channels", { part: "snippet", mine: "true" }, COST.list);
  const c = j.items?.[0];
  if (!c) throw new Error("this token has no YouTube channel");
  return { id: c.id, title: c.snippet?.title ?? "", customUrl: c.snippet?.customUrl };
}

interface RawComment {
  id: string;
  snippet?: { textDisplay?: string; authorDisplayName?: string; authorChannelId?: { value?: string }; publishedAt?: string; parentId?: string };
}
interface RawThread {
  id: string;
  snippet?: { videoId?: string; canReply?: boolean; totalReplyCount?: number; topLevelComment?: RawComment };
  replies?: { comments?: RawComment[] };
}

const reply = (c: RawComment): YtReply => ({ id: c.id, text: c.snippet?.textDisplay ?? "", author: c.snippet?.authorDisplayName ?? "", authorChannelId: c.snippet?.authorChannelId?.value, publishedAt: c.snippet?.publishedAt });

/**
 * The newest comment threads under ALL the channel's videos (commentThreads.list
 * allThreadsRelatedToChannelId, 1 unit for up to 100). moderationStatus "published" by default;
 * "heldForReview" and "likelySpam" are only counted for the owner and never approved by the bot.
 */
export async function channelThreads(channelId: string, moderationStatus = "published"): Promise<YtThread[]> {
  const j = await call<{ items?: RawThread[] }>("GET", "commentThreads", { part: "snippet,replies", allThreadsRelatedToChannelId: channelId, order: "time", maxResults: 100, textFormat: "plainText", moderationStatus }, COST.list);
  return (j.items ?? []).map((t) => {
    const top = t.snippet?.topLevelComment;
    return {
      id: t.id,
      videoId: t.snippet?.videoId ?? "",
      text: top?.snippet?.textDisplay ?? "",
      author: top?.snippet?.authorDisplayName ?? "",
      authorChannelId: top?.snippet?.authorChannelId?.value,
      publishedAt: top?.snippet?.publishedAt,
      canReply: t.snippet?.canReply !== false,
      totalReplyCount: t.snippet?.totalReplyCount ?? 0,
      replies: (t.replies?.comments ?? []).map(reply),
    };
  });
}

/**
 * Fresh check right before posting: has the channel already replied anywhere in this thread?
 * comments.list parentId (1 unit). Throws when YouTube cannot be read, so the caller skips.
 */
export async function ownReplyInThread(threadId: string, channelId: string): Promise<boolean> {
  const j = await call<{ items?: RawComment[] }>("GET", "comments", { part: "snippet", parentId: threadId, maxResults: 100, textFormat: "plainText" }, COST.list);
  return (j.items ?? []).some((c) => c.snippet?.authorChannelId?.value === channelId);
}

/**
 * Arabic replies with English medical terms need a right-to-left wrap or they render scrambled.
 * Instagram uses RLE ... PDF (owner, 24 Oct 2026). YouTube is untested: YT_RTL_WRAP=rli switches to
 * RLI ... PDI and none turns it off.
 */
export function rtlWrapYt(text: string): string {
  const mode = (process.env.YT_RTL_WRAP ?? "rle").toLowerCase();
  if (mode === "none" || !/[؀-ۿ]/.test(text) || /^[‫⁧]/.test(text)) return text;
  return mode === "rli" ? `⁧${text}⁩` : `‫${text}‬`;
}

/** THE ONLY WRITE CALL. comments.insert (50 units): a reply under a top-level comment. Live mode only. */
export async function replyToComment(parentId: string, text: string): Promise<string> {
  const j = await call<{ id: string }>("POST", "comments", { part: "snippet" }, COST.reply, { snippet: { parentId, textOriginal: rtlWrapYt(text) } });
  return j.id;
}
