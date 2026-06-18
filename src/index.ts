// Orchestrator + CLI for the daily carousel poster.
//
// Modes:
//   --sample [slug]  Generate slides for one post (default: the next one) to disk + print the
//                    caption. Posts nothing. For local design QA. Ignores the draft gate.
//   --render         Generate slides for every post due within BOT_RENDER_LOOKAHEAD_H. Posts
//                    nothing. The runner commits + pushes these, so the image URLs are public
//                    BEFORE --live fetches them.
//   --dry-run        Like --render, but also prints each caption. Posts nothing. (default)
//   --live           Publish every due post (postAt <= now) whose slides are already rendered
//                    AND committed. Never generates inline (freshly generated slides are not
//                    public yet). Requires BOT_CONFIRM_LIVE=yes and GITHUB_RAW_BASE.
//
// state.json guarantees a post is never published twice.

import { writeFileSync, existsSync } from "node:fs";
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

/** Drafts (generator-created, unreviewed) never render or post. Approve by setting draft:false. */
function isBlockedDraft(post: Post): boolean {
  return Boolean(post.draft);
}

/** True only when every slide image for the post actually exists on disk. */
function slidesPresent(post: Post): boolean {
  return (
    Boolean(post.slides?.length) &&
    post.slides!.every((f) => existsSync(join(config.postsDir, post.folder!, f)))
  );
}

/** Slides are usable for publishing only when generated AND present on disk (committable). */
function slidesReady(post: Post, state: State): boolean {
  return Boolean(state.get(post.slug).slidesGeneratedAt) && slidesPresent(post);
}

/** Generate + persist slide images for a post unless already ready on disk (or force). */
async function renderSlides(post: Post, state: State, force = false): Promise<string[]> {
  if (!force && slidesReady(post, state)) return post.slides!;

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

  // --- sample: one post, to disk, no posting (allowed on drafts) ---
  if (mode === "sample") {
    const post = slug
      ? posts.find((p) => p.slug === slug || p.folder === slug)
      : posts.find((p) => !state.get(p.slug).postedAt) ?? posts[0];
    if (!post) throw new Error(`sample: post not found${slug ? ` for "${slug}"` : ""}`);
    const files = await renderSlides(post, state, true);
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
      await renderSlides(post, state);
      touched++;
      if (mode === "dry-run") console.log(`\n[${post.folder}] caption:\n${buildCaption(post)}\n`);
    }
    console.log(`${mode}: ${touched} post(s) rendered, nothing posted.`);
    return;
  }

  // --- live: publish every due post whose slides are already rendered AND committed ---
  if (!config.confirmLive) throw new Error("Live posting requires BOT_CONFIRM_LIVE=yes.");
  if (!config.githubRawBase) {
    throw new Error("GITHUB_RAW_BASE must be set so Meta can fetch the slide images.");
  }
  let posted = 0;
  for (const post of posts) {
    if (isBlockedDraft(post)) continue;
    if (state.get(post.slug).postedAt) continue;
    if (new Date(post.postAt) > now) continue;

    // Never generate here: only already-committed slides have public URLs that resolve when
    // Meta fetches them. Render + push first; this run picks them up on the next pass.
    if (!slidesReady(post, state)) {
      console.log(`  ${post.folder}: slides not rendered+committed yet, skipping (run --render then push).`);
      continue;
    }
    const urls = post.slides!.map((f) => imageUrl(post.folder!, f));
    const caption = buildCaption(post);
    console.log(`Publishing ${post.folder} (${post.slides!.length} slides) ...`);
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
