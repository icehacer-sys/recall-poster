// Offline test of the YouTube comment bot (npm run yt:cloud:test): faked Google and YouTube, no model
// calls (the comments are answered by approved templates or the rules), nothing leaves the machine.
// Proves: draft mode posts nothing and never drafts twice, one reply per thread even when the state is
// lost, the fresh thread check before posting, caps recounted from YouTube, no links in replies, the
// right-to-left wrap, redacted public logs, held comments for the owner, and the encrypted state.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "yt-comments-"));
const MOCK = pathToFileURL(join(ROOT, "test", "mock-yt.mjs")).href;
const DB = join(TMP, "db.json");
const now = new Date().toISOString();

// Templates with the YouTube app replies approved (the real file keeps them unapproved until the owner OKs them).
const templates = JSON.parse(readFileSync(join(ROOT, "data", "templates.json"), "utf8"));
templates.youtube_app_question.en.approved = true;
templates.youtube_app_question.ar.approved = true;
writeFileSync(join(TMP, "templates.json"), JSON.stringify(templates));
writeFileSync(join(TMP, "youtube-state.json"), JSON.stringify({ "yt:03-anaphylaxis": { videoId: "V1", recordedFrom: "uploaded" } }));

const env = {
  ...process.env,
  MOCK_DB: DB,
  MOCK_CHANNEL_ID: "",
  BOT_STATE_FILE: join(TMP, "yt-state.json"),
  BOT_REVIEW_FILE: join(TMP, "yt-review.json"),
  BOT_SPEND_FILE: join(TMP, "yt-spend.json"),
  BOT_QUOTA_FILE: join(TMP, "yt-quota.json"),
  BOT_CLOUD_STATE: join(TMP, "yt-cloud-state.enc"),
  BOT_TEMPLATES_FILE: join(TMP, "templates.json"),
  BOT_YT_STATE: join(TMP, "youtube-state.json"),
  BOT_CLAUDE_ENV_FILE: join(TMP, "none.env"),
  CLAUDE_API_KEY: "fake-test-claude-key",
  YT_CLIENT_ID: "fake-client-id",
  YT_CLIENT_SECRET: "fake-client-secret",
  YT_REFRESH_TOKEN: "fake-refresh-token",
  YT_CHANNEL_ID: "UC_TEST",
  BOT_CONFIRM_LIVE: "yes",
  BOT_ACTIVE_WINDOWS: "0-24",
  BOT_PUBLIC_LOG: "yes",
  BOT_WINDOW_HOURS: "168",
  BOT_DAILY_CAP: "",
  YT_RTL_WRAP: "",
};

const thread = (id, author, text, replied = false, extra = {}) => ({
  id,
  videoId: "V1",
  text,
  author,
  authorChannelId: `UC_${author}`,
  publishedAt: now,
  replies: replied ? [{ id: `old${id}`, text: "done", author: "Recall Engine", authorChannelId: "UC_TEST", publishedAt: now }] : [],
  ...extra,
});
const ALL = {
  t1: thread("t1", "student_one", "how much is the app?", true),
  t2: thread("t2", "student_two", "where can I practise more cases like this?"),
  t3: { ...thread("t3", "Recall Engine", "Pinned: write your answer below"), authorChannelId: "UC_TEST" },
  t4: thread("t4", "spammer", "check my channel www.example.com"),
  t5: thread("t5", "student_five", "how much is the app?", true),
  t6: thread("t6", "student_six", "where can I find this app?"),
  t7: thread("t7", "student_seven", "بكام الاشتراك؟"),
};
function db(ids, opts = {}) {
  writeFileSync(DB, JSON.stringify({ threads: ids.map((i) => structuredClone(ALL[i])), held: opts.held ?? [], stale: !!opts.stale }));
}
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
const posts = () => read(DB).posts ?? 0;
const outs = [];
function run(args, extra = {}, script = "src/yt-run.ts") {
  const r = spawnSync(process.execPath, ["--import", "tsx", "--import", MOCK, script, ...args], { cwd: ROOT, env: { ...env, ...extra }, encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  outs.push(out);
  return { code: r.status, out };
}
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n${detail.split("\n").slice(-20).join("\n")}`}`);
  if (!ok) failed++;
};

// ---- draft mode (the cloud default until YT_REPLIES=live)
db(["t1", "t2", "t3", "t4"], { held: [thread("h1", "held_user", "held text")] });
let r = run(["--draft"]);
const review = read(env.BOT_REVIEW_FILE) ?? [];
check("draft: nothing posted", r.code === 0 && posts() === 0, r.out);
check("draft: proposed reply saved for the owner", review.some((i) => i.commentId === "t2" && i.category === "proposed_reply"), JSON.stringify(review));
check("draft: spam and held comments listed for the owner, never answered", review.some((i) => i.commentId === "t4" && i.category === "spam") && review.some((i) => i.commentId === "h1" && i.category === "heldForReview"), JSON.stringify(review));
r = run(["--draft"]);
check("draft: a second run drafts nothing again", /Drafted 0 replies/.test(r.out) && (read(env.BOT_REVIEW_FILE) ?? []).length === review.length, r.out);

// ---- live
rmSync(env.BOT_STATE_FILE, { force: true });
db(["t1", "t2", "t3", "t4", "t7"]);
r = run(["--live"], { BOT_CONFIRM_LIVE: "" });
check("live refused without BOT_CONFIRM_LIVE", r.code !== 0 && posts() === 0, r.out);
r = run(["--live"]);
check("live: replies to the two unanswered app questions only (not answered, own, or spam threads)", r.code === 0 && posts() === 2, r.out);
const t2 = read(DB).threads.find((t) => t.id === "t2").replies.at(-1)?.text ?? "";
const t7 = read(DB).threads.find((t) => t.id === "t7").replies.at(-1)?.text ?? "";
check("live: no link in a YouTube reply, the channel page instead", !/https?:|www\.|\.app/.test(t2 + t7) && /channel page|صفحة القناة/.test(t2 + t7), `${t2} | ${t7}`);
check("live: Arabic reply wrapped right to left", t7.startsWith("‫") && t7.endsWith("‬"), JSON.stringify(t7));
rmSync(env.BOT_STATE_FILE);
r = run(["--live"]);
check("lost state: no second reply", posts() === 2, r.out);

writeFileSync(DB, JSON.stringify({ threads: [structuredClone(ALL.t5)], stale: true }));
rmSync(env.BOT_STATE_FILE);
r = run(["--live"]);
check("stale thread list: the fresh thread check blocks the reply", posts() === 0 && /already has our reply on YouTube/.test(r.out), r.out);

db(["t1", "t6"]);
rmSync(env.BOT_STATE_FILE);
r = run(["--live"], { BOT_DAILY_CAP: "1" });
check("lost state: daily cap recounted from YouTube", r.code === 0 && posts() === 0 && /retry later/.test(r.out), r.out);

r = run(["--live"], { MOCK_CHANNEL_ID: "UC_OTHER" });
check("token for another channel: refused, nothing read or posted", r.code !== 0 && /not YT_CHANNEL_ID/.test(r.out) && posts() === 0, r.out);

check("public log hides names, comments, and replies", !outs.some((o) => /student_|spammer|held_user|how much is the app|practise more cases|channel page|صفحة القناة|بكام/.test(o)), outs.join("\n"));

// ---- prompt identity and encrypted state
r = spawnSync(process.execPath, ["--import", "tsx", "-e", 'import("./src/voice.ts").then(m=>{const y=m.systemPrompt("youtube"),i=m.systemPrompt();console.log(JSON.stringify({yt:y.includes("Recall Engine\'s YouTube Shorts")&&!y.includes("Instagram case reels")&&y.includes("Never ask anyone to like, subscribe or comment"),ig:i===m.SYSTEM_PROMPT&&i.includes("@recallengine\'s Instagram case reels")}))})'], { cwd: ROOT, encoding: "utf8" });
const p = JSON.parse(r.stdout.trim().split("\n").at(-1) || "{}");
check("YouTube prompt: own identity line and no-subscribe rule, Instagram prompt unchanged", p.yt && p.ig, r.stdout + r.stderr);

r = run(["pack"], {}, "src/cloud-state.ts");
const enc = existsSync(env.BOT_CLOUD_STATE) ? readFileSync(env.BOT_CLOUD_STATE, "utf8") : "";
check("packed YouTube state is encrypted (and includes the quota ledger)", r.code === 0 && /quota/.test(r.out) && enc && !/student_|held_user|handledCommentIds/.test(enc), r.out);
rmSync(env.BOT_STATE_FILE, { force: true });
rmSync(env.BOT_QUOTA_FILE, { force: true });
r = run(["unpack"], {}, "src/cloud-state.ts");
check("unpack restores the state and the quota ledger", existsSync(env.BOT_STATE_FILE) && existsSync(env.BOT_QUOTA_FILE), r.out);

rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} YouTube comment check(s) FAILED` : "\nyt-cloud-test passed");
process.exit(failed ? 1 : 0);
