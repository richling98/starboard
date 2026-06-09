# Starboard Comprehensive Supabase Index Plan

## Executive Summary

This plan makes Starboard feel much more like its own open-source discovery engine instead of a prettier wrapper around GitHub search.

Right now, Starboard has a small starter cache in Supabase. It can show useful all-time account data, but it is not broad enough yet to feel comprehensive. The next step is to build a backend indexing system that regularly searches GitHub, saves the useful repository and account data into Supabase, and precomputes the leaderboards that the website needs.

In plain English, this plan will:

- Find many more GitHub repositories by searching GitHub in smaller, smarter chunks instead of relying on one broad search.
- Save those repositories into Supabase so Starboard does not have to ask GitHub for everything every time someone opens the site.
- Discover accounts and organizations from those repositories, then calculate how many stars each account has across the repos we have indexed.
- Precompute the Today, Week, Month, and All Time leaderboards for both repositories and accounts.
- Make the website load those cached leaderboards quickly from Supabase.
- Show when the data was last updated so users know whether they are looking at fresh data.
- Stay within GitHub rate limits by running controlled background jobs instead of doing heavy live calculations in the browser.

The main outcome is that Starboard will become faster, broader, and more reliable. It still will not instantly contain every GitHub repo in the world, because GitHub limits how much search data can be pulled at once. But it will have a real path toward much better coverage, and the index can grow over time as scheduled jobs keep adding and refreshing data.

For the Today, Week, and Month tabs, the cron job will use rolling time windows. Every time the job runs, it will calculate the current cutoff dates, then query and recompute each leaderboard separately:

- Today means repos created in the last 24 hours.
- Week means repos created in the last 7 days.
- Month means repos created in the last 30 days.
- All Time means all indexed repos with at least one star.

The job will then save a separate Supabase snapshot for each tab. For example, it might save one cached result for `repositories/today`, another for `repositories/week`, another for `accounts/month`, and so on. When a user clicks a tab, the website loads the matching snapshot from Supabase instead of recalculating everything live. That means the data stays aligned with the correct time period, but the site remains fast.

The first implementation slice I recommend is:

1. Add job tracking and saved GitHub search partitions to Supabase.
2. Build a repository discovery job that pulls more repos into Supabase.
3. Generate cached leaderboard snapshots from Supabase.
4. Update the website to read those snapshots instead of doing expensive live fetching.

After that, we should improve account enrichment so accounts like Vercel, Microsoft, GitHub, OpenAI, and other major builders have more complete star totals and expandable repo lists.

## Goal

Make Starboard more comprehensive by moving from a limited GitHub Search-backed cache to a Supabase-backed discovery index that can power fast, credible repository and account leaderboards.

The important product shift is:

- GitHub becomes the ingestion source.
- Supabase becomes Starboard's cached source of truth.
- The frontend reads precomputed leaderboard data instead of doing expensive live aggregation.

## Current State

Starboard currently has:

- `67` cached account rows in Supabase.
- `4,185` repository rows in Supabase.
- `0` leaderboard snapshot rows.
- A working all-time account leaderboard served from Supabase.
- Today, week, month, and repository views still rely heavily on GitHub Search-backed frontend/server requests.

This proves the architecture works, but the dataset is still a starter cache. It is not yet broad enough to feel like a comprehensive open-source discovery engine.

## Assumptions

- We should stay within GitHub API limits and avoid brute-force crawling.
- We should not claim full coverage until we have our own broad, scheduled index.
- Supabase is the persistent database for now.
- The MVP should favor practical coverage over perfect completeness.
- GitHub Search has a 1,000-result cap per query, so broad queries must be partitioned.
- The app should remain usable even if a refresh job is running or GitHub rate limits are temporarily tight.

## Target Architecture

### Data Flow

1. Scheduled backend jobs query GitHub in bounded partitions.
2. Jobs upsert repository and account data into Supabase.
3. Jobs compute leaderboard snapshots for each view.
4. The app serves leaderboard API responses from Supabase.
5. The frontend renders cached results instantly and shows freshness metadata.

### High-Level Components

- `repositories`: normalized repo records.
- `accounts`: normalized owner/account records.
- `leaderboard_snapshots`: precomputed top lists by period and view.
- `ingestion_runs`: job history, status, counts, and errors.
- `discovery_queries`: reusable GitHub query partitions and metadata.
- Backend scripts/jobs for discovery, enrichment, rollups, and snapshots.

## Coverage Strategy

GitHub Search cannot return every matching repo from a single query. The only practical way to increase coverage is to split large searches into smaller partitions.

### Repository Discovery Partitions

Use multiple query families:

- All-time by stars:
  - `stars:>=100000 fork:false archived:false`
  - `stars:50000..99999 fork:false archived:false`
  - `stars:10000..49999 fork:false archived:false`
  - `stars:5000..9999 fork:false archived:false`
  - `stars:1000..4999 fork:false archived:false`
  - Lower ranges can be added later if needed.

- Recent by creation date:
  - Today: `created:>=YYYY-MM-DD stars:>=1 fork:false archived:false`
  - Week: `created:>=YYYY-MM-DD stars:>=1 fork:false archived:false`
  - Month: `created:>=YYYY-MM-DD stars:>=1 fork:false archived:false`

- Optional breadth partitions:
  - By language for high-volume buckets.
  - By topic for popular categories.
  - By pushed date for active mature projects.

### Account Discovery

Accounts should be discovered from repositories first. Every qualifying repository creates or updates its owner account.

For account rollups:

- Today accounts: sum stars from qualifying repos created in the past 24 hours.
- Week accounts: sum stars from qualifying repos created in the past 7 days.
- Month accounts: sum stars from qualifying repos created in the past 30 days.
- All-time accounts: sum stars from all indexed repos owned by the account that have at least one star.

For high-value all-time accounts, add account enrichment:

- For each discovered top account, query that owner's repos with `user:{login} stars:>=1 fork:false archived:false`.
- Fetch up to GitHub's practical cap for that account.
- Store the account's indexed repo list and total indexed stars.

This is why Vercel can be represented properly: once the owner is known, we enrich the owner directly instead of relying only on whichever Vercel repos appeared in global search.

## Database Changes

### Keep Existing Tables

Continue using:

- `accounts`
- `repositories`
- `leaderboard_snapshots`

### Add `ingestion_runs`

Purpose: track jobs and make failures visible.

Suggested columns:

- `id`
- `job_type`
- `status`
- `started_at`
- `finished_at`
- `github_requests`
- `repos_discovered`
- `accounts_discovered`
- `error_message`
- `metadata`

### Add `discovery_queries`

Purpose: make partitions explicit and resumable.

Suggested columns:

- `id`
- `query_key`
- `query`
- `period`
- `sort`
- `enabled`
- `last_run_at`
- `last_status`
- `last_result_count`
- `metadata`

### Improve Repository Rows

Ensure repository rows include:

- GitHub repo id
- Full name
- Owner login
- Owner type
- Description
- Stars
- Forks
- Language
- Topics
- Created at
- Pushed at
- Updated at
- Archived/fork/private flags
- HTML URL
- Last refreshed at
- Source query keys
- README language gate result when available

### Improve Account Rows

Ensure account rows include:

- GitHub user/org id
- Login
- Type
- Avatar URL
- HTML URL
- Total indexed stars
- Indexed starred repo count
- Top repo
- Repo names / repo summary JSON
- Last enriched at
- Last refreshed at

## Leaderboard Snapshots

Snapshots should store the exact rows the UI needs for each period and view.

Suggested snapshot dimensions:

- `view`: `repositories` or `accounts`
- `period`: `today`, `week`, `month`, `all`
- `sort_key`: usually `stars`
- `generated_at`
- `total_indexed_count`
- `coverage_label`
- `rows` JSONB

This lets the frontend load a leaderboard with one API call.

## Backend Jobs

### Job 1: Repository Discovery

Purpose: fill `repositories` from GitHub Search partitions.

Steps:

1. Load enabled discovery queries.
2. For each query, request GitHub Search pages with `per_page=100`.
3. Stop when there are no more pages, GitHub's cap is reached, or rate-limit budget is low.
4. Upsert repository rows.
5. Record which query found each repo.
6. Create or update basic account rows for repo owners.

### Job 2: Account Enrichment

Purpose: make account leaderboards more accurate.

Steps:

1. Select accounts that are important or stale.
2. Query `user:{login} stars:>=1 fork:false archived:false`.
3. Fetch up to the practical GitHub Search limit.
4. Upsert the owner's repos.
5. Recompute that account's total indexed stars and repo count.
6. Store top repo and repo summary JSON for dropdowns.

Prioritization:

- Top accounts by current indexed stars.
- Accounts newly discovered from high-star repos.
- Accounts with stale `last_enriched_at`.
- Known important organizations from a manual seed list.

### Job 3: Rollups

Purpose: compute account/repo aggregates from normalized rows.

Steps:

1. Recompute repo leaderboards from `repositories`.
2. Recompute account totals for today, week, month, and all time.
3. Exclude forks, archived repos, and repos with zero stars.
4. Apply English-language gating where available.
5. Write results into `leaderboard_snapshots`.

### Job 4: Cleanup and Freshness

Purpose: keep the cache accurate.

Steps:

1. Refresh stale high-impact repos.
2. Mark deleted or inaccessible repos if GitHub returns 404.
3. Refresh account avatars and profile URLs periodically.
4. Track stale snapshots and expose freshness to the UI.

## Scheduling

Use simple schedules at first:

- Today repo/account snapshots: every 1-3 hours.
- Week snapshots: every 6-12 hours.
- Month snapshots: daily.
- All-time repo discovery: daily.
- All-time account enrichment: daily or every few days, prioritized by stale/high-impact accounts.

Good first scheduler options:

- GitHub Actions cron calling the Node scripts.
- Vercel Cron if the app is deployed on Vercel.
- Supabase Edge Functions later if we want jobs closer to the database.

For the current local MVP, GitHub Actions is likely the cleanest next step because it can run scheduled scripts without keeping a server alive.

## Rate Limit Strategy

Use the GitHub token and keep requests bounded.

Rules:

- Fetch search pages with `per_page=100`.
- Space search requests by roughly 2-3 seconds.
- Track `x-ratelimit-remaining` and `x-ratelimit-reset`.
- Stop jobs early when remaining budget is low.
- Resume next run from `discovery_queries.last_run_at` and job metadata.
- Prefer incremental refresh over full rebuild.

Expected behavior:

- Showing more frontend rows should not cost GitHub requests.
- Refresh jobs should use GitHub requests.
- The frontend should read Supabase snapshots.

## English-Language Gate

Keep the existing intent: include only repos where the description and README appear to be English.

Implementation:

1. Store language check fields on `repositories`.
2. Run the gate during repo enrichment, not every page load.
3. Cache the result:
   - `english_check_status`
   - `english_check_confidence`
   - `english_checked_at`
4. Exclude failed/unknown records from production leaderboard snapshots if we want strict gating.

This prevents repeated README fetching and keeps the frontend fast.

## API Changes

Add or expand backend endpoints:

- `GET /api/leaderboard/repositories?period=today|week|month|all`
- `GET /api/leaderboard/accounts?period=today|week|month|all`
- `GET /api/cache/status`

Each leaderboard response should include:

- Rows
- Total indexed count
- Generated timestamp
- Coverage label
- Whether the result is complete, partial, or GitHub Search-limited

## UI Changes

Minimal UI changes for this phase:

- Continue using existing Repos/Accounts and Today/Week/Month/All toggles.
- Read leaderboard rows from Supabase-backed endpoints.
- Show a small freshness line:
  - `Updated 2 hours ago`
  - `Showing 500 indexed accounts`
- Avoid claiming "all GitHub" until the index is genuinely broad.

## Implementation Phases

### Phase 1: Database and Job Metadata

Deliverables:

- Add `ingestion_runs`.
- Add `discovery_queries`.
- Add missing repository/account metadata columns if needed.
- Add setup/migration script.
- Seed initial discovery queries.

Verification:

- Run setup script against Supabase.
- Confirm existing account/repo data remains intact.
- Confirm discovery queries are visible in Supabase.

### Phase 2: Partitioned Repository Discovery

Deliverables:

- Build `scripts/discover-repositories.mjs`.
- Implement partitioned GitHub Search.
- Upsert repo rows.
- Track run status and query status.

Verification:

- Run with a small query limit.
- Confirm repository count increases.
- Confirm no duplicate repo rows.
- Confirm rate-limit handling logs correctly.

### Phase 3: Account Enrichment

Deliverables:

- Build or expand account enrichment script.
- Prioritize top/stale/manual-seed accounts.
- Store complete indexed repo summaries per account.

Verification:

- Confirm Vercel, Microsoft, GitHub, Facebook, OpenAI, and other known accounts have realistic repo counts.
- Confirm account totals match the indexed repo rows.

### Phase 4: Snapshot Generation

Deliverables:

- Build `scripts/build-leaderboard-snapshots.mjs`.
- Generate repository snapshots for today/week/month/all.
- Generate account snapshots for today/week/month/all.
- Store rows in `leaderboard_snapshots`.

Verification:

- Confirm each period/view has a snapshot.
- Confirm frontend-shaped JSON is complete.
- Confirm all-time account snapshot includes enriched accounts like Vercel.

### Phase 5: API Reads from Snapshots

Deliverables:

- Update server leaderboard endpoints to prefer snapshots.
- Keep fallback behavior for missing snapshots.
- Add cache status endpoint.

Verification:

- Confirm page load does not trigger heavy GitHub aggregation.
- Confirm leaderboard API responses are fast.
- Confirm empty/missing snapshot states are clear.

### Phase 6: Scheduled Refresh

Deliverables:

- Add GitHub Actions workflow or equivalent scheduler.
- Store required secrets securely.
- Run discovery, enrichment, and snapshot jobs on a schedule.

Verification:

- Confirm scheduled job completes.
- Confirm Supabase row counts change after scheduled run.
- Confirm leaderboard `generated_at` updates.

## Proposed First Implementation Slice

The first slice should be intentionally small:

1. Add `ingestion_runs` and `discovery_queries`.
2. Seed 10-20 discovery queries.
3. Build repository discovery with request pacing.
4. Build snapshot generation for repository leaderboards.
5. Switch repository views to snapshot reads.

Then do account enrichment in the next slice.

Reason: repository discovery is the base layer. Account comprehensiveness depends on better repo coverage.

## Open Review Questions

1. Should strict English gating exclude repos with unknown README language, or only exclude repos confidently detected as non-English?
2. Should we prioritize all-time accounts first, or make today/week/month repository discovery broader first?
3. Should the first scheduled backend use GitHub Actions, or should we wait until the app is deployed and use Vercel Cron?
4. Do we want a manual allowlist of important accounts to enrich early, such as `vercel`, `openai`, `microsoft`, `facebook`, `google`, `github`, `anthropics`, and `huggingface`?

## Risks

- GitHub Search's 1,000-result cap means "complete" coverage requires careful partitioning.
- GitHub rate limits mean the index must grow over time, not instantly.
- All-time comprehensive account ranking is hard because GitHub does not expose a global "accounts by total stars" endpoint.
- README language checks can be imperfect, especially for code-heavy repos with sparse prose.
- Supabase free-tier limits may become relevant as the index grows.

## Success Criteria

This phase is successful when:

- Leaderboards load from Supabase snapshots.
- Refresh jobs can run repeatedly without duplicating data.
- The index grows beyond the current 67 accounts and 4,185 repos.
- Known high-star accounts like Vercel appear with reasonable all-time totals.
- The UI clearly communicates freshness and indexed coverage.
- GitHub API usage stays bounded and predictable.
