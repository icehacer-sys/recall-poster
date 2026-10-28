// Offline fake of Google OAuth and the YouTube Data API for test/yt-cloud-test.mjs. State lives in
// $MOCK_DB (JSON) so replies posted in one run are visible to the next. Anything else throws: no network.
import { readFileSync, writeFileSync } from "node:fs";

const DB = process.env.MOCK_DB;
const CHANNEL = process.env.MOCK_CHANNEL_ID || "UC_TEST";
const load = () => JSON.parse(readFileSync(DB, "utf8"));
const save = (d) => writeFileSync(DB, JSON.stringify(d));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const comment = (c) => ({ id: c.id, snippet: { textDisplay: c.text, authorDisplayName: c.author, authorChannelId: { value: c.authorChannelId }, publishedAt: c.publishedAt } });

globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input));
  const method = init.method ?? "GET";
  if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
    const p = new URLSearchParams(String(init.body));
    return p.get("refresh_token") === "fake-refresh-token" ? json({ access_token: "fake-access-token" }) : json({ error: "invalid_grant" }, 400);
  }
  if (u.hostname !== "www.googleapis.com") throw new Error(`mock: unexpected request ${method} ${u.hostname}`);
  if ((init.headers ?? {}).Authorization !== "Bearer fake-access-token") return json({ error: { message: "no auth" } }, 401);
  const db = load();
  const path = u.pathname;
  if (path === "/youtube/v3/channels") return json({ items: [{ id: CHANNEL, snippet: { title: "Recall Engine", customUrl: "@recallengineapp" } }] });
  if (path === "/youtube/v3/commentThreads" && method === "GET") {
    if (u.searchParams.get("allThreadsRelatedToChannelId") !== CHANNEL) return json({ error: { message: "wrong channel" } }, 400);
    const status = u.searchParams.get("moderationStatus") ?? "published";
    const list = status === "published" ? db.threads : status === "heldForReview" ? db.held ?? [] : [];
    const items = list.map((t) => ({
      id: t.id,
      snippet: { videoId: t.videoId, canReply: t.canReply !== false, totalReplyCount: t.replies.length, topLevelComment: comment(t) },
      replies: { comments: db.stale ? [] : t.replies.map(comment) },
    }));
    return json({ items });
  }
  if (path === "/youtube/v3/comments" && method === "GET") {
    const t = db.threads.find((x) => x.id === u.searchParams.get("parentId"));
    if (!t) return json({ error: { message: "no such comment" } }, 404);
    return json({ items: t.replies.map(comment) });
  }
  if (path === "/youtube/v3/comments" && method === "POST") {
    const { snippet } = JSON.parse(String(init.body));
    const t = db.threads.find((x) => x.id === snippet.parentId);
    if (!t) return json({ error: { message: "no such comment" } }, 404);
    t.replies.push({ id: `R${Date.now()}${Math.random()}`, text: snippet.textOriginal, author: "Recall Engine", authorChannelId: CHANNEL, publishedAt: new Date().toISOString() });
    db.posts = (db.posts ?? 0) + 1;
    db.lastText = snippet.textOriginal;
    save(db);
    console.log(`MOCK POST reply to ${t.id}`);
    return json({ id: "R-new" });
  }
  throw new Error(`mock: unexpected request ${method} ${path}`);
};
