// YouTube uploader settings (owner, 28 Oct 2026). Every live switch defaults to OFF: nothing is
// uploaded unless the workflow sets YT_CONFIRM_LIVE=yes, which it only does while the repository
// variable YT_BOTS is "on" and the OAuth secrets exist. Videos stay PRIVATE until YT_PUBLIC=on
// (set by the owner once a test upload proves the API project can publish).

import { join } from "node:path";
import { tmpdir } from "node:os";
import "../config.js"; // loads ../.env

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function onOff(name: string, fallback = false): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "on", "yes", "true"].includes(raw);
}

const reelsDir = process.env.REELS_DIR ?? "./reels";

export const yt = {
  reelsDir,
  /** Public ids only (video ids, times, quota counts): committed back by the workflow. */
  stateFile: process.env.YT_STATE_FILE ?? join(reelsDir, "youtube-state.json"),
  /** Laptop only: the folder holding the YouTube cuts (READY-TO-SCHEDULE-YT/<NN>/), for npm run yt:media. */
  sourceDir: process.env.YT_SOURCE_DIR ?? (process.env.REELS_SOURCE_DIR ? `${process.env.REELS_SOURCE_DIR.replace(/[\\/]+$/, "")}-YT` : ""),
  /** Signed URL lifetime for a YouTube cut, in days (the private bucket, like the Instagram media). */
  signDays: Number(process.env.YT_SIGN_DAYS ?? process.env.REELS_SIGN_DAYS ?? 7),
  /** The Recall Engine channel id (repository variable). The token must resolve to it. */
  channelId: (process.env.YT_CHANNEL_ID ?? "").trim(),
  /** Live latch. Only the workflow sets it (YT_BOTS=on, plus a schedule or mode=live). */
  confirmLive: (process.env.YT_CONFIRM_LIVE ?? "").toLowerCase() === "yes",
  /** Off: every upload stays private with no publish time (the owner flips it in Studio). On: private + publishAt = the slot. */
  public: onOff("YT_PUBLIC"),
  /** On: approved Instagram reels without a youtube.json are cross-posted with generated text. */
  crossPost: onOff("YT_CROSSPOST"),
  /** Upload this many hours before the slot (YouTube publishes at publishAt by itself). */
  leadHours: num("YT_LEAD_HOURS", 24),
  /** A slot more than this many hours in the past is not uploaded (move publishAt instead). */
  maxLateHours: num("YT_MAX_LATE_HOURS", 6),
  /** A publishAt closer than this is never sent: the video stays private with no publish time and the owner publishes it in Studio. */
  minScheduleMinutes: num("YT_MIN_SCHEDULE_MINUTES", 15),
  maxPerRun: num("YT_MAX_PER_RUN", 1),
  /** Uploads per Cairo day. */
  maxPerDay: num("YT_MAX_PER_DAY", 2),
  /** The uploader's share of the 10,000 units per Pacific day (the comment bot has its own share). */
  unitBudget: num("YT_UNIT_BUDGET", 1000),
  /** The uploader's share of the 100 videos.insert calls per Pacific day. */
  uploadBudget: num("YT_UPLOAD_BUDGET", 5),
  /** Try thumbnails.set with the reel cover (50 units). Shorts thumbnails are Partner Program only, so off. */
  thumbnails: onOff("YT_THUMBNAIL"),
  /** Default slot for new YouTube entries. */
  postTime: process.env.YT_POST_TIME ?? "20:00",
  siteUrl: "https://www.recallengine.app",
  // Fixed hosts: the refresh token, client secret, and access token only ever go to Google (no env override).
  apiBase: "https://www.googleapis.com",
  tokenUrl: "https://oauth2.googleapis.com/token",
  tmpDir: process.env.YT_TMP_DIR ?? tmpdir(),
};

/** Category 27 is Education (confirm once with videoCategories.list regionCode=EG, 1 unit). */
export const EDUCATION = "27";
export const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
