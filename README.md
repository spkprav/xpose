# xPose

**your x circle, xposed.**

an electron desktop tool that turns your X (Twitter) feed into a queryable, owned dataset. no api keys. no scraping html. no third-party service.

it runs alongside your normal browsing session, intercepts X's own GraphQL responses via Chrome DevTools Protocol, and stores everything to Postgres. the app exposes a sidebar to triage, score, and draft engagement directly against the data you've collected.

built by [@praveeninpublic](https://x.com/praveeninpublic).

- X: [@praveeninpublic](https://x.com/praveeninpublic)
- GitHub: [@spkprav](https://github.com/spkprav)
- YouTube: [@praveeninpublic](https://youtube.com/@praveeninpublic)
- LinkedIn: [praveen-kumars](https://www.linkedin.com/in/praveen-kumars/)

---

## What it does

- **Browses X for you.** A logged-in BrowserView lets you scroll your feed normally; CDP captures every `UserTweets`, `Followers`, `Following`, `UserByRestId` response on the wire.
- **Crawls your circle.** Queue followers / following / replies of any handle. Auto-paginates via synthesized scroll gestures (`Input.synthesizeScrollGesture`, the only thing that triggers X's IntersectionObserver lazy load).
- **Stores cleanly.** Postgres tables: `tweets`, `social_circle`, `circle_tweets`, `crawl_jobs`, `drafts`, `tweet_analysis`, plus an `engagement_opportunities` view.
- **Scores opportunities.** Built-in view ranks untouched tweets across 10 components (recency, freshness, low-competition reply windows, mutual amplification, follower-tier bonuses).
- **Drafts in your voice.** Optional LLM client (Ollama / OpenRouter / GLM / OpenAI) generates post drafts grounded in selected source tweets.
- **Exports a wiki.** Optional markdown export pipeline writes a fully cross-linked Obsidian vault.

## Why

The X API costs hundreds of dollars per month for the access this tool needs. The web app already has every byte of data you'd want, and intercepting the responses your own browser receives is faster than scraping HTML and gives you the same JSON the official client uses.

This is personal-tooling. Fork it, point it at your circle, see what you actually have.

## Prerequisites

- Node 18+ and npm
- Postgres 14+ (local or remote)
- Optional: Ollama for local LLM analysis

## Install

```bash
git clone https://github.com/spkprav/xpose
cd xpose
npm install
```

## Set up the database

```bash
createdb xpose
psql -d xpose -f schema.sql
```

(Database name is configurable in the Settings panel.)

## Run

```bash
npm run dev    # nodemon-watched, auto-restart on changes
npm start      # plain electron .
```

On first launch:

1. Open **Settings** in the sidebar.
2. Configure **Database** (host, port, user, password, database).
3. Configure **LLM Provider** (Ollama defaults to `localhost:11434`).
4. Add **Feed Links**. one URL per line for X lists / community pages you want to harvest.
5. Save.

The app reconnects to the configured database without restart.

## Architecture

```
main process (Electron)
  twitterView    BrowserView with your logged-in X session (visible)
  crawlView      BrowserView running parallel crawls (hidden)
  CDP debugger   intercepts Network.requestWillBeSent / loadingFinished
         |
         v
  Postgres (configured via Settings panel)

renderer (single-page app, vanilla JS + Tailwind)
  feed panel (For You + Following + list-driven)
  circle panel
  engagement-opportunities view
  drafts panel
  settings
```

## Schema highlights

See `schema.sql`. Tables:

- `tweets`: main tweet store, engagement metrics, raw GraphQL JSONB
- `social_circle`: followers / following / mutuals / 2nd-degree connections
- `circle_tweets`: tweets from circle members (separate table for volume + lifecycle)
- `crawl_jobs`: queue of profile / list crawl tasks
- `drafts`: generated post drafts with provenance back to source tweets
- `tweet_analysis`: LLM-scored relevance per tweet, per ICP definition
- `engagement_opportunities`: view that scores untouched tweets across 10 components

## Configuration

All app config lives in the **Settings** panel. Persisted to `~/Library/Application Support/xpose/settings.json` (macOS) / equivalent on other platforms. Never transmitted.

LLM provider keys (OpenRouter / GLM / OpenAI) are stored locally with the same persistence. Ollama is keyless.

## Privacy

The app uses your own logged-in X session. Nothing is sent to a server you don't control. All data lives in your local or self-hosted Postgres.

## License

MIT. See [LICENSE](./LICENSE).

## TOS risk (read this before running)

**Running this tool violates X's Terms of Service.** I checked. Don't run it on an account you can't afford to lose.

X's TOS §4 ("Misuse of the Services") prohibits, verbatim:

> "access or search or attempt to access or search the Services by any means (automated or otherwise) other than through our currently available, published interfaces that are provided by us (and only pursuant to the applicable terms and conditions), unless you have been specifically allowed to do so in a separate agreement with us (NOTE: crawling or scraping the Services in any form, for any purpose without our prior written consent is expressly prohibited)"

xPose intercepts X's internal GraphQL responses via Chrome DevTools Protocol and synthesizes scroll gestures to paginate. That is automated access to a non-published interface, regardless of whether you're logged in. "Your own logged-in session" is not a carve-out in the TOS.

Specific risks:

- **Account suspension or termination.** §4 grants X this right for any ToS violation.
- **Legal action.** X has sued scrapers (Bright Data, CCDH) on TOS-only grounds.
- **No safe-harbor for "personal use".** The TOS says "in any form, for any purpose."

This repo exists because the tool is useful for personal research on data you already have access to, and because the engineering pattern (CDP interception of your own browser session) is interesting on its own merits. It is published with full disclosure of the legal posture. It is not a license to run it. If you do run it:

- Use a burner account, not your main.
- Keep the default pacing (5s/profile, 3s/scroll). Do not lower it.
- Do not resell the data, redistribute crawled profiles, or build a commercial service on top.
- Do not crawl other users' followers / following at a scale you'd be uncomfortable with someone doing to you.

Read X's TOS yourself: https://x.com/en/tos (§4 is the relevant part).
