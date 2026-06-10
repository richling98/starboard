# Starboard

Starboard is a static MVP prototype for a polished GitHub discovery dashboard.

Run the local server so GitHub API requests use the token in `.env.local`:

```bash
npm run dev
```

Then visit `http://127.0.0.1:4176`.

Create `.env.local` with:

```bash
GITHUB_TOKEN=your_github_token
DATABASE_URL=your_supabase_postgres_uri
OPENAI_API_KEY=your_openai_api_key
```

## Current Prototype

- Period toggles for Today, Week, Month, and All time
- Supabase-backed repository and account snapshots for Today, Week, Month, and All time
- GitHub-backed discovery jobs that expand the Supabase index over time
- AI semantic search over repository names, descriptions, and cleaned README text
- `Load more` pagination that shows 20 repositories at a time
- GitHub Search requests batched at 100 repositories per page to reduce rate-limit pressure
- `Repos | Accounts` leaderboard switch
- Account leaderboard aggregates fetched repositories by GitHub owner
- Expandable account rows that show the fetched repositories contributing to each account score
- English-only repository gate based on description and README text
- Supabase Edge Function search endpoint backed by `pgvector`
- Black-and-white table layout with rank, repository, stars, forks, and one `Visit repo` action
- Search and compact-view controls
- Sortable Stars and Forks columns
- Responsive desktop and mobile layout
- Local Fira Mono font and layered ASCII art for the terminal title treatment

## Data Notes

This local prototype serves a small same-origin GitHub API proxy from `server.mjs`. The browser calls `/api/github/*`, and the server adds `Authorization: Bearer GITHUB_TOKEN` from `.env.local`. Do not expose the token in frontend JavaScript.

Starboard now prefers Supabase snapshots for leaderboard reads. The browser asks the local server for `/api/leaderboard/repositories` or `/api/leaderboard/accounts`, and the server returns cached snapshot rows from Supabase. If a repository snapshot is missing during local development, the app can still fall back to the older live GitHub Search path.

GitHub Search still exposes up to the first 1,000 results for a single query, so Starboard expands coverage by splitting discovery into query partitions. The seeded partitions include all-time star buckets, rolling created-date searches for Today/Week/Month, and several language buckets.

The Accounts view is generated from Supabase snapshots. Today, Week, and Month account scores sum stars from qualifying indexed repos created in the selected rolling period. All time accounts use enriched account rows when available and repository rollups for newly indexed owners.

Initialize or update the Supabase schema and seed discovery queries with:

```bash
npm run setup:db
```

If you have a local `.cache/all-time-accounts.json`, import it into Supabase with:

```bash
npm run import:cache
```

Run repository discovery from GitHub partitions with:

```bash
npm run discover:repos
```

Useful bounded local runs:

```bash
npm run discover:repos -- --max-queries=18 --max-pages=1
npm run discover:repos -- --period=week --max-pages=2
```

Build cached leaderboard snapshots after discovery:

```bash
npm run build:snapshots
```

Build or refresh the older enriched all-time account cache with:

```bash
npm run refresh:all-time-accounts
```

For a deeper seed set:

```bash
STARBOARD_SEED_PAGES=5 npm run refresh:all-time-accounts
```

The refresh job stores cached account rows in Supabase Postgres when `DATABASE_URL` is present and also keeps `.cache/all-time-accounts.json` as a local fallback. It skips accounts refreshed in the last 24 hours unless you pass `-- --force`, and it spaces GitHub Search requests to stay under rate limits.

Run the full local indexing pipeline with:

```bash
npm run index:github
```

The pipeline runs setup, repository discovery, README language refinement, all-time account enrichment, and snapshot generation. For the first pass, keep `STARBOARD_MAX_PAGES=1` or pass `-- --max-pages=1` so the index grows safely without heavy GitHub API usage.

Build semantic search documents and embeddings with:

```bash
npm run build:semantic-index
```

The semantic index stores one embedding per repository in Supabase `pgvector`. It uses `text-embedding-3-small` with 1024 dimensions by default and skips unchanged documents using a content hash.

Check the cache status with:

```bash
curl http://127.0.0.1:4176/api/cache/status
```

The MVP period definitions are:

- Today: starred repositories created in the last 24 hours
- Week: starred repositories created in the last 7 days
- Month: starred repositories created in the last 30 days
- All time: starred repositories overall

Repository discovery stores an English-script heuristic status using the GitHub description and README text. A stray non-English character is allowed, but repos whose README/description are predominantly Chinese, Japanese, Korean, Cyrillic, Arabic, Hebrew, Devanagari, or Thai are rejected. Snapshot generation excludes repos that are confidently rejected as non-English.

## Scheduled Indexing

The repository includes `.github/workflows/starboard-index.yml`. Once this project is pushed to GitHub, add these repository secrets:

```bash
STARBOARD_GITHUB_TOKEN=your_github_token
STARBOARD_DATABASE_URL=your_supabase_postgres_uri
STARBOARD_OPENAI_API_KEY=your_openai_api_key
```

The workflow runs every 6 hours and can also be started manually from GitHub Actions. It runs:

```bash
npm run setup:db
npm run discover:repos
npm run refine:language
npm run build:semantic-index
npm run refresh:all-time-accounts
npm run build:snapshots
```

## Semantic Search Edge Function

The production GitHub Pages site calls a Supabase Edge Function for semantic search:

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

The function embeds the user query server-side, calls the `match_semantic_repositories` RPC, and returns matching repository or account rows for the active period.

## Next Build Step

Increase semantic index coverage gradually, tune similarity thresholds with real searches, and consider README chunk embeddings if repo-level embeddings miss specific README-only matches.

## Font Attribution

The `STARBOARD` hero uses a local Fira Mono regular font file. Fira Mono is distributed under the SIL Open Font License. The hero wordmark is static ANSI Shadow-style ASCII art rendered with layered `<pre>` blocks, matching the structure used by `skills.sh`.
