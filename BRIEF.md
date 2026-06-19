# Recall Engine — Instagram Carousel Auto-Poster Brief

Living creative + operational brief for the daily carousel bot that posts to **@recallengine**.
This is a separate account and voice from the xray-cases bot (`D:\Projects\xray-poster`). We reuse
that project's plumbing only, not its product, voice, or rules.

## Account + access

- Handle: **@recallengine**
- Account type: **Business/Creator, linked to a Facebook Page** (confirmed by owner). Eligible for the
  Instagram Content Publishing API.
- Publishing path: Instagram Graph API (`https://graph.instagram.com/v21.0`, `/me/media`), token-scoped,
  so no separate IG user id is needed at publish time.

### Secrets the bot needs (owner pastes these into `.env` and GitHub Secrets; never committed)

| Secret | Purpose |
|--------|---------|
| `OPENAI_API_KEY` | gpt-image-2 slide generation |
| `ANTHROPIC_API_KEY` | Claude writes/extends captions + queues new topics |
| `IG_ACCESS_TOKEN` | long-lived Instagram token (~60 days, needs refresh) |
| `GITHUB_RAW_BASE` | public base URL for slide images, e.g. `https://raw.githubusercontent.com/<user>/recall-poster/main` |

## Purpose + audience

- **Goal:** show medical students the kind of high-yield exam material Recall Engine generates from any
  lecture, build trust and following, and convert to the app.
- **Audience:** medical students preparing for exams (SBAs, MCQs, OSCEs; UK/PLAB + USMLE crossover).

## Voice + tone

- Authoritative, high-yield, confidence-building, exam-focused. Clear and modern. "Your sharpest study partner."
- NOT the xray voice: no "no commas" gimmick, no "guess the diagnosis" format, no "educational entertainment
  only / not medical advice" sign-off. This account teaches, it does not run a diagnosis game.

## Carousel format

- 6 slides: **hook -> 4 value slides -> CTA**.
- Slide design: **pure gpt-image-2** (owner's choice). Text baked into the image. Prompts demand exact
  spelling; output is reviewed before the first live posts (see review gate below).
- Canvas: 1024x1024 generated, post-processed to 1080x1080 JPEG.
- Visual identity (Recall Engine): deep navy `#0b1019`, cyan accent `#2dd4ef`, amber accent `#fbbf24`,
  clean white sans-serif, minimal, premium medical-tech. Small "RECALL ENGINE" wordmark top-left.

## Content source

- Launch week: 7 hand-authored, vetted posts in `posts/` (medical facts checked).
- Ongoing: `src/generate.ts` tops the queue up to `BOT_QUEUE_TARGET` with Claude-proposed topics, written
  as `draft: true` posts the owner reviews before they go live (`BOT_AUTO_APPROVE=off` by default).

## Caption + hashtags

- Caption assembled from each post's `caption` body + a curated hashtag set (max 30, IG cap 2200 chars).
- CTA: drive to the **Recall Engine app signup** via link in bio.

## Schedule

- Once daily, **20:00 Africa/Cairo** (= 17:00 UTC; Egypt is UTC+3 in summer). Encoded as explicit
  `postAt` ISO timestamps per post.
- Runner: GitHub Actions perpetual poll-and-rechain (see `.github/workflows/publish.yml`).

## Review gate + safety

- `--sample` and `--dry-run` render slides to disk without posting.
- Live posting is latched behind `BOT_CONFIRM_LIVE=yes`.
- Owner confirms before the first live post and reviews the first week of generated slides for text errors.
- State is tracked in `state.json` so a restart never double-posts.

## Hard rules ("never do")

- Never reuse xray captions, branding, or the "guess the diagnosis" format.
- Never commit secrets.
- Never post medically wrong content. When unsure, the post stays a draft for review.
- Never invent product claims, pricing, or a CTA URL. The app URL is a placeholder until the owner confirms it.

## Open items to confirm

- Final CTA/link-in-bio URL for the Recall Engine app (placeholder until provided).
- Whether to keep a light disclaimer in captions (currently none, per "no xray-style disclaimer").
- Starter hashtag set the owner prefers (current set is a sensible default).
