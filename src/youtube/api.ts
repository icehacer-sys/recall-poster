// Thin YouTube Data API v3 client for the uploader. Plain fetch, no SDK, like the Instagram client.
// OAuth: the refresh token (YT_REFRESH_TOKEN, scope youtube.force-ssl) is exchanged for a short-lived
// access token. Neither is ever logged, and error messages carry only Google's reason and message.
// Quota: every call is charged to the ledger in reels/youtube-state.json BEFORE it is made (failed
// calls cost quota too) and refused when it would pass the uploader's share of the daily quota.

import { yt } from "./config.js";
import type { YtState } from "./state.js";

/** Quota costs (developers.google.com/youtube/v3/determine_quota_cost, checked 28 Oct 2026). */
export const COST = {
  list: 1, // channels, playlistItems, videos, commentThreads, comments, videoCategories, i18nLanguages
  insert: 1, // videos.insert: its own bucket, 100 per day
  update: 50, // videos.update
  thumbnail: 50, // thumbnails.set
  comment: 50, // comments.insert
};

export class QuotaError extends Error {}

export class YoutubeApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
  }
}

export interface Channel {
  id: string;
  title: string;
  customUrl?: string;
  uploadsPlaylistId?: string;
}

export interface VideoResource {
  id: string;
  snippet?: { title?: string; description?: string; tags?: string[]; channelId?: string; publishedAt?: string };
  status?: { privacyStatus?: string; publishAt?: string; uploadStatus?: string; rejectionReason?: string; failureReason?: string; selfDeclaredMadeForKids?: boolean; containsSyntheticMedia?: boolean };
  contentDetails?: { duration?: string };
}

export interface InsertBody {
  snippet: { title: string; description: string; tags: string[]; categoryId: string; defaultLanguage: string; defaultAudioLanguage: string };
  status: { privacyStatus: "private" | "public" | "unlisted"; publishAt?: string; selfDeclaredMadeForKids: boolean; containsSyntheticMedia: boolean; embeddable: boolean; license: "youtube" };
}

export function missingSecrets(): string[] {
  return ["YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"].filter((n) => !(process.env[n] ?? "").trim());
}

async function googleError(res: Response, what: string): Promise<YoutubeApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: Array<{ reason?: string }> } | string; error_description?: string };
  const err = typeof body.error === "object" ? body.error : undefined;
  const reason = err?.errors?.[0]?.reason ?? (typeof body.error === "string" ? body.error : undefined);
  const message = err?.message ?? body.error_description ?? "";
  return new YoutubeApiError(`YouTube API ${what} -> ${res.status}${reason ? ` ${reason}` : ""}${message ? `: ${message.slice(0, 200)}` : ""}`, res.status, reason);
}

export class YouTubeClient {
  private accessToken: string | null = null;

  constructor(private readonly state: YtState, private readonly budget = { units: yt.unitBudget, uploads: yt.uploadBudget }) {}

  /** Exchange the refresh token for an access token (no quota cost). */
  async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const missing = missingSecrets();
    if (missing.length) throw new Error(`missing ${missing.join(", ")} (the owner runs node scripts/youtube-auth.mjs)`);
    const res = await fetch(yt.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.YT_CLIENT_ID!.trim(),
        client_secret: process.env.YT_CLIENT_SECRET!.trim(),
        refresh_token: process.env.YT_REFRESH_TOKEN!.trim(),
        grant_type: "refresh_token",
      }).toString(),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!res.ok || !j.access_token) {
      const hint = j.error === "invalid_grant" ? "the refresh token expired or was revoked. The owner reruns node scripts/youtube-auth.mjs" : "check YT_CLIENT_ID and YT_CLIENT_SECRET";
      throw new Error(`OAuth refresh failed (${res.status}${j.error ? ` ${j.error}` : ""}): ${hint}.`);
    }
    this.accessToken = j.access_token;
    return this.accessToken;
  }

  /** Charge the ledger first: Google bills invalid and failed requests too. */
  private charge(units: number, uploads = 0): void {
    const q = this.state.quota();
    if (q.units + units > this.budget.units) throw new QuotaError(`quota: ${q.units} + ${units} units would pass the uploader's budget of ${this.budget.units} for ${q.day} (Pacific). Retried after midnight Pacific.`);
    if (q.uploads + uploads > this.budget.uploads) throw new QuotaError(`quota: ${q.uploads} uploads already on ${q.day} (Pacific), budget ${this.budget.uploads}.`);
    this.state.addQuota(units, uploads);
  }

  private async get<T>(path: string, query: Record<string, string | number>, units = COST.list): Promise<T> {
    this.charge(units);
    const u = new URL(`${yt.apiBase}/youtube/v3/${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    const res = await fetch(u, { headers: { Authorization: `Bearer ${await this.token()}` } });
    if (!res.ok) throw await googleError(res, `GET ${path}`);
    return (await res.json()) as T;
  }

  /** channels.list mine=true (1 unit): the channel this token belongs to. */
  async myChannel(): Promise<Channel> {
    const j = await this.get<{ items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>("channels", { part: "snippet,contentDetails", mine: "true" });
    const c = j.items?.[0];
    if (!c) throw new Error("this token has no YouTube channel (sign in again and pick the Recall Engine channel)");
    return { id: c.id, title: c.snippet?.title ?? "", customUrl: c.snippet?.customUrl, uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads };
  }

  /** The newest uploads of the channel (playlistItems.list, 1 unit). Includes private and scheduled videos for the owner's token. */
  async recentUploadIds(playlistId: string, max = 50): Promise<string[]> {
    const j = await this.get<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>("playlistItems", { part: "contentDetails", playlistId, maxResults: Math.min(max, 50) });
    return (j.items ?? []).map((i) => i.contentDetails?.videoId).filter((v): v is string => !!v);
  }

  /** videos.list (1 unit for up to 50 ids). */
  async videos(ids: string[], part = "snippet,status"): Promise<VideoResource[]> {
    if (!ids.length) return [];
    const j = await this.get<{ items?: VideoResource[] }>("videos", { part, id: ids.slice(0, 50).join(",") });
    return j.items ?? [];
  }

  /**
   * videos.insert as a resumable upload (1 unit in the upload bucket): POST the metadata for a
   * session URL, then PUT the bytes. A dropped connection is resumed from the byte YouTube confirms.
   */
  async insertVideo(body: InsertBody, bytes: Buffer, notifySubscribers: boolean): Promise<VideoResource> {
    this.charge(0, 1);
    const u = new URL(`${yt.apiBase}/upload/youtube/v3/videos`);
    u.searchParams.set("uploadType", "resumable");
    u.searchParams.set("part", "snippet,status");
    u.searchParams.set("notifySubscribers", String(notifySubscribers));
    const start = await fetch(u, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(bytes.length),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(body),
    });
    if (!start.ok) throw await googleError(start, "POST videos (resumable start)");
    const session = start.headers.get("location");
    if (!session) throw new Error("YouTube API: no upload session URL in the response");

    let offset = 0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(session, {
          method: "PUT",
          headers: {
            "Content-Type": "video/mp4",
            ...(offset > 0 ? { "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
          },
          body: new Uint8Array(bytes.subarray(offset)),
        });
        if (res.ok) return (await res.json()) as VideoResource;
        if (res.status < 500 && res.status !== 308) throw await googleError(res, "PUT video bytes");
      } catch (e) {
        if (e instanceof YoutubeApiError) throw e;
        if (attempt === 4) throw new Error(`upload failed after ${attempt} attempts: ${(e as Error).message}`);
      }
      // Ask YouTube how much arrived, then resume from there.
      const probe = await fetch(session, { method: "PUT", headers: { "Content-Range": `bytes */${bytes.length}` } });
      if (probe.ok) return (await probe.json()) as VideoResource;
      if (probe.status !== 308) throw await googleError(probe, "PUT upload status");
      const range = probe.headers.get("range")?.match(/bytes=0-(\d+)/);
      offset = range ? Number(range[1]) + 1 : 0;
      console.log(`  upload interrupted, resuming at byte ${offset} of ${bytes.length}`);
    }
    throw new Error("upload did not complete");
  }

  /**
   * videos.update part=status (50 units). The status part is replaced as a whole, so leaving out
   * publishAt cancels a scheduled publish.
   */
  async updateStatus(videoId: string, status: Omit<InsertBody["status"], "embeddable" | "license"> & { embeddable?: boolean; license?: string }): Promise<VideoResource> {
    this.charge(COST.update);
    const u = new URL(`${yt.apiBase}/youtube/v3/videos`);
    u.searchParams.set("part", "status");
    const res = await fetch(u, {
      method: "PUT",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ id: videoId, status }),
    });
    if (!res.ok) throw await googleError(res, "PUT videos (status)");
    return (await res.json()) as VideoResource;
  }

  /** thumbnails.set (50 units). Shorts thumbnails are Partner Program only for now: a 403 is expected. */
  async setThumbnail(videoId: string, jpeg: Buffer): Promise<void> {
    this.charge(COST.thumbnail);
    const u = new URL(`${yt.apiBase}/upload/youtube/v3/thumbnails/set`);
    u.searchParams.set("videoId", videoId);
    const res = await fetch(u, { method: "POST", headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "image/jpeg" }, body: new Uint8Array(jpeg) });
    if (!res.ok) throw await googleError(res, "POST thumbnails/set");
  }
}
