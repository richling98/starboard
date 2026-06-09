# Star Velocity Trending Plan

## Goal

Open World should rank repositories by the metric the tabs promise:

- **Today**: repositories with the most stars gained in the last 24 hours.
- **Week**: repositories with the most stars gained in the last 7 days.
- **All time**: repositories with the most total stars.

The current static MVP cannot calculate true Today/Week rankings from GitHub Search alone. GitHub exposes current `stargazers_count`, and repository search can sort by total stars, but it does not expose a search sort for "stars gained since timestamp." We need to collect and store historical star counts.

## Recommended Architecture

Move from a purely static browser app to a small server-backed app.

Recommended stack:

- Next.js App Router
- TypeScript
- Tailwind or current CSS ported into components
- Server-side GitHub REST client
- SQLite for local/dev, Postgres for hosted production
- Scheduled ingestion job via Vercel Cron, GitHub Actions cron, or a small worker

Why server-backed:

- Keeps `GITHUB_TOKEN` private.
- Avoids browser-side GitHub rate-limit problems.
- Enables durable star snapshots.
- Allows background ranking jobs instead of slow client-side computation.

## Data Sources

### All Time

Use GitHub repository search:

```text
GET /search/repositories?q=stars:>1 archived:false fork:false&sort=stars&order=desc
```

This directly supports the All time tab because the ranking is total stars.

### Today And Week

Use local star snapshots.

At regular intervals, fetch candidate repositories and store their current `stargazers_count`. Then calculate deltas:

```text
stars_gained_24h = current_stars - stars_at_or_before_24h_ago
stars_gained_7d = current_stars - stars_at_or_before_7d_ago
```

Sort Today by `stars_gained_24h desc`.
Sort Week by `stars_gained_7d desc`.

## Candidate Repository Discovery

We still need a way to decide which repos to track. Track a broad but bounded candidate set:

1. **High-star active repos**
   ```text
   q=stars:>1000 archived:false fork:false pushed:>=YYYY-MM-DD
   sort=updated
   ```

2. **New fast-rising repos**
   ```text
   q=created:>=YYYY-MM-DD archived:false fork:false
   sort=stars
   ```

3. **All-time leaders**
   ```text
   q=stars:>1 archived:false fork:false
   sort=stars
   ```

4. **Language/topic slices**
   Run the same searches for popular languages and topics so the candidate pool is not dominated only by giant repos:
   - TypeScript
   - Python
   - Rust
   - Go
   - JavaScript
   - Swift
   - AI
   - developer-tools
   - cli
   - desktop

Deduplicate by GitHub repository ID.

## Data Model

### repositories

```text
id                 GitHub repo ID, primary key
full_name          owner/name
owner              repo owner
name               repo name
description        GitHub description
html_url           GitHub repo URL
avatar_url         owner avatar
language           primary language
topics             JSON array
license            SPDX/license name
default_branch
created_at
pushed_at
archived
fork
current_stars
current_forks
open_issues
latest_release_url
dmg_asset_name
dmg_download_url
last_seen_at
```

### repo_star_snapshots

```text
id
repo_id
stars
forks
open_issues
pushed_at
captured_at
```

Indexes:

```text
(repo_id, captured_at)
(captured_at)
```

### repo_rankings

Precompute rankings so page loads are fast.

```text
id
period             today | week | all
repo_id
rank
stars_gained
current_stars
score
computed_at
```

Indexes:

```text
(period, computed_at, rank)
(repo_id, period)
```

## Ingestion Job

Run every 1-3 hours.

Steps:

1. Build candidate search queries.
2. Fetch candidates from GitHub Search API.
3. Upsert repository metadata into `repositories`.
4. Insert a star snapshot into `repo_star_snapshots`.
5. Fetch releases for top candidates and store `.dmg` asset metadata.
6. Recompute rankings for Today, Week, and All time.
7. Delete snapshots older than 30-60 days.

For MVP, hourly ingestion is enough. More frequent ingestion improves freshness but increases API usage.

## Ranking Logic

### Today

```sql
stars_gained_24h =
  latest_snapshot.stars - snapshot_at_or_before(now - interval '24 hours').stars
```

Fallback if a repo was first seen less than 24 hours ago:

```text
stars_gained_24h = latest_stars - first_seen_stars
```

Show a small label such as `+1,248 today`.

### Week

```sql
stars_gained_7d =
  latest_snapshot.stars - snapshot_at_or_before(now - interval '7 days').stars
```

Fallback if first seen less than 7 days ago:

```text
stars_gained_7d = latest_stars - first_seen_stars
```

Show `+8,904 this week`.

### All Time

```text
rank by repositories.current_stars desc
```

Show total stars, e.g. `128K stars`.

## API Routes

```text
GET /api/repositories?period=today|week|all&language=&q=&installer=
GET /api/developers?period=today|week|all
GET /api/repositories/:owner/:repo/releases
POST /api/jobs/ingest-github
```

The dashboard should no longer call GitHub directly. It should call Open World's API.

Example response field additions:

```json
{
  "fullName": "vercel/next.js",
  "stars": 128000,
  "starsGained": 2400,
  "period": "week",
  "rank": 3,
  "trendLabel": "+2.4K this week"
}
```

## UI Changes

Repository cards should make the ranking metric explicit:

- Today tab badge: `+842 today`
- Week tab badge: `+5.6K this week`
- All time tab badge: `128K stars`

Add small supporting text near the leaderboard:

- Today: `Ranked by stars gained over the trailing 24 hours.`
- Week: `Ranked by stars gained over the trailing 7 days.`
- All time: `Ranked by total GitHub stars.`

Add an `Updated X minutes ago` timestamp based on the latest ranking `computed_at`.

## Accuracy Notes

The snapshot approach measures star growth only after Open World starts tracking a repo. That is acceptable for MVP if we label early data clearly. After 7 days of hourly ingestion, Week rankings become fully accurate for tracked repos. After 24 hours, Today rankings become fully accurate for tracked repos.

If we need backfilled historical star events, the alternatives are:

- GitHub Archive / GHArchive event data
- BigQuery public GitHub event datasets
- Per-repository stargazer pagination with `application/vnd.github.star+json`

For this product, scheduled snapshots are simpler, cheaper, and reliable enough for MVP.

## Implementation Phases

### Phase 1: Server Foundation

- Create Next.js app structure.
- Move current static UI into React components.
- Add `.env.local` with `GITHUB_TOKEN`.
- Add server-side GitHub client.
- Add `/api/repositories` returning current GitHub search results.

Verification:

- Today/Week/All tabs still render.
- Token is never exposed to the browser.
- Rate-limit errors are handled server-side.

### Phase 2: Database And Snapshots

- Add database schema.
- Add repository upsert.
- Add snapshot insert.
- Add ingestion command/job.
- Seed initial snapshot data.

Verification:

- Running ingestion twice creates two snapshots per tracked repo.
- No duplicate repository records.
- Snapshot indexes support period lookups.

### Phase 3: Star Velocity Rankings

- Implement `stars_gained_24h`.
- Implement `stars_gained_7d`.
- Implement all-time `current_stars`.
- Store computed rankings in `repo_rankings`.
- Update `/api/repositories` to read from rankings.

Verification:

- Seed test snapshots with known star counts.
- Confirm Today ranking sorts by 24h delta.
- Confirm Week ranking sorts by 7d delta.
- Confirm All time ranking sorts by total stars.

### Phase 4: UI Integration

- Update trend badges.
- Add ranking explainer copy.
- Add `Updated X minutes ago`.
- Keep language/search/installer filters.
- Preserve DMG release actions.

Verification:

- Desktop and mobile screenshots for all tabs.
- Filtering does not change the ranking metric.
- Empty and loading states are still clean.

## Testing Plan

Unit tests:

- Date-window snapshot selection.
- Star delta calculation.
- Ranking sort order.
- Fallback for newly tracked repos.

Integration tests:

- Ingestion upserts repositories.
- Ingestion inserts snapshots.
- Ranking job writes `today`, `week`, and `all` rows.
- API returns expected sorted records.

Browser QA:

- Today tab shows `+X today`.
- Week tab shows `+X this week`.
- All time tab shows `X stars`.
- Filters continue to work.
- DMG buttons only appear when `.dmg` release assets exist.

## Recommended Next Step

Implement Phase 1 and Phase 2 together. The current static app can stay available while the Next.js version is built in parallel, but true Today/Week rankings require snapshots, so the backend/database work is the critical path.

## Sources

- GitHub repository search supports repository qualifiers like stars, language, pushed/created dates, and sorting by stars: https://docs.github.com/en/rest/search/search
- GitHub repository objects expose `stargazers_count`, `forks_count`, `pushed_at`, topics, and release URLs: https://docs.github.com/en/rest/repos/repos
- GitHub stargazer endpoints can expose star timestamps with the star media type, but using that at scale is expensive compared with snapshots: https://docs.github.com/en/rest/activity/starring
- GitHub Events API includes event objects such as `WatchEvent`, but events are not a complete durable product-grade historical ranking source: https://docs.github.com/en/rest/using-the-rest-api/github-event-types
