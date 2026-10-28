// YouTube Shorts uploader for the Recall Engine channel (owner, 28 Oct 2026).
//
//   --dry-run (default)  Print every YouTube entry: status, slot, and the exact videos.insert request
//                        (query, headers, JSON body). No secrets needed, no network, nothing uploaded.
//                        --check-urls also probes each signed video URL (size only, no download).
//   --sync               Write reels/<slug>/youtube.json for approved reels that have none (title,
//                        description, tags, slot, and video facts from ffprobe). "approved": false.
//                        Never overwrites an edited field. --reslot moves passed slots of entries that
//                        are not uploaded yet to the next free days. --all includes Instagram drafts.
//   --live               Upload due Shorts. Needs YT_CONFIRM_LIVE=yes (the workflow sets it only while
//                        the repository variable YT_BOTS is "on"), the OAuth secrets, and YT_CHANNEL_ID.
//   --unschedule <slug>  Cancel a scheduled publish (the video stays private). Needs the same as --live.
//   --test-upload <slug> Phase 0: upload that reel PRIVATE now with no publish time and no subscriber
//                        notification. It ignores the slot window and needs no approval (only the owner
//                        sees it). Every other check still runs. Needs the same as --live.
//   --only <slug>        Limit a run to one reel.
//
// Live flow per reel: preflight -> signed URL problems -> channel check -> lost-state guard (the
// channel's newest uploads, by the hidden tag re-<slug> or the title) -> download the mp4 and check its
// size and sha256 prefix -> videos.insert (resumable: the moment YouTube opens the upload session it is
// recorded. A session without a saved video id is never retried by the bot) -> save the video id at
// once -> read the status back. One upload per run, YT_MAX_PER_DAY per Cairo day.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reel, ReelYoutube } from "../types.js";
import { addDays, cairoLabel, loadReelsFrom, localToUtcIso, localYmd, signedProblem } from "../reels-manifest.js";
import { probeUrl, redactUrl } from "../media.js";
import { yt } from "./config.js";
import { YtState } from "./state.js";
import { COST, QuotaError, YouTubeClient, missingSecrets, type VideoResource } from "./api.js";
import { buildYoutube, idempotencyTag, insertPlan, preflightYoutube, titleKey } from "./metadata.js";

// ---------------------------------------------------------------- entries

export interface Entry {
  reel: Reel;
  y: ReelYoutube;
  /** "file" = reels/<slug>/youtube.json; "crosspost" = listed because YT_CROSSPOST=on (never uploaded). */
  source: "file" | "crosspost";
}

export type YtStatus = "uploaded" | "skip" | "draft" | "unapproved" | "early" | "due" | "late" | "missed";

const ytFile = (slug: string) => join(yt.reelsDir, slug, "youtube.json");

function readYoutube(slug: string): ReelYoutube | null {
  const f = ytFile(slug);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ReelYoutube) : null;
}

function writeYoutube(slug: string, y: ReelYoutube): void {
  writeFileSync(ytFile(slug), JSON.stringify(y, null, 2) + "\n");
}

/** Instagram reel state (reels/state.json): only read, to know which reels are live there. */
function igPosted(): Set<string> {
  const f = join(yt.reelsDir, "state.json");
  if (!existsSync(f)) return new Set();
  const s = JSON.parse(readFileSync(f, "utf8")) as Record<string, { postedAt?: string }>;
  return new Set(Object.entries(s).filter(([k, v]) => k.startsWith("reel:") && v.postedAt).map(([k]) => k.slice(5)));
}

/** Cairo days already holding a YouTube slot (entries plus what was sent). */
function takenDays(entries: Array<{ y: ReelYoutube }>, state: YtState): Set<string> {
  const days = new Set(entries.map((e) => localYmd(Date.parse(e.y.publishAt))));
  for (const [, slug] of state.videoIds()) {
    const slot = state.get(slug).slotAt;
    if (slot) days.add(localYmd(Date.parse(slot)));
  }
  return days;
}

/** The next free day (from tomorrow, Cairo) at YT_POST_TIME. Marks it taken. */
function nextFreeSlot(taken: Set<string>, now: number): string {
  let day = addDays(localYmd(now), 1);
  while (taken.has(day)) day = addDays(day, 1);
  taken.add(day);
  return localToUtcIso(day, yt.postTime);
}

const bySlot = (a: Entry, b: Entry) => a.y.publishAt.localeCompare(b.y.publishAt) || a.reel.slug.localeCompare(b.reel.slug);

export function loadEntries(state: YtState, now: number): Entry[] {
  const reels = loadReelsFrom(yt.reelsDir);
  const entries: Entry[] = [];
  for (const reel of reels) {
    const y = readYoutube(reel.slug);
    if (y) entries.push({ reel, y, source: "file" });
  }
  if (!yt.crossPost) return entries.sort(bySlot);
  // YT_CROSSPOST=on: approved Instagram reels (live there or posted by hand) without a youtube.json are
  // LISTED with generated text and a free slot. They stay "approved": false and never upload: the owner
  // reads the text (npm run yt:sync writes it to youtube.json) and approves each reel himself.
  const posted = igPosted();
  const taken = takenDays(entries, state);
  for (const reel of reels) {
    if (entries.some((e) => e.reel.slug === reel.slug)) continue;
    if (reel.draft || reel.trial || !(posted.has(reel.slug) || reel.manual)) continue;
    const sent = state.get(reel.slug).slotAt;
    const at = sent ?? (Date.parse(reel.postAt) > now + yt.minScheduleMinutes * 60_000 ? reel.postAt : nextFreeSlot(taken, now));
    const y = { ...buildYoutube(reel, at, cairoLabel(at)), approved: false, note: "generated by YT_CROSSPOST: run npm run yt:sync, read it, then approve it in youtube.json" };
    entries.push({ reel, y, source: "crosspost" });
  }
  return entries.sort(bySlot);
}

export function statusOf(e: Entry, state: YtState, now: number): YtStatus {
  if (state.get(e.reel.slug).videoId) return "uploaded";
  if (e.y.skip || e.reel.trial) return "skip";
  if (e.reel.draft) return "draft";
  if (!e.y.approved) return "unapproved";
  const at = Date.parse(e.y.publishAt);
  if (at - now > yt.leadHours * 3_600_000) return "early";
  if (at >= now) return "due";
  return now - at <= yt.maxLateHours * 3_600_000 ? "late" : "missed";
}

/** A scheduled publish that must be cancelled: the reel went back to skip, draft, or unapproved. */
function shouldUnschedule(e: Entry, state: YtState, now: number): boolean {
  const s = state.get(e.reel.slug);
  if (!s.videoId || !s.publishAtSent || s.unscheduledAt || s.lockedPrivate) return false;
  if (Date.parse(s.publishAtSent) <= now) return false; // already public: the owner handles it in Studio
  return !!(e.y.skip || e.reel.trial || e.reel.draft || !e.y.approved);
}

// ---------------------------------------------------------------- dry run

function requestLines(e: Entry, now: number): string[] {
  const plan = insertPlan(e.reel.slug, e.y, now);
  const q = `uploadType=resumable&part=snippet,status&notifySubscribers=${plan.notifySubscribers}`;
  return [
    `POST ${yt.apiBase}/upload/youtube/v3/videos?${q}`,
    "  headers: Authorization: Bearer <access token>, X-Upload-Content-Type: video/mp4" + (e.reel.videoBytes ? `, X-Upload-Content-Length: ${e.reel.videoBytes}` : ""),
    "  body:",
    JSON.stringify(plan.body, null, 2).replace(/^/gm, "    "),
    `then PUT <upload session URL> with the mp4 (${e.reel.videoBytes ? `${(e.reel.videoBytes / 1e6).toFixed(1)} MB` : "size unknown"}${e.reel.videoSha256 ? `, sha256 ${e.reel.videoSha256}... checked first` : ""})`,
    `after upload: ${plan.outcome}`,
  ];
}

async function runDry(only: string | undefined, checkUrls: boolean): Promise<void> {
  const state = new YtState(yt.stateFile, false);
  const now = Date.now();
  const entries = loadEntries(state, now).filter((e) => !only || e.reel.slug === only);
  const q = state.quota();
  console.log(`\nYOUTUBE DRY RUN at ${cairoLabel(new Date(now).toISOString())}. Nothing is uploaded and nothing is sent to Google.`);
  console.log(
    `Switches: YT_CONFIRM_LIVE=${yt.confirmLive ? "yes" : "no"}, YT_PUBLIC=${yt.public ? "on" : "off"} (${yt.public ? "private + publishAt = the slot" : "private, no publish time"}), YT_CROSSPOST=${yt.crossPost ? "on" : "off"}. ` +
      `Upload window: ${yt.leadHours} h before the slot to ${yt.maxLateHours} h after. Caps: ${yt.maxPerRun} per run, ${yt.maxPerDay} per Cairo day. ` +
      `Quota today (Pacific ${q.day}): ${q.units}/${yt.unitBudget} units, ${q.uploads}/${yt.uploadBudget} uploads. Secrets: ${missingSecrets().length ? `missing ${missingSecrets().join(", ")}` : "present"}.\n`,
  );
  if (!entries.length) {
    console.log(`No YouTube entries (reels/<slug>/youtube.json). Run npm run yt:sync${yt.crossPost ? "" : " or set YT_CROSSPOST=on"}.`);
    return;
  }
  console.log("Schedule:");
  for (const e of entries) {
    const st = statusOf(e, state, now);
    console.log(`  ${st.padEnd(10)} ${cairoLabel(e.y.publishAt).padEnd(36)} ${e.reel.slug}${e.source === "crosspost" ? "  (cross-post)" : ""}${state.get(e.reel.slug).videoId ? `  video ${state.get(e.reel.slug).videoId}` : ""}`);
  }
  for (const e of entries) {
    const st = statusOf(e, state, now);
    const s = state.get(e.reel.slug);
    console.log(`\n=== ${e.reel.slug}  [${st}]  slot ${cairoLabel(e.y.publishAt)}  (UTC ${e.y.publishAt})${e.source === "crosspost" ? "  generated by YT_CROSSPOST" : ""}`);
    if (st === "uploaded") {
      console.log(`already on YouTube as ${s.videoId} (${s.recordedFrom}${s.privacyStatusSeen ? `, ${s.privacyStatusSeen}` : ""}${s.publishAtSent ? `, publishAt ${s.publishAtSent}` : ""}${s.lockedPrivate ? ", LOCKED PRIVATE" : ""}). Never uploaded again.`);
      if (shouldUnschedule(e, state, now)) console.log("  a live run CANCELS its scheduled publish: the reel is now skip, draft, or unapproved.");
      continue;
    }
    if (st === "skip") {
      console.log(e.reel.trial ? "Instagram trial reel: never on YouTube." : "youtube.json has skip: true.");
      continue;
    }
    if (st === "draft") console.log("held: the reel is a draft on the Instagram side.");
    if (st === "unapproved") console.log(e.source === "crosspost" ? "held: generated by YT_CROSSPOST. It never uploads until npm run yt:sync writes it to youtube.json and the owner approves it." : 'held: "approved" is false in youtube.json (the owner has not OKed this title and description).');
    if (st === "missed") console.log(`missed: the slot passed more than ${yt.maxLateHours} h ago. Move publishAt (or npm run yt:sync -- --reslot).`);
    if (st === "early") console.log(`uploads from ${cairoLabel(new Date(Date.parse(e.y.publishAt) - yt.leadHours * 3_600_000).toISOString())}.`);
    const media = signedProblem(e.reel, now);
    console.log(media ? `  MEDIA: ${media}` : `  media: signed video URL valid until ${cairoLabel(e.reel.media!.expiresAt)} (${redactUrl(e.reel.media!.videoUrl).replace(/^https:\/\/[^/]+/, "<supabase>")})`);
    if (checkUrls && e.reel.media?.videoUrl) {
      const h = await probeUrl(e.reel.media.videoUrl);
      console.log(`  probe video URL: ${h.status || "unreachable"}${h.bytes ? `, ${h.bytes} bytes${e.reel.videoBytes ? (h.bytes === e.reel.videoBytes ? " (matches)" : " (SIZE MISMATCH)") : ""}` : ""}`);
    }
    for (const line of requestLines(e, now)) console.log(line);
    const check = preflightYoutube(e.reel.slug, e.y);
    for (const er of check.errors) console.log(`  ERROR: ${er}`);
    for (const w of check.warnings) console.log(`  warn: ${w}`);
    if (!check.errors.length) console.log("  preflight: OK");
    console.log(`  quota for a live upload: ${COST.list * 4} units (channel, uploads list, videos list, status read back) + 1 upload${yt.thumbnails ? ` + ${COST.thumbnail} units (thumbnail)` : ""}.`);
  }
  console.log("\nyoutube dry-run: nothing uploaded, nothing sent.");
}

// ---------------------------------------------------------------- live

async function download(e: Entry): Promise<Buffer> {
  const res = await fetch(e.reel.media!.videoUrl);
  if (!res.ok) throw new Error(`signed video URL answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const want = e.reel.videoBytes ?? e.reel.media!.videoBytes;
  if (want && bytes.length !== want) throw new Error(`downloaded ${bytes.length} bytes, reel.json says ${want}`);
  if (e.reel.videoSha256) {
    const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    if (sha !== e.reel.videoSha256) throw new Error(`sha256 ${sha} does not match reel.json (${e.reel.videoSha256}): not the approved render`);
  }
  return bytes;
}

/** Lost-state guard: the channel's newest uploads, matched by the hidden tag, then by title. */
async function findOnChannel(client: YouTubeClient, uploadsPlaylistId: string, e: Entry, claimed: Map<string, string>): Promise<VideoResource | null> {
  const ids = (await client.recentUploadIds(uploadsPlaylistId, 50)).filter((id) => !claimed.has(id) || claimed.get(id) === e.reel.slug);
  if (!ids.length) return null;
  const vids = await client.videos(ids, "snippet,status");
  const tag = idempotencyTag(e.reel.slug);
  return vids.find((v) => v.snippet?.tags?.includes(tag)) ?? vids.find((v) => titleKey(v.snippet?.title ?? "") === titleKey(e.y.title)) ?? null;
}

function recordSeen(state: YtState, slug: string, v: VideoResource | undefined): void {
  if (!v?.status) return;
  state.set(slug, { privacyStatusSeen: v.status.privacyStatus, publishAtSeen: v.status.publishAt, uploadStatusSeen: v.status.uploadStatus });
}

async function unschedule(client: YouTubeClient, state: YtState, e: Entry, why: string): Promise<void> {
  const id = state.get(e.reel.slug).videoId!;
  await client.updateStatus(id, { privacyStatus: "private", selfDeclaredMadeForKids: e.y.madeForKids, containsSyntheticMedia: e.y.containsSyntheticMedia === true, embeddable: true, license: "youtube" });
  state.set(e.reel.slug, { unscheduledAt: new Date().toISOString() });
  console.log(`  ${e.reel.slug}: scheduled publish CANCELLED (${why}). Video ${id} stays private.`);
}

async function connect(state: YtState): Promise<{ client: YouTubeClient; uploads: string }> {
  if (!yt.channelId) throw new Error("YT_CHANNEL_ID is not set (repository variable; scripts/youtube-auth.mjs sets it).");
  const client = new YouTubeClient(state);
  const me = await client.myChannel();
  if (me.id !== yt.channelId) throw new Error(`the token belongs to channel ${me.id} (${me.title}), not YT_CHANNEL_ID ${yt.channelId}. Nothing uploaded.`);
  if (!me.uploadsPlaylistId) throw new Error("the channel has no uploads playlist id");
  console.log(`Channel ${me.title}${me.customUrl ? ` (${me.customUrl})` : ""} confirmed.`);
  return { client, uploads: me.uploadsPlaylistId };
}

async function runLive(only: string | undefined, testSlug?: string): Promise<void> {
  if (!yt.confirmLive) throw new Error("YouTube uploads need YT_CONFIRM_LIVE=yes (set by the workflow only while YT_BOTS is on).");
  const missing = missingSecrets();
  if (missing.length) throw new Error(`missing ${missing.join(", ")}: the owner runs node scripts/youtube-auth.mjs. Nothing uploaded.`);
  const test = testSlug !== undefined;
  if (test && !testSlug) throw new Error("--test-upload needs a reel slug.");
  const state = new YtState(yt.stateFile, true);
  const now = Date.now();
  const pick = testSlug ?? only;
  const entries = loadEntries(state, now).filter((e) => !pick || e.reel.slug === pick);
  let todo: Entry[];
  let cancel: Entry[];
  if (test) {
    const e = entries.find((x) => x.source === "file");
    if (!e) throw new Error(`${testSlug} has no reels/${testSlug}/youtube.json (npm run yt:sync writes it). Nothing uploaded.`);
    const st = statusOf(e, state, now);
    if (st === "uploaded") {
      console.log(`youtube test: ${testSlug} is already on YouTube as ${state.get(e.reel.slug).videoId}. Nothing uploaded.`);
      return;
    }
    if (st === "skip" || st === "draft") throw new Error(`${testSlug} is ${st === "skip" ? "skip or an Instagram trial reel" : "an Instagram draft"}. Nothing uploaded.`);
    todo = [e];
    cancel = [];
  } else {
    todo = entries.filter((e) => ["due", "late"].includes(statusOf(e, state, now)));
    cancel = entries.filter((e) => shouldUnschedule(e, state, now));
    for (const e of entries.filter((x) => statusOf(x, state, now) === "missed")) {
      console.log(`  ${e.reel.slug}: missed its slot (${cairoLabel(e.y.publishAt)}) by more than ${yt.maxLateHours} h. Not uploading. Move publishAt.`);
    }
  }
  if (!todo.length && !cancel.length) {
    console.log(`youtube live: nothing due (${entries.length} entr${entries.length === 1 ? "y" : "ies"}). No API calls made.`);
    return;
  }
  const { client, uploads } = await connect(state);

  for (const e of cancel) {
    try {
      await unschedule(client, state, e, e.y.skip ? "skip: true" : e.reel.draft ? "the reel is a draft again" : "approved is false");
    } catch (err) {
      console.error(`  ${e.reel.slug}: could not cancel the scheduled publish: ${(err as Error).message}. Set it to Private in YouTube Studio now.`);
      process.exitCode = 1;
    }
  }

  const today = localYmd(now);
  let done = 0;
  for (const e of todo) {
    const slug = e.reel.slug;
    if (done >= yt.maxPerRun) break;
    if (state.uploadsOn(today, (ms) => localYmd(ms)) >= yt.maxPerDay) {
      console.log(`  daily cap: ${yt.maxPerDay} uploads already today (Cairo). ${slug} waits for tomorrow.`);
      break;
    }
    const check = preflightYoutube(slug, e.y);
    if (check.errors.length) {
      console.log(`  ${slug}: preflight failed, not uploading: ${check.errors.join("; ")}`);
      process.exitCode = 1;
      continue;
    }
    const media = signedProblem(e.reel, now);
    if (media) {
      console.log(`  ${slug}: ${media}. Not uploading.`);
      process.exitCode = 1;
      continue;
    }
    const s = state.get(slug);
    try {
      const found = await findOnChannel(client, uploads, e, state.videoIds());
      if (found) {
        state.set(slug, { videoId: found.id, recordedFrom: "found", uploadedAt: found.snippet?.publishedAt ?? new Date().toISOString(), slotAt: e.y.publishAt, titleSent: found.snippet?.title, sessionOpenedAt: undefined });
        recordSeen(state, slug, found);
        console.log(`  ${slug}: already on the channel as ${found.id}. Recorded, not uploaded again.`);
        continue;
      }
      if (s.sessionOpenedAt) {
        // An upload session opened but no video id was saved (the runner was killed or the reply was lost
        // after the bytes landed). A copy may exist that YouTube has not listed yet: never upload it again.
        const hours = (Date.now() - Date.parse(s.sessionOpenedAt)) / 3_600_000;
        if (hours < 2) {
          console.log(`  ${slug}: an upload session opened ${Math.round(hours * 60)} min ago left no video id and no copy is listed yet. Checked again next run. Not uploading.`);
        } else {
          console.error(`  ${slug}: an upload session opened ${cairoLabel(s.sessionOpenedAt)} left no video id and no copy is listed on the channel. Check YouTube Studio > Content (Private and Draft too). If there is no copy, delete "sessionOpenedAt" for this reel in reels/youtube-state.json. Not uploading.`);
          process.exitCode = 1;
        }
        continue;
      }
      const bytes = await download(e);
      const plan = insertPlan(slug, e.y, Date.now(), { public: yt.public, minScheduleMinutes: yt.minScheduleMinutes, test });
      if (plan.tooLate) {
        console.error(`  ${slug}: owner note: the slot ${cairoLabel(e.y.publishAt)} is less than ${yt.minScheduleMinutes} minutes ahead or passed. It goes up PRIVATE: publish it in YouTube Studio.`);
        process.exitCode = 1;
      }
      console.log(`Uploading ${slug} (${(bytes.length / 1e6).toFixed(1)} MB): ${plan.outcome} ...`);
      const v = await client.insertVideo(plan.body, bytes, plan.notifySubscribers, () => state.set(slug, { sessionOpenedAt: new Date().toISOString() }));
      state.set(slug, {
        videoId: v.id,
        recordedFrom: "uploaded",
        uploadedAt: new Date().toISOString(),
        slotAt: e.y.publishAt,
        titleSent: plan.body.snippet.title,
        privacyStatusSent: plan.body.status.privacyStatus,
        publishAtSent: plan.body.status.publishAt,
        sessionOpenedAt: undefined,
        testUpload: test || undefined,
      });
      done++;
      console.log(`  uploaded as ${v.id}`);
      const [back] = await client.videos([v.id], "status");
      recordSeen(state, slug, back ?? v);
      const seen = back?.status ?? v.status;
      if (seen?.rejectionReason || seen?.failureReason) {
        console.error(`  ${slug}: YouTube reports ${seen.rejectionReason ?? seen.failureReason}. Check YouTube Studio.`);
        process.exitCode = 1;
      }
      if (plan.body.status.publishAt && seen && !seen.publishAt && seen.privacyStatus === "private") {
        state.set(slug, { lockedPrivate: true });
        console.error(`  ${slug}: YouTube dropped the publish time and kept the video private: the API project is still locked to private uploads. Set YT_PUBLIC off and publish it in Studio (or submit the API audit).`);
        process.exitCode = 1;
      }
      if (yt.thumbnails && e.reel.media?.coverUrl) {
        try {
          const jpeg = Buffer.from(await (await fetch(e.reel.media.coverUrl)).arrayBuffer());
          await client.setThumbnail(v.id, jpeg);
          state.set(slug, { thumbnailSetAt: new Date().toISOString() });
          console.log("  thumbnail set from the reel cover");
        } catch (err) {
          console.log(`  thumbnail not set (expected for Shorts outside the Partner Program): ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error(`  FAILED ${slug}: ${(err as Error).message}`);
      process.exitCode = 1;
      if (err instanceof QuotaError) break;
    }
  }
  const q = state.quota();
  console.log(`youtube live: ${done} upload(s). Quota today (Pacific ${q.day}): ${q.units}/${yt.unitBudget} units, ${q.uploads}/${yt.uploadBudget} uploads.`);
}

async function runUnschedule(slug: string): Promise<void> {
  if (!yt.confirmLive) throw new Error("--unschedule needs YT_CONFIRM_LIVE=yes.");
  const state = new YtState(yt.stateFile, true);
  const e = loadEntries(state, Date.now()).find((x) => x.reel.slug === slug);
  if (!e || !state.get(slug).videoId) throw new Error(`${slug} has no uploaded video in ${yt.stateFile}.`);
  const { client } = await connect(state);
  await unschedule(client, state, e, "asked on the command line");
}

// ---------------------------------------------------------------- sync (laptop)

function probe(path: string): { durationSec?: number; width?: number; height?: number } {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height", "-of", "json", path], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return {};
  try {
    const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number }> };
    return { durationSec: Math.round(Number(j.format?.duration) * 10) / 10 || undefined, width: j.streams?.[0]?.width, height: j.streams?.[0]?.height };
  } catch {
    return {};
  }
}

function runSync(args: string[]): void {
  const all = args.includes("--all");
  const reslot = args.includes("--reslot");
  const sourceDir = process.env.REELS_SOURCE_DIR ?? "W:/Recall Engine Review/reels-week1-20261023/READY-TO-SCHEDULE";
  const state = new YtState(yt.stateFile, false);
  const now = Date.now();
  const reels = loadReelsFrom(yt.reelsDir);
  const existing = reels.map((r) => ({ r, y: readYoutube(r.slug) }));
  const taken = new Set(existing.filter((x) => x.y && (state.get(x.r.slug).videoId || Date.parse(x.y.publishAt) > now)).map((x) => localYmd(Date.parse(x.y!.publishAt))));
  for (const { r, y: prev } of existing) {
    if (r.trial || (r.draft && !all)) continue;
    const local = join(sourceDir, r.sourceFolder, r.video);
    const facts = existsSync(local) ? probe(local) : {};
    if (!prev) {
      const at = Date.parse(r.postAt) > now + yt.leadHours * 3_600_000 && !taken.has(localYmd(Date.parse(r.postAt))) ? r.postAt : nextFreeSlot(taken, now);
      taken.add(localYmd(Date.parse(at)));
      const y = { ...buildYoutube(r, at, cairoLabel(at)), ...facts };
      writeYoutube(r.slug, y);
      console.log(`  added     ${r.slug}  ${cairoLabel(at)}  "${y.title}"`);
      continue;
    }
    const next: ReelYoutube = { ...prev };
    for (const [k, v] of Object.entries(facts)) if ((next as unknown as Record<string, unknown>)[k] == null && v != null) (next as unknown as Record<string, unknown>)[k] = v;
    const uploaded = !!state.get(r.slug).videoId;
    if (reslot && !uploaded && Date.parse(prev.publishAt) <= now + yt.leadHours * 3_600_000) {
      next.publishAt = nextFreeSlot(taken, now);
      next.publishAtCairo = cairoLabel(next.publishAt);
      console.log(`  reslotted ${r.slug}  ${next.publishAtCairo}`);
    }
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      writeYoutube(r.slug, next);
      if (!reslot) console.log(`  filled    ${r.slug}  (video facts)`);
    } else console.log(`  kept      ${r.slug}`);
  }
  console.log("yt:sync: nothing uploaded. New entries are \"approved\": false until the owner OKs the title and description.");
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  const val = (flag: string) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
  const only = val("--only");
  if (a.includes("--sync")) return runSync(a);
  if (a.includes("--unschedule")) return runUnschedule(val("--unschedule") ?? "");
  if (a.includes("--live")) return runLive(only, a.includes("--test-upload") ? val("--test-upload") ?? "" : undefined);
  return runDry(only, a.includes("--check-urls"));
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
