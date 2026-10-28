#!/usr/bin/env node
// One-time YouTube sign-in for the cloud bots. The OWNER runs this on his laptop:
//
//   node scripts/youtube-auth.mjs --client "C:\Users\HP\Downloads\client_secret_XXXX.json"
//
// It opens Google's consent page in the browser (Desktop app client, loopback redirect on
// 127.0.0.1, PKCE, one scope: youtube.force-ssl, which covers uploads and comment replies). After he
// approves with the Recall Engine channel, it receives the code on the loopback address, exchanges it,
// checks the token belongs to @recallengineapp, and writes YT_CLIENT_ID, YT_CLIENT_SECRET, and
// YT_REFRESH_TOKEN straight into GitHub with `gh secret set` (through stdin), plus the public
// YT_CHANNEL_ID repository variable. The refresh token is never printed, logged, or written to disk
// (unless --env is given: then it also goes into this folder's gitignored .env for local runs).
//
// Options: --repo owner/name (default icehacer-sys/recall-poster), --handle @recallengineapp,
// --force (accept a different channel), --env (also write .env), --no-browser (print the link only).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const REPO = opt("--repo", "icehacer-sys/recall-poster");
const HANDLE = opt("--handle", "@recallengineapp").toLowerCase();
const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
// Fixed hosts: the client secret and tokens only ever go to Google (no env override).
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com";
// Tests swap gh for a fake: YT_GH_CMD='["node","test/fake-gh.mjs"]'.
const GH = process.env.YT_GH_CMD ? JSON.parse(process.env.YT_GH_CMD) : ["gh"];

function fail(msg) {
  console.error(`\nSTOPPED: ${msg}`);
  process.exit(1);
}

function clientCreds() {
  const file = opt("--client");
  if (file) {
    if (!existsSync(file)) fail(`${file} not found. Download the JSON of the Desktop OAuth client from Google Cloud Console > APIs & Services > Credentials.`);
    const j = JSON.parse(readFileSync(file, "utf8"));
    const c = j.installed ?? j.web;
    if (!j.installed) fail('that JSON is not a "Desktop app" client. Create an OAuth client of type Desktop app.');
    return { id: c.client_id, secret: c.client_secret };
  }
  const id = process.env.YT_CLIENT_ID?.trim();
  const secret = process.env.YT_CLIENT_SECRET?.trim();
  if (!id || !secret) fail("pass --client <client_secret_....json> (the Desktop OAuth client you downloaded).");
  return { id, secret };
}

function gh(argv, input) {
  const r = spawnSync(GH[0], [...GH.slice(1), ...argv], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (r.status !== 0) fail(`gh ${argv.slice(0, 3).join(" ")} failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
}

function openBrowser(url) {
  if (args.includes("--no-browser") || process.env.YT_AUTH_NO_BROWSER) return;
  const cmd = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the link is printed too */
  }
}

/**
 * Listen on 127.0.0.1 (random port) for Google to send the browser back with ?code=...&state=...
 * Resolves { port, code } where code is a promise of the authorization code.
 */
async function loopback(expectedState) {
  let settle;
  const code = new Promise((resolve, reject) => (settle = { resolve, reject }));
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const got = u.searchParams.get("code");
    const error = u.searchParams.get("error");
    if (!got && !error) {
      res.writeHead(404).end();
      return;
    }
    const ok = !!got && u.searchParams.get("state") === expectedState;
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ok ? "<h1>Recall Engine: signed in.</h1><p>You can close this tab and go back to the terminal.</p>" : "<h1>Sign-in failed.</h1><p>Go back to the terminal.</p>");
    server.close();
    if (error) settle.reject(new Error(`Google returned "${error}"`));
    else if (!ok) settle.reject(new Error("the state value did not match (a stale or forged redirect)"));
    else settle.resolve(got);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.YT_AUTH_PORT ?? 0), "127.0.0.1", resolve);
  });
  return { port: server.address().port, code };
}

async function main() {
  const { id, secret } = clientCreds();
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const { port, code: codePromise } = await loopback(state);
  const redirect = `http://127.0.0.1:${port}`;
  const consent = new URL(AUTH_URL);
  for (const [k, v] of Object.entries({
    client_id: id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })) consent.searchParams.set(k, v);

  console.log("Opening Google's consent page. Sign in with the account that owns the Recall Engine channel,");
  console.log('pick the "Recall Engine" channel, and allow access. If no browser opens, paste this link:\n');
  console.log(consent.toString());
  console.log("\nWaiting for Google to send you back (5 minutes) ...");
  openBrowser(consent.toString());

  const timer = setTimeout(() => fail("no answer from the browser within 5 minutes."), 5 * 60_000);
  const code = await codePromise.catch((e) => fail(e.message));
  clearTimeout(timer);

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" }).toString(),
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tok.access_token) fail(`the code exchange failed (${tokenRes.status} ${tok.error ?? ""}).`);
  if (!tok.refresh_token) fail("Google sent no refresh token. Remove the app's access at myaccount.google.com/permissions and run this again.");
  if (tok.scope && !String(tok.scope).split(" ").includes(SCOPE)) fail("the YouTube permission was not granted. Run again and tick the YouTube box.");

  const chRes = await fetch(`${API}/youtube/v3/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const ch = await chRes.json().catch(() => ({}));
  const channel = ch.items?.[0];
  if (!chRes.ok || !channel) fail("this Google account has no YouTube channel, or the channel was not picked. Run again and choose the Recall Engine channel.");
  const handle = String(channel.snippet?.customUrl ?? "").toLowerCase();
  console.log(`\nSigned in as channel "${channel.snippet?.title}" ${channel.snippet?.customUrl ?? "(no handle yet)"} (id ${channel.id}).`);
  if (handle !== HANDLE && !args.includes("--force")) fail(`expected ${HANDLE}. Run again and pick the right channel (or add --force if the handle is still being set up).`);

  gh(["secret", "set", "YT_CLIENT_ID", "--repo", REPO], id);
  gh(["secret", "set", "YT_CLIENT_SECRET", "--repo", REPO], secret);
  gh(["secret", "set", "YT_REFRESH_TOKEN", "--repo", REPO], tok.refresh_token);
  gh(["variable", "set", "YT_CHANNEL_ID", "--repo", REPO, "--body", channel.id]);
  console.log(`Set the secrets YT_CLIENT_ID, YT_CLIENT_SECRET, and YT_REFRESH_TOKEN and the variable YT_CHANNEL_ID in ${REPO}.`);

  if (args.includes("--env")) {
    const envFile = join(ROOT, ".env");
    const keep = existsSync(envFile) ? readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l && !/^(YT_CLIENT_ID|YT_CLIENT_SECRET|YT_REFRESH_TOKEN|YT_CHANNEL_ID)=/.test(l)) : [];
    writeFileSync(envFile, [...keep, `YT_CLIENT_ID=${id}`, `YT_CLIENT_SECRET=${secret}`, `YT_REFRESH_TOKEN=${tok.refresh_token}`, `YT_CHANNEL_ID=${channel.id}`].join("\n") + "\n");
    console.log(`Also wrote them to ${envFile} (gitignored) for local runs.`);
  }
  console.log("\nNothing is uploaded or posted until you run: gh variable set YT_BOTS --body on --repo " + REPO);
}

main().catch((e) => fail(e.message));
