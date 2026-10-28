// Offline test of the YouTube uploader and the owner's sign-in helper (npm run yt:test).
// Google, YouTube, Supabase, and gh are all faked (test/yt-mock-fetch.mjs, test/fake-gh.mjs): nothing
// can leave the machine. Runs in a temp folder with temp copies of one approved reel.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "yt-test-"));
const MOCK = pathToFileURL(join(ROOT, "test", "yt-mock-fetch.mjs")).href;
const UPLOAD = join(ROOT, "src", "youtube", "upload.ts");
const REELS = join(TMP, "reels");
const STATE = join(REELS, "youtube-state.json");
const DB = join(TMP, "db.json");
const BYTES = 1000;
const SHA = createHash("sha256").update(Buffer.alloc(BYTES)).digest("hex").slice(0, 16);

const env = {
  ...process.env,
  REELS_DIR: REELS,
  YT_STATE_FILE: STATE,
  REELS_SOURCE_DIR: join(TMP, "no-source"),
  MOCK_YT_DB: DB,
  MOCK_VIDEO_BYTES: String(BYTES),
  YT_CLIENT_ID: "fake-client-id",
  YT_CLIENT_SECRET: "fake-client-secret",
  YT_REFRESH_TOKEN: "fake-refresh-token",
  YT_CHANNEL_ID: "UC_TEST",
  YT_CONFIRM_LIVE: "",
  YT_PUBLIC: "",
  YT_CROSSPOST: "",
  YT_THUMBNAIL: "",
  YT_UNIT_BUDGET: "",
  YT_UPLOAD_BUDGET: "20",
  YT_MAX_PER_DAY: "10",
  MOCK_CHANNEL_ID: "",
  MOCK_LOCK_PRIVATE: "",
  MOCK_CORRUPT: "",
};

function run(args, extra = {}) {
  const e = { ...env, ...extra };
  for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
  const r = spawnSync(process.execPath, ["--import", "tsx", "--import", MOCK, UPLOAD, ...args], { cwd: ROOT, env: e, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const db = () => (existsSync(DB) ? JSON.parse(readFileSync(DB, "utf8")) : {});
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const ytJson = (slug) => JSON.parse(readFileSync(join(REELS, slug, "youtube.json"), "utf8"));
const setYt = (slug, patch) => writeFileSync(join(REELS, slug, "youtube.json"), JSON.stringify({ ...ytJson(slug), ...patch }, null, 2));
const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
// The owner's two decisions per reel: the synthetic-content label and music cleared for a Short over 60 s.
const DECIDED = { containsSyntheticMedia: false, musicCleared: true };

const source = JSON.parse(readFileSync(join(ROOT, "reels", "02-hypoglycaemia", "reel.json"), "utf8"));
function makeReel(slug, caseNo, extra = {}) {
  const r = { ...source, slug, sourceFolder: slug, video: `reel-case-${caseNo}-day-26.mp4`, videoBytes: BYTES, videoSha256: SHA, draft: false, postAt: inHours(-48) };
  delete r.manual;
  delete r.trial;
  r.media = { ...source.media, videoPath: `${slug}/x.mp4`, videoUrl: `https://sb.test/storage/v1/object/sign/ig-reel-media/${slug}/x.mp4?token=t`, coverUrl: undefined, videoBytes: BYTES, expiresAt: inHours(48) };
  Object.assign(r, extra);
  mkdirSync(join(REELS, slug), { recursive: true });
  writeFileSync(join(REELS, slug, "reel.json"), JSON.stringify(r, null, 2));
}

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n${detail.split("\n").slice(-25).join("\n")}`}`);
  if (!ok) failed++;
}

// ---- sync and dry run (no secrets, no network)
makeReel("a-case", "02");
let r = run(["--sync"]);
const a = ytJson("a-case");
const lines = a.description.split("\n");
check("yt:sync writes youtube.json with approved false", r.code === 0 && a.approved === false, r.out);
check("title: approved hook line plus the case number, at most 100 characters", a.title === "نوبات هلع؟ ولا hypoglycaemia متنكرة؟ | حالة 02" && [...a.title].length <= 100, a.title);
check("description: one line, the site link, then a short call to action", lines[1] === "https://www.recallengine.app" && lines[0].startsWith("نوبات هلع") && /Recall Engine/.test(lines[2]), a.description);
check("description: #Shorts and the caption hashtags, no Instagram link line", /#Shorts #medstudent/.test(a.description) && /#RecallEngine/.test(a.description) && !/اللينك في صفحتنا/.test(a.description), a.description);
check("Education category, not for kids, synthetic-content label left for the owner (null)", a.categoryId === "27" && a.madeForKids === false && a.containsSyntheticMedia === null);

r = run(["--dry-run"], { YT_CLIENT_ID: "", YT_CLIENT_SECRET: "", YT_REFRESH_TOKEN: "" });
check("dry run prints the exact insert request with no secrets and no network", r.code === 0 && r.out.includes("POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=true") && r.out.includes('"privacyStatus": "private"') && r.out.includes('"re-a-case"') && r.out.includes("MOCK CALLS: none"), r.out);
check("dry run: no publish time while YT_PUBLIC is off", !r.out.includes('"publishAt"'), r.out);

// ---- gates
r = run(["--live"], { YT_CONFIRM_LIVE: "yes" });
check("unapproved entry: live run uploads nothing and calls nothing", r.code === 0 && /nothing due/.test(r.out) && r.out.includes("MOCK CALLS: none"), r.out);
setYt("a-case", { approved: true, publishAt: inHours(2), durationSec: 91.8, width: 1080, height: 1920, containsSyntheticMedia: false });
r = run(["--live"], { YT_CONFIRM_LIVE: "yes" });
check("a Short over 60 s without musicCleared is refused before any upload", r.code !== 0 && /musicCleared/.test(r.out) && !db().inserts, r.out);
setYt("a-case", DECIDED);
r = run(["--live"]);
check("latch: YT_CONFIRM_LIVE unset refuses and calls nothing", r.code !== 0 && r.out.includes("MOCK CALLS: none"), r.out);

// ---- upload once
r = run(["--live"], { YT_CONFIRM_LIVE: "yes" });
let s = state()["yt:a-case"] ?? {};
check("live: uploads exactly once, private, no publish time", r.code === 0 && db().inserts === 1 && s.videoId === "VID1" && s.privacyStatusSent === "private" && !s.publishAtSent && db().lastInsert?.status?.privacyStatus === "private", r.out);
check("live: hidden idempotency tag and the Shorts metadata were sent", db().lastInsert?.snippet?.tags?.includes("re-a-case") && db().lastInsert?.snippet?.categoryId === "27" && db().lastInsert?.status?.selfDeclaredMadeForKids === false && db().lastInsert?.status?.containsSyntheticMedia === false);
check("live: the session PUT carries the Bearer token", db().lastPutAuth === "Bearer fake-access-token", db().lastPutAuth);
r = run(["--live"], { YT_CONFIRM_LIVE: "yes" });
check("second run uploads nothing", db().inserts === 1 && /nothing due/.test(r.out), r.out);
rmSync(STATE);
r = run(["--live"], { YT_CONFIRM_LIVE: "yes" });
check("lost state: the video on the channel is recorded, not uploaded again", db().inserts === 1 && /already on the channel as VID1/.test(r.out) && state()["yt:a-case"]?.recordedFrom === "found", r.out);

// ---- YT_PUBLIC=on: private with publishAt = the slot; a locked project is detected
makeReel("b-case", "03");
run(["--sync"]);
const slotB = inHours(3);
setYt("b-case", { approved: true, publishAt: slotB, ...DECIDED });
r = run(["--live"], { YT_CONFIRM_LIVE: "yes", YT_PUBLIC: "on" });
s = state()["yt:b-case"] ?? {};
check("YT_PUBLIC=on: uploaded private with publishAt = the slot", db().inserts === 2 && db().lastInsert?.status?.publishAt === slotB && db().lastInsert?.status?.privacyStatus === "private" && s.publishAtSent === slotB, r.out);
makeReel("c-case", "04");
run(["--sync"]);
setYt("c-case", { approved: true, publishAt: inHours(4), ...DECIDED });
r = run(["--live"], { YT_CONFIRM_LIVE: "yes", YT_PUBLIC: "on", MOCK_LOCK_PRIVATE: "1" });
check("a project still locked to private is detected and the job fails", r.code !== 0 && state()["yt:c-case"]?.lockedPrivate === true && /still locked/.test(r.out), r.out);

// ---- refusals
makeReel("d-case", "05", { media: { ...source.media, videoUrl: "https://sb.test/storage/v1/object/sign/ig-reel-media/d/x.mp4?token=t", videoBytes: BYTES, expiresAt: inHours(-1) } });
run(["--sync"]);
setYt("d-case", { approved: true, publishAt: inHours(1), ...DECIDED });
r = run(["--live", "--only", "d-case"], { YT_CONFIRM_LIVE: "yes" });
check("expired signed URL: refused and the job fails", r.code !== 0 && /expired/.test(r.out) && db().inserts === 3, r.out);
makeReel("e-case", "06");
run(["--sync"]);
setYt("e-case", { approved: true, publishAt: inHours(1), ...DECIDED });
r = run(["--live", "--only", "e-case"], { YT_CONFIRM_LIVE: "yes", MOCK_CORRUPT: "1" });
check("sha256 mismatch: refused, nothing uploaded", r.code !== 0 && /sha256/.test(r.out) && db().inserts === 3, r.out);
r = run(["--live", "--only", "e-case"], { YT_CONFIRM_LIVE: "yes", MOCK_CHANNEL_ID: "UC_OTHER" });
check("token for another channel: refused, nothing uploaded", r.code !== 0 && /not YT_CHANNEL_ID/.test(r.out) && db().inserts === 3, r.out);
r = run(["--live", "--only", "e-case"], { YT_CONFIRM_LIVE: "yes", YT_UNIT_BUDGET: "1" });
check("quota budget reached: refused before any call", r.code !== 0 && /quota/.test(r.out) && db().inserts === 3, r.out);
r = run(["--live", "--only", "e-case"], { YT_CONFIRM_LIVE: "yes", YT_MAX_PER_DAY: "1" });
check("daily cap: waits for tomorrow", /daily cap/.test(r.out) && db().inserts === 3, r.out);
setYt("e-case", { containsSyntheticMedia: null });
r = run(["--live", "--only", "e-case"], { YT_CONFIRM_LIVE: "yes" });
check("undecided synthetic-media disclosure: refused", r.code !== 0 && /containsSyntheticMedia/.test(r.out) && db().inserts === 3, r.out);
makeReel("f-case", "07", { trial: "MANUAL" });
run(["--sync", "--all"]);
r = run(["--dry-run", "--only", "f-case"], { YT_CLIENT_ID: "" });
check("Instagram trial reels never get a YouTube entry", !existsSync(join(REELS, "f-case", "youtube.json")) && /No YouTube entries/.test(r.out), r.out);

// ---- a reel pulled back after upload: its scheduled publish is cancelled
setYt("b-case", { skip: true });
r = run(["--live"], { YT_CONFIRM_LIVE: "yes", YT_PUBLIC: "on" });
const vb = db().videos.find((v) => v.id === state()["yt:b-case"].videoId);
check("skip after upload: scheduled publish cancelled, video stays private", /CANCELLED/.test(r.out) && db().updates === 1 && vb?.status?.privacyStatus === "private" && !vb?.status?.publishAt && !!state()["yt:b-case"].unscheduledAt, r.out);

// ---- the bot never makes a video public by itself: a slot too close stays private for the owner
makeReel("h-case", "09");
run(["--sync"]);
setYt("h-case", { approved: true, publishAt: inHours(0.05), ...DECIDED });
r = run(["--live", "--only", "h-case"], { YT_CONFIRM_LIVE: "yes", YT_PUBLIC: "on" });
check("YT_PUBLIC=on, slot 3 minutes ahead: uploaded PRIVATE with no publish time, owner note, job flagged", r.code !== 0 && db().lastInsert?.status?.privacyStatus === "private" && !db().lastInsert?.status?.publishAt && /owner note/.test(r.out) && db().inserts === 4, r.out);

// ---- an upload session that left no video id is never retried by the bot
makeReel("i-case", "10");
run(["--sync"]);
setYt("i-case", { approved: true, publishAt: inHours(2), ...DECIDED });
r = run(["--live", "--only", "i-case"], { YT_CONFIRM_LIVE: "yes", MOCK_START_FAIL: "1" });
check("rejected start (4xx): no video, nothing recorded", r.code !== 0 && !state()["yt:i-case"]?.sessionOpenedAt && db().inserts === 4, r.out);
r = run(["--live", "--only", "i-case"], { YT_CONFIRM_LIVE: "yes", MOCK_PUT_FAIL: "1" });
check("failed after the session opened: sessionOpenedAt recorded, no video id", r.code !== 0 && !!state()["yt:i-case"]?.sessionOpenedAt && !state()["yt:i-case"]?.videoId, r.out);
r = run(["--live", "--only", "i-case"], { YT_CONFIRM_LIVE: "yes" });
check("next run (under 2 h): checks the channel, does not upload again", r.code === 0 && /checked again next run/i.test(r.out) && db().inserts === 4, r.out);
const st = state();
st["yt:i-case"].sessionOpenedAt = inHours(-3);
writeFileSync(STATE, JSON.stringify(st));
r = run(["--live", "--only", "i-case"], { YT_CONFIRM_LIVE: "yes" });
check("after 2 h with no copy listed: owner note, job fails, still no second upload", r.code !== 0 && /Check YouTube Studio/.test(r.out) && db().inserts === 4, r.out);

// ---- Phase 0 test upload: unapproved and outside the window, private, no subscriber notification
makeReel("j-case", "11");
run(["--sync"]);
setYt("j-case", { publishAt: inHours(24 * 5), ...DECIDED });
r = run(["--live", "--only", "j-case"], { YT_CONFIRM_LIVE: "yes" });
check("a normal live run does not upload an unapproved reel 5 days out", /nothing due/.test(r.out) && db().inserts === 4, r.out);
r = run(["--live", "--test-upload", "j-case"], { YT_CONFIRM_LIVE: "yes", YT_PUBLIC: "on" });
check("--test-upload: uploaded PRIVATE now, no publish time, notifySubscribers=false, recorded as a test", r.code === 0 && db().inserts === 5 && db().lastInsert?.status?.privacyStatus === "private" && !db().lastInsert?.status?.publishAt && db().lastNotify === "false" && state()["yt:j-case"]?.testUpload === true, r.out);
r = run(["--live", "--test-upload", "j-case"], { YT_CONFIRM_LIVE: "yes" });
check("--test-upload twice: nothing uploaded again", /already on YouTube/.test(r.out) && db().inserts === 5, r.out);
r = run(["--live", "--test-upload", "j-case"]);
check("--test-upload without YT_CONFIRM_LIVE: refused", r.code !== 0 && db().inserts === 5, r.out);

// ---- cross-post flag: an approved Instagram reel without youtube.json is listed, never uploaded
makeReel("g-case", "08");
writeFileSync(join(REELS, "state.json"), JSON.stringify({ "reel:g-case": { postedAt: inHours(-30) } }));
r = run(["--dry-run", "--only", "g-case"], { YT_CROSSPOST: "on", YT_CLIENT_ID: "" });
check("YT_CROSSPOST=on: an Instagram reel without youtube.json is listed with generated text, held unapproved", /\(cross-post\)/.test(r.out) && /حالة 08/.test(r.out) && /generated by YT_CROSSPOST/.test(r.out) && r.out.includes("MOCK CALLS: none"), r.out);
r = run(["--live", "--only", "g-case"], { YT_CROSSPOST: "on", YT_CONFIRM_LIVE: "yes" });
check("YT_CROSSPOST=on: a live run never uploads generated text", /nothing due/.test(r.out) && db().inserts === 5, r.out);
r = run(["--dry-run", "--only", "g-case"], { YT_CLIENT_ID: "" });
check("YT_CROSSPOST off: no entry for it", /No YouTube entries/.test(r.out), r.out);

// ---- the YouTube cut (youtube.json "video"): uploaded instead of the Instagram media (owner, 28 Oct 2026)
makeReel("v-case", "09");
const before = db().inserts ?? 0;
const ytUrl = (slug) => `https://sb.test/storage/v1/object/sign/ig-reel-media/youtube/${slug}/cut.mp4?token=t`;
const cutMedia = (slug, extra = {}) => ({ bucket: "ig-reel-media", videoPath: `youtube/${slug}/cut.mp4`, videoUrl: ytUrl(slug), videoBytes: BYTES, uploadedAt: inHours(-1), expiresAt: inHours(48), ...extra });
writeFileSync(join(REELS, "v-case", "youtube.json"), JSON.stringify({ ...ytJson("a-case"), ...DECIDED, approved: true, publishAt: inHours(2), durationSec: 91.8, width: 1080, height: 1920, video: { file: "reel-case-09-yt.mp4", folder: "09", bytes: BYTES, sha256: SHA } }, null, 2));
r = run(["--live", "--only", "v-case"], { YT_CONFIRM_LIVE: "yes" });
check('"video" without a signed URL: refused, nothing fetched or uploaded', r.code !== 0 && /no signed URL yet: run npm run yt:media -- v-case/.test(r.out) && (db().inserts ?? 0) === before && !/object\/sign/.test(r.out.split("MOCK CALLS:")[1] ?? ""), r.out);
setYt("v-case", { video: { ...ytJson("v-case").video, sha256: "deadbeefdeadbeef", media: cutMedia("v-case") } });
r = run(["--live", "--only", "v-case"], { YT_CONFIRM_LIVE: "yes" });
check('"video" whose bytes do not match its sha256: refused before any upload', r.code !== 0 && /does not match youtube\.json/.test(r.out) && (db().inserts ?? 0) === before, r.out);
setYt("v-case", { video: { ...ytJson("v-case").video, sha256: SHA, media: cutMedia("v-case") } });
r = run(["--dry-run", "--only", "v-case"], { YT_CLIENT_ID: "" });
check("dry run names the YouTube cut as the file it sends", /media: YouTube cut reel-case-09-yt\.mp4/.test(r.out) && /with YouTube cut reel-case-09-yt\.mp4/.test(r.out), r.out);
r = run(["--live", "--only", "v-case"], { YT_CONFIRM_LIVE: "yes" });
const fetched = (r.out.split("MOCK CALLS:")[1] ?? "");
check('"video": the YouTube cut is downloaded and uploaded, never the Instagram media', r.code === 0 && db().inserts === before + 1 && fetched.includes("/ig-reel-media/youtube/v-case/cut.mp4") && !fetched.includes("/ig-reel-media/v-case/x.mp4"), r.out);
// yt:media refuses a file that is not the approved render, before any network call.
const srcDir = join(TMP, "yt-src");
mkdirSync(join(srcDir, "09"), { recursive: true });
writeFileSync(join(srcDir, "09", "reel-case-09-yt.mp4"), Buffer.alloc(BYTES + 1));
r = run(["--media", "v-case"], { YT_SOURCE_DIR: srcDir });
check("yt:media refuses a file whose size differs from youtube.json, with no network call", r.code !== 0 && /is 1001 bytes but youtube\.json says 1000/.test(r.out) && r.out.includes("MOCK CALLS: none"), r.out);
writeFileSync(join(srcDir, "09", "reel-case-09-yt.mp4"), Buffer.alloc(BYTES, 1));
r = run(["--media", "v-case"], { YT_SOURCE_DIR: srcDir });
check("yt:media refuses a file whose sha256 differs from youtube.json, with no network call", r.code !== 0 && /sha256 of reel-case-09-yt\.mp4 does not match/.test(r.out) && r.out.includes("MOCK CALLS: none"), r.out);

// ---- the owner's sign-in helper: token straight into gh, never printed
const ghLog = join(TMP, "gh.log");
const clientJson = join(TMP, "client.json");
writeFileSync(clientJson, JSON.stringify({ installed: { client_id: "fake-client-id.apps.googleusercontent.com", client_secret: "fake-client-secret-value" } }));
const auth = spawn(process.execPath, ["--import", MOCK, join(ROOT, "scripts", "youtube-auth.mjs"), "--client", clientJson, "--no-browser"], {
  cwd: ROOT,
  env: { ...env, MOCK_YT_DB: join(TMP, "auth-db.json"), YT_GH_CMD: JSON.stringify([process.execPath, join(ROOT, "test", "fake-gh.mjs")]), FAKE_GH_LOG: ghLog },
});
let authOut = "";
const consent = await new Promise((resolve) => {
  auth.stdout.on("data", (d) => {
    authOut += d;
    const m = authOut.match(/https:\/\/accounts\.google\.com\/\S+/);
    if (m) resolve(new URL(m[0]));
  });
  auth.stderr.on("data", (d) => (authOut += d));
  auth.on("exit", () => resolve(null));
});
if (consent) {
  const back = await fetch(`${consent.searchParams.get("redirect_uri")}/?code=fake-code&state=${consent.searchParams.get("state")}`);
  check("sign-in helper: loopback page answers", back.ok);
}
const code = await new Promise((resolve) => (auth.exitCode != null ? resolve(auth.exitCode) : auth.on("exit", resolve)));
const gh = existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const secret = (n) => gh.find((c) => c.args[0] === "secret" && c.args[2] === n);
check("sign-in helper: consent link asks only for youtube.force-ssl with PKCE and offline access", !!consent && consent.searchParams.get("scope") === "https://www.googleapis.com/auth/youtube.force-ssl" && consent.searchParams.get("code_challenge_method") === "S256" && consent.searchParams.get("access_type") === "offline" && consent.searchParams.get("redirect_uri")?.startsWith("http://127.0.0.1:"), authOut);
check("sign-in helper: refresh token, client id, and secret go to gh through stdin", code === 0 && secret("YT_REFRESH_TOKEN")?.stdin === "fake-refresh-from-consent" && secret("YT_CLIENT_SECRET")?.stdin === "fake-client-secret-value" && !!secret("YT_CLIENT_ID"), authOut);
check("sign-in helper: channel id set as a repository variable", gh.some((c) => c.args[0] === "variable" && c.args.includes("YT_CHANNEL_ID") && c.args.includes("UC_TEST")));
check("sign-in helper: never prints the refresh token or the client secret", !authOut.includes("fake-refresh-from-consent") && !authOut.includes("fake-client-secret-value"), authOut);

rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\nyt:test: ${failed} check(s) FAILED` : "\nyt:test passed");
process.exit(failed ? 1 : 0);
