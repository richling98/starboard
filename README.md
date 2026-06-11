# Starboard

Starboard is a GitHub discovery dashboard for finding notable open source repositories and the accounts behind them. It combines cached leaderboard snapshots, semantic search over repository metadata and README text, and a terminal-inspired black-and-white interface.

Production:

- Vercel: `https://starboard-xi.vercel.app`
- GitHub Pages: `https://richling98.github.io/starboard/`

## Features

- Repository leaderboards for Today, Week, Month, and All time.
- Account leaderboards for the same periods.
- Supabase-backed snapshot data for fast repository and account reads.
- Static fallback leaderboard JSON under `data/leaderboards`.
- AI semantic search over repository names, descriptions, topics, and cleaned README text.
- Semantic search support for both repository and account views.
- Keyword fallback results for indexed rows that do not yet have embeddings.
- Sortable repository columns for Stars and Forks.
- Sortable account columns for Stars and Repos.
- `Load more` pagination with 20-row reveal increments.
- Expandable account rows that show the repositories contributing to each account score.
- Copyable clone commands for HTTPS, SSH, and GitHub CLI.
- Compact view toggle.
- Responsive desktop and mobile table layouts.
- English-language quality gate for repository discovery and snapshots.
- Terminal ASCII `STARBOARD` title treatment with a replayed generated-on-load animation.
- Vercel production deployment from the static `dist/` artifact.
- GitHub Actions workflow for scheduled index refreshes and GitHub Pages deployment.

## How It Works

The browser is a static app made from `index.html`, `styles.css`, and `app.js`.

For local development, `server.mjs` provides:

- Static file serving at `http://127.0.0.1:4176`.
- A same-origin GitHub API proxy at `/api/github/*`.
- Leaderboard endpoints at `/api/leaderboard/repositories` and `/api/leaderboard/accounts`.
- A local semantic search endpoint at `/api/semantic-search`.
- Cache status at `/api/cache/status`.

For hosted static deployments, the app reads pre-exported leaderboard JSON from `data/leaderboards` if local API endpoints are unavailable. Semantic search calls the Supabase Edge Function directly outside localhost.

## Local Setup

Install dependencies:

```bash
npm install
```

Create `.env.local`:

```bash
GITHUB_TOKEN=your_github_token
DATABASE_URL=your_supabase_postgres_uri
OPENAI_API_KEY=your_openai_api_key
```

Run the local server:

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:4176
```

## Data Model

Starboard stores repository, account, snapshot, search-document, and embedding data in Supabase Postgres.

The main indexed data flow is:

1. Seed or update schema and discovery queries.
2. Discover repositories from GitHub Search partitions.
3. Refine repository language quality from descriptions and README text.
4. Build semantic search documents and embeddings.
5. Refresh enriched all-time account data.
6. Build cached leaderboard snapshots.
7. Export static leaderboard JSON.
8. Build the static deployment artifact.

GitHub Search exposes only a bounded result window for each query, so discovery uses multiple partitions: all-time star buckets, rolling created-date windows, and language buckets.

Period definitions:

- Today: starred repositories created in the last 24 hours.
- Week: starred repositories created in the last 7 days.
- Month: starred repositories created in the last 30 days.
- All time: starred repositories overall.

Account scores:

- Today, Week, and Month sum stars from qualifying indexed repos created in the selected rolling period.
- All time uses enriched account rows when available and repository rollups for newly indexed owners.

## Scripts

Initialize or update the database schema:

```bash
npm run setup:db
```

Import a legacy local all-time account cache:

```bash
npm run import:cache
```

Discover repositories from GitHub Search partitions:

```bash
npm run discover:repos
```

Useful bounded discovery runs:

```bash
npm run discover:repos -- --max-queries=18 --max-pages=1
npm run discover:repos -- --period=week --max-pages=2
```

Refine repository language status:

```bash
npm run refine:language
```

Build semantic search documents and embeddings:

```bash
npm run build:semantic-index
```

Build leaderboard snapshots:

```bash
npm run build:snapshots
```

Refresh enriched all-time accounts:

```bash
npm run refresh:all-time-accounts
```

Run the full local indexing pipeline:

```bash
npm run index:github
```

Export static leaderboard JSON:

```bash
npm run export:static-data
```

Build the static deploy artifact:

```bash
npm run build:pages
```

The artifact is written to `dist/`.

## Semantic Search

The semantic index stores one embedding per repository in Supabase `pgvector`. It uses `text-embedding-3-small` with 1024 dimensions by default and skips unchanged documents using a content hash.

Search behavior:

- Queries shorter than 3 characters use normal keyword filtering.
- Longer queries call the semantic endpoint.
- Default semantic ordering is relevance.
- Clicking Stars, Forks, or Repos sorts within the semantic match pool.
- Keyword-only fallback rows are appended after semantic rows when available.

Deploy the Supabase Edge Function with:

```bash
supabase functions deploy starboard-semantic-search --no-verify-jwt
```

Required Supabase function secrets:

```bash
STARBOARD_OPENAI_API_KEY
STARBOARD_SUPABASE_URL
STARBOARD_ALLOWED_ORIGIN
STARBOARD_EMBEDDING_MODEL
STARBOARD_EMBEDDING_DIMENSIONS
```

`STARBOARD_ALLOWED_ORIGIN` accepts a comma-separated allowlist. Include both hosted origins when both deployments are active:

```bash
STARBOARD_ALLOWED_ORIGIN=https://richling98.github.io,https://starboard-xi.vercel.app
```

The function embeds the user query server-side, calls the `match_semantic_repositories` RPC, and returns matching repository or account rows for the active period.

## Deployment

### Vercel

Vercel is the primary production deployment target.

The project includes `vercel.json`:

```json
{
  "buildCommand": "npm run build:pages",
  "outputDirectory": "dist",
  "framework": null
}
```

Deploy from the repo root:

```bash
npm exec --yes vercel -- deploy --prod
```

The current production alias is:

```text
https://starboard-xi.vercel.app
```

### GitHub Pages

The repository also includes `.github/workflows/starboard-index.yml`.

Required GitHub repository secrets:

```bash
STARBOARD_GITHUB_TOKEN=your_github_token
STARBOARD_DATABASE_URL=your_supabase_postgres_uri
STARBOARD_OPENAI_API_KEY=your_openai_api_key
```

Scheduled and manual workflow runs perform the full refresh path:

```bash
npm run setup:db
npm run discover:repos
npm run refine:language
npm run build:semantic-index
npm run refresh:all-time-accounts
npm run build:snapshots
npm run export:static-data
npm run build:pages
```

Push-triggered workflow runs skip the heavy discovery, semantic indexing, account refresh, and snapshot rebuild steps so UI-only changes can deploy quickly.

## Quality Gates

Repository discovery stores an English-script heuristic status using the GitHub description and README text. Repositories whose README or description are predominantly Chinese, Japanese, Korean, Cyrillic, Arabic, Hebrew, Devanagari, or Thai are rejected from snapshots. This keeps the discovery feed focused on English-language projects without rejecting incidental non-English characters.

## Font Attribution

The `STARBOARD` hero uses a local Fira Mono regular font file. Fira Mono is distributed under the SIL Open Font License. The hero wordmark is static ANSI Shadow-style ASCII art rendered with layered `<pre>` blocks.
