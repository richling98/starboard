# Starboard Semantic Search Plan

## Goal

Upgrade Starboard search from keyword filtering to AI semantic search.

Example target behavior:

- User is on `Today`, `Week`, `Month`, or `All time`.
- User searches `terminal emulators`.
- Starboard returns repositories in that active tab that are semantically about terminal emulators, even if the repo name or description does not literally contain both words.

Search should consider:

1. Repository name
2. Owner/name
3. Short GitHub description
4. Topics, when available
5. README content, when available

## Key Feasibility Point

Real semantic search should not be implemented as a pure static-browser feature.

Reasons:

- Embedding/API keys must not be exposed in client-side JavaScript.
- Browser-only semantic models are possible but heavy, slower to load, harder to tune, and only search whatever rows are currently loaded.
- GitHub Search does not provide true semantic repo search over arbitrary README meaning.
- README content needs to be fetched, cleaned, chunked, embedded, cached, and refreshed. That belongs in a backend/indexing layer.

Recommended approach:

- Keep the current browser search as a fast fallback.
- Add a backend semantic index.
- Query that index from Starboard when the user types into the search box.

## Product Behavior

### Empty Search

When the search box is empty:

- Keep the existing leaderboard behavior.
- Respect active tab:
  - Today
  - Week
  - Month
  - All time
- Default ordering remains stars descending unless the user selected another sort.

### Semantic Search

When the user enters a search query:

- Debounce input by roughly 300-500ms.
- Send the query and active period to the backend semantic search endpoint.
- Return repositories that semantically match the query within the active tab.
- Default ordering becomes semantic relevance.
- If the user clicks `Stars` or `Forks`, sort the semantic result set by that metric.

Recommended UI copy:

```text
Semantic search for "terminal emulators" in Week
```

If the backend is unavailable:

```text
Semantic search unavailable. Showing keyword matches.
```

## Recommended Architecture

### Components

```text
frontend/
  Starboard UI

api/
  GET /api/repos
  GET /api/search

worker/
  ingest GitHub repositories
  fetch README files
  clean repository text
  create embeddings
  refresh stale records

db/
  repositories
  repository_texts
  repository_embeddings
  readme_chunks
```

### Recommended Storage

Use Postgres with a vector extension such as `pgvector`.

Why:

- Keeps repository metadata and vector search in one database.
- Allows filtering by period, stars, forks, English status, archived/fork status, and vector similarity in one query.
- Works well enough for MVP scale and can later migrate to a dedicated vector database if needed.

## Data Model

### repositories

```text
id                  GitHub repository ID
owner               owner login
name                repo name
full_name           owner/name
description
topics              JSON
stars
forks
avatar_url
html_url
default_branch
created_at
updated_at
archived
fork
english_status      pass | fail | unknown
last_seen_at
```

### repository_texts

Stores cleaned text used for embedding and display.

```text
repo_id
name_text           owner/name plus repo name
description_text
topics_text
readme_summary
readme_excerpt
combined_text
readme_checked_at
embedding_updated_at
```

### repository_embeddings

One repo-level embedding for broad retrieval.

```text
repo_id
embedding
embedding_model
content_hash
created_at
updated_at
```

### readme_chunks

Optional but recommended for better README search.

```text
id
repo_id
chunk_index
heading
chunk_text
embedding
embedding_model
content_hash
created_at
```

## Text Preparation

Build a clean searchable document for each repo:

```text
Repository: owner/name
Name: repo-name
Description: short GitHub description
Topics: cli, terminal, rust, emulator
README summary: concise extracted intro
README excerpt: cleaned high-signal README sections
```

README handling:

- Fetch README from the default branch.
- Try common filenames:
  - `README.md`
  - `README`
  - `readme.md`
- Strip markdown code blocks, badges, image links, raw URLs, tables, and install logs where possible.
- Keep the intro, first useful paragraphs, and meaningful headings.
- Limit repo-level embedding text to a bounded size.
- For longer READMEs, create chunk embeddings.

## Embedding Strategy

### MVP

Create one embedding per repository from:

- `owner/name`
- repo name
- description
- topics
- README summary/excerpt

This is enough for queries like:

- `terminal emulators`
- `open source video editor`
- `local AI coding assistant`
- `postgres database tools`
- `mac menu bar productivity`

### Better Version

Add README chunk embeddings.

Search flow:

1. Embed the user query.
2. Retrieve top repo-level matches.
3. Retrieve top README chunk matches.
4. Merge by repo ID.
5. Rank final repositories using combined score.

This helps when the README explains the purpose but the GitHub description is vague.

## Search API

### Endpoint

```text
GET /api/search
```

Query params:

```text
period=today|week|month|all
q=terminal%20emulators
sort=relevance|stars|forks
direction=desc|asc
page=1
limit=20
```

Response:

```json
{
  "items": [
    {
      "rank": 1,
      "owner": "example",
      "name": "terminal-app",
      "description": "A GPU-accelerated terminal emulator",
      "avatarUrl": "...",
      "htmlUrl": "...",
      "stars": 1234,
      "forks": 120,
      "semanticScore": 0.83,
      "matchReason": "README and description mention terminal emulation and shell workflows."
    }
  ],
  "query": "terminal emulators",
  "period": "week",
  "sort": "relevance",
  "page": 1,
  "limit": 20,
  "hasMore": true,
  "semantic": true
}
```

## Ranking

### Default Semantic Ranking

When a query is present:

```text
final_score =
  semantic_similarity * 0.75
  + log_normalized_stars * 0.15
  + freshness_or_period_boost * 0.10
```

This avoids returning obscure weak matches above clearly useful projects while still prioritizing meaning.

### Explicit Column Sort

If the user clicks `Stars` or `Forks` while a semantic query is active:

- Keep the semantic result set.
- Reorder that result set by the selected metric.
- Keep a small UI state showing the active semantic query.

Example:

```text
Semantic results for "terminal emulators", sorted by Stars ↓
```

## Frontend Changes

### Search State

Current state has simple text filtering. Replace it with:

```js
const searchState = {
  query: "",
  mode: "idle", // idle | keyword | semantic | fallback
  isSearching: false,
  semanticResults: [],
  error: ""
};
```

### Search Flow

1. User types in search input.
2. Debounce for 300-500ms.
3. If query is empty:
   - Clear semantic results.
   - Return to leaderboard data.
4. If query is present:
   - Show small loading state near the search input.
   - Call `/api/search`.
   - Render returned rows.
   - Preserve active period tab.
5. If `/api/search` fails:
   - Fall back to local keyword filtering across currently loaded rows.
   - Show the fallback copy.

### UI States

Recommended states:

- Empty search: normal leaderboard.
- Searching: subtle loading dot inside or near search field.
- Semantic results: show semantic status copy.
- No semantic results: show useful empty state.
- Backend unavailable: show fallback state.

## Load More With Semantic Search

Semantic search should also paginate.

Behavior:

- Search endpoint returns 20 results per page.
- `Load more` requests the next semantic page.
- Do not fetch GitHub directly from the browser during semantic search.
- Sorting changes reset semantic pagination to page 1.
- Tab changes rerun the semantic query within the new period.

## README Data Availability

Current Starboard fetches README data in the browser for English validation. That is not enough for robust semantic search.

For semantic search:

- Move README fetching into the backend worker.
- Store cleaned README excerpts.
- Store embeddings.
- Track `readme_checked_at`.
- Refresh popular or recently changed repos more often.

Suggested refresh policy:

- Today: refresh every 30-60 minutes.
- Week: refresh every few hours.
- Month: refresh daily.
- All time: refresh high-ranking repos weekly and stale repos opportunistically.

## Privacy And Security

Do not expose embedding provider keys in the browser.

Required:

- Backend-only embedding calls.
- Server-side rate limiting.
- Query length limits.
- Request timeout handling.
- Caching for repeated queries.

Recommended query limits:

```text
max query length: 300 characters
debounce: 300-500ms
page size: 20
max pages per query in UI: product-defined
```

## Implementation Phases

### Phase 1: Backend Search Skeleton

- Add backend route `/api/search`.
- Accept `period`, `q`, `sort`, `direction`, `page`, and `limit`.
- Return mocked or keyword-backed results initially.
- Wire frontend to semantic search endpoint with fallback.

Verification:

- Typing in search calls `/api/search`.
- Empty search restores the normal leaderboard.
- Backend failure falls back to local keyword filtering.

### Phase 2: Repository Text Index

- Add database tables for repositories and repository text.
- Persist repo metadata already used by Starboard.
- Move README fetching from browser-only behavior into worker logic.
- Store cleaned `combined_text`.

Verification:

- Worker stores repo text for newly discovered repositories.
- README excerpts are available for indexed repos.
- English gate continues to filter non-English repos.

### Phase 3: Embeddings

- Generate repo-level embeddings from `combined_text`.
- Store embeddings with model name and content hash.
- Skip re-embedding when content hash has not changed.

Verification:

- Indexed repos have embeddings.
- Re-running ingestion does not duplicate embeddings.
- Updated descriptions or READMEs trigger re-embedding.

### Phase 4: Semantic Query

- Embed the user query server-side.
- Run vector similarity search filtered by active period.
- Return ranked repositories.
- Support pagination.

Verification:

- Query `terminal emulators` returns terminal-related projects when present.
- Query `local AI coding assistant` returns semantically related tools.
- Results respect active period.
- Results exclude repos failing the English gate.

### Phase 5: Hybrid Ranking And Sort

- Blend semantic score with stars and freshness.
- Keep `Stars` and `Forks` clickable.
- Re-sort semantic result set when a metric column is active.

Verification:

- Default search feels relevance-first.
- Stars/Forks sorting remains predictable.
- Changing period reruns the query for that period.

### Phase 6: README Chunk Search

- Add chunk embeddings for longer READMEs.
- Merge repo-level and README-chunk matches.
- Optionally expose a short `matchReason`.

Verification:

- Vague repo descriptions can still match based on README content.
- Chunk matches do not flood results with duplicate repos.
- Match reasons are short and useful.

## MVP Recommendation

For the first implementation, build:

1. Backend-only semantic search endpoint.
2. Repo-level embeddings from name, description, topics, and README excerpt.
3. Search within the active period.
4. Semantic result pagination with `Load more`.
5. Keyword fallback when semantic search is unavailable.

Do **not** start with README chunk search unless repo-level embeddings feel too weak. Chunk search is valuable, but it adds indexing and ranking complexity.

## Open Product Decisions

1. Should semantic relevance always be the default sort when searching?
   - Recommendation: yes.
2. Should Stars/Forks sort all semantic matches or only currently loaded semantic matches?
   - Recommendation: backend sorts all matching semantic results.
3. Should `matchReason` be generated by AI or derived from matching text?
   - Recommendation: derive it first. AI-generated explanations can be added later.
4. Should semantic search cover only indexed repos or call GitHub live?
   - Recommendation: indexed repos only. GitHub live search is not semantic and has strict limits.

## Risks

- Semantic quality depends heavily on README and description quality.
- README fetching at scale can be expensive.
- Embedding cost grows with repo count and README chunking.
- Vector search requires backend infrastructure.
- A purely static implementation would only search currently loaded rows and would not meet the desired product behavior.

## Acceptance Criteria

- Searching `terminal emulators` can return repos semantically related to terminal apps without exact keyword matching.
- Results are scoped to the active tab.
- Results use name, description, topics, and README excerpts when available.
- Search is debounced and has a visible loading state.
- `Load more` works for semantic search.
- Stars/Forks sorting works on semantic results.
- No API keys are exposed in browser code.
- If semantic search fails, the UI falls back gracefully to local keyword search.
