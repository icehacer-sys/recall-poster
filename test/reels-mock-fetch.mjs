// Offline fake of the Instagram Graph API + public hosting for `npm run reels:test`.
// Every request is answered locally; anything unexpected throws, so the test can never
// reach Instagram or the internet.
const calls = [];
let container = 0;
globalThis.__reelCalls = calls;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? "GET";
  calls.push(`${method} ${u.replace(/^https:\/\/[^/]+/, "")}`);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  // Fake Supabase Storage: uploads, deletes, and public HEADs for staged files.
  if (u.startsWith("https://sb.test/storage/v1/object/")) {
    const path = u.slice("https://sb.test/storage/v1/object/".length);
    if (method === "POST" && path.startsWith("ig-reel-staging/")) {
      globalThis.__staged = new Set([...(globalThis.__staged ?? []), decodeURIComponent(path.slice("ig-reel-staging/".length))]);
      return json({ Key: path });
    }
    if (method === "DELETE" && path === "ig-reel-staging") {
      const { prefixes } = JSON.parse(init.body);
      for (const p of prefixes) globalThis.__staged?.delete(p);
      return json(prefixes.map((name) => ({ name })));
    }
    if (method === "HEAD" && path.startsWith("public/ig-reel-staging/")) {
      const key = decodeURIComponent(path.slice("public/ig-reel-staging/".length));
      if (!globalThis.__staged?.has(key)) return new Response(null, { status: 400 });
      const size = key.endsWith(".mp4") ? process.env.MOCK_VIDEO_BYTES : "1000";
      return new Response(null, { status: 200, headers: { "content-length": size, "content-type": key.endsWith(".mp4") ? "video/mp4" : "image/jpeg" } });
    }
  }
  if (u.startsWith("https://stage.test/")) {
    const size = u.endsWith(".mp4") ? process.env.MOCK_VIDEO_BYTES : "1000";
    return new Response(null, { status: 200, headers: { "content-length": size, "content-type": u.endsWith(".mp4") ? "video/mp4" : "image/jpeg" } });
  }
  if (u.startsWith("https://graph.instagram.com/")) {
    if (u.includes("content_publishing_limit")) return json({ data: [{ quota_usage: 1 }] });
    if (u.endsWith("/me/media") && method === "POST") {
      const body = new URLSearchParams(init.body);
      if (body.get("media_type") !== "REELS" || !body.get("video_url")) return json({ error: { message: "bad params" } }, 400);
      return json({ id: `C${++container}` });
    }
    if (u.includes("fields=status_code")) return json({ status_code: "FINISHED" });
    if (u.endsWith("/me/media_publish")) {
      if (process.env.MOCK_PUBLISH_FAIL) return json({ error: { message: "mock publish failure" } }, 500);
      return json({ id: "M-PUBLISHED-1" });
    }
  }
  throw new Error(`mock: unexpected request ${method} ${u}`);
};
process.on("exit", () => console.log("MOCK CALLS:\n  " + calls.join("\n  ")));
