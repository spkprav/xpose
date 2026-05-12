# xPose

**your x circle, xposed.**

an electron desktop tool that turns your X (Twitter) feed into a queryable, owned dataset. no api keys. no scraping html. no third-party service.

it runs alongside your normal browsing session, intercepts X's own GraphQL responses via Chrome DevTools Protocol, and stores everything to Postgres. the app exposes a sidebar to triage, score, and draft engagement directly against the data you've collected.

built by [@praveeninpublic](https://x.com/praveeninpublic).

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

## Responsible use

- Don't crawl other users' followers / following at scale you'd be uncomfortable with someone doing to you.
- Respect rate limits. The default pacing (5s between profiles, 3s between scrolls) is conservative; don't lower it.
- Read X's TOS. Personal-research tooling is generally fine; building a commercial scraping service on top of this is not the intent.
