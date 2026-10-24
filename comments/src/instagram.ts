// Thin Instagram Graph API client (Instagram API with Instagram Login), adapted from ig-bot.
// The token is sent only in the Authorization header (never in a URL or a log line).
// Needs a Business or Creator account and the scopes instagram_business_basic and
// instagram_business_manage_comments. Read calls are used by dry runs; replyToComment is the
// ONLY write call and index.ts calls it only in live mode behind BOT_CONFIRM_LIVE=yes.
//
// Comments are one level deep: top-level comments, each with a flat `replies` edge. We flatten
// them and tag each reply with the top-level comment it belongs to (parentId).

import { config, requireEnv } from "./config";

export interface IgMedia {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  media_type?: string;
  media_product_type?: string; // REELS for reels
}

export interface IgComment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  hidden?: boolean;
  parentId?: string | null;
}

interface ListResponse<T> {
  data?: T[];
  paging?: { next?: string };
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${requireEnv("IG_ACCESS_TOKEN")}` },
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? JSON.stringify(json);
    throw new Error(`Instagram API ${init.method ?? "GET"} ${new URL(url).pathname} -> ${res.status}: ${msg}`);
  }
  return json as T;
}

function url(path: string, query: Record<string, string | number | undefined> = {}): string {
  const u = new URL(config.graphBase + path);
  for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
  return u.toString();
}

async function getAll<T>(path: string, query: Record<string, string | number | undefined>): Promise<T[]> {
  let next: string | undefined = url(path, query);
  const out: T[] = [];
  for (let page = 0; next && page < 25; page++) {
    const body: ListResponse<T> = await call<ListResponse<T>>(next);
    if (body.data) out.push(...body.data);
    next = body.paging?.next;
  }
  return out;
}

export async function getMyUsername(): Promise<string> {
  const me = await call<{ username?: string }>(url("/me", { fields: "user_id,username" }));
  if (!me.username) throw new Error("Could not read own username from /me");
  return me.username;
}

/** Recent media, newest first, filtered to the last windowHours. */
export async function getRecentMedia(): Promise<IgMedia[]> {
  const raw = await call<ListResponse<IgMedia>>(
    url("/me/media", { fields: "id,caption,media_type,media_product_type,permalink,timestamp", limit: 25 }),
  );
  const cutoff = Date.now() - config.windowHours * 3_600_000;
  return (raw.data ?? [])
    .filter((m) => !m.timestamp || Date.parse(m.timestamp) >= cutoff)
    .slice(0, config.maxPostsScanned);
}

interface RawComment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  hidden?: boolean;
  replies?: { data?: RawComment[] };
}

export async function getComments(mediaId: string): Promise<IgComment[]> {
  const top = await getAll<RawComment>(`/${mediaId}/comments`, {
    fields: "id,text,username,timestamp,hidden,replies{id,text,username,timestamp,hidden}",
    limit: 50,
  });
  const out: IgComment[] = [];
  for (const c of top) {
    out.push({ id: c.id, text: c.text, username: c.username, timestamp: c.timestamp, hidden: c.hidden, parentId: null });
    for (const r of c.replies?.data ?? []) {
      out.push({ id: r.id, text: r.text, username: r.username, timestamp: r.timestamp, hidden: r.hidden, parentId: c.id });
    }
  }
  return out;
}

/** Arabic replies with English medical terms render scrambled when laid out left to right.
 * A right-to-left embedding (RLE ... PDF) keeps the word order (owner, 24 Oct 2026; same fix as TikTok). */
/**
 * Fresh check on Instagram, right before posting: has @me already replied anywhere in this thread?
 * This is what makes a lost or stale state file safe (it can never cause a second reply).
 * Throws when Instagram cannot be read, so the caller skips instead of replying blind.
 */
export async function ownReplyInThread(threadId: string, me: string): Promise<boolean> {
  const replies = await getAll<{ id: string; username?: string }>(`/${threadId}/replies`, { fields: "id,username", limit: 50 });
  return replies.some((r) => r.username === me);
}

export function rtlWrap(text: string): string {
  if (!/[؀-ۿ]/.test(text) || text.startsWith("‫")) return text;
  return `‫${text}‬`;
}

/** THE ONLY WRITE CALL. Reply to a comment. Live mode only. */
export async function replyToComment(commentId: string, text: string): Promise<string> {
  const res = await call<{ id: string }>(url(`/${commentId}/replies`), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: rtlWrap(text) }).toString(),
  });
  return res.id;
}
