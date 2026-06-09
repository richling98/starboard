# Starboard Black-And-White Table Redesign Plan

## Goal

Restyle Starboard to feel closer to `skills.sh`: stark black-and-white, terminal-native, compact, and leaderboard-first. The repo list should move away from card-style product tiles and toward a structured table with clear columns:

- Rank
- Repository
- Stars
- Forks
- Visit repo button

This plan is for review only. No implementation should happen until approved.

## Reference Direction

`skills.sh` uses:

- Pure black/white visual language
- Terminal/ASCII-style hero branding
- Minimal borders and restrained controls
- Dense leaderboard rows
- Clear column labels
- Strong monospace influence
- No decorative color chips

Starboard should keep its terminal `STARBOARD` identity but reduce the remaining color-heavy dashboard feel.

## Requested UI Changes

### 1. Pure Black-And-White Theme

Replace the current green/blue/red/yellow accent system with monochrome tokens.

Proposed tokens:

```css
--page: #000000;
--panel: #050505;
--panel-2: #0d0d0d;
--ink: #f5f5f5;
--muted: #a3a3a3;
--line: #2a2a2a;
--line-strong: #525252;
--inverse: #ffffff;
--inverse-ink: #000000;
```

Use white for primary labels/buttons, gray for metadata, and black for the page background. No green active tabs, no colored metric dots, no colored topic/language pills.

### 2. Keep Terminal Header, Make It Monochrome

Keep:

- `STARBOARD`
- `THE OPEN SOURCE ECOSYSTEM`

Adjust:

- Remove green from top-left logo mark.
- Make logo mark black/white only.
- Make active tab black/white instead of mint green.
- Keep the terminal/block title but ensure shadows are grayscale only.

### 3. Remove Language Pill From Each Repo

Currently each repo card creates a language chip from `repo.language`.

Remove:

- The language pill
- Topic pills if they visually conflict with the clean table direction

Recommendation:

- Remove all pills from the main row for the first table version.
- If topics are useful later, add them as small muted text under the description, not as colored chips.

### 4. Replace Card Layout With Table-Like Rows

Move from:

```text
rank | avatar | repo body | action buttons
```

To:

```text
# | Repo | Stars | Forks | Visit
```

Desktop layout:

```text
┌──────┬──────────────────────────────────────┬──────────┬──────────┬────────────────────┐
│ #    │ Repo                                 │ Stars    │ Forks    │ Actions            │
├──────┼──────────────────────────────────────┼──────────┼──────────┼────────────────────┤
│ 1    │ [logo] repo-name                     │ 12.4K    │ 1.2K     │ Visit repo         │
│      │ owner/name + short description       │          │          │                    │
└──────┴──────────────────────────────────────┴──────────┴──────────┴────────────────────┘
```

Note: the final action column should not have visible header text. It exists only to align the `Visit repo` button.

Mobile layout:

- Keep rows as stacked panels, but preserve the same order:
  - rank and repo identity
  - description
  - stars/forks inline
  - `Visit repo` button

Avoid horizontal scrolling on mobile unless absolutely necessary.

### 5. Stars And Forks Columns

Replace the colored metadata bullet row with two explicit columns:

- Stars
- Forks

Remove:

- Issues count
- Pushed date
- Colored bullets

Use GitHub-like icons:

- Star icon next to star count
- Fork icon next to fork count

Implementation option:

- Use inline SVG icons to avoid adding dependencies.
- Keep them monochrome via `currentColor`.

Example:

```html
<span class="metric-cell">
  <svg aria-hidden="true">...</svg>
  12.4K
</span>
```

### 6. Visit Repo Column

Final column contains one action only:

- `Visit repo`

Button styling:

- White primary button
- Black text
- Opens the GitHub repository in a new tab

Remove:

- Releases button
- DMG button
- DMG/release lookup from the table UI
- Visible header label for the final action column

### 7. Controls Bar Simplification

Keep:

- Today
- Week
- Month
- All time
- Search
- Language filter
- Installer filter
- Compact toggle if still useful

Restyle:

- Active tab: white background, black text
- Inactive tabs: black background, white/gray text
- Inputs/selects: black background, white border/text

Possible later simplification:

- Remove compact toggle once table rows are dense enough.

## Code-Level Change Plan

### `index.html`

Update repo template from card anatomy to row/table anatomy.

Current template:

```html
<article class="repo-card">
  <div class="repo-rank"></div>
  <img class="repo-avatar" />
  <div class="repo-body">...</div>
  <div class="repo-actions"></div>
</article>
```

Proposed:

```html
<article class="repo-row">
  <div class="repo-rank"></div>
  <div class="repo-identity">
    <img class="repo-avatar" />
    <div>
      <p class="repo-owner"></p>
      <h3 class="repo-name"></h3>
      <p class="repo-description"></p>
    </div>
  </div>
  <div class="repo-stars"></div>
  <div class="repo-forks"></div>
  <div class="repo-actions"></div>
</article>
```

Add a visible header row:

```html
<div class="repo-table-header">
  <span>#</span>
  <span>Repo</span>
  <span>Stars</span>
  <span>Forks</span>
  <span aria-hidden="true"></span>
</div>
```

### `app.js`

Update rendering:

- Stop rendering language chips.
- Stop rendering issue count.
- Stop rendering pushed date.
- Stop rendering topic chips for MVP table version.
- Add `repo-stars` cell with star icon and `formatNumber(repo.stars)`.
- Add `repo-forks` cell with fork icon and `formatNumber(repo.forks)`.
- Replace the current action links with one `Visit repo` link.
- Stop rendering `Releases` and `DMG` actions.

Remove or stop using:

- `createMeta(repo)` or rewrite it into `metricCell`.
- `topic-list` construction.
- `topic.language`.
- `meta-dot` logic.
- `enrichReleases(...)`, unless future UI still needs release data.
- `findReleaseAsset(...)`, unless future UI still needs release data.

Keep:

- GitHub data fetching
- English gate
- loading skeleton behavior
- filters
- period tabs

### `styles.css`

Major restyle:

- Replace color tokens with monochrome system.
- Rename or adapt `.repo-card` styles to `.repo-row`.
- Add `.repo-table-header`.
- Add CSS grid columns:

```css
.repo-table-header,
.repo-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) 120px 120px 220px;
  gap: 16px;
  align-items: center;
}
```

Responsive:

```css
@media (max-width: 760px) {
  .repo-table-header {
    display: none;
  }

  .repo-row {
    grid-template-columns: 44px minmax(0, 1fr);
  }

  .repo-stars,
  .repo-forks,
  .repo-actions {
    grid-column: 1 / -1;
  }
}
```

Skeletons:

- Update skeleton cards to match table columns.
- Keep the pulsing loading indicator.

## Open Questions For Review

1. Should topic chips be removed entirely, or should topics appear as muted inline text under the description?
2. Should the `Compact` toggle remain, or should the new table design make it unnecessary?
3. Should the rank column show `#1`, `#2`, etc., or plain `1`, `2`, etc. like `skills.sh`?

## Recommended Decisions

For the cleanest MVP:

- Remove language and topic pills entirely.
- Keep `Compact` for now, but consider removing after table density is proven.
- Use plain rank numbers: `1`, `2`, `3`.
- Use one action button labeled `Visit repo`.
- Use monochrome inline SVG star/fork icons.

## Verification Plan

After implementation:

- Run `node --check app.js`.
- Render desktop screenshot at `1440x1200`.
- Render mobile screenshot at `390x1200`.
- Confirm no colored UI accents remain except images/logos from GitHub avatars.
- Confirm no language pill appears.
- Confirm rows show only stars and forks, not issues or pushed date.
- Confirm each row has one `Visit repo` button and no Releases/DMG button.
- Confirm Today, Week, Month, and All time still load 20 repos.
- Confirm loading skeletons still appear during buffering.

## Source Reference

- `skills.sh` reference inspected for terminal hero and leaderboard structure: https://www.skills.sh/
