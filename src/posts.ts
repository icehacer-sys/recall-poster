// Queue loader/saver. Each post lives at posts/<slug>/post.json; generated slide
// images sit alongside it and are served via the public GITHUB_RAW_BASE.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { Post } from "./types.js";

/** Read every posts/<slug>/post.json, set .folder/.number, sorted by postAt ascending. */
export function loadPosts(): Post[] {
  if (!existsSync(config.postsDir)) return [];
  const posts: Post[] = [];
  for (const d of readdirSync(config.postsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = join(config.postsDir, d.name, "post.json");
    if (!existsSync(file)) continue;
    const post = JSON.parse(readFileSync(file, "utf8")) as Post;
    post.folder = d.name;
    if (post.slug == null) post.slug = d.name;
    if (post.number == null) {
      const m = d.name.match(/^(\d+)/);
      post.number = m ? Number(m[1]) : 0;
    }
    posts.push(post);
  }
  posts.sort((a, b) => a.postAt.localeCompare(b.postAt));
  return posts;
}

/** Public URL Meta fetches for a slide image. */
export function imageUrl(folder: string, file: string): string {
  return `${config.githubRawBase}/posts/${folder}/${file}`;
}

/** Persist a post back to posts/<folder>/post.json (without the transient .folder field). */
export function savePost(post: Post): void {
  if (!post.folder) throw new Error("savePost: post has no folder");
  const { folder, ...rest } = post;
  writeFileSync(join(config.postsDir, folder, "post.json"), JSON.stringify(rest, null, 2) + "\n");
}
