// Orchestrator + CLI for the daily carousel poster.
//
// Modes:
//   --sample [slug]  Generate slides for one post (default: the next one) to disk + print the
//                    caption. Posts nothing. For local design QA.
//   --render         Generate (and let the runner commit) slides for every post due within
//                    BOT_RENDER_LOOKAHEAD_H. Posts nothing. Run + push BEFORE --live so the
//                    slide URLs are public when Meta fetches them.
//   --dry-run        Like --render, but also prints each caption. Posts nothing. (default)
//   --live           Publish every due post (postAt <= now) not yet posted. Requires
//                    BOT_CONFIRM_LIVE=yes and GITHUB_RAW_BASE.
//
// State in state.json guarantees a post is never published twice.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { loadPosts, imageUrl, savePost } from "./posts.js";
import { State } from "./state.js";
import { generateSlides } from "./slidegen.js";
import { buildCaption } from "./captions.js";
import { publishCarousel } from "./instagram.js";
import type { Post } from "./types.js";

type Mode = "live" | "render" | "dry-run" | "sample";

function parseArgs(): { mode: Mode; slug?: string } {
  const a = process.argv.slice(2);
  if (a.includes("--live")) return { mode: "live" };
  if (a.includes("--render")) return { mode: "render" };
  if (a.includes("--sample")) {
    const i = a.indexOf("--sample");
    const next = a[i + 1];
    return { mode: "sample", slug: next && !next.startsWith("--") ? next : undefined };
  }
  return { mode: "dry-run" };
}

const slideFile = (n: number) => `slide${n}.jpg`;

/** True when a post should not be considered (an unapproved generator draft). */
function isBlockedDraft(post: Post): boolean {
  return Boolean(post.draft) && !config.autoApprove;
}

/** Generate + persist slide images for a post unless already done (or force). Returns filenames. */
async function ensureSlides(post: Post, state: State, force = false): Promise<string[]> {
  const done = state.get(post.slug).slidesGeneratedAt;
  if (!force && done && post.slides && post.slides.length) return post.slides;

  const count = post.points.length + 2;
  console.log(`  generating ${count} slides for ${post.folder} ...`);
  const buffers = await generateSlides(post);
  const files: string[] = [];
  buffers.forEach((buf, i) => {
    const file = slideFile(i + 1);
    writeFileSync(join(config.postsDir, post.folder!, file), buf);
    files.push(file);
  });
  post.slides = files;
  savePost(post);
  state.set(post.slug, { slidesGeneratedAt: new Date().toISOString() });
  return files;
}

async function main(): Promise<void> {
  const { mode, slug } = parseArgs();
  const now = new Date();
  const posts = loadPosts();
  const state = new State();

  if (posts.length === 0) {
    console.log("No posts found in", config.postsDir);
    return;
  }

  // --- sample: one post, to disk, no posting ---
  if (mode === "sample") {
    const post = slug
      ? posts.find((p) => p.slug === slug || p.folder === slug)
      : posts.find((p) => !state.get(p.slug).postedAt) ?? posts[0];
    if (!post) throw new Error(`sample: post not found${slug ? ` for "${slug}"` : ""}`);
    const files = await ensureSlides(post, state, true);
    console.log(`\nSample written to ${join(config.postsDir, post.folder!)}: ${files.join(", ")}`);
    console.log(`\n--- caption ---\n${buildCaption(post)}`);
    return;
  }

  // --- render / dry-run: pre-generate slides for due + upcoming posts ---
  if (mode === "render" || mode === "dry-run") {
    const lookahead = new Date(now.getTime() + config.renderLookaheadH * 3_600_000);
    let touched = 0;
    for (const post of posts) {
      if (isBlockedDraft(post)) continue;
      if (state.get(post.slug).postedAt) continue;
      if (new Date(post.postAt) > lookahead) continue;
      await ensureSlides(post, state);
      touched++;
      if (mode === "dry-run") console.log(`\n[${post.folder}] caption:\n${buildCaption(post)}\n`);
    }
    console.log(`${mode}: ${touched} post(s) rendered, nothing posted.`);
    return;
  }

  // --- live: publish every due post ---
  if (!config.confirmLive) throw new Error("Live posting requires BOT_CONFIRM_LIVE=yes.");
  if (!config.githubRawBase) {
    throw new Error("GITHUB_RAW_BASE must be set so Meta can fetch the slide images.");
  }
  let posted = 0;
  for (const post of posts) {
    if (isBlockedDraft(post)) continue;
    if (state.get(post.slug).postedAt) continue;
    if (new Date(post.postAt) > now) continue;

    const files = await ensureSlides(post, state);
    const urls = files.map((f) => imageUrl(post.folder!, f));
    const caption = buildCaption(post);
    console.log(`Publishing ${post.folder} (${files.length} slides) ...`);
    try {
      const id = await publishCarousel(urls, caption);
      state.set(post.slug, { postedAt: new Date().toISOString(), igMediaId: id });
      console.log(`  published as ${id}`);
      posted++;
    } catch (e) {
      console.error(`  FAILED to publish ${post.folder}: ${(e as Error).message}`);
    }
  }
  console.log(`live: ${posted} post(s) published.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
