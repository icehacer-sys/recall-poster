// One-time token helper for @recallengine, Instagram API with Instagram Login only
// (graph.instagram.com). No Facebook Page and no Facebook Login are involved.
//
//   npm run token:url          print the authorization URL to open (signed in as @recallengine)
//   npm run token -- <code>    exchange the ?code= for a long-lived (~60 day) token
//   npm run token:refresh      refresh the current token before it expires (any time after 24 h)
//
// The token is written straight into this folder's .env as IG_ACCESS_TOKEN and is never printed.
// Copy the same line into W:/Projects/recall-poster/.env so the reel publisher uses it too.
// Needs IG_CLIENT_ID, IG_CLIENT_SECRET, IG_REDIRECT_URI in .env (Meta app dashboard, Instagram
// product, "API setup with Instagram login").

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config";

// One token covers both bots: reading and replying to comments, and publishing reels.
const SCOPES = "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments";
const ENV_FILE = join(ROOT, ".env");

function need(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v.trim();
}

function saveToken(token: string, expiresIn?: number): void {
  const body = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const line = `IG_ACCESS_TOKEN=${token}`;
  const next = /^IG_ACCESS_TOKEN=.*$/m.test(body) ? body.replace(/^IG_ACCESS_TOKEN=.*$/m, line) : `${body.replace(/\s*$/, "\n")}${line}\n`;
  writeFileSync(ENV_FILE, next);
  const days = Math.round((expiresIn ?? 0) / 86400);
  const until = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString().slice(0, 10) : "unknown";
  console.log(`\nSaved IG_ACCESS_TOKEN to ${ENV_FILE} (valid about ${days} days, until ${until}). It was not printed.`);
  console.log("Copy that line into W:/Projects/recall-poster/.env too. Refresh with npm run token:refresh before it expires.\n");
}

const arg = process.argv[2];

if (arg === "--refresh") {
  const res = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(need("IG_ACCESS_TOKEN"))}`,
  );
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!res.ok || !json.access_token) {
    console.error("Refresh failed:", json.error?.message ?? res.status, "(an expired token cannot be refreshed: run npm run token:url again)");
    process.exit(1);
  }
  saveToken(json.access_token, json.expires_in);
} else if (!arg || arg === "--url") {
  const url =
    "https://www.instagram.com/oauth/authorize" +
    `?client_id=${encodeURIComponent(need("IG_CLIENT_ID"))}` +
    `&redirect_uri=${encodeURIComponent(need("IG_REDIRECT_URI"))}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    "&response_type=code";
  console.log("\n1) Open this URL signed in as @recallengine on Instagram and approve:\n");
  console.log(url);
  console.log("\n2) You land on the redirect URI with ?code=... in the address bar. Copy the code (drop a trailing #_), then run:\n   npm run token -- <code>\n");
} else {
  const code = arg.replace(/#_$/, "").trim();
  const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: need("IG_CLIENT_ID"),
      client_secret: need("IG_CLIENT_SECRET"),
      grant_type: "authorization_code",
      redirect_uri: need("IG_REDIRECT_URI"),
      code,
    }).toString(),
  });
  const shortJson = (await shortRes.json()) as { access_token?: string; error_message?: string };
  if (!shortRes.ok || !shortJson.access_token) {
    console.error("Short-token exchange failed:", shortJson.error_message ?? shortRes.status);
    process.exit(1);
  }
  // Meta's documented exchange takes the secret and short token as query parameters. This is a
  // one-time call from the owner's machine and the URL is never logged.
  const longRes = await fetch(
    "https://graph.instagram.com/access_token?grant_type=ig_exchange_token" +
      `&client_secret=${encodeURIComponent(need("IG_CLIENT_SECRET"))}` +
      `&access_token=${encodeURIComponent(shortJson.access_token)}`,
  );
  const longJson = (await longRes.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!longRes.ok || !longJson.access_token) {
    console.error("Long-token exchange failed:", longJson.error?.message ?? longRes.status);
    process.exit(1);
  }
  saveToken(longJson.access_token, longJson.expires_in);
}
