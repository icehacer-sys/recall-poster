// Reel scheduler + publisher for @recallengine (separate from the carousel runner).
//
//   --sync       Scan REELS_SOURCE_DIR (READY-TO-SCHEDULE/<NN-case>/) and write or refresh
//                reels/<slug>/reel.json: caption snapshot, chosen mp4, cover, file size + hash.
//                New reels get the next free day at REELS_POST_TIME (20:00) Africa/Cairo.
//                An existing postAt is never moved. Posts nothing, no token needed.
//   --dry-run    (default) Print every scheduled reel: status, the exact REELS container
//                params (video_url, cover_url, share_to_feed, caption) and the preflight checks.
//                Add --check-urls to HEAD the public video/cover URLs (still no token, no posting).
//   --live       Publish due reels. Requires BOTH BOT_CONFIRM_LIVE=yes and REELS_CONFIRM_LIVE=yes,
//                plus IG_ACCESS_TOKEN. The carousel workflow never calls this, so merging this
//                branch cannot post a reel by itself.
//
// Publish flow (Graph API Reels): POST /me/media {media_type: REELS, video_url, caption,
// share_to_feed, cover_url | thumb_offset} -> poll status_code until FINISHED -> POST
// /me/media_publish. The container id is saved to state.json BEFORE publishing, so a rerun
// reuses it or sees PUBLISHED and records it instead of creating a second post.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { State } from "./state.js";
import {
  containerStatus,
  createReelContainer,
  publishingQuotaUsage,
  publishReelContainer,
  recentMedia,
  type ReelContainerParams,
} from "./instagram.js";
import type { Reel } from "./types.js";
import { MEDIA_BUCKET, ensureMediaBucket, probeUrl, redactUrl, signMedia, uploadMedia } from "./media.js";
import {
  STAGING_BUCKET,
  createBucket,
  deleteFromStaging,
  getBucket,
  stagingPath,
  stagingPublicUrlFor,
  supabaseCreds,
  uploadToStaging,
} from "./staging.js";

// ---------------------------------------------------------------- settings

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const TZ = process.env.REELS_TZ ?? "Africa/Cairo";
const reelsCfg = {
  dir: process.env.REELS_DIR ?? "./reels",
  sourceDir:
    process.env.REELS_SOURCE_DIR ?? "W:/Recall Engine Review/reels-week1-20261023/READY-TO-SCHEDULE",
  // Owner 24 Oct: every reel posts at 20:00 Cairo by default (owner moved it from 19:00 on 24 Oct) (override per reel in reel.json).
  postTime: process.env.REELS_POST_TIME ?? "20:00",
  // First day a NEW reel may take (YYYY-MM-DD, Cairo). Default: tomorrow in Cairo.
  startDate: process.env.REELS_START_DATE ?? "",
  // "master" = the full-quality mp4; "phone" = the smaller *-phone.mp4 render.
  videoVariant: (process.env.REELS_VIDEO_VARIANT ?? "master").toLowerCase(),
  // Owner 24 Oct: "supabase" stages video + cover in the public ig-reel-staging bucket shortly
  // before the slot and deletes them after publishing. "url" = files already public under
  // REELS_PUBLIC_BASE/<slug>/<file>.
  // Cloud mode (owner GO, 24 Oct): "signed" = reel.json carries signed URLs to the PRIVATE bucket
  // ig-reel-media, written by `npm run reels:upload` on the laptop. The runner needs no Supabase key.
  hosting: ((h: string) => (h === "url" || h === "supabase" ? h : "signed"))((process.env.REELS_HOSTING ?? "signed").toLowerCase()) as "url" | "supabase" | "signed",
  // Reel publish state (container ids, media ids). Separate from the carousel state.json.
  stateFile: process.env.REELS_STATE_FILE ?? join(process.env.REELS_DIR ?? "./reels", "state.json"),
  // Signed URL lifetime written by --upload.
  signDays: num("REELS_SIGN_DAYS", 7),
  // Upload this many minutes before the slot.
  stageMinutes: num("REELS_STAGE_MINUTES", 60),
  // Only for REELS_HOSTING=url: public base the files sit under.
  publicBase: (process.env.REELS_PUBLIC_BASE ?? (config.githubRawBase ? `${config.githubRawBase}/reels-media` : ""))
    .replace(/\/+$/, ""),
  // A reel more than this many hours past its postAt is NOT auto-posted (laptop was off etc.).
  maxLateHours: num("REELS_MAX_LATE_HOURS", 3),
  // At most this many reels per live run, so a backlog can never burst out at once.
  maxPerRun: num("REELS_MAX_PER_RUN", 1),
  // Second, reel-specific live latch (on top of BOT_CONFIRM_LIVE).
  confirmLive: (process.env.REELS_CONFIRM_LIVE ?? "").toLowerCase() === "yes",
};

// Instagram Reels limits (graph API reference, Reels specifications).
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;
const MAX_MENTIONS = 20;

// ---------------------------------------------------------------- time helpers

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
export function localToUtcIso(ymd: string, hhmm: string, tz = TZ): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall - tzOffsetMinutes(wall, tz) * 60_000;
  utc = wall - tzOffsetMinutes(utc, tz) * 60_000; // re-evaluate at the real instant
  return new Date(utc).toISOString();
}

/** UTC ISO -> "Sun 25 Oct 2026 19:00 Africa/Cairo". */
export function cairoLabel(iso: string, tz = TZ): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${date.replace(/,/g, "")} ${time} ${tz}`;
}

/** Calendar date (YYYY-MM-DD) of an instant in tz. */
function localYmd(ms: number, tz = TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- manifest IO

function reelFile(slug: string): string {
  return join(reelsCfg.dir, slug, "reel.json");
}

export function loadReels(): Reel[] {
  if (!existsSync(reelsCfg.dir)) return [];
  const out: Reel[] = [];
  for (const d of readdirSync(reelsCfg.dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = reelFile(d.name);
    if (!existsSync(f)) continue;
    out.push(JSON.parse(readFileSync(f, "utf8")) as Reel);
  }
  return out.sort((a, b) => a.postAt.localeCompare(b.postAt) || a.slug.localeCompare(b.slug));
}

function saveReel(reel: Reel): void {
  mkdirSync(join(reelsCfg.dir, reel.slug), { recursive: true });
  writeFileSync(reelFile(reel.slug), JSON.stringify(reel, null, 2) + "\n");
}

const stateKey = (slug: string) => `reel:${slug}`;

// ---------------------------------------------------------------- sync

function readCaption(path: string): string {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function sha256Prefix(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

function pickVideo(files: string[]): string | undefined {
  // Skip half-written encodes (e.g. up.tmp.mp4): a sync during a re-encode once picked one as the master.
  const mp4 = files.filter((f) => f.toLowerCase().endsWith(".mp4") && !/(^|\.)(tmp|part)\./i.test(f)).sort();
  const phone = mp4.filter((f) => /-phone\.mp4$/i.test(f));
  // The master is the plain render: the shortest non-phone name (skips e.g. *-browser-720p.mp4).
  const master = mp4.filter((f) => !/-phone\.mp4$/i.test(f)).sort((a, b) => a.length - b.length || a.localeCompare(b));
  return reelsCfg.videoVariant === "phone" ? phone[0] ?? master[0] : master[0] ?? phone[0];
}

function runSync(): void {
  if (!existsSync(reelsCfg.sourceDir)) throw new Error(`REELS_SOURCE_DIR not found: ${reelsCfg.sourceDir}`);
  const existing = new Map(loadReels().map((r) => [r.slug, r] as const));
  const taken = new Set([...existing.values()].map((r) => localYmd(Date.parse(r.postAt))));
  let day = reelsCfg.startDate || addDays(localYmd(Date.now()), 1);

  const folders = readdirSync(reelsCfg.sourceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{2}-/.test(d.name))
    .map((d) => d.name)
    .sort();

  for (const folder of folders) {
    const abs = join(reelsCfg.sourceDir, folder);
    const files = readdirSync(abs);
    const video = pickVideo(files);
    if (!video) {
      console.log(`  ${folder}: no mp4, skipped`);
      continue;
    }
    const captionFile = "caption-instagram.txt";
    if (!files.includes(captionFile)) {
      console.log(`  ${folder}: no ${captionFile}, skipped`);
      continue;
    }
    const cover = files.includes("cover.jpg") ? "cover.jpg" : "";
    const storyDay = video.match(/day-(\d+)/i)?.[1];
    const prev = existing.get(folder);

    let postAt = prev?.postAt;
    if (!postAt) {
      while (taken.has(day)) day = addDays(day, 1);
      postAt = localToUtcIso(day, reelsCfg.postTime);
      taken.add(day);
      day = addDays(day, 1);
    }
    const reel: Reel = {
      slug: folder,
      sourceFolder: folder,
      video,
      cover,
      captionFile,
      caption: readCaption(join(abs, captionFile)),
      postAt,
      postAtCairo: cairoLabel(postAt),
      thumbOffsetMs: prev?.thumbOffsetMs ?? 0,
      shareToFeed: prev?.shareToFeed ?? true,
      storyDay: prev?.storyDay ?? (storyDay ? `day-${storyDay}` : undefined),
      videoBytes: statSync(join(abs, video)).size,
      videoSha256: sha256Prefix(join(abs, video)),
      draft: prev?.draft ?? false,
      manual: prev?.manual,
      note: prev?.note,
    };
    // Keep the signed media only while it still matches this exact video; a new render must be re-uploaded.
    if (prev?.media && prev.video === video && prev.media.videoBytes === reel.videoBytes && prev.videoSha256 === reel.videoSha256) reel.media = prev.media;
    else if (prev?.media) console.log(`  ${folder}: the video changed, so its signed media was dropped. Run npm run reels:upload -- ${folder}`);
    saveReel(reel);
    console.log(`  ${prev ? "refreshed" : "added    "} ${folder}  ${reel.postAtCairo}  (${video})`);
  }
  console.log(`sync: ${folders.length} source folder(s) scanned. Nothing posted.`);
}

// ---------------------------------------------------------------- preflight

interface Check {
  errors: string[];
  warnings: string[];
}

/** Top-level MP4 box order: Instagram needs the moov atom before mdat ("fast start"). */
function moovBeforeMdat(path: string): boolean | null {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    let pos = 0;
    const head = Buffer.alloc(16);
    for (let i = 0; i < 64 && pos + 8 <= size; i++) {
      readSync(fd, head, 0, 16, pos);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      if (boxSize < 8) return null;
      pos += boxSize;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

interface Probe {
  duration?: number;
  vcodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  vbitrate?: number;
  acodec?: string;
  sampleRate?: number;
  abitrate?: number;
}

/** Optional ffprobe read (skipped silently when ffprobe is not installed). */
function ffprobe(path: string): Probe | null {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate,sample_rate", "-of", "json", path], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Array<Record<string, string | number>> };
    const v = j.streams?.find((s) => s.codec_type === "video");
    const a = j.streams?.find((s) => s.codec_type === "audio");
    const [fn, fd] = String(v?.r_frame_rate ?? "0/1").split("/").map(Number);
    return {
      duration: Number(j.format?.duration),
      vcodec: v?.codec_name as string | undefined,
      width: Number(v?.width),
      height: Number(v?.height),
      fps: fd ? fn / fd : undefined,
      vbitrate: Number(v?.bit_rate),
      acodec: a?.codec_name as string | undefined,
      sampleRate: Number(a?.sample_rate),
      abitrate: Number(a?.bit_rate),
    };
  } catch {
    return null;
  }
}

function preflight(reel: Reel): Check {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cap = reel.caption ?? "";
  if (!cap.trim()) errors.push("caption is empty");
  if ([...cap].length > MAX_CAPTION) errors.push(`caption is ${[...cap].length} chars (max ${MAX_CAPTION})`);
  const tags = cap.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (tags.length > MAX_HASHTAGS) errors.push(`${tags.length} hashtags (max ${MAX_HASHTAGS})`);
  const mentions = cap.match(/(^|\s)@[\w.]+/g) ?? [];
  if (mentions.length > MAX_MENTIONS) errors.push(`${mentions.length} mentions (max ${MAX_MENTIONS})`);
  if (/[\u2014\u2013]/.test(cap)) warnings.push("caption contains an em or en dash (house rule: none)");
  if (Number.isNaN(Date.parse(reel.postAt))) errors.push(`postAt is not a valid date: ${reel.postAt}`);

  const abs = join(reelsCfg.sourceDir, reel.sourceFolder);
  if (!existsSync(abs)) {
    warnings.push(`source folder not on this machine (${abs}): local file checks skipped`);
    return { errors, warnings };
  }
  const videoPath = join(abs, reel.video);
  if (!existsSync(videoPath)) {
    errors.push(`video missing: ${videoPath}`);
  } else {
    const bytes = statSync(videoPath).size;
    if (bytes > MAX_VIDEO_BYTES) errors.push(`video is ${(bytes / 1e6).toFixed(1)} MB (max 300 MB)`);
    if (reel.videoBytes && reel.videoBytes !== bytes) warnings.push("video changed since the last --sync (run npm run reels:sync)");
    const fast = moovBeforeMdat(videoPath);
    if (fast === false) errors.push("moov atom is after mdat (re-mux with ffmpeg -movflags +faststart)");
    const p = ffprobe(videoPath);
    if (p) {
      if (p.duration != null && (p.duration < 3 || p.duration > 900)) errors.push(`duration ${p.duration}s (3 s to 15 min)`);
      if (p.vcodec && !["h264", "hevc"].includes(p.vcodec)) errors.push(`video codec ${p.vcodec} (H.264 or HEVC)`);
      if (p.fps && (p.fps < 23 || p.fps > 60)) errors.push(`frame rate ${p.fps} (23 to 60)`);
      if (p.width && p.width > 1920) errors.push(`width ${p.width}px (max 1920)`);
      if (p.vbitrate && p.vbitrate > 25e6) errors.push(`video bitrate ${(p.vbitrate / 1e6).toFixed(1)} Mbps (max 25)`);
      if (p.acodec && p.acodec !== "aac") errors.push(`audio codec ${p.acodec} (AAC)`);
      if (p.sampleRate && p.sampleRate > 48000) errors.push(`audio ${p.sampleRate} Hz (max 48 kHz)`);
      if (p.abitrate && p.abitrate > 132_000) warnings.push(`audio ${(p.abitrate / 1000).toFixed(0)} kbps (Meta spec lists 128 kbps; Instagram re-encodes, so this is usually fine)`);
      if (p.width && p.height && Math.abs(p.width / p.height - 9 / 16) > 0.01) warnings.push(`aspect ${p.width}x${p.height} is not 9:16`);
    }
  }
  if (reel.cover) {
    const coverPath = join(abs, reel.cover);
    if (!existsSync(coverPath)) errors.push(`cover missing: ${coverPath}`);
    else if (statSync(coverPath).size > MAX_COVER_BYTES) errors.push("cover is over 8 MB");
  }
  if (readCaptionSafe(join(abs, reel.captionFile)) !== null && readCaptionSafe(join(abs, reel.captionFile)) !== cap) {
    warnings.push(`${reel.captionFile} changed since the last --sync (the snapshot in reel.json is what posts)`);
  }
  return { errors, warnings };
}

function readCaptionSafe(path: string): string | null {
  try {
    return readCaption(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- container params

/** Project URL for building staging URLs in the dry run (no key needed). */
function supabaseProjectUrl(): string {
  try {
    return supabaseCreds().url;
  } catch {
    return process.env.SUPABASE_URL ?? "https://<project>.supabase.co";
  }
}

function publicUrl(slug: string, file: string): string {
  if (reelsCfg.hosting === "signed") return `<run npm run reels:upload -- ${slug}>`;
  if (reelsCfg.hosting === "supabase") return stagingPublicUrlFor(supabaseProjectUrl(), slug, file);
  if (!reelsCfg.publicBase) return `<REELS_PUBLIC_BASE unset>/${slug}/${file}`;
  return `${reelsCfg.publicBase}/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
}

export function containerParams(reel: Reel): ReelContainerParams {
  const signed = reelsCfg.hosting === "signed" ? reel.media : undefined;
  const p: ReelContainerParams = {
    media_type: "REELS",
    video_url: signed?.videoUrl ?? publicUrl(reel.slug, reel.video),
    caption: reel.caption,
    share_to_feed: reel.shareToFeed === false ? "false" : "true",
  };
  if (signed?.coverUrl) p.cover_url = signed.coverUrl;
  else if (reel.cover && !signed) p.cover_url = publicUrl(reel.slug, reel.cover);
  else p.thumb_offset = String(reel.thumbOffsetMs ?? 0);
  return p;
}

/** HEAD a public URL (no token). Returns status and content-length/type. */
async function headUrl(url: string): Promise<{ ok: boolean; status: number; bytes?: number; type?: string }> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    const len = res.headers.get("content-length");
    return { ok: res.ok, status: res.status, bytes: len ? Number(len) : undefined, type: res.headers.get("content-type") ?? undefined };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ---------------------------------------------------------------- status

type Status = "posted" | "manual" | "draft" | "staging" | "due" | "missed" | "scheduled";

function statusOf(reel: Reel, state: State, now: number): Status {
  if (state.get(stateKey(reel.slug)).postedAt) return "posted";
  if (reel.manual) return "manual";
  if (reel.draft) return "draft";
  const at = Date.parse(reel.postAt);
  if (at > now) return at - now <= reelsCfg.stageMinutes * 60_000 ? "staging" : "scheduled";
  return now - at <= reelsCfg.maxLateHours * 3_600_000 ? "due" : "missed";
}

// ---------------------------------------------------------------- dry run

async function runDry(checkUrls: boolean): Promise<void> {
  const reels = loadReels();
  const state = new State(reelsCfg.stateFile);
  const now = Date.now();
  console.log(`\nREELS DRY RUN at ${cairoLabel(new Date(now).toISOString())}. Nothing is uploaded or posted.`);
  const hostLine =
    reelsCfg.hosting === "signed"
      ? `signed URLs to the private bucket "${MEDIA_BUCKET}" (written by npm run reels:upload)`
      : reelsCfg.hosting === "supabase"
        ? `Supabase Storage bucket "${STAGING_BUCKET}" (upload ${reelsCfg.stageMinutes} min before the slot, delete after publish)`
        : `REELS_PUBLIC_BASE ${reelsCfg.publicBase || "(unset)"}`;
  console.log(`Default slot ${reelsCfg.postTime} ${TZ}. Hosting: ${hostLine}. Live latches: BOT_CONFIRM_LIVE=${config.confirmLive ? "yes" : "no"}, REELS_CONFIRM_LIVE=${reelsCfg.confirmLive ? "yes" : "no"}.\n`);
  if (reels.length === 0) {
    console.log("No reels in", reelsCfg.dir, "(run npm run reels:sync).");
    return;
  }
  console.log("Schedule:");
  for (const r of reels) {
    const extra = r.manual ? `  (${r.note ?? "posted by hand"})` : "";
    console.log(`  ${statusOf(r, state, now).padEnd(9)} ${cairoLabel(r.postAt).padEnd(36)} ${r.postAt}  ${r.slug}${extra}`);
  }
  for (const r of reels) {
    const st = statusOf(r, state, now);
    if (st === "manual") {
      console.log(`\n=== ${r.slug}  [manual]  ${r.note ?? "posted by hand"}. The bot does not publish it.`);
      continue;
    }
    const params = containerParams(r);
    const check = preflight(r);
    const stageAt = new Date(Date.parse(r.postAt) - reelsCfg.stageMinutes * 60_000).toISOString();
    console.log(`\n=== ${r.slug}  [${st}]  ${cairoLabel(r.postAt)}  (UTC ${r.postAt})`);
    console.log(`source: ${join(reelsCfg.sourceDir, r.sourceFolder)}  video ${r.video}${r.videoBytes ? ` (${(r.videoBytes / 1e6).toFixed(1)} MB)` : ""}  story ${r.storyDay ?? "?"}`);
    if (reelsCfg.hosting === "supabase") {
      console.log(`1. stage at ${cairoLabel(stageAt)}: upload ${r.video}${r.cover ? ` and ${r.cover}` : ""} to ${STAGING_BUCKET}/${r.slug}/`);
      console.log(`2. at the slot: HEAD both public URLs (200 and matching size), then:`);
    }
    console.log("POST /me/media (form fields, token in the Authorization header only):");
    if (reelsCfg.hosting === "signed") {
      const m = signedProblem(r, now);
      console.log(m ? `  MEDIA: ${m}` : `  media: signed URLs valid until ${cairoLabel(r.media!.expiresAt)}`);
    }
    const shown = { ...params, caption: `<${[...params.caption].length} chars, see below>`, video_url: redactUrl(params.video_url), ...(params.cover_url ? { cover_url: redactUrl(params.cover_url) } : {}) };
    console.log(JSON.stringify(shown, null, 2).replace(/^/gm, "  "));
    console.log("then: poll GET /<container-id>?fields=status_code every 15 s until FINISHED, then POST /me/media_publish {creation_id}");
    if (reelsCfg.hosting === "supabase") {
      console.log(`3. delete both staged files after publish (or after ${reelsCfg.maxLateHours} h if publishing keeps failing).`);
    }
    if (checkUrls) {
      for (const [label, url] of [["video_url", params.video_url], ["cover_url", params.cover_url]] as const) {
        if (!url) continue;
        const h = await probeUrl(url);
        const match = h.ok && label === "video_url" && r.videoBytes && h.bytes ? (h.bytes === r.videoBytes ? ", size matches" : `, SIZE MISMATCH ${h.bytes} vs ${r.videoBytes}`) : "";
        console.log(`  HEAD ${label}: ${h.status || "unreachable"}${h.type ? ` ${h.type}` : ""}${match}`);
      }
    }
    for (const e of check.errors) console.log(`  ERROR: ${e}`);
    for (const w of check.warnings) console.log(`  warn: ${w}`);
    if (!check.errors.length) console.log("  preflight: OK");
    console.log("--- caption ---");
    console.log(r.caption);
  }
  console.log("\nreels dry-run: nothing uploaded, nothing posted.");
}

// ---------------------------------------------------------------- staging (live only)

/** Upload the reel's video and cover to the public staging bucket. Records paths in state. */
async function stageReel(r: Reel, state: State): Promise<void> {
  const abs = join(reelsCfg.sourceDir, r.sourceFolder);
  const files = [r.video, ...(r.cover ? [r.cover] : [])];
  const paths: string[] = [];
  for (const f of files) {
    const p = stagingPath(r.slug, f);
    await uploadToStaging(p, readFileSync(join(abs, f)), f);
    paths.push(p);
  }
  state.set(stateKey(r.slug), { stagedAt: new Date().toISOString(), stagedPaths: paths, cleanedAt: undefined });
  console.log(`  ${r.slug}: staged ${files.join(" and ")} in ${STAGING_BUCKET}.`);
}

/** Delete the reel's staged files (after publish, or once the retry window has passed). */
async function cleanupReel(r: Reel, state: State, why: string): Promise<void> {
  const s = state.get(stateKey(r.slug));
  const paths = s.stagedPaths ?? [];
  if (!paths.length || s.cleanedAt) return;
  try {
    const n = await deleteFromStaging(paths);
    state.set(stateKey(r.slug), { cleanedAt: new Date().toISOString() });
    console.log(`  ${r.slug}: deleted ${n} staged file(s) (${why}).`);
  } catch (e) {
    console.error(`  ${r.slug}: staged files NOT deleted yet, retried next run: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- live

/** Why a signed-mode reel cannot publish now, or null when its media is ready. */
function signedProblem(r: Reel, now: number): string | null {
  if (!r.media?.videoUrl) return `no signed media yet: run npm run reels:upload -- ${r.slug} on the laptop`;
  if (Date.parse(r.media.expiresAt) <= now + 15 * 60_000) return `signed URLs expired or expire within 15 min (${r.media.expiresAt}): rerun npm run reels:upload -- ${r.slug}`;
  if (r.videoBytes && r.media.videoBytes !== r.videoBytes) return "uploaded video size differs from reel.json (rerun reels:sync and reels:upload)";
  return null;
}

/** First caption line, normalised, to recognise a reel that is already live on Instagram. */
export function captionKey(s: string): string {
  const first = s.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
  return first.replace(/[\u064B-\u0652\u0640\u202A-\u202E\u200E\u200F]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Lost-state guard: before creating a new container, read the account's recent media. A post whose
 * first caption line matches this reel means it is already live (posted earlier, by hand, or by a run
 * whose state was not saved). Throws when Instagram cannot be read, so nothing posts blind.
 */
async function alreadyLive(r: Reel): Promise<{ id: string; timestamp?: string } | null> {
  const key = captionKey(r.caption);
  if (!key) return null;
  const media = await recentMedia();
  return media.find((m) => captionKey(m.caption ?? "") === key) ?? null;
}

async function runLive(): Promise<void> {
  if (!config.confirmLive || !reelsCfg.confirmLive) {
    throw new Error("Reel publishing requires BOTH BOT_CONFIRM_LIVE=yes and REELS_CONFIRM_LIVE=yes.");
  }
  if (reelsCfg.hosting === "url" && !reelsCfg.publicBase) throw new Error("REELS_PUBLIC_BASE must be set when REELS_HOSTING=url.");
  const reels = loadReels();
  const state = new State(reelsCfg.stateFile);
  const now = Date.now();
  let published = 0;

  for (const r of reels) {
    const st = statusOf(r, state, now);
    const key = stateKey(r.slug);
    const staged = !!state.get(key).stagedPaths?.length && !state.get(key).cleanedAt;

    // Cleanup first: posted or missed reels never keep public files around.
    if (reelsCfg.hosting === "supabase" && staged && (st === "posted" || st === "missed" || st === "draft" || st === "manual")) {
      await cleanupReel(r, state, st === "posted" ? "published" : `status ${st}`);
      continue;
    }
    if (st === "missed") {
      console.log(`  ${r.slug}: missed its slot (${cairoLabel(r.postAt)}) by more than ${reelsCfg.maxLateHours} h. Not posting. Move its postAt.`);
      continue;
    }
    if (st !== "due" && st !== "staging") continue;

    const check = preflight(r);
    if (check.errors.length) {
      console.log(`  ${r.slug}: preflight failed, not posting: ${check.errors.join("; ")}`);
      continue;
    }
    if (reelsCfg.hosting === "signed") {
      const problem = signedProblem(r, now);
      if (problem) {
        console.log(`  ${r.slug}: ${problem}. Not posting.`);
        if (st === "due") process.exitCode = 1;
        continue;
      }
    }
    if (reelsCfg.hosting === "supabase" && !staged) {
      try {
        await stageReel(r, state);
      } catch (e) {
        console.error(`  ${r.slug}: staging failed: ${(e as Error).message}`);
        continue;
      }
    }
    if (st !== "due" || published >= reelsCfg.maxPerRun) continue; // staged early, publish at the slot

    const params = containerParams(r);
    const v = await probeUrl(params.video_url);
    if (!v.ok || (r.videoBytes && v.bytes && v.bytes !== r.videoBytes)) {
      console.log(`  ${r.slug}: video_url not reachable (${v.status}${v.bytes ? `, ${v.bytes} bytes` : ""}). Not posting.`);
      process.exitCode = 1;
      continue;
    }
    if (params.cover_url && !(await probeUrl(params.cover_url)).ok) {
      console.log(`  ${r.slug}: cover_url not reachable. Not posting.`);
      process.exitCode = 1;
      continue;
    }
    const usage = await publishingQuotaUsage();
    if (usage != null && usage >= 25) {
      console.log(`  ${r.slug}: ${usage} API posts in the last 24 h. Holding to stay far below Meta's cap.`);
      continue;
    }

    try {
      let containerId = state.get(key).reelContainerId;
      if (containerId) {
        const s = await containerStatus(containerId).catch(() => "");
        if (s === "PUBLISHED") {
          state.set(key, { postedAt: new Date().toISOString() });
          console.log(`  ${r.slug}: container ${containerId} was already PUBLISHED. Recorded, not reposted.`);
          if (reelsCfg.hosting === "supabase") await cleanupReel(r, state, "published");
          continue;
        }
        if (s !== "FINISHED" && s !== "IN_PROGRESS") containerId = undefined; // ERROR / EXPIRED / unknown
      }
      if (!containerId) {
        const live = await alreadyLive(r);
        if (live) {
          state.set(key, { postedAt: live.timestamp ?? new Date().toISOString(), igMediaId: live.id, recordedFrom: "found" });
          console.log(`  ${r.slug}: already live on Instagram as ${live.id}. Recorded, not reposted.`);
          if (reelsCfg.hosting === "supabase") await cleanupReel(r, state, "already live");
          continue;
        }
        containerId = await createReelContainer(params);
        state.set(key, { reelContainerId: containerId, reelContainerCreatedAt: new Date().toISOString() });
      }
      console.log(`Publishing reel ${r.slug} (container ${containerId}) ...`);
      const id = await publishReelContainer(containerId);
      state.set(key, { postedAt: new Date().toISOString(), igMediaId: id, recordedFrom: "published" });
      console.log(`  published as ${id}`);
      published++;
      if (reelsCfg.hosting === "supabase") await cleanupReel(r, state, "published");
    } catch (e) {
      // Files stay staged for the retry window; the missed branch above deletes them after it.
      console.error(`  FAILED to publish ${r.slug}: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log(`reels live: ${published} reel(s) published.`);
}

// ---------------------------------------------------------------- upload (laptop, cloud mode)

/**
 * npm run reels:upload -- [slug ...] [--push]
 * Uploads each reel's mp4 and cover to the PRIVATE bucket ig-reel-media and writes signed URLs
 * (valid REELS_SIGN_DAYS) into reels/<slug>/reel.json. With no slug: every upcoming reel that is not
 * manual or draft and has no signed media yet (or media that expires before its slot window ends).
 * --push commits and pushes those reel.json files so the cloud workflow sees them.
 * The Supabase key is read locally and never printed.
 */
async function runUpload(args: string[]): Promise<void> {
  const push = args.includes("--push");
  const force = args.includes("--force");
  const wanted = args.filter((a) => !a.startsWith("--"));
  const all = loadReels();
  const now = Date.now();
  const windowEnd = (r: Reel) => Date.parse(r.postAt) + reelsCfg.maxLateHours * 3_600_000;
  const picked: Reel[] = [];
  for (const s of wanted) {
    const r = all.find((x) => x.slug === s);
    if (!r) throw new Error(`no reels/${s}/reel.json (run npm run reels:sync first)`);
    picked.push(r);
  }
  if (!wanted.length) picked.push(...all.filter((r) => !r.manual && !r.draft && windowEnd(r) > now && (!r.media || Date.parse(r.media.expiresAt) < windowEnd(r))));
  if (!picked.length) {
    console.log("Nothing to upload: every upcoming reel already has signed media.");
    return;
  }
  await ensureMediaBucket();
  const seconds = Math.round(reelsCfg.signDays * 86_400);
  const changed: string[] = [];
  for (const r of picked) {
    if ((r.manual || r.draft) && !force) {
      console.log(`  ${r.slug}: ${r.manual ? "manual" : "draft"}, skipped. Use --force to upload anyway.`);
      continue;
    }
    const abs = join(reelsCfg.sourceDir, r.sourceFolder);
    const videoPath = join(abs, r.video);
    if (!existsSync(videoPath)) throw new Error(`${r.slug}: ${videoPath} not found`);
    const bytes = statSync(videoPath).size;
    if (r.videoBytes && r.videoBytes !== bytes) throw new Error(`${r.slug}: the mp4 changed since the last sync (${bytes} vs ${r.videoBytes} bytes). Run npm run reels:sync first.`);
    const check = preflight(r);
    if (check.errors.length) throw new Error(`${r.slug}: preflight failed: ${check.errors.join("; ")}`);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const vPath = `${r.slug}/${stamp}-${r.video}`;
    await uploadMedia(vPath, readFileSync(videoPath), "video/mp4");
    const videoUrl = await signMedia(vPath, seconds);
    let coverPath: string | undefined;
    let coverUrl: string | undefined;
    if (r.cover) {
      coverPath = `${r.slug}/${stamp}-${r.cover}`;
      await uploadMedia(coverPath, readFileSync(join(abs, r.cover)), "image/jpeg");
      coverUrl = await signMedia(coverPath, seconds);
    }
    const v = await probeUrl(videoUrl);
    if (!v.ok || v.bytes !== bytes) throw new Error(`${r.slug}: the signed video URL did not answer with the right size (${v.status}, ${v.bytes} vs ${bytes})`);
    if (coverUrl && !(await probeUrl(coverUrl)).ok) throw new Error(`${r.slug}: the signed cover URL does not answer`);
    r.media = { bucket: MEDIA_BUCKET, videoPath: vPath, coverPath, videoUrl, coverUrl, videoBytes: bytes, uploadedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + seconds * 1000 - 60_000).toISOString() };
    saveReel(r);
    changed.push(reelFile(r.slug));
    console.log(`  ${r.slug}: uploaded ${(bytes / 1e6).toFixed(1)} MB${r.cover ? " and the cover" : ""} to ${MEDIA_BUCKET}. Signed URLs valid until ${cairoLabel(r.media.expiresAt)}. Posts ${cairoLabel(r.postAt)}.`);
  }
  if (!changed.length) return;
  if (!push) {
    console.log(`\nNext: commit and push ${changed.join(", ")} to main (or rerun with --push).`);
    return;
  }
  const git = (...a: string[]) => {
    const res = spawnSync("git", a, { stdio: "inherit" });
    if (res.status !== 0) throw new Error(`git ${a[0]} failed`);
  };
  git("add", ...changed);
  git("commit", "-m", `chore(reels): signed media for ${picked.map((r) => r.slug).join(", ")}`);
  git("pull", "--rebase", "--autostash");
  git("push");
  console.log("Pushed. The cloud workflow publishes it at the slot.");
}

// ---------------------------------------------------------------- bucket setup and test

/** Create the staging bucket if it does not exist (owner-authorized, 24 Oct 2026). */
async function runBucket(): Promise<void> {
  let b = await getBucket();
  if (!b) {
    await createBucket();
    console.log(`Created bucket ${STAGING_BUCKET}.`);
    b = await getBucket();
  }
  console.log(`Bucket ${STAGING_BUCKET}: public=${b?.public}, file_size_limit=${b?.file_size_limit}, allowed_mime_types=${JSON.stringify(b?.allowed_mime_types)}`);
}

/** Upload a tiny dummy jpeg, HEAD its public URL, delete it, HEAD again. No reel media involved. */
async function runStageTest(): Promise<void> {
  // A valid 1x1 JPEG (125 bytes).
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    "base64",
  );
  const p = stagingPath("_selftest", `dummy-${Date.now()}.jpg`);
  const url = `${supabaseCreds().url}/storage/v1/object/public/${STAGING_BUCKET}/${p}`;
  await uploadToStaging(p, jpeg, "dummy.jpg");
  const before = await headUrl(url);
  console.log(`uploaded ${p} (${jpeg.length} bytes). HEAD public URL: ${before.status} ${before.type ?? ""} ${before.bytes ?? "?"} bytes`);
  const n = await deleteFromStaging([p]);
  console.log(`deleted ${n} file(s).`);
  const after = await headUrl(`${url}?t=${Date.now()}`);
  console.log(`HEAD after delete: ${after.status}`);
  const ok = before.ok && before.bytes === jpeg.length && n === 1 && !after.ok;
  console.log(ok ? "stage test: PASS" : "stage test: FAIL");
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  if (a.includes("--sync")) return runSync();
  if (a.includes("--upload")) return runUpload(a.filter((x) => x !== "--upload"));
  if (a.includes("--bucket")) return runBucket();
  if (a.includes("--stage-test")) return runStageTest();
  if (a.includes("--live")) return runLive();
  return runDry(a.includes("--check-urls"));
}

if (!process.env.REELS_NO_MAIN) main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
