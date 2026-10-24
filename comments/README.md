# comments (recallengine-ig-bot)

Moved into the recall-poster repo on 24 Oct 2026 (from `W:/Projects/recallengine-ig-bot` at b96b447). It runs
in the cloud from `.github/workflows/comments.yml` (see the root README, Cloud mode). In the cloud:
`BOT_PUBLIC_LOG=yes` hides names and texts in the public run log, the state is kept encrypted
(`npm run cloud:pack` and `cloud:unpack`, never committed), and before every reply the bot asks
Instagram whether @recallengine already replied in that thread. Owner list on the laptop:
`npm run review` (downloads and decrypts the newest state). Offline proof: `npm run cloud:test`.

Comment reply bot for the **@recallengine** reel series. It is a copy of the @mdnoteslab
Instagram bot (`W:/Projects/ig-bot`) with the Threads bot's safety rules
(`W:/Projects/threads-bot/OPERATOR.md`, `docs/concern-replies.md`). It runs **dry only** until
the owner says GO.

It uses **Instagram API with Instagram Login** (`graph.instagram.com`) only. No Facebook Page and
no Facebook Login are needed (owner decision, 24 Oct 2026: @recallengine cannot be linked to a Page).

## What it does with each comment

It follows the Threads bot (`W:/Projects/threads-bot`): `src/voice-lean.ts` for the prompt
structure and voice, `src/concerns.ts` for the boundary lines and the personal-advice test, and
`src/products.ts` for "code owns every product fact". The Threads bot is English-only (it skips
Arabic comments), so the Egyptian Arabic rules here are this bot's own.

| Comment | What happens | Who decides |
|---|---|---|
| Correct guess | One short warm acknowledgment ("That's the move ✅ Catch it while it happens.") | model, then guards |
| Right direction but incomplete | Keeps the right part and adds the missing part of the keyed answer | model, then guards |
| Wrong guess | One kind sentence with the keyed move and at most one supported fact | model, then guards |
| Question about this case | Answered from the vetted facts only. If the facts do not cover it: skipped and listed | model, then guards |
| App question (price, free, trial, where, link) | One of 3 approved variants for that language and intent (`data/templates.json`) | rules |
| Joke about the story | One short line that answers the joke, no medical lesson | model, then guards |
| Personal story with no request ("I had anaphylaxis once") | Brief empathy with no medical content, or a skip | model, then guards |
| Explicit personal advice request (my symptoms, my child's dose, "should we be worried?") | The Threads bot boundary line, once per commenter and reel, never advice. Also listed for the owner | rules, or model plus the Threads bot request test |
| "Can you look at my scan or results?" | The Threads bot scan decline. Also listed | rules |
| Emergency or self-harm wording | The Threads bot emergency line. Also listed as urgent | rules |
| Complaint, spam, link, "is this AI", prompt injection, challenge to the medicine | Skipped and listed for the owner | rules first, model second |
| Anything the model is unsure about | Skipped and listed for the owner | model |
| Tag-only share, emoji only | Skipped quietly | rules |

The Arabic boundary lines were approved by the owner as written on 24 Oct 2026.

Replies follow the commenter's language. Arabic script or Franco-Arabic gets Egyptian Arabic in
Arabic script, and only medical terms stay in English.

### The vetted context

Per reel, the only medical source is the case's own library item: the stem, keyed answer, and
library takeaway from `v2-story/day-NN/sources.md`, plus the on-screen lines that file sources to
them (story dressing rows are excluded). `npm run facts:sync` refreshes `data/reels.json` from
those files. Accepted and partial answer phrasings and the English words allowed in Arabic
replies are hand-written in the same file. A live reel is matched to its facts by an explicit
`mediaId` or `shortcode`, by the poster's `state.json`, or by the first caption line.

### Safety layers (in order)

1. **Rules** (`src/rules.ts`): emergencies, scan requests, explicit personal advice requests, spam,
   injection, complaints, provenance, disputes, and app questions are decided here, before any
   model call (the Threads bot runs `directConcern` before its model the same way).
2. **Model** (`src/reply.ts`, prompt in `src/voice.ts`): structured JSON output, supplied facts
   only, comments treated as untrusted, skip when unsure.
3. **Sanitizer** (can only turn a reply into a skip): advice wording in English and Arabic, any
   number that is not in the vetted facts, non-medical English inside an Arabic reply, a language
   mismatch, product or link wording outside the template, dashes, extra emoji, and the
   comma rules.
4. **Caps**: 20 replies per reel per Cairo day, 40 per day, 1 per comment thread, 40 model calls
   per run, a billing breaker that stops model calls after a credit or auth error, a hard cap of
   40 model calls per Cairo day, and a monthly spend guard of 5 USD computed from the usage
   tokens of every call (`spend.json`). Once a cap or the guard is hit, model replies are
   skipped and left unhandled so a later run answers them.
5. **Live latch**: nothing is posted unless `BOT_CONFIRM_LIVE=yes`, and only inside
   `BOT_ACTIVE_WINDOWS` (19:00 to 02:00 Cairo).

## Claude key and spend

Replies use the **Claude for Startups key**: `CLAUDE_API_KEY`, read at run time from
`W:/Projects/recall-engine/.env.local` (or the environment). It is never printed or copied.
`ANTHROPIC_API_KEY` is ignored on purpose, so no other bot's key is ever used here.
`npm run key:check` makes one tiny Claude Haiku 5.5 call to prove the key works.
Caps: `BOT_DAILY_MODEL_CALLS=40`, `BOT_MONTHLY_USD=5` (Sonnet 5.5 at $2 in and $10 out per
million tokens, cache reads $0.20, cache writes $2.50). The ledger is `spend.json`.

## Commands

```bash
npm install
npm test                 # offline checks of rules and guards (no keys, no cost)
npm run offline          # fixture comments, no model (rules, template, exact answers only)
npm run demo             # fixture comments with the model; report in reports/fixtures-latest.md
npm run dry              # real @recallengine comments, read-only, nothing posted (needs the IG token)
npm run live             # posts replies (needs BOT_CONFIRM_LIVE=yes, not yet)
npm run facts:sync       # refresh data/reels.json from each reel's sources.md
npm run token:url        # one-time token setup (below)
npm run token -- <code>
npm run token:refresh    # extend the token before its 60 days run out
```

`npm run demo` costs a few cents per run (about 25 model calls for the 43 fixtures).

## One-time token setup (owner)

1. In the Instagram app, make sure @recallengine is a **Professional** account (Business or Creator).
2. At developers.facebook.com create an app (type Business), add the **Instagram** product, and
   open **API setup with Instagram login**. Do not use the Facebook Login path.
3. Add the permissions `instagram_business_basic`, `instagram_business_content_publish`, and
   `instagram_business_manage_comments`. While the app is in development mode, add @recallengine
   as an Instagram tester (App roles) and accept the invite in the Instagram app.
4. Register a redirect URI you own (for example `https://recallengine.app/`). Put the app's
   Instagram app ID, secret, and that URI in `.env` as `IG_CLIENT_ID`, `IG_CLIENT_SECRET`, and
   `IG_REDIRECT_URI`.
5. `npm run token:url`, open the link signed in as @recallengine, approve, copy the `code` from
   the address bar, then `npm run token -- <code>`. The long-lived token is written into `.env`
   and never printed. Copy the `IG_ACCESS_TOKEN=` line into `W:/Projects/recall-poster/.env` too
   (one token serves both bots).
   Alternative: the dashboard's "Generate token" button for the tester account gives the same
   token. Paste it into both `.env` files.
6. `npm run dry` must list @recallengine and its recent reels. Refresh every month or so with
   `npm run token:refresh` (an expired token cannot be refreshed, it must be re-created).

## GO steps (only when the owner says GO)

1. The app replies and all boundary lines (English and Arabic) are approved. Nothing to do here.
2. Run `npm run dry` after a reel has comments and read every line of the output.
3. Set `BOT_CONFIRM_LIVE=yes` in `.env` and run `npm run live` once by hand inside 19:00 to 02:00
   Cairo. Check the replies on Instagram.
4. Read `review-queue.json` for the owner list after every run. Answer those comments yourself.
5. Only after a few clean manual runs: schedule it (Windows Task Scheduler every 15 minutes, or a
   GitHub Actions workflow in a private repo with `state.json` and `review-queue.json` committed back).
   Keep `state.json`: it prevents double replies. Never reset it to empty.

## Files

- `src/rules.ts` deterministic first pass. `src/reply.ts` model call, offline matcher, sanitizer.
- `src/voice.ts` the system prompt. `src/reels.ts` vetted facts and reel matching.
- `src/index.ts` modes and reports. `src/state.ts` handled comments, caps, owner list.
- `src/instagram.ts` Graph API (Instagram Login). `replyToComment` is the only write call.
- `data/reels.json` facts per reel. `data/templates.json` approved replies. `data/fixtures/` synthetic comments.
