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
}
