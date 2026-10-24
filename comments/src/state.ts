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
