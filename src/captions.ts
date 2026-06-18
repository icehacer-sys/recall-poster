// Caption assembly. Deterministic: caption body + curated hashtags, capped at IG's limits.

import type { Post } from "./types.js";

const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;

/** Build the final IG caption: body + hashtag block, within IG limits. */
export function buildCaption(post: Post): string {
  const tags = post.hashtags
    .slice(0, MAX_HASHTAGS)
    .map((t) => `#${t.replace(/^#/, "").trim()}`)
    .filter((t) => t.length > 1)
    .join(" ");
  const body = post.caption.trim();
  const full = tags ? `${body}\n\n${tags}` : body;
  return full.length > MAX_CAPTION ? full.slice(0, MAX_CAPTION) : full;
}
