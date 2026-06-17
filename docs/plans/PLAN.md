# Open World MVP Plan

## Product Goal

Open World is a polished discovery dashboard for open source projects and builders. The first version should feel closer to Product Hunt or a curated startup directory than GitHub's default trending page: visual, scannable, opinionated, and focused on helping someone quickly decide what is worth opening, starring, or installing.

## Core Assumptions

- The MVP will be a web app, not a browser extension.
- Public GitHub data is enough for the first version.
- "All time" can be ranked by total stars.
- "Past 24 hours" and "past week" need a clear MVP definition because GitHub's official REST search does not expose GitHub Trending's exact ranking algorithm or direct star-gain deltas.
- For the MVP, daily and weekly repository rankings should use either:
  - `created:>=DATE sort:stars` as a simple "top recently created repositories" view, or
  - a scheduled ingestion job that snapshots star counts and computes local star velocity.
- The second option is more accurate and should be the target if we want Open World to feel meaningfully better than a prettier search page.

## MVP Scope

### Repository Discovery

The primary view is a repository leaderboard with period toggles:

- Today
- This week
- All time

Each repository card should show:

- Repository name and owner
- One-line description from GitHub
- Optional expanded summary generated from README content later
- Language and topic chips
- Stars, forks, open issues, license, and last pushed date
- Trend indicator for the selected time range
- Owner avatar
- Latest release version, when available
- DMG availability badge, when release assets include `.dmg`

Actions:

- Open repository
- Download DMG, when an eligible release asset exists
- View releases, when no DMG exists but releases exist

### Developer Discovery

Add a right rail or dedicated tab for top GitHub developers.

MVP developer ranking:

- All time: users sorted by followers.
- Today/week: contributors and owners of the top repositories in the selected period, ranked by repo impact plus follower count.

Developer cards should show:

- Avatar
- Name and username
- Bio
- Followers
- Public repositories
- Notable top repo from the current list
- Profile link

### Filters And Controls

The dashboard should include:

- Period segmented control: Today, Week, All time
- Language filter
- Topic/search input
- Sort toggle: Trending, Stars, Recent activity
- Platform filter for downloads: macOS DMG, any release, no installer
- Compact/list view toggle

## Data Strategy

### Recommended MVP Architecture

Use a small server-backed app instead of calling GitHub directly from the browser.

Reasons:

- Keeps a GitHub token out of client code.
- Allows caching to avoid rate limits.
- Enables star-count snapshots for real daily/weekly trending later.
- Makes DMG asset discovery practical without hammering GitHub's API from every client.

Recommended stack:

- Next.js App Router
- TypeScript
- Tailwind CSS
- shadcn/ui or custom Radix-based components
- GitHub REST API via Octokit
- SQLite or Postgres for snapshots
- Vercel Cron, GitHub Actions cron, or a lightweight scheduled job for ingestion

### GitHub API Endpoints

Repository candidates:

- `GET /search/repositories`
- All time query: `q=stars:>1&sort=stars&order=desc`
- Today query: `q=created:>=YYYY-MM-DD&sort=stars&order=desc`
- Week query: `q=created:>=YYYY-MM-DD&sort=stars&order=desc`

Users:

- `GET /search/users`
- All time query: `q=followers:>1000&sort=followers&order=desc`

Releases and downloads:

- `GET /repos/{owner}/{repo}/releases`
- Find assets with names ending in `.dmg`.
- Use `browser_download_url` for the download button.

Rate limiting:

- Unauthenticated GitHub REST API access is low enough that the app should assume authenticated requests and server-side caching.
- Cache repository lists and release asset lookups.
- Start with a 15-60 minute TTL for search results and a 6-24 hour TTL for release assets.

### Better Trending In Phase 2

For a more faithful "trending" experience, store snapshots:

- `repo_id`
- `full_name`
- `stars`
- `forks`
- `open_issues`
- `pushed_at`
- `captured_at`

Then compute:

- `stars_gained_24h`
- `stars_gained_7d`
- `activity_score`
- `freshness_score`

Suggested ranking formula:

```text
score =
  stars_gained * 1.0
  + forks_gained * 0.4
  + log(total_stars + 1) * 0.3
  + recent_push_bonus
  - stale_repo_penalty
```

This makes the Today/Week toggles genuinely useful instead of just showing newly created repositories.

## UX Direction

### Visual Personality

Open World should feel like a premium open source discovery surface:

- Clean, editorial, high-density layout
- Strong repository cards with visible hierarchy
- Warm white or soft neutral background, not GitHub gray
- Accent palette that avoids a single dominant hue
- Subtle borders and shadows
- Large owner avatars and language color cues
- Fast toggles, no heavy marketing hero

The first screen should be the actual dashboard:

- Top nav with Open World wordmark
- Search/filter row
- Period segmented control
- Repository feed
- Developer sidebar or tab

### Main Layout

Desktop:

- Left/main: ranked repository feed
- Right: top developers, language/topic heat, "installer-ready" repos

Mobile:

- Sticky period toggle
- Repository cards full-width
- Developers moved into a tab

### Repository Card Anatomy

Each card should include:

- Rank number
- Owner avatar
- Repo name
- Owner username
- Short description
- Topics/language chips
- Metrics row
- Action buttons aligned right or bottom:
  - Repository
  - Download DMG, when available
  - Releases, as fallback

The DMG button should only appear as a primary action when a verified `.dmg` release asset exists. If no DMG exists, show a quieter "Releases" action rather than a dead button.

## Routes

MVP routes:

- `/` dashboard
- `/api/repositories?period=today|week|all&language=&q=`
- `/api/developers?period=today|week|all`
- `/api/repositories/[owner]/[repo]/releases`

Optional later routes:

- `/repo/[owner]/[repo]` richer detail page
- `/developer/[username]` developer profile
- `/collections` curated lists

## Data Model

```text
Repository
- id
- owner
- name
- fullName
- htmlUrl
- description
- language
- topics
- stars
- forks
- openIssues
- license
- pushedAt
- createdAt
- avatarUrl
- latestReleaseUrl
- dmgAssetName
- dmgDownloadUrl
- score

Developer
- id
- login
- name
- avatarUrl
- htmlUrl
- bio
- followers
- publicRepos
- notableRepoFullName
- score

RepoSnapshot
- repoId
- fullName
- stars
- forks
- openIssues
- pushedAt
- capturedAt
```

## Implementation Phases

### Phase 1: Static Product Prototype

Goal: prove the dashboard interaction and visual direction.

Tasks:

- Create Next.js project.
- Build responsive dashboard shell.
- Use mocked repository and developer data.
- Implement period toggles, filters, cards, and action states.
- Add empty/loading/error states.

Verification:

- Run local build.
- Check desktop and mobile screenshots.
- Confirm no overlapping text or broken responsive cards.

### Phase 2: Live GitHub Data

Goal: populate the dashboard from GitHub.

Tasks:

- Add server-side GitHub client.
- Implement repository search endpoint.
- Implement user search endpoint.
- Add release asset lookup for top repositories.
- Detect `.dmg` assets and wire download buttons.
- Add caching.

Verification:

- Confirm all three period toggles return data.
- Confirm repository links open GitHub URLs.
- Confirm DMG buttons only render when a `.dmg` asset exists.
- Confirm rate-limit errors show a graceful state.

### Phase 3: True Trending

Goal: make Today and Week rankings based on star growth, not only creation date.

Tasks:

- Add database.
- Add scheduled ingestion job.
- Store repository snapshots.
- Compute 24h and 7d star deltas.
- Update ranking formula.

Verification:

- Seed test snapshots.
- Confirm score calculations are deterministic.
- Confirm period toggles show different rankings.

### Phase 4: Polish And Curation

Goal: make Open World feel like a discovery product.

Tasks:

- Add saved filters.
- Add topic collections.
- Add "installer-ready" section.
- Add README-derived summaries.
- Add shareable links for filtered views.

Verification:

- Manual QA across viewport sizes.
- Check performance with 50-100 cards.
- Validate accessible button labels and keyboard navigation.

## Open Questions

- Should "top GitHub developers" mean most followed developers, most active open source contributors, or builders connected to currently trending repos?
- Should daily/week trending prioritize new projects, fast-growing existing projects, or both?
- Should Open World target macOS users first because of the DMG requirement, or should it also show Windows/Linux installers?
- Should summaries be raw GitHub descriptions in MVP, or should README-based AI summaries be included from the start?

## Recommended MVP Decision

Build the first version as a live GitHub discovery dashboard with:

- Beautiful responsive UI.
- Period toggles.
- GitHub Search API-backed repository lists.
- Top developer sidebar.
- Release asset lookup.
- DMG download action when available.
- Server-side caching.

Then add snapshot-based star velocity as the first post-MVP upgrade. That keeps the MVP achievable while preserving a path toward a genuinely better trending product.

## References

- GitHub Trending: https://github.com/trending
- GitHub REST repository search: https://docs.github.com/en/rest/search/search
- GitHub REST user search: https://docs.github.com/en/rest/search/search
- GitHub REST releases: https://docs.github.com/en/rest/releases/releases
- GitHub REST release assets: https://docs.github.com/en/rest/releases/assets
- GitHub REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
