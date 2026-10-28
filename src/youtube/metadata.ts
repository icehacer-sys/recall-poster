// Title, description, tags, and the exact videos.insert body for one reel, plus the YouTube
// preflight. Text is built from the reel's owner-approved Instagram caption: the hook line becomes
// the title (with the case number), and the description starts with that line, the site link, and a
// short call to action taken from the owner-approved comment templates. New text needs the owner's
// OK, so a generated youtube.json starts with "approved": false.

import type { Reel, ReelYoutube } from "../types.js";
import { EDUCATION, yt } from "./config.js";
import type { InsertBody } from "./api.js";

export const MAX_TITLE = 100;
export const MAX_DESCRIPTION_BYTES = 5000;
export const MAX_TAGS_CHARS = 500;
export const MAX_SHORT_SECONDS = 180;

const CTA = {
  // Owner-approved Instagram app reply (templates.json, 24 Oct 2026) without "link in bio".
  ar: "الحالة دي من الـ Library بتاعة Recall Engine نفسها. أول 7 أيام ببلاش ومعاهم 50 كريدت.",
  en: "This case is from the Recall Engine library. Your first 7 days are free plus 50 credits.",
};

// Instagram-only lines that make no sense under a Short (the link sits right above them).
const IG_ONLY = /(اللينك في صفحتنا|اللينك في البايو|link in (our )?bio|link on our page)/i;
const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}️?)*/gu;

export function isArabic(s: string): boolean {
  return /[؀-ۿ]/.test(s);
}

/** "reel-case-02-day-26.mp4" -> "02". */
export function caseNumberOf(reel: Reel): string | undefined {
  return reel.video.match(/case-(\d+)/i)?.[1];
}

function paragraphs(caption: string): string[] {
  return caption.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function hashtagsOf(caption: string): string[] {
  return [...new Set(caption.match(/#[\p{L}\p{N}_]+/gu) ?? [])];
}

const chars = (s: string) => [...s].length;

/** Hook line + " | حالة 02" (or " | Case 02"), at most 100 characters, no "<" or ">". */
export function titleFor(reel: Reel): string {
  const lang = isArabic(reel.caption) ? "ar" : "en";
  const hook = (paragraphs(reel.caption)[0] ?? reel.slug).split("\n")[0];
  const clean = hook.replace(EMOJI, "").replace(/[<>]/g, "").replace(/\s*[—–]\s*/g, ": ").replace(/\s+/g, " ").trim();
  const n = caseNumberOf(reel);
  const suffix = n ? (lang === "ar" ? ` | حالة ${n}` : ` | Case ${n}`) : "";
  let base = clean;
  if (chars(base) + chars(suffix) > MAX_TITLE) {
    const room = MAX_TITLE - chars(suffix) - 1;
    const cut = [...base].slice(0, room).join("");
    const q = Math.max(cut.lastIndexOf("؟"), cut.lastIndexOf("?"));
    base = q > room / 2 ? cut.slice(0, q + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
  }
  return `${base}${suffix}`;
}

export function hashtagsFor(reel: Reel): string[] {
  const tags = hashtagsOf(reel.caption).map((t) => (t.toLowerCase() === "#recallengine" ? "#RecallEngine" : t));
  return ["#Shorts", ...tags.filter((t) => t.toLowerCase() !== "#shorts")];
}

/** One line, the link, a short call to action, then the rest of the approved caption and hashtags. */
export function descriptionFor(reel: Reel): string {
  const lang = isArabic(reel.caption) ? "ar" : "en";
  const paras = paragraphs(reel.caption);
  const hook = (paras[0] ?? "").split("\n")[0].trim();
  const body = paras
    .slice(1)
    .filter((p) => !/^(#[\p{L}\p{N}_]+\s*)+$/u.test(p))
    .map((p) => p.split("\n").filter((l) => !IG_ONLY.test(l)).join("\n").trim())
    .filter(Boolean);
  return [[hook, yt.siteUrl, CTA[lang]].join("\n"), ...body, hashtagsFor(reel).join(" ")].join("\n\n").replace(/[<>]/g, "");
}

/** API tags: the caption's hashtags as words plus the brand. The idempotency tag is added at upload. */
export function tagsFor(reel: Reel): string[] {
  const words = hashtagsOf(reel.caption).map((t) => t.slice(1).replace(/_/g, " "));
  const base = words.filter((w) => w.toLowerCase() !== "recallengine");
  return [...new Set([...base, "Recall Engine", "medical student", "clinical case", "Shorts"])];
}

/** YouTube counts commas between tags and the quotes around a tag that contains a space. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((n, t) => n + chars(t) + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

export function idempotencyTag(slug: string): string {
  return `re-${slug}`;
}

/** A fresh youtube.json for a reel (approved: false until the owner OKs the text). */
export function buildYoutube(reel: Reel, publishAt: string, publishAtCairo: string): ReelYoutube {
  const lang = isArabic(reel.caption) ? "ar" : "en";
  return {
    title: titleFor(reel),
    description: descriptionFor(reel),
    tags: tagsFor(reel),
    publishAt,
    publishAtCairo,
    categoryId: EDUCATION,
    defaultLanguage: lang,
    defaultAudioLanguage: lang,
    madeForKids: false,
    // AI voice and AI-made illustrations: disclose. Disclosure alone does not limit reach.
    containsSyntheticMedia: true,
    notifySubscribers: true,
    caseNumber: caseNumberOf(reel),
    approved: false,
  };
}

export interface InsertPlan {
  body: InsertBody;
  /** What happens to the video after the upload. */
  outcome: string;
}

/**
 * The exact videos.insert body. privacyStatus is ALWAYS sent (YouTube defaults to public when it is
 * missing). Until YT_PUBLIC=on: private with no publish time. With YT_PUBLIC=on: private with
 * publishAt = the slot, or public straight away when the slot is less than 15 minutes ahead.
 */
export function insertPlan(slug: string, y: ReelYoutube, now: number, opts = { public: yt.public, minScheduleMinutes: yt.minScheduleMinutes }): InsertPlan {
  const at = Date.parse(y.publishAt);
  const tags = [...y.tags.filter((t) => t !== idempotencyTag(slug)), idempotencyTag(slug)];
  const status: InsertBody["status"] = {
    privacyStatus: "private",
    selfDeclaredMadeForKids: y.madeForKids,
    containsSyntheticMedia: y.containsSyntheticMedia === true,
    embeddable: true,
    license: "youtube",
  };
  let outcome = "stays PRIVATE with no publish time (YT_PUBLIC is off): the owner publishes it in YouTube Studio";
  if (opts.public) {
    if (at - now >= opts.minScheduleMinutes * 60_000) {
      status.publishAt = new Date(at).toISOString();
      outcome = `private now, YouTube publishes it at ${status.publishAt}`;
    } else {
      status.privacyStatus = "public";
      outcome = "PUBLIC straight away (the slot is less than 15 minutes ahead or just passed)";
    }
  }
  return {
    body: {
      snippet: { title: y.title, description: y.description, tags, categoryId: y.categoryId || EDUCATION, defaultLanguage: y.defaultLanguage, defaultAudioLanguage: y.defaultAudioLanguage },
      status,
    },
    outcome,
  };
}

export interface Check {
  errors: string[];
  warnings: string[];
}

export function preflightYoutube(slug: string, y: ReelYoutube): Check {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!y.title?.trim()) errors.push("title is empty");
  if (chars(y.title ?? "") > MAX_TITLE) errors.push(`title is ${chars(y.title)} characters (max ${MAX_TITLE})`);
  if (/[<>]/.test(`${y.title}${y.description}`)) errors.push('title or description contains "<" or ">"');
  if (/[—–]/.test(`${y.title}${y.description}`)) errors.push("title or description contains an em or en dash (house rule: none)");
  const bytes = Buffer.byteLength(y.description ?? "", "utf8");
  if (bytes > MAX_DESCRIPTION_BYTES) errors.push(`description is ${bytes} bytes (max ${MAX_DESCRIPTION_BYTES})`);
  if (!(y.description ?? "").includes(yt.siteUrl)) warnings.push(`description has no ${yt.siteUrl} line`);
  const tags = [...(y.tags ?? []), idempotencyTag(slug)];
  if (tagsLength(tags) > MAX_TAGS_CHARS) errors.push(`tags are ${tagsLength(tags)} characters (max ${MAX_TAGS_CHARS})`);
  if (!y.categoryId) errors.push("categoryId is missing (27 = Education)");
  if (typeof y.containsSyntheticMedia !== "boolean") errors.push("containsSyntheticMedia must be true or false (altered or synthetic content disclosure)");
  if (typeof y.madeForKids !== "boolean") errors.push("madeForKids must be true or false");
  if (Number.isNaN(Date.parse(y.publishAt))) errors.push(`publishAt is not a valid date: ${y.publishAt}`);
  if (!y.defaultLanguage || !y.defaultAudioLanguage) errors.push("defaultLanguage and defaultAudioLanguage are required");
  if (y.durationSec == null) warnings.push("duration unknown (run npm run yt:sync on the laptop to record it)");
  else {
    if (y.durationSec > MAX_SHORT_SECONDS) errors.push(`video is ${y.durationSec.toFixed(1)} s: a Short is at most ${MAX_SHORT_SECONDS} s`);
    if (y.durationSec > 60) warnings.push(`video is ${y.durationSec.toFixed(1)} s: a Short over 1 minute with an active copyright claim is blocked worldwide (licensed or own music only)`);
  }
  if (y.width && y.height && y.width > y.height) errors.push(`video is ${y.width}x${y.height}: a Short must be vertical or square`);
  return { errors, warnings };
}

/** Normalised title, to recognise an upload whose state was lost. */
export function titleKey(s: string): string {
  return s.replace(EMOJI, "").replace(/[ً-ْـ‪-‮⁦-⁩‎‏]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
