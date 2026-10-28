// Side-effect-free reel helpers shared by the Instagram publisher (src/reels.ts) and the YouTube
// uploader (src/youtube/*). Importing src/reels.ts runs its CLI, so anything both need lives here.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Reel } from "./types.js";

export const REELS_TZ = process.env.REELS_TZ ?? "Africa/Cairo";

/** Offset (minutes east of UTC) of `tz` at instant `ms`. */
function tzOffsetMinutes(ms: number, tz: string): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName")?.value;
  const m = part?.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Local wall time (YYYY-MM-DD + HH:MM in tz) -> UTC ISO. DST-safe (Egypt changes on 29 Oct 2026). */
export function localToUtcIso(ymd: string, hhmm: string, tz = REELS_TZ): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall - tzOffsetMinutes(wall, tz) * 60_000;
  utc = wall - tzOffsetMinutes(utc, tz) * 60_000; // re-evaluate at the real instant
  return new Date(utc).toISOString();
}

/** UTC ISO -> "Sun 25 Oct 2026 19:00 Africa/Cairo". */
export function cairoLabel(iso: string, tz = REELS_TZ): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${date.replace(/,/g, "")} ${time} ${tz}`;
}

/** Calendar date (YYYY-MM-DD) of an instant in tz. */
export function localYmd(ms: number, tz = REELS_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Every reels/<slug>/reel.json, sorted by slot then slug. */
export function loadReelsFrom(dir: string): Reel[] {
  if (!existsSync(dir)) return [];
  const out: Reel[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = join(dir, d.name, "reel.json");
    if (!existsSync(f)) continue;
    out.push(JSON.parse(readFileSync(f, "utf8")) as Reel);
  }
  return out.sort((a, b) => a.postAt.localeCompare(b.postAt) || a.slug.localeCompare(b.slug));
}

/** First caption line, normalised, to recognise a reel that is already live. */
export function captionKey(s: string): string {
  const first = s.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
  return first.replace(/[ً-ْـ‪-‮‎‏]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Why a signed-mode reel cannot be fetched now, or null when its media is ready. */
export function signedProblem(r: Reel, now: number): string | null {
  if (!r.media?.videoUrl) return `no signed media yet: run npm run reels:upload -- ${r.slug} on the laptop`;
  if (Date.parse(r.media.expiresAt) <= now + 15 * 60_000) return `signed URLs expired or expire within 15 min (${r.media.expiresAt}): rerun npm run reels:upload -- ${r.slug}`;
  if (r.videoBytes && r.media.videoBytes !== r.videoBytes) return "uploaded video size differs from reel.json (rerun reels:sync and reels:upload)";
  return null;
}
