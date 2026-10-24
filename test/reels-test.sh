#!/usr/bin/env bash
# Offline test of the reel live path with a faked Graph API: proves the publish flow
# (container -> status -> media_publish), the state record, and that a second run never
# re-posts. Uses a temp state file and a temp copy of one reel set due 10 minutes ago.
set -euo pipefail
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
mkdir -p "$TMP/reels/02-hypoglycaemia"
node -e '
const fs=require("fs");const r=JSON.parse(fs.readFileSync("reels/02-hypoglycaemia/reel.json","utf8"));
r.postAt=new Date(Date.now()-10*60e3).toISOString();fs.writeFileSync(process.argv[1]+"/reels/02-hypoglycaemia/reel.json",JSON.stringify(r));
process.stdout.write(String(r.videoBytes));' "$TMP" > "$TMP/bytes"
export MOCK_VIDEO_BYTES="$(cat "$TMP/bytes")"
export REELS_DIR="$TMP/reels" BOT_STATE_FILE="$TMP/state.json" REELS_PUBLIC_BASE="https://stage.test/reels"
export IG_ACCESS_TOKEN="fake-test-token" BOT_CONFIRM_LIVE=yes REELS_CONFIRM_LIVE=yes
echo "--- run 1 (should publish once)"
npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live
echo "--- run 2 (must NOT publish again)"
npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live
echo "--- state"; cat "$TMP/state.json"
echo "--- latch check (REELS_CONFIRM_LIVE unset must refuse)"
REELS_CONFIRM_LIVE= npx tsx --import ./test/reels-mock-fetch.mjs src/reels.ts --live && { echo "FAIL: latch did not refuse"; exit 1; } || echo "refused as expected"
rm -rf "$TMP"
