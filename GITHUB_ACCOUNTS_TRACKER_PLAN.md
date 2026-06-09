# Starboard GitHub Accounts Tracker Plan

## Goal

Add an account leaderboard to Starboard that ranks GitHub users and organizations by repository stars.

The same time toggles should apply:

- Today
- Week
- Month
- All time

The repository table remains the core experience, but users can switch to an account view to discover the most interesting builders and organizations behind starred repositories.

## Definitions

### Account

An account is a GitHub repository owner:

- `User`
- `Organization`

For Starboard, both should be supported. The UI can label them as `User` or `Org`.

### Qualifying Account

An account qualifies when it owns:

- at least one public, non-fork, non-archived repository
- with at least one star

### Period Score

Recommended definition for period tabs:

- `Today`: sum stars across that account's qualifying repos created in the last 24 hours.
- `Week`: sum stars across that account's qualifying repos created in the last 7 days.
- `Month`: sum stars across that account's qualifying repos created in the last 30 days.
- `All time`: sum stars across all indexed qualifying repos owned by the account.

This is cleaner than ranking an account by total all-time stars just because it created one new repo today. It answers: “which accounts created the most starred repos in this period?”

## Product Behavior

### View Switch

Add a simple view switch near the leaderboard controls:

```text
Repos | Accounts
```

Current default:

- `Repos`

New view:

- `Accounts`

The existing period tabs continue to work for both views.

### Accounts Table

Recommended columns:

```text
# | Account | Type | Stars | Repos | Top repo | Visit
```

Where:

- `#`: rank
- `Account`: avatar, login, display name when available
- `Type`: `User` or `Org`
- `Stars`: summed stars for the current period scope
- `Repos`: number of qualifying repos contributing to the score
- `Top repo`: highest-star repo contributing to the account score
- `Visit`: button linking to the GitHub account

Keep the same black-and-white table style as the repo leaderboard.

## Static MVP Feasibility

The current Starboard app is static and fetches GitHub Search results directly from the browser.

For a static MVP, the account leaderboard can be computed by aggregating repository search results already fetched from GitHub:

1. Fetch repositories for the active period.
2. Filter to `stars >= 1`, non-fork, non-archived repos.
3. Group repos by `owner.id`.
4. Sum stars per owner.
5. Count qualifying repos per owner.
6. Track top repo per owner.
7. Sort owners by summed stars.
8. Render accounts 20 at a time.

This is feasible and useful, but it is not complete.

### Static MVP Boundaries

GitHub Search can expose only a bounded result window for one query. Starboard already works around this by fetching pages of 100 and revealing 20 at a time.

For the static account MVP:

- Today can aggregate up to the first 1,000 matching repos.
- Week can aggregate up to the first 1,000 matching repos.
- Month can aggregate up to the first 1,000 matching repos.
- All time can aggregate up to the first 1,000 matching repos.

That means:

- Today may be close enough for an MVP.
- Week may be acceptable depending on volume.
- Month will often be incomplete.
- All time will not be a true global account leaderboard.

The UI should avoid claiming full coverage in the static version.

Recommended copy:

```text
Showing accounts aggregated from the first 1,000 searchable GitHub repositories.
```

## Static MVP Query Strategy

Reuse the existing repository query model.

### Today

```text
archived:false fork:false stars:>=1 created:>=YYYY-MM-DD
sort=stars
order=desc
per_page=100
page=1..10
```

Aggregation:

- include repos created in the last 24 hours
- group by owner
- score by sum of stars from those repos

### Week

```text
archived:false fork:false stars:>=1 created:>=YYYY-MM-DD
sort=stars
order=desc
per_page=100
page=1..10
```

Aggregation:

- include repos created in the last 7 days
- group by owner
- score by sum of stars from those repos

### Month

```text
archived:false fork:false stars:>=1 created:>=YYYY-MM-DD
sort=stars
order=desc
per_page=100
page=1..10
```

Aggregation:

- include repos created in the last 30 days
- group by owner
- score by sum of stars from those repos

### All Time

```text
archived:false fork:false stars:>=1
sort=stars
order=desc
per_page=100
page=1..10
```

Aggregation:

- group owners from the fetched repo set
- score by sum of stars from fetched repos

Important: this is “top accounts among the highest-star searchable repos we fetched,” not a complete all-time leaderboard.

## Static MVP Data Shape

Add an account aggregator that derives account rows from repo rows:

```js
{
  id: owner.id,
  login: owner.login,
  type: owner.type, // User | Organization
  avatarUrl: owner.avatar_url,
  htmlUrl: owner.html_url,
  starScore: 12345,
  repoCount: 4,
  topRepo: {
    name: "repo-name",
    fullName: "owner/repo-name",
    stars: 10000,
    url: "https://github.com/owner/repo-name"
  }
}
```

Current `normalizeRepo` should preserve:

- `owner.id`
- `owner.login`
- `owner.type`
- `owner.avatar_url`
- `owner.html_url`

## Frontend State

Add view state:

```js
const state = {
  view: "repos", // repos | accounts
  period: "today",
  query: "",
  sortKey: "default",
  sortDirection: "desc"
};
```

Account view-specific sorting:

- `Stars`: sort by account star score
- `Repos`: sort by qualifying repo count

Search in account view:

- account login
- account type
- top repo name
- contributing repo names/descriptions, if available in fetched data

## Static MVP Implementation Phases

### Phase 1: Preserve Owner Metadata

- Update repo normalization to preserve owner ID, type, avatar, and account URL.
- Confirm existing repository rendering still works.

Verification:

- Repo rows still render.
- Owner data is present in dev console or test output.

### Phase 2: Account Aggregation

- Add `buildAccountRows(repos)`.
- Group by `owner.id`.
- Sum stars.
- Count repos.
- Track top repo.
- Sort by stars descending.

Verification:

- One owner with multiple fetched repos appears once.
- Stars equal the sum of that owner’s qualifying repos.
- `topRepo` is the highest-star contributing repo.

### Phase 3: Accounts Table UI

- Add `Repos | Accounts` segmented control.
- Add account row template.
- Render account leaderboard when `state.view === "accounts"`.
- Reuse the existing loading, empty, and load-more patterns.

Verification:

- Switching views does not refetch unnecessarily.
- Today/Week/Month/All time still switch correctly.
- Account rows look consistent with repo rows.

### Phase 4: Sorting And Search

- In account view, make `Stars` and `Repos` sortable.
- Keep keyword search for account login and top repo.
- Preserve existing repo search behavior in repo view.

Verification:

- Stars toggles high-to-low and low-to-high.
- Repos toggles high-to-low and low-to-high.
- Search filters accounts without breaking repo view.

### Phase 5: Coverage Copy

- Add a status line in account view:

```text
Accounts aggregated from 100 fetched repositories.
```

If the period hits the GitHub Search cap:

```text
Accounts aggregated from the first 1,000 searchable GitHub repositories.
```

Verification:

- Copy changes as more repo pages are fetched.
- Copy does not claim complete coverage in static MVP.

## Backend Version For True Rankings

The static MVP is useful, but true account rankings require a backend index.

### Why Backend Is Required

GitHub does not provide a single endpoint for:

- “top accounts by total stars across all repositories”
- “top accounts by stars from repos created this week”
- “sum stars across every public repo owned by each account”

To compute that accurately, Starboard needs to store and aggregate repository data.

### Backend Data Model

#### accounts

```text
id                  GitHub account ID
login
type                User | Organization
avatar_url
html_url
name
bio_or_description
public_repos
followers
last_seen_at
```

#### repositories

```text
id
owner_id
owner_login
name
full_name
description
stars
forks
created_at
updated_at
archived
fork
english_status
last_seen_at
```

#### account_snapshots

Useful for future trend features.

```text
account_id
period_scope        today | week | month | all
star_score
repo_count
top_repo_id
captured_at
```

### Backend API

```text
GET /api/accounts
```

Query params:

```text
period=today|week|month|all
sort=stars|repos
direction=desc|asc
page=1
limit=20
q=optional account search
```

Response:

```json
{
  "items": [
    {
      "rank": 1,
      "login": "example",
      "type": "Organization",
      "avatarUrl": "...",
      "htmlUrl": "https://github.com/example",
      "starScore": 123456,
      "repoCount": 42,
      "topRepo": {
        "fullName": "example/tool",
        "stars": 50000,
        "htmlUrl": "https://github.com/example/tool"
      }
    }
  ],
  "period": "week",
  "page": 1,
  "limit": 20,
  "hasMore": true,
  "coverage": {
    "status": "indexing",
    "updatedAt": "2026-06-08T20:00:00Z"
  }
}
```

## Backend Aggregation Queries

### Today

```sql
select
  owner_id,
  owner_login,
  sum(stars) as star_score,
  count(*) as repo_count
from repositories
where created_at >= now() - interval '1 day'
  and stars >= 1
  and archived = false
  and fork = false
group by owner_id, owner_login
order by star_score desc
limit 20;
```

### Week

Same as Today, but:

```sql
created_at >= now() - interval '7 days'
```

### Month

Same as Today, but:

```sql
created_at >= now() - interval '30 days'
```

### All Time

```sql
select
  owner_id,
  owner_login,
  sum(stars) as star_score,
  count(*) as repo_count
from repositories
where stars >= 1
  and archived = false
  and fork = false
group by owner_id, owner_login
order by star_score desc
limit 20;
```

## Recommended MVP Scope

Build this in two steps:

1. Static MVP account view:
   - group fetched repositories by owner
   - rank accounts by stars
   - reuse period tabs and load-more behavior
   - add honest coverage copy

2. Backend account index:
   - compute true account rankings from indexed repositories
   - support accurate all-time totals
   - support complete Today/Week/Month coverage beyond the first GitHub Search result window

This gives users value quickly without overclaiming completeness.

## Open Product Decisions

1. Should organizations and individual users be mixed together?
   - Recommendation: yes for MVP, with a visible `Type` column.

2. Should account stars for Today/Week/Month mean stars on repos created in that period, or total account stars if they created anything in that period?
   - Recommendation: stars on repos created in that period.

3. Should forks count?
   - Recommendation: no. Forks pollute discovery.

4. Should archived repos count?
   - Recommendation: no. Archived repos are usually less useful for discovery.

5. Should account view inherit the English-only repository gate?
   - Recommendation: yes. Only English-passing repos should contribute to an account score in the current product.

## Risks

- Static account rankings are incomplete because they only aggregate fetched GitHub Search results.
- All-time account rankings are especially incomplete without a backend index.
- Users with one huge repo can dominate; this may be correct, but `repoCount` helps explain the score.
- Organizations will likely dominate all-time rankings.
- GitHub API rate limits and search caps make browser-only global aggregation impractical.

## Acceptance Criteria

### Static MVP

- User can switch between `Repos` and `Accounts`.
- Today, Week, Month, and All time work in account view.
- Accounts rank by summed stars from qualifying fetched repos.
- Each account row shows avatar, login, type, stars, repo count, top repo, and GitHub link.
- Load more works without duplicating accounts.
- Coverage copy clearly states aggregation source.
- Existing repo leaderboard behavior remains intact.

### Backend Version

- Account rankings are computed from Starboard’s repository index.
- All-time rankings sum stars across all indexed qualifying repos.
- Today/Week/Month rankings sum stars across repos created in the period.
- API supports pagination, sorting, and account search.
- UI no longer depends on browser-only aggregation for account rankings.

## Sources

- GitHub REST repository endpoints expose repository owner metadata, repository stars, forks, creation time, archive state, fork state, and pagination up to 100 per page: https://docs.github.com/en/rest/repos/repos
- GitHub REST API documentation notes authenticated requests have higher limits than unauthenticated requests: https://docs.github.com/en/rest
- GitHub REST rate-limit endpoint and rate-limit docs: https://docs.github.com/en/rest/rate-limit/rate-limit
- GitHub Search behavior and result-window constraints need to be treated as a product limitation for the static MVP: https://docs.github.com/en/rest/search/search
