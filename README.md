# recall-poster

Daily Instagram carousel auto-poster for **@recallengine**. It generates 6-slide carousels with
**gpt-image-2**, writes captions, and publishes via the **Instagram Graph API** on a schedule, run by a
perpetual GitHub Actions chain. Built by mirroring the proven `xray-poster` plumbing; content and voice are
specific to Recall Engine (see `BRIEF.md`).

## How it works

1. Each post lives at `posts/<slug>/post.json` (subject, hook, 4 points, CTA, caption, hashtags, `postAt`).
2. `--render` generates the slide images with gpt-image-2 into `posts/<slug>/slideN.jpg`.
3. The runner commits + pushes those images so they are public at `raw.githubusercontent.com`.
4. `--live` builds the caption and publishes the carousel: per-image container -> CAROUSEL container ->
   poll until `FINISHED` -> `media_publish`.
5. `state.json` records `postedAt` per slug, so a post is never published twice.

Images must be public **before** the publish call (Meta fetches them server-side), which is why the
workflow renders + pushes, then publishes.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the secrets
```

Secrets (`.env` locally, GitHub Secrets for the runner):

| Secret | Where to get it |
|--------|-----------------|
| `OPENAI_API_KEY` | platform.openai.com (billing on, gpt-image-2 access) |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `IG_ACCESS_TOKEN` | long-lived Instagram Graph token (~60 days) |
| `GITHUB_RAW_BASE` | `https://raw.githubusercontent.com/<user>/recall-poster/main` |

This repo must be **public** so the slide image URLs are fetchable by Meta.

## Commands

```bash
npm run sample            # render the next post's slides to disk + print caption (no posting)
npm run sample 00002-dka-vs-hhs   # render a specific post
npm run dry               # render due/upcoming posts + print captions (no posting)
npm run render            # render due/upcoming posts (no posting)
npm run live              # publish due posts (needs BOT_CONFIRM_LIVE=yes + GITHUB_RAW_BASE)
npm run generate          # top the queue up with Claude-drafted topics (saved as drafts)
npm run typecheck
```

## Going live (first time)

1. `npm run sample` and eyeball every slide for spelling/accuracy (gpt-image-2 can garble text).
2. Push the rendered slides so their URLs are public.
3. One manual `npm run live` with `BOT_CONFIRM_LIVE=yes`; confirm the carousel on @recallengine.
4. Add the secrets to GitHub, then run the `publish` workflow (Actions tab -> Run workflow).

## Content queue

- Seeded posts are vetted and always post on their `postAt`.
- `npm run generate` adds new Claude-drafted topics as `"draft": true`. They post only after you set
  `"draft": false` after review (or run the generator with `BOT_AUTO_APPROVE=on` to pre-approve). A draft
  post never publishes, regardless of any other flag. Keep the review gate on for medical accuracy.

## Operational notes

- **Token refresh:** `IG_ACCESS_TOKEN` expires ~every 60 days. Re-exchange and update the secret.
- **Push code mid-chain:** a plain push will not take effect inside a running 5h loop. Cancel the
  in-progress + pending runs, then dispatch a fresh run on the new commit.
- **Always** `git pull --rebase --autostash` before pushing locally; the bot commits `state.json` and
  rendered slides back to the repo.
- Schedule is encoded as `postAt` per post (19:00 Africa/Cairo = 16:00 UTC).

## Reels

The reel series is published by a separate command, `src/reels.ts`. The carousel workflow never
calls it, and it needs its own second latch (`REELS_CONFIRM_LIVE=yes`), so merging this code
cannot post a reel by itself.

### How it works

1. Each finished reel sits in `REELS_SOURCE_DIR/<NN-case>/` (default
   `W:/Recall Engine Review/reels-week1-20261023/READY-TO-SCHEDULE`) with the final mp4,
   `cover.jpg`, and `caption-instagram.txt`.
2. `npm run reels:sync` writes `reels/<slug>/reel.json` per folder: a snapshot of the caption, the
   chosen mp4 (`REELS_VIDEO_VARIANT=master` by default, `phone` for the smaller render), its size
   and hash, and `postAt`. A new reel gets the next free day at **19:00 Africa/Cairo** (owner, 24 Oct).
   An existing `postAt` is never moved by a sync. Edit `postAt` (UTC ISO) in `reel.json` to
   reschedule one reel, or set `"draft": true` to hold it.
3. `npm run reels:dry` prints the schedule, the exact `POST /me/media` form fields per reel
   (`media_type=REELS`, `video_url`, `cover_url`, `share_to_feed`), the full caption, and a
   preflight against Meta's Reels specs (size, moov before mdat, codec, fps, duration, caption
   length, hashtag count). `npm run reels:check` also HEADs the public video and cover URLs.
4. `npm run reels:live` stages and publishes. About an hour before a reel's slot
   (`REELS_STAGE_MINUTES`, 60) it uploads the mp4 and cover to the public Supabase bucket
   `ig-reel-staging`. At the slot it publishes only when all of this holds: the reel is less than
   `REELS_MAX_LATE_HOURS` (3) late, preflight passes, the public `video_url` answers 200 with the
   same byte size as the local file, the cover URL answers 200, and fewer than 25 API posts were
   made in the last 24 h. Flow: create the REELS container, save its id to `state.json`, poll
   `status_code` every 15 s until `FINISHED`, then `media_publish`, then delete both staged files.
   A failed publish keeps the files for the retry window, and once the reel is past it the files
   are deleted and nothing posts. A rerun reuses the saved container or records it as already
   `PUBLISHED`, so a reel is never posted twice. One reel per run (`REELS_MAX_PER_RUN`).
   A reel with `"manual": true` (posted by hand) is never published by the bot.
5. `npm run reels:test` runs the live path offline against a faked Graph API and a faked Supabase
   Storage (stage, publish once, delete, no second post, latch refusal, failure cleanup).
   `npm run reels:stage-test` uploads a tiny dummy jpeg to the real bucket, checks its public
   URL, and deletes it. `npm run reels:bucket` creates the bucket if it is missing.

### Hosting the video (Meta fetches `video_url` itself)

Instagram Login tokens (`graph.instagram.com`) publish reels from a public `video_url`. Meta's
docs describe a resumable upload only for Facebook Login apps, so it is not used here.

**Owner decision (24 Oct 2026): Supabase Storage.** Bucket `ig-reel-staging` in project
`mlmdecvfiyizhuwvyptp`: public, `video/mp4` and `image/jpeg` only, 100 MB per file. Files live
at `ig-reel-staging/<slug>/<file>` for about an hour before the slot until publishing ends.
The Supabase URL and secret key are read at run time from `W:/Projects/recall-engine/.env.local`
(`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`) or from the environment (`SUPABASE_URL`,
`SUPABASE_SECRET_KEY`), and are never printed. `REELS_HOSTING=url` with `REELS_PUBLIC_BASE`
switches back to files that are already public somewhere else.

### Cloud mode (live since the owner's GO, 24 Oct 2026)

The reels and the comment bot run on GitHub Actions in this public repo. The laptop is not needed at
post time.

| Workflow | Schedule (UTC cron, gated in Cairo time) | What it does |
|---|---|---|
| `.github/workflows/reels.yml` | every 10 min, 17:45 to 22:00 Cairo | publishes the due reel (`npm run reels:live`, `REELS_HOSTING=signed`) and commits `reels/state.json` |
| `.github/workflows/comments.yml` | every 15 min, 19:00 to 02:00 Cairo | runs `comments/` live with an encrypted, uncommitted state |
| `.github/workflows/ci.yml` | every PR and push | actionlint, secret scan, typecheck, offline tests, and dry runs (no secrets) |

Egypt is UTC+3 until 29 Oct 2026 and UTC+2 after it. Each cron covers both offsets and the first step
keeps only the Cairo window. GitHub cron can start late, so the 3-hour late window stays.

**Media.** The runner has no Supabase key. Per reel, on the laptop:

```bash
npm run reels:sync                                 # adds or refreshes reels/<slug>/reel.json
npm run reels:upload -- <slug> --push              # private bucket ig-reel-media + 7-day signed URLs, then push
```

`reels:upload` reads the key from `W:/Projects/recall-engine/.env.local` (never printed), uploads the mp4
and cover to the PRIVATE bucket `ig-reel-media`, checks the signed URL answers with the exact byte size,
and writes `media` into `reel.json`. Upload no more than 7 days before the slot. A reel without valid
signed media is never posted (the job fails so GitHub emails the owner).

**Double posts.** The container id is saved before publishing, `reels/state.json` is committed back, and
before creating any new container the publisher reads the account's recent media: a post whose first
caption line matches is recorded as already live and never posted again.

**Secrets** (owner only): `powershell -ExecutionPolicy Bypass -File scripts/set-secrets.ps1` sets
`IG_ACCESS_TOKEN` and `CLAUDE_API_KEY`. Rerun it after every Instagram token refresh (about every 60
days). Until both exist, the workflows exit with "secrets missing". Stop everything with
`gh variable set CLOUD_BOTS --body off --repo icehacer-sys/recall-poster` (`on` or delete it to resume).
No Supabase key ever goes to GitHub.

## YouTube (Recall Engine channel, @recallengineapp)

Two bots for the YouTube channel (owner, 28 Oct 2026). Both are **off** until the owner turns them on,
and both default to dry or draft runs.

| Workflow | Schedule (UTC cron, gated in Cairo time) | What it does |
|---|---|---|
| `.github/workflows/youtube.yml` | hourly, 08:00 to 23:30 Cairo | uploads the due Short (`npm run yt:live`) and commits `reels/youtube-state.json` (video ids only) |
| `.github/workflows/youtube-comments.yml` | every 15 min, 20:00 to 02:00 Cairo | drafts replies under the channel's own Shorts, or posts them once `YT_REPLIES=live`. Encrypted state, like `comments.yml` |

### Switches (repository variables)

| Variable | Unset (default) | Turned on |
|---|---|---|
| `YT_BOTS` | both workflows stop at the gate | `on`: both run (the secrets must exist too) |
| `YT_PUBLIC` | uploads stay **private** with no publish time. The owner publishes in YouTube Studio | `on`: uploads go up private with `publishAt` = the slot and YouTube publishes them on time |
| `YT_REPLIES` | the comment bot only **drafts** (owner list: `cd comments`, then `npm run yt:review`) | `live`: replies post (caps below) |
| `YT_CROSSPOST` | only reels with `reels/<slug>/youtube.json` upload | `on`: approved Instagram reels without one upload with generated text |
| `CLOUD_BOTS` | | `off` stops every bot, YouTube included |

Turning `YT_BOTS` off does not cancel a publish time YouTube already holds. Set `"skip": true` in that
reel's `youtube.json` first (the next run cancels the schedule and keeps the video private), or set the
video to Private in YouTube Studio.

### Per Short

1. `npm run yt:sync` writes `reels/<slug>/youtube.json` for every approved reel that has none. It lives
   next to `reel.json` because `reels:sync` rewrites `reel.json` from scratch. The title is the reel's
   approved hook line plus the case number (at most 100 characters). The description starts with that
   line, `https://www.recallengine.app`, and the approved "first 7 days free plus 50 credits" line, then
   the rest of the approved caption and `#Shorts` with the caption hashtags. It records the duration and
   frame size with ffprobe (a Short must be vertical and at most 3 minutes). New entries start with
   `"approved": false`: nothing uploads until the owner sets it to `true`.
2. Slots: one Short a day at 20:00 Cairo by default. `npm run yt:sync -- --reslot` moves passed slots of
   entries that are not uploaded yet to the next free days.
3. The uploader downloads the same signed URL as the Instagram publisher (`npm run reels:upload -- <slug>`)
   and checks the byte size and the sha256 prefix against `reel.json` before uploading.
4. `containsSyntheticMedia` is `true` (AI voice and AI-made illustrations). YouTube may add an "altered or
   synthetic content" note to the description. The disclosure alone does not limit reach.
5. `npm run yt:dry` prints the exact `videos.insert` request per entry. No secrets, no network.

**Never twice:** the video id is saved the moment the upload finishes, and before every upload the
channel's 50 newest uploads are checked for the hidden tag `re-<slug>` (or the same title).

**Quota:** about 5 units per upload plus one call from the separate upload bucket (100 a day). The
uploader stops at 1,000 units and 5 uploads per Pacific day and the comment bot at 3,000 units, out of
the project's 10,000. Runs with nothing due make no API call.

**Comments:** same rules, templates, guards, and Sonnet prompt as the Instagram bot, with a YouTube
identity line. Replies only under the channel's own Shorts, never a link (Shorts comment links are not
clickable and repeated link replies count as spam), never a subscribe ask. App questions use the
`youtube_app_question` templates ("the link is on our channel page"), which stay `approved: false` until
the owner OKs them. Held and likely-spam comments go to the owner list and are never approved. Caps: 5
replies per run, 30 a day, 15 per Short a day, 1 per thread, 30 model calls a day, and 3 USD a month.

### One-time owner setup

Claude never creates accounts, projects, or OAuth clients. The owner does these steps:

1. YouTube: on the channel's Google account open `youtube.com/verify` and verify the phone number.
2. [Google Cloud Console](https://console.cloud.google.com), signed in as the channel's Google account:
   1. Create a project named `Recall Engine YouTube`.
   2. APIs and Services > Library > **YouTube Data API v3** > Enable.
   3. Google Auth Platform > Get started: app name `Recall Engine`, support email `hello@recallengine.app`,
      audience **External**, contact email `hello@recallengine.app`.
   4. Branding: home page `https://www.recallengine.app`, privacy policy
      `https://www.recallengine.app/privacy`, terms `https://www.recallengine.app/terms`, authorised
      domain `recallengine.app`.
   5. Data access > Add or remove scopes > `https://www.googleapis.com/auth/youtube.force-ssl` > Save.
   6. Audience > **Publish app** (In production). In Testing, Google ends the refresh token after 7 days.
      Do not submit for verification: one user is well under the 100-user limit.
   7. Clients > Create client > **Desktop app**, name `recall-poster` > Create > Download JSON.
3. On the laptop: `cd W:\Projects\recall-poster`, then
   `node scripts/youtube-auth.mjs --client "C:\Users\HP\Downloads\client_secret_XXXX.json"`.
   Sign in, pick the **Recall Engine** channel, and on "Google hasn't verified this app" choose
   Advanced > Go to Recall Engine > Continue. The script sets the secrets `YT_CLIENT_ID`,
   `YT_CLIENT_SECRET`, and `YT_REFRESH_TOKEN` and the variable `YT_CHANNEL_ID`. It never prints the token.
   Then move the downloaded JSON out of Downloads into a private folder.
4. **Test upload (Phase 0):** set `"approved": true` in one `youtube.json`, then
   `gh variable set YT_BOTS --body on -R icehacer-sys/recall-poster` and
   `gh workflow run youtube.yml -R icehacer-sys/recall-poster -f mode=live -f slug=<slug>`. In YouTube
   Studio the Short is Private. Switch it to Unlisted. If YouTube allows it, turn on scheduled publishing
   with `gh variable set YT_PUBLIC --body on -R icehacer-sys/recall-poster`. If YouTube keeps it locked to
   private, leave `YT_PUBLIC` off, publish each Short by hand in Studio, and send the
   [API audit form](https://support.google.com/youtube/contact/yt_api_form).
5. Comment replies: read the drafts with `cd comments`, then `npm run yt:review`. When they look right,
   approve the `youtube_app_question` templates in `comments/data/templates.json` and run
   `gh variable set YT_REPLIES --body live -R icehacer-sys/recall-poster`.

### Channel art and text (`assets/youtube/`)

- `banner-2560x1440.png` (Studio > Customization > Branding > Banner image). Everything readable sits in
  the 1546 x 423 middle area that phones show. `banner-safe-area-preview.png` shows the crops.
- `profile-800x800.png` (Branding > Picture). The recall-v2 symbol, never the old teal R.
- `channel-description.txt` (Basic info > Description) and `channel-keywords.txt` (Settings > Channel >
  Keywords). Add the link `Recall Engine` = `https://www.recallengine.app` under Basic info > Links: the
  channel header link is the only clickable one for Shorts viewers.
- Sources: `assets/youtube/src/*.html`. Re-render on the NVIDIA GPU through the heavy slot:
  `node D:/Temp/ClaudeCode/process/heavy-slot.cjs yt-assets --cwd W:/Projects/recall-poster -- node scripts/render-youtube-assets.mjs`

### Commands

```bash
npm run yt:sync            # write youtube.json for approved reels (approved: false)
npm run yt:sync -- --reslot
npm run yt:dry             # exact upload requests, no secrets, no network
npm run yt:check           # dry run plus a size probe of each signed video URL
npm run yt:live            # upload (needs YT_CONFIRM_LIVE=yes, which only the workflow sets)
npm run yt:unschedule -- <slug>
npm run yt:test            # offline: faked Google, YouTube, Supabase, and gh
cd comments && npm run yt:dry    # also yt:draft, yt:live, yt:review, yt:cloud:test
```
