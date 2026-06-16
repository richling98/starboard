# Starboard

Starboard is a GitHub discovery dashboard for finding notable open source repositories and the accounts behind them. It combines Supabase-backed leaderboard snapshots, semantic search over repository metadata and README text, trend clustering, and a terminal-inspired black-and-white interface.

Production:

- Vercel: `https://starboard-xi.vercel.app`
- GitHub Pages: `https://richling98.github.io/starboard/`
- Semantic backfill dashboard: `/semantic-dashboard.html`

## Features

- Repository leaderboards for Today, Week, Month, and All time.
- Account leaderboards for the same periods, including expandable contributing-repository details.
- A Trends tab that clusters the top Today and Week repositories into current technology themes.
- Supabase-backed snapshot data for fast repository and account reads.
- Static fallback JSON under `data/leaderboards` for hosted static deployments.
- Live `Last updated` status from the active snapshot or trend metadata.
- AI semantic search over repository names, descriptions, topics, and cleaned README text.
- Semantic search support for both repository and account views.
- Keyword fallback rows appended after semantic results when available.
- Sortable repository columns for Stars and Forks.
- Sortable account columns for Stars and Repos.
- Sortable trend rows for Stars and Forks.
- `Load more` pagination with 20-row reveal increments.
- Copyable clone commands for HTTPS, SSH, and GitHub CLI.
- Client-side and indexing-time filtering for unsafe repository metadata.
- English-language quality gate for repository discovery and snapshots.
- Responsive desktop and mobile layouts.
- Terminal ASCII `STARBOARD` title treatment with a replayed generated-on-load animation.
- Semantic embedding coverage dashboard with recent runs, rejection reasons, known issues, and plan progress.
- Vercel production deployment from the static `dist/` artifact.
- GitHub Actions workflows for scheduled index refreshes, trend refreshes, semantic backfills, and generated data commits.

## How It Works

The browser app is static and is built from:

- `index.html`
- `styles.css`
- `app.js`
- `semantic-dashboard.html`
- `semantic-dashboard.css`
- `semantic-dashboard.js`

For local development, `server.mjs` provides:

- Static file serving at `http://127.0.0.1:4176`.
- A same-origin GitHub API proxy at `/api/github/*`.
- Leaderboard endpoints at `/api/leaderboard/repositories` and `/api/leaderboard/accounts`.
- A local semantic search endpoint at `/api/semantic-search`.
- Cache status at `/api/cache/status`.

For hosted static deployments, the app first tries same-origin API endpoints and then falls back to pre-exported leaderboard JSON in `data/leaderboards`. Trends always load from `data/leaderboards/trends.json`. Outside localhost, semantic search calls the deployed Supabase Edge Function directly.

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

`.env.local` and `.supabase-secrets.local` are both loaded by local Node scripts. `OPENAI_API_KEY` can also be supplied as `STARBOARD_OPENAI_API_KEY` for scripts that support the production secret name.

Run the local server:

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:4176
```

The semantic dashboard is available locally at:

```text
http://127.0.0.1:4176/semantic-dashboard.html
```

## Data Model

Starboard stores repository, account, snapshot, search-document, embedding, rejection, discovery-query, and ingestion-run data in Supabase Postgres. Semantic search uses the `pgvector` extension with 1024-dimensional embeddings by default.

The main indexed data flow is:

1. Seed or update schema and discovery queries.
2. Discover repositories from GitHub Search partitions.
3. Refine repository language quality from descriptions and README text.
4. Build semantic search documents and embeddings.
5. Refresh enriched all-time account data.
6. Build cached leaderboard snapshots.
7. Export static leaderboard JSON.
8. Build trend clusters from the top Today and Week repository snapshots.
9. Export semantic dashboard data.
10. Build the static deployment artifact.

GitHub Search exposes only a bounded result window for each query, so discovery uses multiple partitions: all-time star buckets, rolling created-date windows, and language buckets.

Period definitions:

- Today: starred repositories created in the last 24 hours.
- Week: starred repositories created in the last 7 days.
- Month: starred repositories created in the last 30 days.
- All time: starred repositories overall.
- Trends: clusters generated from the top Today and Week repository snapshots.

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

Run a larger semantic backfill:

```bash
npm run backfill:semantic-index
```

Report semantic coverage:

```bash
npm run report:semantic-coverage
```

Export semantic dashboard data:

```bash
npm run export:semantic-dashboard
```

Build leaderboard snapshots:

```bash
npm run build:snapshots
```

Build trend clusters:

```bash
npm run build:trends
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
- Active semantic searches default to star-sorted semantic matches.
- Clicking Stars, Forks, or Repos sorts within the semantic match pool, with semantic score used as a tie-breaker by the repository queries.
- Keyword-only fallback rows are appended after semantic rows when available.
- Repository and account results are filtered for unsafe metadata before display.

The semantic backfill workflow records build and backfill runs in `ingestion_runs`, records quality rejections in `repository_semantic_rejections`, and exports dashboard data to `data/semantic-dashboard.json`.

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

## Trends

`npm run build:trends` reads `data/leaderboards/repositories-today.json` and `data/leaderboards/repositories-week.json`, deduplicates the top repositories, and writes `data/leaderboards/trends.json`.

Trend generation uses `OPENAI_API_KEY` or `STARBOARD_OPENAI_API_KEY` when available. If the model call fails or no API key is configured, the script falls back to heuristic trend buckets.

Useful environment variables:

```bash
STARBOARD_TREND_MODEL=gpt-5.4-mini
STARBOARD_TREND_REQUEST_TIMEOUT_MS=20000
```

## Quality Gates

Repository discovery stores an English-script heuristic status using GitHub descriptions and README text. Repositories whose README or description are predominantly Chinese, Japanese, Korean, Cyrillic, Arabic, Hebrew, Devanagari, or Thai are rejected from snapshots. Repository discovery, semantic indexing, database queries, and the browser UI also filter spam and unsafe-content metadata keywords before those repositories are shown or embedded.

## Font Attribution

The `STARBOARD` hero uses a local Fira Mono regular font file. Fira Mono is distributed under the SIL Open Font License. The hero wordmark is static ASCII art rendered with layered `<pre>` blocks.

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

The app is also usable as static files on GitHub Pages:

```text
https://richling98.github.io/starboard/
```

The repository includes `.github/workflows/starboard-index.yml` and `.github/workflows/starboard-semantic-backfill.yml`.

Required GitHub repository secrets:

```bash
STARBOARD_GITHUB_TOKEN=your_github_token
STARBOARD_DATABASE_URL=your_supabase_postgres_uri
STARBOARD_OPENAI_API_KEY=your_openai_api_key
```

`starboard-index.yml` runs on `push`, on a schedule every 6 hours, and manually. Scheduled and manual runs perform the full refresh path and commit generated leaderboard data:

```bash
npm run setup:db
npm run discover:repos
npm run refine:language
npm run build:semantic-index
npm run refresh:all-time-accounts
npm run build:snapshots
npm run export:static-data
npm run build:trends
```

On `push`, the same workflow runs schema setup and static-data export, but skips the heavy GitHub/OpenAI refresh steps and generated-data commit.

`starboard-semantic-backfill.yml` runs on a separate schedule every 6 hours and manually. It backfills semantic embeddings, reports coverage, exports `data/semantic-dashboard.json`, refreshes static leaderboard data, builds the static artifact, and commits generated dashboard data.
