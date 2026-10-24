#!/usr/bin/env bash
# Offline test of the reel live path with a faked Graph API and a faked Supabase Storage.
# Proves: stage (upload video + cover) -> HEAD -> container -> status -> media_publish ->
# delete staged files, the state record, that a second run never re-posts, and that the
# second latch refuses. Uses a temp state file and a temp copy of one reel due 10 minutes ago.
# Nothing here can reach Instagram, Supabase, or the internet (the mock throws on anything else).
set -euo pipefail
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
SLUG=03-anaphylaxis
mkdir -p "$TMP/reels/$SLUG"
node -e '
const fs=require("fs");const r=JSON.parse(fs.readFileSync("reels/'"$SLUG"'/reel.json","utf8"));
r.postAt=new Date(Date.now()-10*60e3).toISOString();delete r.manual;delete r.draft;
fs.writeFileSync(process.argv[1]+"/reels/'"$SLUG"'/reel.json",JSON.stringify(r));
process.stdout.write(String(r.videoBytes));' "$TMP" > "$TMP/bytes"
export MOCK_VIDEO_BYTES="$(cat "$TMP/bytes")"
export REELS_DIR="$TMP/reels" BOT_STATE_FILE="$TMP/state.json" REELS_STATE_FILE="$TMP/state.json"
export REELS_HOSTING=supabase SUPABASE_URL="https://sb.test" SUPABASE_SECRET_KEY="fake-test-key"
export IG_ACCESS_TOKEN="fake-test-token" BOT_CONFIRM_LIVE=yes REELS_CONFIRM_LIVE=yes
echo "--- run 1 (stage, publish once, delete staged files)"
npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live | tee "$TMP/run1.txt"
echo "--- run 2 (must NOT publish again)"
npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live | tee "$TMP/run2.txt"
echo "--- latch check (REELS_CONFIRM_LIVE unset must refuse)"
if REELS_CONFIRM_LIVE= npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live > /dev/null 2>&1; then echo "FAIL: latch did not refuse"; exit 1; fi
node -e '
const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.argv[1]+"/state.json","utf8"))["reel:'"$SLUG"'"];
const r1=fs.readFileSync(process.argv[1]+"/run1.txt","utf8"), r2=fs.readFileSync(process.argv[1]+"/run2.txt","utf8");
const checks=[
 ["uploaded video and cover", (r1.match(/POST \/storage\/v1\/object\/ig-reel-staging\//g)||[]).length===2],
 ["published exactly once", (r1.match(/POST \/v21\.0\/me\/media_publish/g)||[]).length===1],
 ["deleted staged files", /DELETE \/storage\/v1\/object\/ig-reel-staging/.test(r1)],
 ["state has postedAt, media id, and cleanedAt", !!(s.postedAt && s.igMediaId && s.cleanedAt)],
 ["run 2 posted nothing", /0 reel\(s\) published/.test(r2) && !/media_publish/.test(r2)],
 ["latch refused", true],
];
let bad=0;for(const [n,ok] of checks){console.log((ok?"ok   ":"FAIL ")+n);if(!ok)bad++;}
process.exit(bad?1:0);' "$TMP"
echo "--- failure path: publish fails, files stay for the retry window, then are deleted"
rm -f "$TMP/state.json"
MOCK_PUBLISH_FAIL=1 npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live > "$TMP/fail1.txt" 2>&1 || true
node -e '
const fs=require("fs");const f=process.argv[1]+"/reels/'"$SLUG"'/reel.json";const r=JSON.parse(fs.readFileSync(f,"utf8"));
r.postAt=new Date(Date.now()-4*3600e3).toISOString();fs.writeFileSync(f,JSON.stringify(r));' "$TMP"
npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live > "$TMP/fail2.txt" 2>&1
node -e '
const fs=require("fs");const d=process.argv[1];const s=JSON.parse(fs.readFileSync(d+"/state.json","utf8"))["reel:'"$SLUG"'"];
const f1=fs.readFileSync(d+"/fail1.txt","utf8"), f2=fs.readFileSync(d+"/fail2.txt","utf8");
const checks=[
 ["failed publish keeps the files (no delete)", /FAILED to publish/.test(f1) && !/DELETE/.test(f1) && !s.postedAt],
 ["after the window the files are deleted and nothing posts", /DELETE \/storage\/v1\/object\/ig-reel-staging/.test(f2) && !/media_publish/.test(f2) && !!s.cleanedAt],
];
let bad=0;for(const [n,ok] of checks){console.log((ok?"ok   ":"FAIL ")+n);if(!ok)bad++;}
process.exit(bad?1:0);' "$TMP"
echo "--- cloud mode: signed URLs, no Supabase key, lost-state guard, expiry"
rm -f "$TMP/state.json"
node -e '
const fs=require("fs");const f=process.argv[1]+"/reels/'"$SLUG"'/reel.json";const r=JSON.parse(fs.readFileSync(f,"utf8"));
r.postAt=new Date(Date.now()-10*60e3).toISOString();
r.media={bucket:"ig-reel-media",videoPath:"x.mp4",coverPath:"c.jpg",videoUrl:"https://sb.test/storage/v1/object/sign/ig-reel-media/'"$SLUG"'/x.mp4?token=t",coverUrl:"https://sb.test/storage/v1/object/sign/ig-reel-media/'"$SLUG"'/c.jpg?token=t",videoBytes:r.videoBytes,uploadedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400e3).toISOString()};
fs.writeFileSync(f,JSON.stringify(r));' "$TMP"
CLOUD="env -u SUPABASE_URL -u SUPABASE_SECRET_KEY REELS_SUPABASE_ENV_FILE=$TMP/none.env REELS_HOSTING=signed"
$CLOUD npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live > "$TMP/c1.txt" 2>&1 || { cat "$TMP/c1.txt"; exit 1; }
$CLOUD npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live > "$TMP/c2.txt" 2>&1 || true
rm -f "$TMP/state.json"
CAPTION="$(node -e 'process.stdout.write(JSON.stringify([{id:"LIVE-1",caption:require(process.argv[1]+"/reels/'"$SLUG"'/reel.json").caption,timestamp:new Date().toISOString()}]))' "$TMP")"
MOCK_IG_MEDIA="$CAPTION" $CLOUD npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live > "$TMP/c3.txt" 2>&1 || true
rm -f "$TMP/state.json"
node -e '
const fs=require("fs");const f=process.argv[1]+"/reels/'"$SLUG"'/reel.json";const r=JSON.parse(fs.readFileSync(f,"utf8"));
r.media.expiresAt=new Date(Date.now()-60e3).toISOString();fs.writeFileSync(f,JSON.stringify(r));' "$TMP"
if $CLOUD npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live > "$TMP/c4.txt" 2>&1; then EXP=0; else EXP=1; fi
node -e '
const fs=require("fs");const d=process.argv[1];const rd=(n)=>fs.readFileSync(d+"/"+n,"utf8");

const c1=rd("c1.txt"),c2=rd("c2.txt"),c3=rd("c3.txt"),c4=rd("c4.txt");
const checks=[
 ["signed: published exactly once with no Supabase key", (c1.match(/POST \/v21\.0\/me\/media_publish/g)||[]).length===1 && !/storage\/v1\/object\/ig-reel/.test(c1)],
 ["signed: container used the signed video_url", /HEAD \/storage\/v1\/object\/sign\/ig-reel-media/.test(c1)],
 ["signed: second run posted nothing", !/media_publish/.test(c2)],
 ["lost state + reel already on Instagram: recorded, not reposted", /already live on Instagram as LIVE-1/.test(c3) && !/media_publish/.test(c3) && !/POST \/v21\.0\/me\/media$/m.test(c3)],
 ["expired signed URL: refused and the job fails", /expired/.test(c4) && !/media_publish/.test(c4) && process.argv[2]==="1"],
];
let bad=0;for(const [n,ok] of checks){console.log((ok?"ok   ":"FAIL ")+n);if(!ok)bad++;}
process.exit(bad?1:0);' "$TMP" "$EXP"
rm -rf "$TMP"
echo "reels:test passed"
