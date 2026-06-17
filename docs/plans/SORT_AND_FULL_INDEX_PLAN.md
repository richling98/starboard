# Sorting And Full Repository Index Plan

## Goals

Implement four requested changes:

1. Make `Visit repo` hover state black with a white border outline.
2. Let users sort by `Stars` or `Forks` by clicking the table columns, toggling descending and ascending order.
3. Use the `Starboard` name consistently, use a star as the logo mark, and make the terminal-style hero read `STARBOARD`.
4. Move from the current top-20 GitHub Search result model toward including every repository with at least one star for each period:
   - Today: repos created in the last 24 hours with `stars >= 1`
   - Week: repos created in the last 7 days with `stars >= 1`
   - Month: repos created in the last 30 days with `stars >= 1`
   - All time: all repos with `stars >= 1`

## Feasibility Summary

The hover state, sortable columns, and brand rename are straightforward in the current static app.

The full “every repository with at least one star” change is not feasible as a pure browser/static-page feature. GitHub Search is intentionally capped and rate-limited:

- GitHub REST Search provides up to 1,000 results per search query.
- Search has a custom rate limit: 10 requests/minute unauthenticated, 30 requests/minute authenticated.
- GitHub also applies secondary rate limits and search scope limits.

Therefore, “every repository with at least one star” requires a backend data pipeline that builds and maintains our own repository index. The UI should query Starboard’s index, not GitHub directly.

## Phase 1: Immediate UI Changes

These can be done in the current static app.

### 1. Starboard Brand And Star Logo

Requested behavior:

- Use `Starboard` as the website name.
- Use `STARBOARD` in the terminal-style hero text.
- Use a star as the logo mark.
- Replace old brand references with `Starboard` or `STARBOARD`.

Implementation:

- Update `index.html`:
  - `<title>`
  - header/brand text
  - terminal-style hero block
  - any ARIA labels or metadata that mention the old name
- Update `README.md` and project docs that describe the current product name.
- Use a simple monochrome star logo, preferably an inline lucide-style star icon or CSS-safe text/icon mark that fits the black-and-white visual system.

Verification:

- Search for old brand strings.

```text
rg -n "old brand string pattern" .
```

- Confirm only historical planning notes mention the old name, if we decide to preserve history.

### 2. Visit Repo Hover State

Current behavior:

- `Visit repo` button becomes inverted on hover.

Requested behavior:

- Hover background becomes black.
- Border outline becomes white.
- Text becomes white.

Implementation:

```css
.action.primary:hover {
  background: #000;
  color: #fff;
  border: 1px solid #fff;
  filter: none;
}
```

Also ensure `.action.primary` has a stable border in its non-hover state to avoid layout shift:

```css
.action.primary {
  border: 1px solid #fff;
}
```

### 3. Sortable Stars And Forks Columns

Make the `Stars` and `Forks` table headers interactive.

UI behavior:

- Click `Stars` once: sort highest to lowest.
- Click `Stars` again: sort lowest to highest.
- Click `Forks` once: sort highest to lowest.
- Click `Forks` again: sort lowest to highest.
- Show a small monochrome arrow indicator:
  - `Stars ↓`
  - `Stars ↑`
  - `Forks ↓`
  - `Forks ↑`

State model:

```js
const state = {
  sortKey: "default", // default | stars | forks
  sortDirection: "desc" // desc | asc
};
```

Sorting:

```js
function getFilteredRepos() {
  const filtered = ...

  if (state.sortKey === "stars") {
    return filtered.sort((a, b) =>
      state.sortDirection === "desc" ? b.stars - a.stars : a.stars - b.stars
    );
  }

  if (state.sortKey === "forks") {
    return filtered.sort((a, b) =>
      state.sortDirection === "desc" ? b.forks - a.forks : a.forks - b.forks
    );
  }

  return filtered;
}
```

Important:

- Sort the currently loaded dataset.
- Once full indexing exists, sorting should happen server-side for large result sets.

## Phase 2: Remove Static “Top 20” Assumption

The static MVP should fetch GitHub results with `GITHUB_FETCH_PAGE_SIZE = 100`, then reveal rows in `UI_REVEAL_SIZE = 20` increments.

### Best Static MVP Approach

Keep the UI lightweight, but fetch GitHub results efficiently:

- Keep the visible table page size at 20 rows.
- Fetch GitHub Search results in pages of 100 using `per_page=100`.
- Store fetched results client-side per tab.
- Each `Load more` click reveals the next 20 already-fetched rows.
- Only every fifth `Load more` click should require another GitHub Search request.

This keeps normal usage comfortably inside GitHub Search rate limits. For example:

- Showing 100 repos takes 1 GitHub Search request.
- Showing 500 repos takes 5 GitHub Search requests.
- Showing the maximum reachable 1,000 repos for one query takes 10 GitHub Search requests.

That is much better than fetching 20 repos per request, where 500 visible repos would require 25 requests.

### Static MVP Boundary

This does **not** mean the static MVP can include literally every matching repo.

GitHub Search exposes at most 1,000 results per search query. Therefore the static MVP can show:

- Today: up to the first 1,000 matching repos created in the last 24 hours.
- Week: up to the first 1,000 matching repos created in the last 7 days.
- Month: up to the first 1,000 matching repos created in the last 30 days.
- All time: up to the first 1,000 matching repos overall.

This may be acceptable for `today`, may be acceptable for `week` depending on GitHub volume, is less likely to be complete for `month`, and is definitely not complete for `all time`.

### User-Facing Transparency

When GitHub reports more than 1,000 matching repositories for a tab, show a small status line near the table controls:

```text
Showing 20 of the first 1,000 searchable GitHub results.
```

As users load more:

```text
Showing 120 of the first 1,000 searchable GitHub results.
```

If GitHub reports fewer than or equal to 1,000 matching repositories:

```text
Showing 120 of 348 matching GitHub repositories.
```

This keeps the product honest: the static version is GitHub Search-backed, not a complete global repository index.

### Client State Model

Track loaded data separately for each tab:

```js
const paginationState = {
  today: {
    githubPage: 1,
    fetchedRepos: [],
    visibleCount: 20,
    totalCount: 0,
    incompleteResults: false,
    reachedGithubCap: false,
    isLoading: false
  },
  week: { ... },
  month: { ... },
  all: { ... }
};
```

Recommended constants:

```js
const GITHUB_FETCH_PAGE_SIZE = 100;
const UI_REVEAL_SIZE = 20;
const GITHUB_SEARCH_RESULT_CAP = 1000;
```

### Load More Algorithm

On initial tab load:

1. Fetch page 1 from GitHub with `per_page=100`.
2. Cache the returned 100 repos for that tab.
3. Render the first 20 rows.
4. Show `Load more` if more cached repos exist or another GitHub page is available.

On `Load more`:

1. If cached repos contain at least 20 hidden rows, increase `visibleCount` by 20 and re-render.
2. If fewer than 20 hidden rows remain and GitHub page 10 has not been reached, fetch the next GitHub page with `per_page=100`.
3. Merge new results into the tab cache, dedupe by repository ID, increase `visibleCount` by 20, and re-render.
4. If GitHub page 10 has been reached, disable `Load more` and show the 1,000-result cap copy.

### Sorting Behavior In Static MVP

For the static MVP:

- Sorting by `Stars` or `Forks` sorts the currently fetched client-side dataset.
- If the user has loaded only 100 repos, the sort applies to those 100 repos.
- If the user has loaded 500 repos, the sort applies to those 500 repos.
- Changing tabs preserves each tab’s fetched cache.
- Changing sort should not trigger a refetch unless we explicitly decide to fetch GitHub with a different sort parameter.

Important limitation:

- Client-side sorting cannot sort repos that have not been fetched yet.
- Full global sorting requires the backend index in Phase 3.

### Rate Limit Guardrails

Add conservative protections:

- Keep requests sequential, not concurrent.
- Disable `Load more` while a fetch is in progress.
- Reuse cached pages when switching tabs.
- If GitHub returns a rate-limit response, show a clear retry message instead of looping.
- Prefer `per_page=100` to minimize request count.

### Recommended Phase 2 Deliverable

For this project’s MVP, implement:

1. `Load more` button.
2. GitHub fetches of 100 results per request.
3. Client-side reveal of 20 rows at a time.
4. Per-tab result caches.
5. Clear “showing X of Y” or “showing X of first 1,000” copy.
6. No claim that the static MVP is a complete all-GitHub index.

This is the best practical bridge before building the backend index.

Verification:

- Initial tab render shows 20 repos.
- One GitHub request fetches up to 100 repos.
- The first four `Load more` clicks reveal cached rows without additional GitHub requests.
- The fifth `Load more` click fetches the next GitHub page only if more results are available.
- `Load more` disables while fetching.
- Switching tabs reuses cached tab data.
- The status line accurately shows either total matches or the first-1,000 GitHub Search cap.
- Sorting still works on the currently fetched dataset after loading more rows.

## Phase 3: Backend Index Architecture

### Recommended Stack

- Next.js or small Node server
- Postgres
- GitHub token stored server-side
- Scheduled ingestion worker
- Background job queue
- API routes for table data

Suggested components:

```text
web/
  app UI
api/
  GET /api/repos?period=today|week|month|all&sort=stars|forks&direction=desc|asc&page=1
worker/
  ingest GitHub search partitions
db/
  repositories
  repository_snapshots
  ingestion_partitions
```

### Data Model

#### repositories

```text
id                  GitHub repository ID
owner               owner login
name                repo name
full_name           owner/name
description
language
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
readme_checked_at
last_seen_at
```

#### ingestion_partitions

Tracks which GitHub Search slices have been fully ingested.

```text
id
period_scope        today | week | month | all
created_from
created_to
stars_from
stars_to
status              pending | running | complete | split | failed
total_count
last_page_fetched
last_error
updated_at
```

#### repository_snapshots

Optional but useful for future trend velocity.

```text
repo_id
stars
forks
captured_at
```

## Phase 4: GitHub Ingestion Strategy

### Why Partitioning Is Required

GitHub Search cannot return more than 1,000 results for one query. To collect more than 1,000, we need to break the problem into smaller queries that each return <= 1,000 results.

Base query:

```text
stars:>=1 archived:false fork:false created:YYYY-MM-DD..YYYY-MM-DD
```

Sort:

```text
sort=stars&order=desc
```

Pagination:

```text
per_page=100&page=1..10
```

If GitHub reports more than 1,000 results for a date window:

1. Split the date window into smaller windows.
2. If still too large, split by star ranges.
3. Continue until each partition can be completely paginated.

Example:

```text
created:2026-06-01..2026-06-30 stars:>=1
```

If too large:

```text
created:2026-06-01..2026-06-15 stars:>=1
created:2026-06-16..2026-06-30 stars:>=1
```

If still too large:

```text
created:2026-06-01..2026-06-15 stars:1..10
created:2026-06-01..2026-06-15 stars:11..50
created:2026-06-01..2026-06-15 stars:51..100
created:2026-06-01..2026-06-15 stars:>100
```

### Period Coverage

#### Today

- Backfill last 24 hours.
- Refresh every 15-30 minutes.
- Usually feasible with date/hour partitions.

#### Week

- Backfill last 7 days.
- Refresh hourly.
- Use daily or smaller date partitions.

#### Month

- Backfill last 30 days.
- Refresh hourly or daily depending on budget.
- Use day-level partitions, split busy days further.

#### All Time

This is the hard one.

All repos with `stars >= 1` across GitHub is a very large historical dataset. It cannot be fetched interactively. It needs a long-running backfill:

- Start from current date and walk backward by created date.
- Partition into small enough date windows.
- Store results permanently.
- Resume from checkpoints.
- Run continuously until historical backfill is complete.

MVP compromise:

- For `all time`, initially show indexed results while backfill is running.
- Add small copy: `Indexing historical GitHub repositories. Coverage improves continuously.`
- Once backfill completes, remove or hide that note.

## Phase 5: API Design

### Repository Listing

```text
GET /api/repos
```

Query params:

```text
period=today|week|month|all
sort=stars|forks
direction=desc|asc
q=optional search text
page=1
limit=50
```

Response:

```json
{
  "items": [
    {
      "rank": 1,
      "owner": "example",
      "name": "repo",
      "description": "Short description",
      "avatarUrl": "...",
      "htmlUrl": "...",
      "stars": 1234,
      "forks": 120
    }
  ],
  "page": 1,
  "limit": 50,
  "totalIndexed": 123456,
  "hasMore": true,
  "coverage": {
    "status": "indexing",
    "updatedAt": "2026-06-08T20:00:00Z"
  }
}
```

### UI Loading Model

Do not render all repos at once.

Use:

- Server-side pagination
- `Load more`
- Or virtualized infinite scrolling

Recommended MVP:

- Start with 50 rows per page.
- Add `Load more`.
- Preserve table sorting server-side.

## Phase 6: English Gate At Scale

Current browser gate:

- Checks description immediately.
- Refines with README text in the background.

At scale:

- Move English detection into the ingestion worker.
- Store `english_status`.
- Only return repos where `english_status = pass`.

Important:

- README checks across millions of repos will be expensive.
- Phase it:
  1. Description-only English gate during ingestion.
  2. README gate for visible/high-rank repos.
  3. Background README verification over time.

## Phase 7: Implementation Order

### Step 1: Current Static UI

- Confirm the product name is `Starboard`.
- Add star logo mark.
- Add `Visit repo` hover white border.
- Remove language selector.
- Add sortable `Stars` and `Forks` headers.
- Keep current 20-row behavior for now.

Verification:

- `node --check app.js`
- Desktop screenshot
- Mobile screenshot
- Click `Stars` twice and confirm order changes.
- Click `Forks` twice and confirm order changes.

### Step 2: Backend Shell

- Create Next.js or Express backend.
- Add Postgres.
- Add server-side GitHub client.
- Move GitHub token to server env.
- Create `/api/repos`.

Verification:

- API returns current top repos.
- Token is not exposed to browser.

### Step 3: Indexed Today/Week/Month

- Create ingestion worker.
- Partition by created date.
- Store repos with `stars >= 1`.
- Query DB for Today/Week/Month.

Verification:

- Today returns more than 20 rows when available.
- Week/Month return paginated data.
- Sorting by stars/forks works server-side.

### Step 4: All-Time Backfill

- Add resumable historical partition queue.
- Walk created-date partitions backward.
- Store progress.
- Surface indexing coverage in API.

Verification:

- Backfill can stop/restart.
- No duplicate repository records.
- Query performance stays acceptable with indexes.

### Step 5: Frontend Pagination

- Replace fixed list with paginated table.
- Add `Load more`.
- Keep sorting stable across pages.

Verification:

- Loading more does not duplicate rows.
- Changing sort resets pagination.
- Changing period resets pagination.

## Key Product Decision Needed

Before implementation, decide what “every repository” means:

1. **Recommended**: non-archived, non-fork public repos with `stars >= 1`.
2. Literal GitHub public repos with `stars >= 1`, including forks and archived repos.

The current product has been excluding archived repos and forks. I recommend keeping that behavior because forks would pollute discovery and archived repos are often not useful to users.

## Risks

- GitHub Search caps each query at 1,000 results.
- Search rate limits make full backfill slow.
- Secondary rate limits can interrupt aggressive crawling.
- Full all-time coverage may take a long time.
- README English checking for every repo is expensive.
- A backend/index is mandatory for the full version.

## Practical Recommendation

Implement the immediate UI changes first:

- Hover border
- Sortable stars/forks
- Remove language selector

Then build the backend index in phases. Do not try to fetch every repo directly from the browser.

## Sources

- GitHub REST Search docs: search returns up to 1,000 results per search and has custom search rate limits: https://docs.github.com/en/rest/search/search
- GitHub REST rate limits: unauthenticated requests are 60/hour, authenticated requests are much higher, and secondary limits apply: https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api
- GitHub REST best practices recommend authenticated requests, rate-limit handling, and avoiding excessive polling: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
