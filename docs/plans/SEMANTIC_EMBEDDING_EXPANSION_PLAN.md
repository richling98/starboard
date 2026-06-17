# Semantic Embedding Expansion Plan

## Executive Summary

Starboard's semantic search is working, but the index is still too small. We currently have a little over 100 embedded repositories, so searches only feel good when the embedded pool happens to contain relevant projects. The goal of this plan is to expand the semantic index in a controlled way so searches like "agentic coding projects", "terminal developer tools", and "AI coding assistant" have enough real projects to rank.

The safest MVP path is not to embed everything immediately. Instead, we should expand in staged passes:

1. Add better logging so every embedding run records exact token usage, estimated OpenAI cost, candidate counts, skipped rows, GitHub requests, and quality-filter rejects.
2. Add a pre-embedding quality filter to avoid spending embeddings on obvious spam, cracked software, activation-key repos, empty repos, and repos with very weak metadata.
3. Raise the scheduled semantic indexing limit from `50` to `500` candidates per run.
4. Review search quality and cost after one or two runs.
5. If quality improves and runtime stays reasonable, raise to `1,000` or `2,000` candidates per run.

At current observed document sizes, OpenAI embedding cost is extremely low. The 50-candidate run was roughly $0.0004, so a 500-candidate run should be roughly $0.004, and a 2,000-candidate run should be roughly $0.016, assuming similar README lengths. The real constraint is GitHub API/readme fetching and result quality, not OpenAI cost.

This plan keeps Starboard honest: semantic search will improve as the index grows, but we should also show or track semantic coverage internally so we know whether odd results are caused by poor search or just not enough embedded data yet.

One important product requirement: search must still work for repositories that do not have embeddings yet. The app should use semantic search for embedded repositories, but it should also continue keyword matching across the non-embedded data already loaded for the active tab. Expanding embeddings should improve search quality over time without making unembedded repositories invisible.

## Current State

- Semantic search endpoint is live through Supabase Edge Functions.
- Embeddings are stored in Supabase `repository_embeddings` using `text-embedding-3-small` at 1024 dimensions.
- Search documents are stored in `repository_search_documents`.
- Each document currently includes:
  - repo full name
  - repo name
  - description
  - topics
  - cleaned README text
- The GitHub Actions workflow currently sets:
  - `STARBOARD_SEMANTIC_LIMIT=50`
  - `STARBOARD_SEMANTIC_BATCH_SIZE=25`
- The index build script skips unchanged repos by comparing content hashes.
- The current candidate selector prioritizes repos missing documents/embeddings, then recent created repos, then stars.

## Goals

- Improve semantic search quality across all tabs and views.
- Expand coverage beyond the first 125 embedded repos.
- Preserve keyword search coverage for repos and accounts that are not embedded yet.
- Avoid embedding obvious low-quality repos.
- Stay comfortably inside GitHub and OpenAI limits.
- Keep each scheduled workflow run reliable.
- Make costs and coverage visible after every run.

## Non-Goals

- Do not build a full custom crawler yet.
- Do not embed all public GitHub repos.
- Do not switch embedding providers yet.
- Do not introduce a separate vector database; Supabase `pgvector` is enough for this stage.
- Do not require users to authenticate before searching.
- Do not make semantic search the only way a repo can be found while the embedding index is incomplete.

## Phase 1: Add Run Accounting

Before increasing volume, update the embedding pipeline to record exact usage.

### Changes

- Update `embeddings.mjs` so `createEmbeddings` returns:
  - vectors
  - `prompt_tokens`
  - `total_tokens`
  - model
  - dimensions
- Update `scripts/build-semantic-index.mjs` summary metadata to include:
  - `embeddingTokens`
  - `estimatedEmbeddingCostUsd`
  - `embeddingRequests`
  - `averageCharsPerDocument`
  - `averageTokensPerDocument`
  - `qualityRejected`
  - `skippedUnchanged`
- Keep recording this in `ingestion_runs.metadata`.

### Verification

Run:

```bash
npm run build:semantic-index -- --limit=10 --batch-size=10
```

Then verify:

```sql
select status, metadata
from ingestion_runs
where job_type = 'build-semantic-index'
order by started_at desc
limit 1;
```

Expected result: metadata includes exact token counts and cost estimate.

## Phase 2: Add A Pre-Embedding Quality Gate

Right now we risk embedding repos that are popular briefly but not useful for discovery. We should reject obvious low-signal repos before fetching README and embedding.

### Initial Reject Rules

Reject repos when any of these are true:

- `archived = true`
- `fork = true`
- `stars < 1`
- `english_check_status = 'rejected'`
- repo name/full name/topics contain obvious spam terms:
  - `activation`
  - `crack`
  - `keygen`
  - `license-key`
  - `unlock`
  - `premium-unlocked`
  - `serial-key`
  - `free-download`
- description is empty and topics are empty and stars are below a small threshold, for example `< 10`
- README fetch returns empty text and description is empty and topics are empty

### Keep The Filter Conservative

The filter should not reject a repo just because it is small or new. It should reject obvious junk only. The goal is to avoid spending semantic budget on repos that make search results feel polluted.

### Implementation Shape

- Add `quality-filter.mjs`.
- Export `evaluateRepositoryQuality(repo, document?)`.
- Add a lightweight `repository_semantic_rejections` table so rejected repos do not consume the embedding budget every scheduled run.
- Return a structured result:

```js
{
  accepted: true,
  reason: "accepted"
}
```

or:

```js
{
  accepted: false,
  reason: "spam_keyword"
}
```

- Store aggregate reject counts in `ingestion_runs.metadata.qualityRejectsByReason`.
- Store per-repo rejection reason/model in Supabase and retry only if the repo changes later.

### Verification

Run a small dry pass and inspect rejected reasons:

```bash
npm run build:semantic-index -- --limit=50 --batch-size=25
```

Then verify the latest ingestion metadata includes a reasonable reject count and no unexpected mass rejection.

## Phase 3: Improve Candidate Priority

The current selector mostly prioritizes missing embeddings and then recent repos. That helps new tabs, but it is not ideal for all-time semantic search.

### Proposed Priority

Select candidates in this order:

1. Repos that appear in current leaderboard snapshots and are not embedded.
2. High-star all-time repos that are not embedded.
3. Recent day/week/month repos that are not embedded.
4. Existing embedded repos whose document hash is stale.

### Why

This gives semantic search broad usefulness quickly:

- all-time searches get strong canonical repos
- today/week/month searches still improve
- stale repos get refreshed without crowding out never-embedded repos

### Implementation Shape

- Update `readRepositoriesForSemanticIndex` to accept a `strategy`.
- Default strategy: `balanced`.
- Balanced strategy should order by:
  - missing embedding first
  - snapshot presence first
  - stars descending
  - recent created date descending
  - full name ascending

Potential future strategies:

- `recent`
- `all-time`
- `stale`
- `backfill`

## Phase 4: Raise Scheduled Embedding Limit To 500

Once Phase 1 and Phase 2 are in place, change GitHub Actions:

```yaml
STARBOARD_SEMANTIC_LIMIT: "500"
STARBOARD_SEMANTIC_BATCH_SIZE: "50"
```

Keep README text capped:

```yaml
STARBOARD_README_CHAR_LIMIT: "16000"
```

### Expected Cost

Based on the observed 50-candidate run:

- 50 candidates: about 20k tokens, about $0.0004
- 500 candidates: about 200k tokens, about $0.004
- 2,000 candidates: about 800k tokens, about $0.016

These are estimates until Phase 1 adds exact token logging.

### GitHub API Impact

Each candidate can cost roughly one GitHub API request for README metadata plus one README download. With authenticated GitHub API requests, 500 candidates per six-hour run should be comfortable. The workflow also does repository discovery, language refinement, all-time account refresh, and static export, so we should observe a full run before increasing further.

## Phase 5: Test Search Quality On The Website

After the 500-candidate run completes, test these queries on the live website:

### Repos, All Time

- `terminal developer tools`
- `agentic coding projects`
- `ai coding assistant`
- `browser automation tools`
- `local database`
- `observability dashboard`

### Repos, Today/Week/Month

- `video downloader`
- `AI image generation`
- `developer productivity`
- `automation scripts`
- `database tools`

### Accounts, All Time

- `frontend infrastructure`
- `AI developer tools`
- `database companies`
- `cloud deployment platforms`

### Good Result Criteria

- Results do not need exact keyword matches.
- Results should be plausibly related to the query.
- Obvious spam/crackware should be rare.
- "Load more" should continue within the semantic result set.
- Switching tabs should re-run semantic search for the active tab.

## Phase 6: Preserve Keyword Search For Unembedded Rows

Even after increasing the embedding limit, many repositories will not have embeddings yet. Search should therefore be hybrid during the MVP stage.

### Required Behavior

When the user searches within a tab:

1. Query the semantic endpoint for embedded matches.
2. Also run keyword search across the active tab's available static/client-side dataset.
3. Merge the two result sets.
4. Deduplicate by repo ID or account ID.
5. Rank semantic matches first by semantic score.
6. Include keyword-only matches after semantic matches, sorted by the current table sort where possible.
7. Clearly avoid showing duplicate rows.

This means a repository can still appear in search results even if it has not been embedded yet, as long as its name, description, topics, owner, or available static fields match the user's query.

### Repository Search

For repos:

- Semantic search should cover embedded repo name, description, topics, and README.
- Keyword search should cover the static repo fields available in the frontend:
  - repo name
  - full name
  - owner
  - description
  - topics
  - language if still available in data

Keyword-only results will not search README content unless the README is present in the static dataset, which it currently is not. That is acceptable for the MVP because README semantic search is available as repos become embedded.

### Account Search

For accounts:

- Semantic account results should come from grouped embedded repositories.
- Keyword fallback should still search static account fields:
  - account name
  - login
  - qualifying repo names/descriptions already present in the account row

### UI Behavior

Search should not visibly split into two modes. The user should just see one list.

Optional debug/status text can say something like:

```text
Semantic + keyword results
```

or:

```text
Semantic results with keyword fallback
```

Do not over-explain this in the polished UI.

### Verification

Use two kinds of test queries:

1. Semantic queries that should match embedded rows:
   - `video downloader`
   - `AI coding assistant`

2. Exact keyword queries for a known unembedded repo/account:
   - pick a repo from the active tab that has no row in `repository_embeddings`
   - search for part of its exact name
   - confirm it still appears

SQL to find a known unembedded repo:

```sql
select r.full_name, r.name, r.description
from repositories r
left join repository_embeddings e on e.repo_github_id = r.github_id
where e.repo_github_id is null
  and r.stars >= 1
  and r.english_check_status <> 'rejected'
order by r.stars desc
limit 20;
```

Then test one of those repo names in the website search bar.

## Phase 7: Increase To 1,000 Or 2,000 If Healthy

Only increase after reviewing:

- GitHub Actions runtime
- failed README fetches
- OpenAI token usage
- Supabase query latency
- search result quality
- spam rate

Recommended next increments:

1. `500` candidates/run for one or two runs.
2. `1,000` candidates/run if runtime is stable.
3. `2,000` candidates/run if search quality still needs more coverage and workflow runtime remains under the 45-minute timeout.

Do not jump straight to very high limits until the quality gate is proven.

## Phase 8: Add Semantic Coverage Reporting

Add internal visibility so we know how complete the index is.

### Metrics To Track

- total repositories in Supabase
- total repositories with embeddings
- embedded repos by period eligibility:
  - today
  - week
  - month
  - all
- embedded repos by account/repo view
- last semantic index run status
- last semantic token usage and estimated cost

### Where To Show It

For now, keep this out of the polished UI. Add it to:

- ingestion run metadata
- a local command/script
- optionally a hidden debug endpoint later

## Rollback Plan

If the 500-candidate run causes problems:

1. Set `STARBOARD_SEMANTIC_LIMIT` back to `50`.
2. Keep the existing embeddings in Supabase; they do not hurt anything.
3. If spam polluted the index, delete only embeddings/documents matching rejected repos after validating the filter.
4. Re-run snapshots and static export.

## Approval Checklist

Before execution, confirm:

- Increase semantic run size to `500`.
- Add quality filtering before embedding.
- Add exact token/cost logging.
- Improve candidate priority toward high-signal leaderboard repos.
- Preserve keyword fallback for unembedded repos and accounts.
- Keep current model: `text-embedding-3-small`.
- Keep current dimensions: `1024`.
- Do not expose any secrets in logs.

## Recommended Approval

Approve Phases 1 through 6 now. They are low-cost, reversible, and directly address why only some semantic queries feel good today while making sure unembedded repositories remain searchable.

Hold Phases 7 and 8 as follow-up work after we inspect one or two 500-candidate runs.
