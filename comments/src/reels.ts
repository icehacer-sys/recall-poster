// The vetted context per reel (data/reels.json) and the mapping from a live Instagram media to
// its reel. The ONLY medical source of truth for replies is the reel's own library item:
// stem, keyed answer, library takeaway, and the on-screen lines sourced to them.

import { existsSync, readFileSync } from "node:fs";
import { config } from "./config";
import type { IgMedia } from "./instagram";

export interface ReelFacts {
  slug: string;
  storyDay: string;
  /** Short English label for logs and the owner list. */
  title: string;
  /** Optional explicit mapping (fill after the reel is live). */
  mediaId?: string;
  shortcode?: string;
  /** First line of the posted caption, used to recognise the reel automatically. */
  captionStart: string;
  /** The question the reel asks. */
  question: string;
  stem: string;
  answer: string;
  takeaway: string;
  /** On-screen lines whose source is the stem, answer, or takeaway (never story dressing). */
  onScreen: string[];
  /** Ways a commenter may phrase the full correct move (English and Arabic). Hand-authored. */
  acceptedAnswers: string[];
  /** Right direction but incomplete (e.g. the drug without route). Gets a warm partial confirm. */
  partialAnswers: string[];
  /** Invented story and satire details from sources.md (names, props, jokes). Banter only. */
  storyDressing?: string;
  /** Latin words allowed inside an Arabic reply (owner rule: only medical terms in English). */
  medicalTerms: string[];
}

export interface ReelsFile {
  storySource: string;
  readySource: string;
  reels: ReelFacts[];
}

export function loadReels(): ReelsFile {
  return JSON.parse(readFileSync(config.reelsFile, "utf8")) as ReelsFile;
}

export function shortcodeFromPermalink(permalink?: string): string | null {
  const m = permalink?.match(/\/(?:p|reel|tv)\/([^/?#]+)/);
  return m ? m[1] : null;
}

function norm(s: string): string {
  return s.replace(/[ً-ْـ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** media id per reel slug, read from the poster's state.json when it is on this machine. */
function posterMediaIds(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (!existsSync(config.posterStateFile)) return out;
    const st = JSON.parse(readFileSync(config.posterStateFile, "utf8")) as Record<string, { igMediaId?: string }>;
    for (const [k, v] of Object.entries(st)) if (k.startsWith("reel:") && v.igMediaId) out.set(v.igMediaId, k.slice(5));
  } catch {
    /* optional */
  }
  return out;
}

/** Find the reel a media belongs to: explicit id or shortcode, the poster's state, then caption. */
export function reelForMedia(media: IgMedia, reels: ReelFacts[]): ReelFacts | undefined {
  const sc = shortcodeFromPermalink(media.permalink);
  const explicit = reels.find((r) => (r.mediaId && r.mediaId === media.id) || (r.shortcode && r.shortcode === sc));
  if (explicit) return explicit;
  const slug = posterMediaIds().get(media.id);
  if (slug) return reels.find((r) => r.slug === slug);
  const cap = norm(media.caption ?? "");
  return reels.find((r) => r.captionStart && cap.startsWith(norm(r.captionStart)));
}

/** All vetted fact lines for the prompt and for the number guard. */
export function factLines(r: ReelFacts): string[] {
  return [
    `Case stem: ${r.stem}`,
    `The question: ${r.question}`,
    `Keyed answer (the correct next move): ${r.answer}`,
    `Library takeaway: ${r.takeaway}`,
    ...r.onScreen.map((l) => `Shown in the reel: ${l}`),
  ];
}
