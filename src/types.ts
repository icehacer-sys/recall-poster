// Shared contracts for the poster.

/** One value slide: a short heading + a few spaced bullet lines + an optional icon hint. */
export interface SlidePoint {
  heading: string;
  /** Preferred: short bullet lines, rendered as a spaced list (not a paragraph). */
  bullets?: string[];
  /** Legacy paragraph body; split into sentence lines when no bullets are given. */
  body?: string;
  /** Hint for the small on-slide infographic icon (cyan line art). */
  icon?: string;
}

/** A single carousel post. Persisted as posts/<slug>/post.json. */
export interface Post {
  /** Stable id, also the folder name (e.g. "00001-heart-murmurs"). */
  slug: string;
  /** Sequence number (derived from the folder's leading digits if absent). */
  number?: number;
  /** Subject eyebrow, e.g. "Cardiology". */
  subject: string;
  /** Slide 1 headline (the hook). */
  title: string;
  /** Slide 1 subline. */
  hook: string;
  /** Value slides (aim for 4 -> 6 total slides with hook + CTA). */
  points: SlidePoint[];
  /** CTA slide headline (1-2 lines). The product pitch lives in the caption. */
  cta: string;
  /** Caption as blocks, joined with a blank line between each (preferred). Add light emoji. */
  captionLines?: string[];
  /** Legacy single-string caption, used only if captionLines is absent. */
  caption?: string;
  /** Hashtags without the leading '#'. Capped at 30. */
  hashtags: string[];
  /** ISO timestamp the post should go live. */
  postAt: string;
  /** Generated slide image filenames, in order. Filled by the renderer. */
  slides?: string[];
  /** Generator-created topics start as drafts; they only post when approved/auto-approved. */
  draft?: boolean;
  /** Set by the loader = directory name. Not persisted. */
  folder?: string;
}

/** Per-post run state, persisted in state.json keyed by slug. */
export interface PostState {
  slidesGeneratedAt?: string;
  postedAt?: string;
  igMediaId?: string;
  /** Reels only: the REELS container created for this reel, saved BEFORE publishing so a
   *  rerun reuses it (or detects that it already published) instead of posting twice. */
  reelContainerId?: string;
  reelContainerCreatedAt?: string;
  /** Reels only: files uploaded to the public staging bucket, and when they were removed. */
  stagedAt?: string;
  stagedPaths?: string[];
  cleanedAt?: string;
  /** How the post was recorded: "published" by this bot, or "found" on Instagram (already live). */
  recordedFrom?: string;
}

/** A scheduled reel. Persisted as reels/<slug>/reel.json (tracked, small, no media). */
export interface Reel {
  /** Stable id and folder name, e.g. "02-hypoglycaemia" (the READY-TO-SCHEDULE folder name). */
  slug: string;
  /** Folder under REELS_SOURCE_DIR that holds the final mp4, cover.jpg, and caption-instagram.txt. */
  sourceFolder: string;
  /** The mp4 to publish (file name inside sourceFolder and inside the public staging folder). */
  video: string;
  /** Cover image file name, or "" to use thumbOffsetMs instead. */
  cover: string;
  /** Caption file name inside sourceFolder (snapshotted into `caption` by --sync). */
  captionFile: string;
  /** Caption snapshot, exactly as it will be posted. Refreshed from captionFile by --sync. */
  caption: string;
  /** When to publish (UTC ISO). Default: one reel per day at REELS_POST_TIME Africa/Cairo. */
  postAt: string;
  /** Human-readable postAt, e.g. "Sun 25 Oct 2026 19:00 Africa/Cairo". Informational only. */
  postAtCairo?: string;
  /** Used only when cover is "": the frame (ms) Instagram uses as the cover. */
  thumbOffsetMs?: number;
  /** Also show the reel in the main grid/feed (default true). */
  shareToFeed?: boolean;
  /** Post as a trial reel, shown to non-followers first. MANUAL = the owner graduates it in the
   * Instagram app; SS_PERFORMANCE = Instagram graduates it if it performs well. Unset = a normal reel. */
  trial?: "MANUAL" | "SS_PERFORMANCE";
  /** Story day folder in v2-story (sources.md + script.md), e.g. "day-26". Used by the comment bot. */
  storyDay?: string;
  /** Local file facts captured by --sync (bytes, sha256 prefix) so drift is visible. */
  videoBytes?: number;
  videoSha256?: string;
  /** A draft reel never publishes. */
  draft?: boolean;
  /** Posted by the owner by hand: the bot never publishes it (the comment bot still covers it). */
  manual?: boolean;
  /** Free note shown in the dry run. */
  note?: string;
  /** Cloud mode: signed URLs to the PRIVATE bucket, written by `npm run reels:upload` on the laptop. */
  media?: ReelMedia;
}

/**
 * The YouTube Short for one reel. Kept in its own file, reels/<slug>/youtube.json, because
 * `npm run reels:sync` rewrites reel.json from scratch. Written by `npm run yt:sync`, edited by hand.
 */
export interface ReelYoutube {
  /** At most 100 characters, no "<" or ">". */
  title: string;
  /** At most 5,000 bytes (UTF-8), no "<" or ">". Starts with one line, the site link, and a short call to action. */
  description: string;
  /** API tags, at most 500 characters together. The hidden idempotency tag re-<slug> is added by the code. */
  tags: string[];
  /** The slot (UTC ISO). With YT_PUBLIC=on the video is uploaded private with publishAt = this, and YouTube publishes it. */
  publishAt: string;
  /** Human-readable slot. Informational only. */
  publishAtCairo?: string;
  /** "27" = Education. */
  categoryId: string;
  /** Language of the title and description ("ar" or "en"). */
  defaultLanguage: string;
  /** Language spoken in the video. */
  defaultAudioLanguage: string;
  madeForKids: boolean;
  /**
   * YouTube "altered or synthetic content" disclosure (status.containsSyntheticMedia). Required only for
   * realistic altered or synthetic content. The owner decides: null (the default) refuses the upload.
   */
  containsSyntheticMedia: boolean | null;
  /** Owner OK that the music cannot draw a copyright claim (needed for a Short over 60 s). */
  musicCleared?: boolean;
  notifySubscribers?: boolean;
  /** Case number shown in the reel ("02"), parsed from the video file name. */
  caseNumber?: string;
  /** Owner OK on this title and description. Nothing uploads while this is false. */
  approved: boolean;
  approvedBy?: string;
  /** Never upload this reel to YouTube (an already scheduled upload is unscheduled). */
  skip?: boolean;
  /** Video facts recorded by yt:sync from the local file (Shorts must be vertical and at most 3 minutes). */
  durationSec?: number;
  width?: number;
  height?: number;
  note?: string;
}

export interface ReelMedia {
  bucket: string;
  videoPath: string;
  coverPath?: string;
  videoUrl: string;
  coverUrl?: string;
  videoBytes: number;
  uploadedAt: string;
  /** When the signed URLs stop working (UTC ISO). */
  expiresAt: string;
}
