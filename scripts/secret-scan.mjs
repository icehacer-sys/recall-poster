// Secret scan over tracked files (CI and before every push): API keys, tokens, and Supabase keys must
// never reach this PUBLIC repo. Signed Storage URLs in reels/*/reel.json and reels/*/youtube.json are allowed: their JWT is
// object-scoped and has no "role" claim. Any JWT with a role claim (anon or service_role key) fails.
// Usage: node scripts/secret-scan.mjs [file ...]   (default: git ls-files)
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

const PATTERNS = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /sk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ["Supabase secret key", /sb_secret_[A-Za-z0-9_-]{10,}/],
  ["Supabase access token", /sbp_[A-Za-z0-9]{20,}/],
  ["Instagram token", /IGAA[A-Za-z0-9_-]{30,}/],
  ["Facebook token", /EAA[A-Za-z0-9]{40,}/],
  ["GitHub token", /(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Google OAuth client secret", /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ["Google refresh token", /\b1\/\/0[A-Za-z0-9_-]{30,}/],
  ["Google access token", /\bya29\.[A-Za-z0-9_-]{30,}/],
  ["filled secret variable", /^[ 	]*(IG_ACCESS_TOKEN|CLAUDE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|IG_CLIENT_SECRET|YT_CLIENT_SECRET|YT_REFRESH_TOKEN)[ 	]*=[ 	]*["']?[A-Za-z0-9_\-./]{12,}/m],
];
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;

let bad = 0;
for (const f of files) {
  if (f === "package-lock.json" || f.endsWith("/package-lock.json")) continue;
  let text;
  try {
    if (statSync(f).size > 5_000_000) continue;
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const [name, re] of PATTERNS) {
    if (re.test(text)) {
      console.log(`FAIL ${f}: looks like a ${name}`);
      bad++;
    }
  }
  for (const m of text.matchAll(JWT)) {
    let payload = {};
    try {
      payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    } catch {
      /* not a JWT payload */
    }
    const signedUrl = /reels\/[^/]+\/(reel|youtube)\.json$/.test(f) && payload.url && !payload.role;
    if (!signedUrl) {
      console.log(`FAIL ${f}: contains a JWT${payload.role ? ` with role "${payload.role}"` : ""} (only signed Storage URLs in reels/*/reel.json and reels/*/youtube.json are allowed)`);
      bad++;
    }
  }
}
console.log(bad ? `\nsecret scan: ${bad} problem(s)` : `secret scan: ${files.length} files clean`);
process.exit(bad ? 1 : 0);
