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
- Schedule is encoded as `postAt` per post (22:00 Africa/Cairo = 19:00 UTC).
