// YouTube upload state: reels/youtube-state.json (public ids and times only, committed back by the
// workflow, separate from reels/state.json so the two workflows never fight over one file).
// Keys: "yt:<slug>" per reel, "_quota" for the uploader's quota ledger (Pacific day).

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface YtReelState {
  videoId?: string;
  uploadedAt?: string;
  /** "uploaded" by this bot or "found" on the channel (lost-state guard). */
  recordedFrom?: "uploaded" | "found";
  /** The slot from youtube.json at upload time (sent as publishAt only when YT_PUBLIC=on). */
  slotAt?: string;
  titleSent?: string;
  privacyStatusSent?: string;
  publishAtSent?: string;
  /** Read back right after the upload. */
  privacyStatusSeen?: string;
  publishAtSeen?: string;
  uploadStatusSeen?: string;
  /** YouTube kept the video private although a publish time was sent (an API project still locked to private). */
  lockedPrivate?: boolean;
  /**
   * YouTube opened an upload session (set before the bytes go out, cleared when the video id is saved).
   * Set without a video id means a copy MAY exist: the bot never uploads that reel again by itself.
   */
  sessionOpenedAt?: string;
  /** Set by --test-upload: private, outside the slot window, no subscriber notification. */
  testUpload?: boolean;
  thumbnailSetAt?: string;
  /** The scheduled publish was cancelled because the reel went back to skip, draft, or unapproved. */
  unscheduledAt?: string;
}

export interface QuotaLedger {
  /** Pacific Time date the counters belong to (quota resets at midnight PT). */
  day: string;
  units: number;
  uploads: number;
}

type Data = Record<string, unknown>;

export function pacificDay(ms = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export class YtState {
  private data: Data;

  constructor(private readonly file: string, private readonly persist: boolean) {
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Data) : {};
  }

  get(slug: string): YtReelState {
    return (this.data[`yt:${slug}`] as YtReelState | undefined) ?? {};
  }

  set(slug: string, partial: Partial<YtReelState>): void {
    const next: YtReelState = { ...this.get(slug), ...partial };
    for (const k of Object.keys(next) as Array<keyof YtReelState>) if (next[k] === undefined) delete next[k];
    this.data[`yt:${slug}`] = next;
    this.save();
  }

  /** Every slug with a recorded video id, for the lost-state guard and the comment bot. */
  videoIds(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(this.data)) {
      const id = (v as YtReelState).videoId;
      if (k.startsWith("yt:") && id) out.set(id, k.slice(3));
    }
    return out;
  }

  /** Uploads this bot made on a Cairo calendar day. */
  uploadsOn(day: string, dayOf: (ms: number) => string): number {
    return Object.entries(this.data).filter(([k, v]) => {
      const s = v as YtReelState;
      return k.startsWith("yt:") && s.recordedFrom === "uploaded" && s.uploadedAt && dayOf(Date.parse(s.uploadedAt)) === day;
    }).length;
  }

  quota(): QuotaLedger {
    const today = pacificDay();
    const q = this.data._quota as QuotaLedger | undefined;
    return q && q.day === today ? q : { day: today, units: 0, uploads: 0 };
  }

  addQuota(units: number, uploads: number): QuotaLedger {
    const q = this.quota();
    const next = { day: q.day, units: q.units + units, uploads: q.uploads + uploads };
    this.data._quota = next;
    this.save();
    return next;
  }

  private save(): void {
    if (this.persist) writeFileSync(this.file, JSON.stringify(this.data, null, 2) + "\n");
  }
}
