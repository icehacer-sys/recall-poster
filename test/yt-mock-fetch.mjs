// Offline fake of Google OAuth, the YouTube Data API, and the signed Supabase URL for test/yt-test.mjs.
// State lives in $MOCK_YT_DB (JSON) so one run's uploads are visible to the next. Anything else throws:
// no test can reach Google, Supabase, or the internet.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DB = process.env.MOCK_YT_DB;
const load = () => (DB && existsSync(DB) ? JSON.parse(readFileSync(DB, "utf8")) : {});
const save = (d) => DB && writeFileSync(DB, JSON.stringify(d, null, 2));
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
const calls = [];
globalThis.__ytCalls = calls;

function video(v, lockPrivate) {
  const status = { ...v.status };
  if (lockPrivate) delete status.publishAt;
  return { id: v.id, snippet: v.snippet, status };
}

async function bodyBytes(init) {
  const b = init.body;
  if (!b) return new Uint8Array();
  if (b instanceof Uint8Array) return b;
  if (typeof b === "string") return new TextEncoder().encode(b);
  return new Uint8Array(await new Response(b).arrayBuffer());
}

globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input));
  const method = init.method ?? "GET";
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  calls.push(`${method} ${u.hostname}${u.pathname}`);
  const db = load();
  db.videos ??= [];

  if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token" && method === "POST") {
    const p = new URLSearchParams(String(init.body));
    if (p.get("grant_type") === "refresh_token") {
      if (p.get("refresh_token") !== "fake-refresh-token") return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "fake-access-token", expires_in: 3599, token_type: "Bearer" });
    }
    if (p.get("grant_type") === "authorization_code") {
      if (p.get("code") !== "fake-code" || !p.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "fake-access-token", refresh_token: "fake-refresh-from-consent", scope: "https://www.googleapis.com/auth/youtube.force-ssl", token_type: "Bearer" });
    }
  }

  if (u.hostname === "www.googleapis.com") {
    if (headers.authorization !== "Bearer fake-access-token" && !u.searchParams.get("upload_id")) return json({ error: { code: 401, message: "no auth", errors: [{ reason: "authError" }] } }, 401);
    const path = u.pathname;
    if (path === "/youtube/v3/channels" && method === "GET") {
      return json({ items: [{ id: process.env.MOCK_CHANNEL_ID || "UC_TEST", snippet: { title: "Recall Engine", customUrl: "@recallengineapp" }, contentDetails: { relatedPlaylists: { uploads: "UU_TEST" } } }] });
    }
    if (path === "/youtube/v3/playlistItems" && method === "GET") {
      const items = [...db.videos].reverse().slice(0, 50).map((v) => ({ contentDetails: { videoId: v.id } }));
      return json({ items });
    }
    if (path === "/youtube/v3/videos" && method === "GET") {
      const ids = (u.searchParams.get("id") ?? "").split(",");
      return json({ items: db.videos.filter((v) => ids.includes(v.id)).map((v) => video(v, process.env.MOCK_LOCK_PRIVATE)) });
    }
    if (path === "/youtube/v3/videos" && method === "PUT") {
      const b = JSON.parse(String(init.body));
      const v = db.videos.find((x) => x.id === b.id);
      if (!v) return json({ error: { code: 404, message: "video not found", errors: [{ reason: "videoNotFound" }] } }, 404);
      v.status = b.status;
      db.updates = (db.updates ?? 0) + 1;
      save(db);
      return json(video(v));
    }
    if (path === "/upload/youtube/v3/videos" && method === "POST" && u.searchParams.get("uploadType") === "resumable") {
      const meta = JSON.parse(String(init.body));
      if (!meta.status?.privacyStatus) return json({ error: { code: 400, message: "privacyStatus missing (test guard)" } }, 400);
      if (process.env.MOCK_START_FAIL) return json({ error: { code: 403, message: "mock start refused", errors: [{ reason: "forbidden" }] } }, 403);
      db.lastNotify = u.searchParams.get("notifySubscribers");
      const len = Number(headers["x-upload-content-length"]);
      const id = `S${(db.sessions?.length ?? 0) + 1}`;
      db.sessions = [...(db.sessions ?? []), { id, meta, len }];
      save(db);
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}` } });
    }
    if (path === "/upload/youtube/v3/videos" && method === "PUT" && u.searchParams.get("upload_id")) {
      const s = (db.sessions ?? []).find((x) => x.id === u.searchParams.get("upload_id"));
      db.lastPutAuth = headers.authorization ?? "";
      save(db);
      if (process.env.MOCK_PUT_FAIL) return json({ error: { code: 400, message: "mock bytes refused" } }, 400);
      const bytes = await bodyBytes(init);
      if (!s || bytes.length !== s.len) return json({ error: { code: 400, message: `size ${bytes.length} vs ${s?.len}` } }, 400);
      const v = { id: `VID${db.videos.length + 1}`, snippet: { ...s.meta.snippet, publishedAt: new Date().toISOString() }, status: { ...s.meta.status, uploadStatus: "uploaded" } };
      db.videos.push(v);
      db.inserts = (db.inserts ?? 0) + 1;
      db.lastInsert = s.meta;
      save(db);
      console.log(`MOCK INSERT ${v.id} privacy=${v.status.privacyStatus} publishAt=${v.status.publishAt ?? "-"}`);
      return json(video(v));
    }
  }

  if (u.hostname === "sb.test" && u.pathname.startsWith("/storage/v1/object/sign/ig-reel-media/") && method === "GET") {
    const n = Number(process.env.MOCK_VIDEO_BYTES ?? 1000);
    const bytes = new Uint8Array(n);
    if (process.env.MOCK_CORRUPT) bytes[0] = 7;
    return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(n) } });
  }

  throw new Error(`mock: unexpected request ${method} ${u}`);
};

process.on("exit", () => console.log("MOCK CALLS:" + (calls.length ? "\n  " + calls.join("\n  ") : " none")));
