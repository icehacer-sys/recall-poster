// File-backed state: which comments were handled, per-reel and per-day reply counts (Cairo day),
// and the owner review queue. Only live mode writes either file. Dry runs read them.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config";

interface StateShape {
  handledCommentIds: string[];
  /** "<cairoDate>|<reelSlug>" -> replies posted that day under that reel. */
  reelDayCounts: Record<string, number>;
  /** "<cairoDate>" -> replies posted that day in total. */
  dayCounts: Record<string, number>;
  /** "<reel>|<username>|<kind>" boundary lines already given (threads-bot: once per commenter and post). */
  boundaries?: string[];
  /** YouTube draft mode: comments already drafted for the owner (not handled, so a live run still answers them). */
  draftedCommentIds?: string[];
  /** Only with BOT_RETENTION_DAYS: when each id or boundary key was stored ("h:", "d:", or "b:" + key). */
  storedAt?: Record<string, string>;
}

/** Days stored comment data may be kept (0 = no limit). The YouTube bot keeps 30 (API Developer Policies III.E.4). */
export function retentionDays(): number {
  return Math.max(0, Number(process.env.BOT_RETENTION_DAYS) || 0);
}

export interface ReviewItem {
  at: string;
  reel: string;
  mediaId: string;
  commentId: string;
  username: string;
  text: string;
  category: string;
  reason: string;
  resolved?: boolean;
}

export function cairoDate(ms = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.activeTz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export class State {
  private s: StateShape;
  private review: ReviewItem[];

  constructor(private readonly persist: boolean) {
    this.s = { handledCommentIds: [], reelDayCounts: {}, dayCounts: {} };
    if (existsSync(config.stateFile)) {
      try {
        this.s = { ...this.s, ...(JSON.parse(readFileSync(config.stateFile, "utf8")) as StateShape) };
      } catch {
        throw new Error(`state file ${config.stateFile} is unreadable. Restore it; never reset it to empty (it prevents double replies).`);
      }
    }
    this.review = existsSync(config.reviewFile) ? (JSON.parse(readFileSync(config.reviewFile, "utf8")) as ReviewItem[]) : [];
  }

  handled(commentId: string): boolean {
    return this.s.handledCommentIds.includes(commentId);
  }

  /** Mark a comment as done (replied, or listed for the owner) so it is never processed twice. */
  markHandled(commentId: string): void {
    if (!this.handled(commentId)) this.s.handledCommentIds.push(commentId);
    this.stamp(`h:${commentId}`);
    this.save();
  }

  private stamp(key: string): void {
    if (!retentionDays()) return;
    this.s.storedAt ??= {};
    this.s.storedAt[key] ??= new Date().toISOString();
  }

  /**
   * BOT_RETENTION_DAYS: delete comment data older than the limit (review items by "at", handled and
   * drafted ids, boundary keys, and day counts). Entries stored before stamping existed get stamped now.
   * Safe: before every reply the bot re-checks the thread on YouTube and only reads the last few days.
   */
  prune(now = Date.now()): { removed: number } {
    const days = retentionDays();
    if (!days) return { removed: 0 };
    const cutoff = now - days * 86_400_000;
    const stamps = (this.s.storedAt ??= {});
    const old = (key: string) => {
      stamps[key] ??= new Date(now).toISOString();
      return Date.parse(stamps[key]) < cutoff;
    };
    let removed = 0;
    const keep = <T>(list: T[], key: (x: T) => string) =>
      list.filter((x) => {
        if (!old(key(x))) return true;
        delete stamps[key(x)];
        removed++;
        return false;
      });
    this.s.handledCommentIds = keep(this.s.handledCommentIds, (id) => `h:${id}`);
    if (this.s.draftedCommentIds) this.s.draftedCommentIds = keep(this.s.draftedCommentIds, (id) => `d:${id}`);
    if (this.s.boundaries) this.s.boundaries = keep(this.s.boundaries, (k) => `b:${k}`);
    const day = (k: string) => Date.parse(`${k.slice(0, 10)}T23:59:59Z`);
    for (const counts of [this.s.dayCounts, this.s.reelDayCounts]) for (const k of Object.keys(counts)) if (day(k) < cutoff) delete counts[k];
    const before = this.review.length;
    this.review = this.review.filter((r) => !(Date.parse(r.at) < cutoff));
    removed += before - this.review.length;
    this.save();
    if (this.persist) writeFileSync(config.reviewFile, JSON.stringify(this.review, null, 2) + "\n");
    return { removed };
  }

  drafted(commentId: string): boolean {
    return (this.s.draftedCommentIds ?? []).includes(commentId);
  }

  /** Draft mode: never draft (and pay for) the same comment twice. */
  markDrafted(commentId: string): void {
    if (!this.drafted(commentId)) this.s.draftedCommentIds = [...(this.s.draftedCommentIds ?? []), commentId].slice(-2000);
    this.stamp(`d:${commentId}`);
    this.save();
  }

  countReply(reelSlug: string): void {
    const day = cairoDate();
    this.s.reelDayCounts[`${day}|${reelSlug}`] = (this.s.reelDayCounts[`${day}|${reelSlug}`] ?? 0) + 1;
    this.s.dayCounts[day] = (this.s.dayCounts[day] ?? 0) + 1;
    this.save();
  }

  repliesToday(reelSlug?: string): number {
    const day = cairoDate();
    return reelSlug ? this.s.reelDayCounts[`${day}|${reelSlug}`] ?? 0 : this.s.dayCounts[day] ?? 0;
  }

  boundaryKeys(): string[] {
    return this.s.boundaries ?? [];
  }

  /** Persist boundary keys given in this run (only after the reply really posted). */
  saveBoundaries(keys: Iterable<string>): void {
    this.s.boundaries = [...new Set([...(this.s.boundaries ?? []), ...keys])];
    for (const k of this.s.boundaries) this.stamp(`b:${k}`);
    this.save();
  }

  addReview(item: ReviewItem): void {
    if (this.review.some((r) => r.commentId === item.commentId)) return;
    this.review.push(item);
    if (this.persist) writeFileSync(config.reviewFile, JSON.stringify(this.review, null, 2) + "\n");
  }

  pendingReview(): ReviewItem[] {
    return this.review.filter((r) => !r.resolved);
  }

  private save(): void {
    if (this.persist) writeFileSync(config.stateFile, JSON.stringify(this.s, null, 2) + "\n");
  }
}
