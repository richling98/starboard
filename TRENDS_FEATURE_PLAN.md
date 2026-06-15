# Starboard Trends Feature Plan

## Goal

Add a new `Trends` tab next to `Today`, `Week`, `Month`, and `All time`.

The `Trends` tab should identify no more than five major trends from the top repositories in the `Today` and `Week` leaderboards. Each trend should be shown in the same table style as the existing leaderboard, with an action to expand and see the repositories associated with that trend.

## Assumptions

- Trends are based on repository rows, not account rows.
- The input set is the top 20 `Today` repositories plus the top 20 `Week` repositories.
- Repositories are deduplicated by repository id before trend detection.
- Trends are generated from existing Starboard indexed/snapshot data, not from live GitHub calls in the browser.
- A repository should normally belong to only one trend so stars and forks are not double-counted across trend rows.

## Recommended Approach

Generate Trends during the existing snapshot build, then export them as static JSON.

Starboard already builds repository and account snapshots for each period and exports them under `data/leaderboards`. Trends should follow that same model:

- build once during the snapshot pipeline
- validate and normalize trend rows server-side
- export a static `trends.json` file
- render the cached trend rows in the browser

This keeps the static site fast and avoids client-side AI/API calls.

## Official Refresh Plan

Trends should run in the existing Starboard Index GitHub Actions workflow:

```yaml
schedule:
  - cron: "17 */6 * * *"
```

The official pipeline order is:

1. Discover and refine repository data.
2. Build semantic index.
3. Refresh account rollups.
4. Build leaderboard snapshots.
5. Export static leaderboard JSON.
6. Build `data/leaderboards/trends.json` from the exported `repositories-today.json` and `repositories-week.json`.
7. Force-add `data/leaderboards/` and commit refreshed data.

The Trends generator should run on scheduled and manual index refreshes, not on every push. It should avoid unnecessary LLM calls by hashing the top 20 today plus top 20 week source rows. If the source hash is unchanged and the existing trend snapshot is less than 24 hours old, reuse the existing snapshot.

This gives Starboard:

- up to six-hour freshness when the leaderboard materially changes
- at least daily LLM trend review when the same source rows persist
- no client-side AI calls
- low and predictable cost

Because `data/` is ignored locally, the first official ship should force-add `data/leaderboards/trends.json` once. The scheduled workflow already force-adds `data/leaderboards/`, so future trend refresh commits will include the file automatically.

## Trend Row Shape

Each trend row should look like:

```js
{
  id: "terminal-emulators",
  name: "Terminal emulators",
  description: "New terminal projects are focusing on agent-friendly workflows, richer input, and macOS-native polish.",
  stars: 12840,
  forks: 710,
  repoCount: 4,
  repos: [repo, repo, repo],
  rank: 1
}
```

Rules:

- `stars` is the sum of stars for repos assigned to the trend.
- `forks` is the sum of forks for repos assigned to the trend.
- `repoCount` is the number of contributing repos.
- `repos` are sorted by stars descending.
- There should be no more than five trend rows.
- Prefer trends with at least two repositories.
- Single-repo trends should be dropped unless they are explicitly allowed later.

## Trend Generation

### 1. Load Source Rows

Read the top repository rows from existing snapshots:

- top 20 from `repositories-today`
- top 20 from `repositories-week`

Then:

- dedupe by repository id
- keep repository metadata unchanged
- optionally preserve `sourcePeriods`, such as `["today", "week"]`

### 2. Build Trend Input Text

For each repository, use:

- name
- full name
- description
- language
- topics
- optionally existing semantic search document text if already available

### 3. Generate Trend Candidates

Preferred implementation: use an LLM during the snapshot script to cluster repositories and name trends.

Use OpenAI's Responses API with:

- default model: `gpt-5.4-mini`
- API key: `OPENAI_API_KEY` or `STARBOARD_OPENAI_API_KEY`
- GitHub Actions secret: `secrets.STARBOARD_OPENAI_API_KEY`

The LLM prompt should request JSON only and require:

- no more than five trends
- each trend includes repository ids
- each trend has a short name
- each trend has a one-sentence description
- avoid vague names like `Developer tools` when a more specific trend exists
- do not invent repositories, stars, forks, or facts

### 4. Validate Generated Trends

After generation:

- drop unknown repository ids
- drop duplicate repository assignments after the first accepted trend
- drop trends with zero repos
- prefer trends with at least two repos
- cap output at five trends
- recompute stars and forks from local repository data
- sort by `stars desc`, then `repoCount desc`

The model should never be trusted for numeric totals.

## Fallback Heuristic

If no LLM/API key is configured, use deterministic keyword/topic clustering.

Candidate buckets:

- agents / agent harnesses / MCP / skills
- terminal emulators / shells / CLIs
- screenshotting / browser automation / visual testing
- AI coding tools / code review / dev agents
- databases / search / vector stores
- UI frameworks / design systems
- infra / deployment / observability

For each repo:

- normalize name, description, topics, and language
- score against bucket vocabularies
- assign to the highest-scoring bucket
- build only buckets with at least two repos

This fallback is less insightful than LLM clustering, but keeps the pipeline functional.

The fallback should remain available in production. If the OpenAI key is missing or the LLM request fails, Starboard should still publish a deterministic Trends snapshot rather than breaking the scheduled refresh.

## UI Behavior

Add the tab order:

```text
Today | Week | Month | All time | Trends
```

When `Trends` is active:

- show the trend table
- hide or disable account/repo view switching
- use a table header with:
  - `#`
  - `Trend`
  - `Stars`
  - `Forks`
  - empty action column

Each trend row should show:

- rank `1` to `5`
- trend name
- short trend description
- summed stars
- summed forks
- action button: `See repos`

When the user clicks `See repos`:

- expand an inline panel below the trend row
- show all repositories contributing to the trend
- reuse the existing account repo panel style where possible
- show repo full name, description, stars, forks, and `Visit repo`
- toggle the button text to `Hide repos`

## Search And Sorting

For the first implementation:

- default sort is summed stars descending
- star and fork headers can remain sortable if easy
- search should filter by:
  - trend name
  - trend description
  - contributing repo names
  - contributing repo descriptions
  - contributing repo topics

Do not add semantic search inside Trends for the first pass. Trends are already a semantic clustering view.

## Likely Files To Change

### `db.mjs`

- No required first-pass database changes if Trends are built from exported static repository snapshots.
- A future database-backed implementation could add a persisted `trends` snapshot view, but the current static-file approach is sufficient for the site.

### `scripts/build-leaderboard-snapshots.mjs`

- No required first-pass changes.
- The official workflow runs trend generation after `export:static-data`, when `repositories-today.json` and `repositories-week.json` are available.

### `scripts/export-static-data.mjs`

- No required first-pass changes.
- Trends are written by `scripts/build-trends.mjs` directly to `data/leaderboards/trends.json`.

### `server.mjs`

- No required first-pass endpoint.
- The browser loads `data/leaderboards/trends.json` directly, matching static deployment behavior.

### `app.js`

- Add `trends` as a supported tab state.
- Load cached trend rows when selected.
- Render trend rows.
- Support expand/collapse for contributing repositories.
- Keep regular repo/account behavior unchanged for other tabs.

### `.github/workflows/starboard-index.yml`

- Add `STARBOARD_TREND_MODEL`.
- Run `npm run build:trends` after `npm run export:static-data`.
- Guard the step with `if: github.event_name != 'push'` so ordinary pushes do not spend an LLM call.
- Pass `OPENAI_API_KEY: ${{ secrets.STARBOARD_OPENAI_API_KEY }}`.
- Existing `git add -f data/leaderboards/` picks up `trends.json`.

### `index.html`

- Add the `Trends` tab.
- Add a trend table header/template or reuse the repository template carefully.

### `styles.css`

- Add trend row and expanded repo panel styles.
- Reuse existing table and account expansion styles where possible.

## Verification Plan

### Generator Checks

- Trend generator never returns more than five trends.
- Stars equal the sum of contributing repo stars.
- Forks equal the sum of contributing repo forks.
- No duplicate repo ids appear across trends.
- Unknown repo ids are ignored.
- Empty or weak single-repo trends are dropped.

### Snapshot And Export Checks

- Run the snapshot pipeline.
- Confirm `data/leaderboards/trends.json` is created.
- Confirm trend rows include expected metadata and repository lists.

### UI Checks

- Run the local dev server.
- Open Starboard.
- Click `Trends`.
- Confirm the table headers are `#`, `Trend`, `Stars`, `Forks`.
- Confirm there are no more than five trend rows.
- Click `See repos`.
- Confirm the associated repositories expand inline.
- Confirm repo links open the correct GitHub pages.
- Switch back to `Today`, `Week`, `Month`, and `All time`.
- Confirm existing repository/account views still work.

### Regression Checks

- Repository snapshots still load.
- Account snapshots still load.
- Search still works on regular tabs.
- Load-more behavior does not appear for Trends unless future requirements allow more than five rows.

## Open Design Choice

The recommended version is snapshot-generated LLM clustering with deterministic heuristic fallback.

The main alternative is pure heuristic clustering only. That is cheaper and deterministic, but it will likely produce less insightful trend names and descriptions.
