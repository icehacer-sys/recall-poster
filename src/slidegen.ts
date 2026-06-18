// Pure gpt-image-2 carousel slide generation (owner's choice over a rendered template).
// Each slide is a full image with its text baked in by the prompt. Image models can still
// garble text, so the prompts demand exact spelling and output is reviewed before live posts.
//
// Layout: slide 1 = hook, slides 2..n-1 = value points, slide n = CTA.

import sharp from "sharp";
import { generateSlideImage } from "./openai.js";
import { config } from "./config.js";
import type { Post } from "./types.js";

const EDGE = config.imageSize.split("x")[0];

const STYLE =
  `A ${EDGE}px square Instagram carousel slide for "Recall Engine", a premium medical exam-revision ` +
  `brand for medical students. Deep navy background (#0b1019) with a subtle darker vignette, one cyan ` +
  `accent (#2dd4ef) and a warm amber accent (#fbbf24) used sparingly. Clean modern white sans-serif ` +
  `typography, strong visual hierarchy, generous spacing, high contrast, minimal, trustworthy medical-tech ` +
  `look. A small "RECALL ENGINE" wordmark in the top-left corner. Render every piece of text crisply and ` +
  `CORRECTLY SPELLED, exactly as written, with no extra, missing, or misspelled words. No real patient ` +
  `photos, no fake app screenshots, no logos other than the wordmark, no watermark, no arrows drawn over text.`;

function hookPrompt(post: Post): string {
  return (
    `${STYLE} Eyebrow label near the top in cyan, letter-spaced: "${post.subject.toUpperCase()}". ` +
    `A large bold white headline, centered, two or three lines max: "${post.title}". ` +
    `A smaller muted-grey subline beneath it: "${post.hook}". ` +
    `A small cyan outlined pill at the bottom center reads "SWIPE".`
  );
}

function pointPrompt(post: Post, idx: number): string {
  const p = post.points[idx];
  const n = idx + 1;
  const total = post.points.length;
  return (
    `${STYLE} A small cyan counter in the top-right corner: "${n}/${total}". ` +
    `A bold cyan heading near the top-left: "${p.heading}". Below it, clean white body text in two to ` +
    `four short lines, easy to read: "${p.body}". Plenty of negative space. No swipe cue, no buttons.`
  );
}

function ctaPrompt(post: Post): string {
  return (
    `${STYLE} Centered composition, no counter. A bold white headline, one or two lines: "${post.cta}". ` +
    `A short amber divider line under the headline. Below it a cyan outlined pill button: ` +
    `"FOLLOW ${config.handle}". A small muted-grey line at the very bottom: "Save this post for revision".`
  );
}

/** Build the ordered prompt list for a post (hook, points..., CTA). Exported for review/tests. */
export function slidePrompts(post: Post): string[] {
  return [hookPrompt(post), ...post.points.map((_, i) => pointPrompt(post, i)), ctaPrompt(post)];
}

/** Generate all carousel slides for a post as processed square JPEG buffers, in order. */
export async function generateSlides(post: Post): Promise<Buffer[]> {
  const raw = await Promise.all(slidePrompts(post).map((p) => generateSlideImage(p)));
  return Promise.all(raw.map((buf) => toSquareJpeg(buf)));
}

/** Normalize a generated PNG to a config.slideSize square JPEG for smaller, IG-friendly files. */
function toSquareJpeg(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .resize(config.slideSize, config.slideSize, { fit: "cover", position: "centre" })
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer();
}
