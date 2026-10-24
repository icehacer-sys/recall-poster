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
  /** Story day folder in v2-story (sources.md + script.md), e.g. "day-26". Used by the comment bot. */
  storyDay?: string;
  /** Local file facts captured by --sync (bytes, sha256 prefix) so drift is visible. */
  videoBytes?: number;
  videoSha256?: string;
  /** A draft reel never publishes. */
  draft?: boolean;
}
