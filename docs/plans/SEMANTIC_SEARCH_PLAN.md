# Starboard Semantic Search Plan

## Executive Summary

Starboard search is currently keyword-based. It checks whether the typed text appears in the already-loaded repository/account rows. That is useful for exact matches, but it will not understand intent. A search like `Open Claw competitors`, `agentic projects`, or `terminal emulator` only works when those exact words appear in the visible data.

The right implementation is to add an AI semantic search index on the backend. For every indexed repository, Starboard will store a searchable text document built from:

1. Repository title/name
2. GitHub description
3. Cleaned README text

The backend will convert those documents into embeddings and store them in Supabase Postgres with `pgvector`. When a user searches, the backend will embed the query, compare it against all repositories in the active tab, and return the closest semantic matches. This means search will apply to the full cached dataset for the selected tab, not just the first 20 rows visible on screen.

The browser should not call the AI embedding provider directly because that would expose the API key. Since the production site is currently deployed on GitHub Pages, which cannot run private server code, we need one secure backend surface for semantic search. The cleanest MVP is a Supabase Edge Function or hosted Node API that receives the query, creates the query embedding, runs the vector search in Supabase, and returns matching rows.

## Current State

### Frontend

Current search is handled in `app.js`:

- `getFilteredRepos()` filters `store.fetchedRepos` with `searchText.includes(query)`.
- `filterAccountRows()` filters accounts with `searchText.includes(query)`.
- The search input updates `state.query` and immediately rerenders.
- Loaded rows are capped by the cached snapshot payload, and the UI only reveals 20 rows at a time.

### Backend/Data

Current data lives in Supabase tables created in `db.mjs`:

- `repositories`
- `accounts`
- `leaderboard_snapshots`
- `ingestion_runs`
- `discovery_queries`

Current leaderboard reads use `readLeaderboardSnapshot(...)`, which filters snapshot JSON with keyword matching. Snapshot rows are exported to static JSON for GitHub Pages.

### README Handling

README text is already fetched for language filtering, but it is not stored as searchable text and is not embedded. Semantic search needs to persist a cleaned README excerpt/summary so we do not refetch README files every time we build embeddings.

## Product Requirements

### Repository Search

When the user is on the `Repos` view and enters a query:

- Search only repositories eligible for the active tab:
  - `Today`: repos created in the last 24 hours
  - `Week`: repos created in the last 7 days
  - `Month`: repos created in the last 30 days
  - `All time`: all indexed repos
- Search across all indexed rows in that tab, not only the visible 20.
- Match meaning, not just exact words.
- Use repository name, description, and README text.
- Return results ordered by semantic relevance by default.
- Preserve optional column sorting after search:
  - Stars high/low
  - Forks high/low

### Account Search

When the user is on the `Accounts` view and enters a query:

- Search accounts based on the repositories that contribute to that account in the active tab.
- For example, in `Today`, an account should match `agentic projects` only if one or more of its qualifying repos created in the last 24 hours semantically match that query.
- Account score in semantic search should combine:
  - Best matching repo relevance
  - Number of matching repos
  - Existing star score as a tie-breaker
- Expanding an account should show the matching qualifying repos first.

### Empty Search

When the search box is empty:

- Keep the current leaderboard behavior.
- Keep normal ranking by stars.
- Keep current `Load more` behavior.

### Search States

The UI should clearly show:

- `Searching...` while semantic search is running.
- `Semantic search unavailable. Showing keyword matches.` if the backend is down.
- `No semantic matches found.` if the query returns nothing.
- `Showing semantic matches for "{query}" in {period}.` when results are returned.

## Architecture

### Recommended MVP Architecture

```text
GitHub Pages UI
  |
  | POST /semantic-search
  v
Secure backend function
  - validates request
  - embeds query with AI provider
  - calls Supabase vector search RPC
  - returns rows
  |
  v
Supabase Postgres
  - repositories
  - repository_search_documents
  - repository_embeddings
  - leaderboard snapshots
```

The secure backend can be either:

1. Supabase Edge Function
2. Hosted Node endpoint

For this project, Supabase Edge Function is the best fit because we already use Supabase for Starboard data. The deployed GitHub Pages app can call the Edge Function by URL, while the AI provider key stays in Supabase function secrets.

## Data Model Changes

### Enable Vector Support

Add this to `ensureSchema()`:

```sql
create extension if not exists vector;
```

This may require enabling `pgvector` in the Supabase project. If Supabase rejects the extension command, we enable it from the Supabase dashboard once.

### New Table: `repository_search_documents`

Stores cleaned searchable text and change tracking.

```sql
create table if not exists repository_search_documents (
  repo_github_id bigint primary key references repositories(github_id) on delete cascade,
  full_name text not null,
  title_text text not null,
  description_text text,
  readme_text text,
  combined_text text not null,
  content_hash text not null,
  readme_fetched_at timestamptz,
  document_updated_at timestamptz not null default now()
);
```

Indexes:

```sql
create index if not exists repository_search_documents_full_name_idx
  on repository_search_documents (full_name);
```

### New Table: `repository_embeddings`

Stores one repo-level embedding for MVP search.

```sql
create table if not exists repository_embeddings (
  repo_github_id bigint primary key references repositories(github_id) on delete cascade,
  embedding vector(1536) not null,
  embedding_model text not null,
  content_hash text not null,
  embedded_at timestamptz not null default now()
);
```

Notes:

- The vector dimension depends on the embedding model. If we choose a model with a different dimension, this schema must match it.
- Store `embedding_model` so we can re-embed later if we change models.
- Store `content_hash` so the job only re-embeds changed documents.

### Optional Later Table: `repository_readme_chunk_embeddings`

The MVP should start with one embedding per repo. If README matching feels too broad or misses details, add chunk-level embeddings later.

```sql
create table if not exists repository_readme_chunk_embeddings (
  id bigserial primary key,
  repo_github_id bigint not null references repositories(github_id) on delete cascade,
  chunk_index integer not null,
  heading text,
  chunk_text text not null,
  embedding vector(1536) not null,
  embedding_model text not null,
  content_hash text not null,
  embedded_at timestamptz not null default now(),
  unique (repo_github_id, chunk_index, content_hash)
);
```

## Search Document Construction

Create a shared module, for example `search-document.mjs`, that builds the text used for embeddings.

### Input Fields

For each repository:

- `full_name`
- `owner_login`
- `name`
- `description`
- `topics`
- cleaned README excerpt

### Combined Text Format

Use a consistent structure:

```text
Repository: owner/name
Name: repo-name
Description: GitHub description
Topics: topic-one, topic-two
README:
cleaned readme excerpt
```

### README Cleaning

Reuse and extend the existing markdown cleaning from `language-gate.mjs`, but keep this separate enough that language filtering and search indexing can evolve independently.

Cleaning rules:

- Strip code blocks.
- Strip badges and image links.
- Strip raw URLs.
- Strip huge tables.
- Strip installation logs when obvious.
- Keep headings and explanatory paragraphs.
- Cap README text to a bounded size, initially 12,000-20,000 cleaned characters.

### Hashing

Compute a stable hash from:

- title text
- description
- topics
- cleaned README text

If the hash has not changed, skip re-embedding.

## Indexing Pipeline

Add a new script:

```text
scripts/build-semantic-index.mjs
```

Add package script:

```json
"build:semantic-index": "node scripts/build-semantic-index.mjs"
```

### Script Responsibilities

1. Load `.env.local`.
2. Read candidate repositories from Supabase.
3. Fetch README only when needed.
4. Build/refresh `repository_search_documents`.
5. Embed changed documents.
6. Upsert `repository_embeddings`.
7. Log an `ingestion_runs` row with counts and failures.

### Candidate Selection

The first MVP should index:

- repos with `stars >= 1`
- `fork = false`
- `archived = false`
- `english_check_status <> 'rejected'`

Prioritize:

1. Repos in current leaderboard snapshots
2. Recently created repos
3. Highest-star repos
4. Repos with missing or stale search documents

### Batching

Do not embed everything in one request.

Recommended defaults:

- `STARBOARD_SEMANTIC_LIMIT=500`
- `STARBOARD_SEMANTIC_BATCH_SIZE=50`
- `STARBOARD_README_CHAR_LIMIT=16000`

This lets the cron job gradually grow coverage without blowing through API limits.

### Failure Handling

For each repo:

- If README fetch fails, still index title + description.
- If embedding fails, leave the previous embedding untouched.
- If a repo has no meaningful text, skip it and record why.
- Never block the whole pipeline on a single bad repo.

## Vector Search SQL

Add a database function/RPC for repository search.

Example shape:

```sql
create or replace function search_repositories_semantic(
  query_embedding vector(1536),
  target_period text,
  match_limit integer default 100,
  min_similarity double precision default 0.2
)
returns table (
  github_id bigint,
  full_name text,
  similarity double precision
)
language sql
stable
as $$
  select
    r.github_id,
    r.full_name,
    1 - (e.embedding <=> query_embedding) as similarity
  from repository_embeddings e
  join repositories r on r.github_id = e.repo_github_id
  where r.stars >= 1
    and r.fork = false
    and r.archived = false
    and r.english_check_status <> 'rejected'
    and (
      target_period = 'all'
      or (target_period = 'today' and r.repo_created_at >= now() - interval '1 day')
      or (target_period = 'week' and r.repo_created_at >= now() - interval '7 days')
      or (target_period = 'month' and r.repo_created_at >= now() - interval '30 days')
    )
    and 1 - (e.embedding <=> query_embedding) >= min_similarity
  order by e.embedding <=> query_embedding asc, r.stars desc, r.full_name asc
  limit match_limit;
$$;
```

Add an index:

```sql
create index if not exists repository_embeddings_embedding_idx
  on repository_embeddings
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
```

For small datasets, exact search is acceptable first. Add the vector index once table size grows.

## Semantic Search API

Add a secure endpoint:

```text
POST /semantic-search
```

Request:

```json
{
  "query": "Open Claw competitors",
  "period": "all",
  "view": "repositories",
  "limit": 100,
  "offset": 0,
  "sortKey": "relevance",
  "sortDirection": "desc"
}
```

Response for repositories:

```json
{
  "mode": "semantic",
  "query": "Open Claw competitors",
  "period": "all",
  "view": "repositories",
  "total": 84,
  "rows": [
    {
      "rank": 1,
      "semanticScore": 0.82,
      "fullName": "owner/repo",
      "name": "repo",
      "description": "short description",
      "stars": 12345,
      "forks": 321,
      "repoUrl": "https://github.com/owner/repo"
    }
  ]
}
```

Response for accounts:

```json
{
  "mode": "semantic",
  "query": "agentic projects",
  "period": "month",
  "view": "accounts",
  "total": 20,
  "rows": [
    {
      "rank": 1,
      "semanticScore": 0.78,
      "login": "example-org",
      "starScore": 42000,
      "repoCount": 3,
      "matchingRepos": [
        {
          "fullName": "example-org/agent-framework",
          "semanticScore": 0.78,
          "stars": 28000
        }
      ]
    }
  ]
}
```

### Backend Query Rules

For repository view:

1. Embed query.
2. Search `repository_embeddings`.
3. Fetch full repository rows.
4. Return all matches for requested `limit/offset`.

For account view:

1. Embed query.
2. Search qualifying repositories for the active period.
3. Group matching repos by owner.
4. Score each account:
   - `max(repo_similarity)` as primary relevance
   - `sum(stars of matching repos)` as secondary score
   - `matching repo count` as supporting metadata
5. Return account rows with matching repos attached.

## Frontend Changes

### State Additions

Add:

```js
state.searchMode = "keyword" | "semantic";
state.semanticQuery = "";
state.semanticLoading = false;
state.semanticError = "";
state.semanticResults = {
  repositories: {},
  accounts: {}
};
```

Key results by:

```text
{view}:{period}:{query}:{sortKey}:{sortDirection}
```

### Input Handling

Replace instant local filtering with debounced semantic search:

- Debounce by 350-500ms.
- If query length is `0`, clear semantic state and show normal leaderboard.
- If query length is `1-2`, use local keyword filtering only.
- If query length is `3+`, call semantic endpoint.

### Load More Behavior

Semantic search must load from the full result set, not from visible rows.

Implementation:

- Search request uses `limit=100` initially.
- UI reveals 20 at a time from returned results.
- If user clicks `Load more` beyond the local semantic result buffer, request the next `offset`.
- `Load more` should continue to work the same way visually.

### Sorting Behavior

When semantic search is active:

- Default sort: relevance.
- Clicking `Stars` sorts the semantic result set by stars.
- Clicking `Forks` sorts repository results by forks.
- Clicking `Repos` sorts account results by repo count.
- Switching sort should request/reorder the semantic results for the same query.

### Fallback Behavior

If semantic API fails:

- Keep the current keyword search as fallback.
- Show a small status message.
- Do not break the leaderboard.

### Search Placeholder

Update placeholder from:

```text
Search repos, topics, owners
```

to:

```text
Search semantically: agentic projects, terminal tools...
```

## Deployment Changes

### Required Secrets

Add to Supabase Edge Function or hosted backend:

```text
OPENAI_API_KEY or EMBEDDING_PROVIDER_API_KEY
DATABASE_URL or SUPABASE_SERVICE_ROLE_KEY
```

Do not expose these in GitHub Pages or client JavaScript.

### GitHub Actions

Update `.github/workflows/starboard-index.yml`:

1. Run `npm run build:semantic-index` after README language refinement.
2. Keep semantic indexing bounded with env vars:

```yaml
STARBOARD_SEMANTIC_LIMIT: "500"
STARBOARD_SEMANTIC_BATCH_SIZE: "50"
```

3. Store embedding provider key as a GitHub secret if indexing runs in GitHub Actions.

### Production API URL

Add a public config value in `app.js`:

```js
const SEMANTIC_SEARCH_ENDPOINT = "https://...supabase.co/functions/v1/starboard-semantic-search";
```

For local development, use:

```text
http://127.0.0.1:4176/api/semantic-search
```

## Implementation Phases

### Phase 1: Database + Document Storage

Files:

- `db.mjs`
- `search-document.mjs`
- `scripts/setup-db.mjs`

Tasks:

- Enable vector extension.
- Add `repository_search_documents`.
- Add `repository_embeddings`.
- Add helper functions for upserting documents/embeddings.
- Add repository text builder.

Verification:

- `npm run setup:db`
- Confirm new tables exist.
- Build one sample search document for a known repo.

### Phase 2: Semantic Indexing Job

Files:

- `scripts/build-semantic-index.mjs`
- `package.json`
- `.github/workflows/starboard-index.yml`

Tasks:

- Select candidate repos.
- Fetch README if missing/stale.
- Build cleaned combined text.
- Generate embeddings in batches.
- Upsert embeddings only when content hash changes.
- Add job metrics to `ingestion_runs`.

Verification:

- Run `STARBOARD_SEMANTIC_LIMIT=25 npm run build:semantic-index`.
- Confirm 25 documents and embeddings are stored.
- Re-run and confirm unchanged rows are skipped.

### Phase 3: Backend Semantic Search API

Files:

- `server.mjs` for local dev
- Supabase Edge Function or hosted API for production
- `db.mjs`

Tasks:

- Add local `/api/semantic-search`.
- Add production Edge Function.
- Embed user query server-side.
- Run vector search by active period.
- Return repository rows.
- Add account grouping for account view.

Verification:

- Query `terminal emulators` locally.
- Query `agentic projects` locally.
- Confirm results come from the active period only.
- Confirm query does not require visible rows to be loaded.

### Phase 4: Frontend Integration

Files:

- `app.js`
- `index.html`
- `styles.css`

Tasks:

- Debounce search input.
- Call semantic API for queries with 3+ characters.
- Render semantic result rows.
- Preserve 20-at-a-time reveal.
- Preserve sorting controls.
- Add loading/error/empty states.
- Keep keyword fallback.

Verification:

- Search in `Today / Repos`.
- Search in `Week / Repos`.
- Search in `Month / Accounts`.
- Search in `All time / Repos`.
- Confirm results are not limited to the first visible 20 rows.

### Phase 5: Production Rollout

Files:

- `.github/workflows/starboard-index.yml`
- `README.md`
- Supabase Edge Function config

Tasks:

- Add secrets.
- Deploy Edge Function/API.
- Run semantic index job.
- Deploy GitHub Pages frontend.
- Monitor GitHub Actions runtime.
- Monitor semantic endpoint errors.

Verification:

- Live GitHub Pages site can run semantic search.
- No secret appears in browser source/network requests.
- Search works after a hard refresh.
- If API is unavailable, keyword fallback works.

## Risks and Mitigations

### Risk: GitHub Pages Cannot Run Backend Code

Mitigation:

- Use Supabase Edge Function or hosted API for query embeddings.
- Keep GitHub Pages as static UI.

### Risk: Embedding Cost/API Usage

Mitigation:

- Store content hashes.
- Only embed new or changed documents.
- Batch embeddings.
- Cap per-run indexing with `STARBOARD_SEMANTIC_LIMIT`.

### Risk: README Content Is Too Noisy

Mitigation:

- Clean markdown before embedding.
- Cap README text.
- Start with repo-level embedding.
- Add chunk embeddings only if MVP quality is insufficient.

### Risk: Search Results Feel Too Broad

Mitigation:

- Use minimum similarity threshold.
- Tune threshold after testing real queries.
- Add lexical boost for title/name matches.
- Use stars as tie-breaker, not primary score.

### Risk: Account Search Is Ambiguous

Mitigation:

- Define account search as repo-derived.
- Show matching repos under each account.
- Do not embed account profile metadata for MVP.

### Risk: Static Export Cannot Include Semantic Search

Mitigation:

- Static JSON remains the normal leaderboard fallback.
- Semantic search requires the backend endpoint.
- If endpoint is down, fallback to current keyword behavior.

## Acceptance Criteria

The feature is ready when:

- A query like `agentic projects` returns relevant repos even when those exact words do not appear in the repo name.
- A query like `terminal emulators` searches README-enriched repo documents, not just descriptions.
- Searching in `All time / Repos` uses all indexed all-time repos, not only visible rows.
- Searching in `Today`, `Week`, and `Month` respects each time window.
- Account search groups semantically matching repos by owner and shows matching repos in the account dropdown.
- Search remains usable if semantic backend fails.
- No AI provider key is exposed to the browser.
- GitHub Actions can refresh embeddings incrementally without rebuilding the whole index every run.

## Proposed Build Order

1. Add schema and document storage.
2. Add a local embedding/indexing script.
3. Index a small batch and manually inspect quality.
4. Add local semantic API.
5. Wire the frontend to the local API.
6. Add production Supabase Edge Function.
7. Add GitHub Actions semantic indexing.
8. Deploy and test live.

## Open Decisions Before Implementation

1. Which embedding provider should we use first?
   - Recommended MVP: OpenAI embeddings because the API is straightforward and reliable.
   - Alternative: Supabase/gte-small or another hosted embedding provider if we want to minimize external dependencies.

2. Where should the production semantic API live?
   - Recommended MVP: Supabase Edge Function.
   - Alternative: Vercel/Render/other Node host.

3. How much of the README should be embedded in MVP?
   - Recommended MVP: cleaned first 12,000-20,000 characters.
   - Later: chunk long READMEs for deeper matching.

4. How many repositories should we embed per scheduled run?
   - Recommended MVP: 500 per run.
   - Increase after we measure runtime and embedding cost.
