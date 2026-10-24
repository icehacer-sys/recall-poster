// Offline fake of the Instagram Graph API for test/cloud-test.sh. State lives in $MOCK_DB (JSON) so
// replies posted in one run are visible to the next. Anything unexpected throws: no network.
import { readFileSync, writeFileSync } from "node:fs";
const DB = process.env.MOCK_DB;
const load = () => JSON.parse(readFileSync(DB, "utf8"));
const save = (d) => writeFileSync(DB, JSON.stringify(d));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? "GET";
  if (u.hostname !== "graph.instagram.com") throw new Error(`mock: unexpected request ${method} ${u.hostname}`);
  const path = u.pathname.replace(/^\/v[\d.]+/, "");
  const db = load();
  if (path === "/me") return json({ user_id: "1", username: "recallengine" });
  if (path === "/me/media") return json({ data: [{ id: "M1", caption: db.caption, media_type: "VIDEO", media_product_type: "REELS", permalink: "https://www.instagram.com/reel/ABC/", timestamp: new Date().toISOString() }] });
  if (path === "/M1/comments") {
    const data = db.comments.map((c) => ({ id: c.id, text: c.text, username: c.username, timestamp: c.timestamp, replies: { data: db.stale ? [] : c.replies } }));
    return json({ data });
  }
  const m = path.match(/^\/([^/]+)\/replies$/);
  if (m) {
    const c = db.comments.find((x) => x.id === m[1]);
    if (!c) return json({ error: { message: "no such comment" } }, 404);
    if (method === "POST") {
      const msg = new URLSearchParams(init.body).get("message");
      c.replies.push({ id: `R${Date.now()}${Math.random()}`, text: msg, username: "recallengine", timestamp: new Date().toISOString() });
      db.posts = (db.posts ?? 0) + 1;
      save(db);
      console.log(`MOCK POST reply to ${c.id}`);
      return json({ id: "R-new" });
    }
    return json({ data: c.replies });
  }
  throw new Error(`mock: unexpected request ${method} ${path}`);
};
