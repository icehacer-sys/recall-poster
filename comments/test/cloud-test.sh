#!/usr/bin/env bash
# Offline test of the cloud live path (faked Instagram, no model calls, nothing leaves the machine).
# Proves: one reply per thread even when the state file is lost, the fresh Instagram thread check
# before posting, daily caps recounted from Instagram, redacted public logs, and the encrypted state.
set -euo pipefail
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
export MOCK_DB="$TMP/db.json" BOT_STATE_FILE="$TMP/state.json" BOT_REVIEW_FILE="$TMP/review.json" BOT_SPEND_FILE="$TMP/spend.json"
export BOT_CLOUD_STATE="$TMP/cloud-state.enc" BOT_CLAUDE_ENV_FILE="$TMP/none.env"
export IG_ACCESS_TOKEN=fake-test-token CLAUDE_API_KEY=fake-test-claude-key BOT_CONFIRM_LIVE=yes BOT_ACTIVE_WINDOWS=0-24 BOT_PUBLIC_LOG=yes
CAP="$(node -e 'console.log(require("./data/reels.json").reels.find(r=>r.slug==="03-anaphylaxis").captionStart)')"
NOW="$(node -e 'console.log(new Date().toISOString())')"
db() { node -e 'const [f,cap,now,stale,...ids]=process.argv.slice(1);const mk=(id,u,t,rep)=>({id,username:u,text:t,timestamp:now,replies:rep?[{id:"old"+id,username:"recallengine",text:"done",timestamp:now}]:[]});
const all={t1:mk("t1","student_one","how much is the app?",true),t2:mk("t2","student_two","where can I practise more cases like this?",false),t3:mk("t3","student_three","how much is the app?",true)};
require("fs").writeFileSync(f,JSON.stringify({caption:cap+"\nrest",stale:stale==="1",comments:ids.map(i=>all[i])}));' "$MOCK_DB" "$CAP" "$NOW" "$@"; }
run() { npx tsx --import ./test/mock-ig.mjs src/index.ts --live > "$TMP/$1.txt" 2>&1 || { cat "$TMP/$1.txt"; exit 1; }; }
posts() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.MOCK_DB,"utf8")).posts??0)'; }
fails=0; check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got $2, want $3)"; fails=$((fails+1)); fi; }

db 0 t1 t2; run a
check "fresh state: replies only to the unanswered thread" "$(posts)" 1
rm -f "$BOT_STATE_FILE"; run b
check "lost state: no second reply" "$(posts)" 1
db 1 t3; rm -f "$BOT_STATE_FILE"; run c
check "stale comment list: the fresh thread check blocks the reply" "$(posts)" 0
grep -q "already has our reply on Instagram" "$TMP/c.txt" && echo "ok   thread check logged" || { echo "FAIL thread check not logged"; fails=$((fails+1)); }
db 0 t1 t2; rm -f "$BOT_STATE_FILE"; BOT_DAILY_CAP=1 run d
check "lost state: daily cap recounted from Instagram" "$(posts)" 0
if grep -E -q "student_|how much is the app|practise more cases|7 days" "$TMP"/[abcd].txt; then echo "FAIL public log shows usernames or texts"; fails=$((fails+1)); else echo "ok   public log hides usernames, comments, and replies"; fi
echo '[{"at":"2026-10-24T17:00:00Z","reel":"x","mediaId":"M1","commentId":"c","username":"secret_user","text":"private text","category":"urgent","reason":"r"}]' > "$BOT_REVIEW_FILE"
npx tsx src/cloud-state.ts pack > /dev/null
if grep -q -E "secret_user|private text|handledCommentIds" "$BOT_CLOUD_STATE"; then echo "FAIL state file is not encrypted"; fails=$((fails+1)); else echo "ok   packed state is encrypted"; fi
rm -f "$BOT_REVIEW_FILE" "$BOT_STATE_FILE"; npx tsx src/cloud-state.ts unpack > /dev/null
grep -q secret_user "$BOT_REVIEW_FILE" && echo "ok   unpack restores the owner list" || { echo "FAIL unpack"; fails=$((fails+1)); }
CLAUDE_API_KEY=another-key npx tsx src/cloud-state.ts unpack | grep -q "starting fresh" && echo "ok   a wrong key starts fresh instead of crashing" || { echo "FAIL wrong key"; fails=$((fails+1)); }
rm -rf "$TMP"
[ "$fails" = 0 ] && echo "cloud-test passed" || { echo "$fails cloud check(s) FAILED"; exit 1; }
