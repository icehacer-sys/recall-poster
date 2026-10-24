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

## Reels (dry run only until the owner says GO)

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
4. `npm run reels:live` publishes a reel only when all of this holds: it is due, it is less than
   `REELS_MAX_LATE_HOURS` (3) late, preflight passes, the public `video_url` answers 200 with the
   same byte size as the local file, the cover URL answers 200, and fewer than 25 API posts were
   made in the last 24 h. Flow: create the REELS container, save its id to `state.json`, poll
   `status_code` every 15 s until `FINISHED`, then `media_publish`. `postedAt` and the media id go
   into `state.json` under `reel:<slug>`. A rerun reuses the saved container or records it as
   already `PUBLISHED`, so a reel is never posted twice. One reel per run (`REELS_MAX_PER_RUN`).
5. `npm run reels:test` runs the live path offline against a faked Graph API (publish once,
   second run posts nothing, latch refuses without `REELS_CONFIRM_LIVE`).

### Hosting the video (Meta fetches `video_url` itself)

Instagram Login tokens (`graph.instagram.com`) publish reels from a public `video_url`. Meta's
docs describe a resumable upload only for Facebook Login apps, so it is not used here.
`REELS_PUBLIC_BASE` decides where the files are expected: `<base>/<slug>/<video>` and
`<base>/<slug>/cover.jpg`.

| Option | How | Trade-off |
|---|---|---|
| **Public bucket, staged on the day (recommended)** | Supabase Storage public bucket `reels-media` (or Cloudflare R2 public bucket). Upload the mp4 and cover into `<slug>/` an hour before 19:00, delete them after the reel is live. `REELS_PUBLIC_BASE=https://<ref>.supabase.co/storage/v1/object/public/reels-media` | Correct `video/mp4` type, no git bloat, no key in GitHub. The URL is public but unlisted for about an hour. One manual upload per reel. |
| Public GitHub repo (default if unset) | Commit `reels-media/<slug>/` to this public repo right before publishing | Zero setup, but every reel stays public in git history forever and the repo grows 25 to 80 MB per reel (the master is over GitHub's 50 MB warning). Use the `phone` variant here. raw.githubusercontent serves `application/octet-stream`, which Meta usually accepts but is not guaranteed. |
| Push only at publish time from the runner | Not possible today: the GitHub runner cannot read `W:` | Needs the files in cloud storage first, which is the bucket option. |

### GO steps (owner)

1. Refresh the Instagram token for @recallengine (the one in this repo's `.env` expired on
   17 Aug 2026). It needs `instagram_business_basic` and `instagram_business_content_publish`.
2. Pick the hosting option and set `REELS_PUBLIC_BASE` in `.env`.
3. `npm run reels:sync` then `npm run reels:dry` and read every caption and time.
4. On the day: stage the mp4 and cover, run `npm run reels:check` until both HEADs say 200 and
   the size matches.
5. At or after 19:00 Cairo (within 3 h): `BOT_CONFIRM_LIVE=yes REELS_CONFIRM_LIVE=yes npm run reels:live`.
   Watch it finish, open the reel on Instagram, then delete the staged files.
6. Only after a few clean manual runs: schedule the same command (Windows Task Scheduler at
   19:05 Cairo, or a workflow step once the files live in a bucket the runner can reach).
