# Semantic Cron Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated scheduled backfill pipeline that steadily increases Starboard's semantic embedding coverage without making normal site deploys slow or brittle.

**Architecture:** Keep the existing `Starboard Index` workflow responsible for discovery, snapshots, and full site deployment. Add a separate semantic backfill workflow that runs on cron, embeds a bounded number of missing/stale repositories, records coverage/cost metrics, exports a sanitized dashboard data file, and publishes the current static site with refreshed dashboard metrics. Reuse the existing Supabase tables, quality gate, README fetcher, and embedding helpers, but add a backlog-oriented candidate mode so the job prioritizes the most useful unembedded repos first.

**Tech Stack:** GitHub Actions cron, Node.js scripts, Supabase Postgres/pgvector, GitHub API, OpenAI `text-embedding-3-small`.

---

## Executive Summary

Starboard currently has semantic search, but it only works well for repositories that already have embeddings. The right way to reach broad coverage is a slow, resumable cron backfill job. Instead of trying to embed everything in one large run, Starboard should embed a fixed number of missing repositories on a schedule, such as 500 repositories every 6 hours or 1,000 repositories nightly.

The main site workflow should stay focused on freshness: discover repos, refine English status, build leaderboard snapshots, export static data, and deploy GitHub Pages. The new backfill workflow should be separate and focused on semantic coverage plus dashboard refreshes. If the backfill job fails, the already-deployed website should remain untouched and the main deploy workflow should still run normally.

Coverage should mean "every repository Starboard has discovered and stored," not every public GitHub repository globally. GitHub's public search APIs do not make a complete global repo index practical from a static MVP. The backfill job should prioritize true coverage first: repositories with no embedding at all should be processed before any stale refresh work. Within the missing-embedding pool, order by usefulness: leaderboard repos first, high-star repos next, then recent repos. Only after the missing-embedding backlog is drained, or when a run has spare capacity after selecting all missing candidates, should the job spend time on stale embeddings.

Keyword fallback should remain permanently. Even after broad embedding coverage, keyword search is still better for exact repo names, owners, acronyms, and literal terms.

This work should also include a small public progress dashboard for the backfill plan. The dashboard should show embedding coverage, remaining repositories, recent cron runs, failures, fixes applied, and which implementation tasks are complete. It should be generated from sanitized Supabase metrics and checked-in plan metadata, then deployed as a static GitHub Pages page so progress is easy to inspect without opening GitHub Actions or Supabase.

## Current State

- `.github/workflows/starboard-index.yml` runs every 6 hours and deploys GitHub Pages.
- The main workflow currently runs `npm run build:semantic-index` with `STARBOARD_SEMANTIC_LIMIT=500`.
- `scripts/build-semantic-index.mjs` embeds selected repositories and records usage/cost in `ingestion_runs.metadata`.
- `db.mjs` owns Supabase schema setup and repository/embedding queries.
- `repository_search_documents` stores the text document used for semantic search.
- `repository_embeddings` stores vectors for `text-embedding-3-small`.
- `repository_semantic_rejections` stores quality-filter rejects so junk does not consume budget every run.
- `app.js` already uses hybrid search: semantic matches plus keyword fallback.

## Desired End State

- A new scheduled workflow, `.github/workflows/starboard-semantic-backfill.yml`, runs independently from the full indexing workflow.
- A new npm script, `backfill:semantic-index`, runs an embedding-only backfill pass.
- The main deploy workflow either keeps a small semantic refresh or removes the heavy semantic step after the backfill workflow proves stable.
- Supabase records enough metadata to answer:
  - how many repos are discovered
  - how many are embedded
  - how many are rejected
  - how many are stale
  - how much the last backfill cost
  - whether the job is falling behind
- The search UI continues to work for unembedded repos through keyword fallback.
- A static semantic backfill dashboard is available on GitHub Pages and shows:
  - embedded repository count
  - remaining eligible repository count
  - coverage percentage
  - latest run status, runtime, token usage, and estimated cost
  - recent errors and the fix or mitigation for each one
  - implementation progress through this plan

## Non-Goals

- Do not build a full global GitHub crawler.
- Do not embed every public GitHub repository.
- Do not introduce Pinecone, Weaviate, or another vector database.
- Do not require users to sign in.
- Do not expose Supabase secrets, GitHub tokens, OpenAI keys, database URLs, or raw private logs in the dashboard.
- Do not remove keyword fallback.
- Do not make the full site freshness workflow depend on semantic backfill completion.

## Recommended Schedule

Start conservative:

```text
Every 6 hours:
- embed up to 500 repositories
- fill the run with missing embeddings first
- use stale refresh candidates only after missing candidates are exhausted
- cap README text at 8,000 characters
- batch OpenAI calls at 50 documents per request
```

This is roughly 2,000 candidate embeddings per day. Based on the last production run, 495 embeddings cost about `$0.0116`, so this cadence should remain inexpensive while giving us clear operational data.

After 3 stable days:

```text
Every 6 hours:
- raise to 1,000 repositories per run if GitHub/OpenAI/Supabase timing remains healthy
```

Do not raise the limit if any of these happen:

- the workflow regularly exceeds 30 minutes
- GitHub README fetches time out heavily
- OpenAI returns rate limit errors
- quality filtering lets obvious spam dominate results
- semantic result quality gets worse

## File Structure

- Modify `package.json`
  - Add `backfill:semantic-index`.

- Modify `scripts/build-semantic-index.mjs`
  - Add a `--job-type` option so normal indexing and backfill runs are distinguishable in `ingestion_runs`.
  - Add a `--strategy` option, defaulting to current behavior.
  - Support `--strategy=backfill` for coverage-oriented candidate selection.

- Modify `db.mjs`
  - Extend `readRepositoriesForSemanticIndex` to accept `strategy`, `staleAfterDays`, and `includeRejectedAfterDays`.
  - Add semantic coverage helper queries.
  - Preserve existing tables; add indexes only if query plans need them.

- Create `scripts/report-semantic-coverage.mjs`
  - Print a compact coverage summary for GitHub Actions logs.
  - Exit non-zero only for script/config errors, not for low coverage.

- Create `scripts/export-semantic-dashboard-data.mjs`
  - Export sanitized dashboard JSON from Supabase into `data/semantic-dashboard.json`.
  - Include coverage numbers, recent run summaries, rejection counts, known issue/fix notes, and plan checklist status.

- Create `semantic-dashboard.html`
  - Static dashboard page served by GitHub Pages.
  - Loads `data/semantic-dashboard.json`.
  - Shows progress bars, run history, errors/fixes, and plan progress.

- Create `semantic-dashboard.js`
  - Client-side renderer for the dashboard JSON.
  - No direct Supabase, GitHub, or OpenAI calls.

- Create `semantic-dashboard.css`
  - Dashboard-only styling that matches Starboard's black-and-white developer aesthetic.

- Modify `scripts/build-pages-dist.mjs`
  - Copy the dashboard HTML, JS, and CSS into `dist`.

- Create `.github/workflows/starboard-semantic-backfill.yml`
  - Run on cron and manual dispatch.
  - Use the same secrets as the current workflow.
  - Run setup, backfill, coverage reporting, dashboard data export, static data export, Pages build, and Pages deploy.
  - Deploy only after the backfill succeeds, so a failed backfill cannot overwrite the live site with partial dashboard data.

- Modify `.github/workflows/starboard-index.yml`
  - Keep discovery/snapshot/deploy behavior unchanged.
  - Reduce or remove the heavy semantic step after the separate backfill job is verified.

- Optional later: Modify `README.md`
  - Document the two workflows and how to manually trigger a backfill.

---

## Task 1: Add Backfill Script Entry Point

**Files:**
- Modify: `package.json`

- [x] **Step 1: Add the npm script**

Add this script next to the existing semantic script:

```json
"backfill:semantic-index": "node scripts/build-semantic-index.mjs --job-type=backfill-semantic-index --strategy=backfill"
```

Expected relevant `scripts` block:

```json
{
  "build:semantic-index": "node scripts/build-semantic-index.mjs",
  "backfill:semantic-index": "node scripts/build-semantic-index.mjs --job-type=backfill-semantic-index --strategy=backfill"
}
```

- [x] **Step 2: Validate package JSON**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8')); console.log('package.json ok')"
```

Expected output:

```text
package.json ok
```

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add semantic backfill script"
```

---

## Task 2: Add Job Type And Strategy Flags

**Files:**
- Modify: `scripts/build-semantic-index.mjs`

- [x] **Step 1: Parse explicit job type and strategy**

In the existing option parsing area, add support for:

```js
const jobType = readOption("job-type", "STARBOARD_SEMANTIC_JOB_TYPE", "build-semantic-index");
const strategy = readOption("strategy", "STARBOARD_SEMANTIC_STRATEGY", "balanced");
const staleAfterDays = Number(readOption("stale-after-days", "STARBOARD_SEMANTIC_STALE_AFTER_DAYS", "14"));
const includeRejectedAfterDays = Number(
  readOption("include-rejected-after-days", "STARBOARD_SEMANTIC_REJECT_RETRY_DAYS", "30")
);
```

Keep existing defaults for `limit`, `batchSize`, `model`, and `dimensions`.

- [x] **Step 2: Record the job type in ingestion runs**

Change the ingestion run start call from:

```js
runId = await startIngestionRun("build-semantic-index", { limit, batchSize, model, dimensions });
```

to:

```js
runId = await startIngestionRun(jobType, {
  limit,
  batchSize,
  model,
  dimensions,
  strategy,
  staleAfterDays,
  includeRejectedAfterDays
});
```

- [x] **Step 3: Pass strategy into repository selection**

Change:

```js
const repos = await readRepositoriesForSemanticIndex({ limit, embeddingModel: model });
```

to:

```js
const repos = await readRepositoriesForSemanticIndex({
  limit,
  embeddingModel: model,
  strategy,
  staleAfterDays,
  includeRejectedAfterDays
});
```

- [x] **Step 4: Include strategy in final metadata**

Ensure the final summary metadata includes:

```js
summary.strategy = strategy;
summary.staleAfterDays = staleAfterDays;
summary.includeRejectedAfterDays = includeRejectedAfterDays;
```

- [x] **Step 5: Syntax check**

Run:

```bash
node --check scripts/build-semantic-index.mjs
```

Expected output: no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-semantic-index.mjs
git commit -m "feat: parameterize semantic indexing jobs"
```

---

## Task 3: Add Backfill Candidate Ordering

**Files:**
- Modify: `db.mjs`

- [x] **Step 1: Extend `readRepositoriesForSemanticIndex` options**

Update the function signature so it reads:

```js
export async function readRepositoriesForSemanticIndex(options = {}) {
  const {
    limit = 100,
    embeddingModel = "text-embedding-3-small",
    strategy = "balanced",
    staleAfterDays = 14,
    includeRejectedAfterDays = 30
  } = options;
```

- [x] **Step 2: Add stale and rejection retry filters**

The query should select repositories when any of these are true:

```sql
e.repo_github_id is null
or d.content_hash is distinct from e.content_hash
or e.updated_at < now() - ($3::int * interval '1 day')
```

The backfill strategy should not treat these reasons equally. Repositories with `e.repo_github_id is null` are true coverage gaps and must be ordered before repositories that already have an embedding but may be stale. Stale refresh candidates should be included only after missing embeddings, so a run does not spend most of its wall-clock time rechecking already-covered repositories while uncovered repositories remain.

It should exclude semantic rejections unless the rejection is old enough to retry:

```sql
and (
  sr.repo_github_id is null
  or sr.rejected_at < now() - ($4::int * interval '1 day')
)
```

Use `$3` for `staleAfterDays` and `$4` for `includeRejectedAfterDays` if the current query already uses `$1` and `$2` for limit/model. Keep parameters ordered clearly.

- [x] **Step 3: Add strategy-specific ordering**

Implement a small helper inside `db.mjs`:

```js
function semanticCandidateOrderSql(strategy) {
  if (strategy === "backfill") {
    return `
      case when e.repo_github_id is null then 0 else 1 end,
      case when e.repo_github_id is null and d.repo_github_id is null then 0 else 1 end,
      case when exists (
        select 1
        from leaderboard_snapshot_items lsi
        where lsi.repo_github_id = r.github_id
      ) then 0 else 1 end,
      r.stars desc,
      r.forks desc,
      r.created_at desc nulls last,
      r.full_name asc
    `;
  }

  return `
    case when e.repo_github_id is null then 0 else 1 end,
    case when d.content_hash is distinct from e.content_hash then 0 else 1 end,
    case when exists (
      select 1
      from leaderboard_snapshot_items lsi
      where lsi.repo_github_id = r.github_id
    ) then 0 else 1 end,
    r.stars desc,
    r.created_at desc nulls last,
    r.full_name asc
  `;
}
```

Then use:

```js
const orderSql = semanticCandidateOrderSql(strategy);
```

in the query's `order by`.

This ordering is intentionally asymmetric:

- `backfill` means maximize new semantic coverage, so missing embeddings always come first and stale refresh work is secondary.
- `balanced` means preserve current freshness behavior for the deploy-time semantic pass, so changed or stale documents can still be refreshed promptly.

- [x] **Step 4: Guard against unsupported strategies**

Before running the query:

```js
const allowedStrategies = new Set(["balanced", "backfill"]);
if (!allowedStrategies.has(strategy)) {
  throw new Error(`Unsupported semantic index strategy: ${strategy}`);
}
```

- [x] **Step 5: Syntax check**

Run:

```bash
node --check db.mjs
```

Expected output: no syntax errors.

- [x] **Step 6: Smoke test selection locally**

Run:

```bash
npm run backfill:semantic-index -- --limit=1 --batch-size=1
```

Expected result:

- one candidate is processed, skipped, rejected, or embedded
- `ingestion_runs.job_type` for the new row is `backfill-semantic-index`
- no deploy is triggered

- [ ] **Step 7: Commit**

```bash
git add db.mjs
git commit -m "feat: prioritize semantic backfill candidates"
```

---

## Task 4: Add Coverage Reporting

**Files:**
- Create: `scripts/report-semantic-coverage.mjs`

- [x] **Step 1: Create the reporting script**

Create `scripts/report-semantic-coverage.mjs`:

```js
import { getDatabaseClient } from "../db.mjs";

const embeddingModel = process.env.STARBOARD_EMBEDDING_MODEL || "text-embedding-3-small";

function pct(part, total) {
  if (!total) return "0.00%";
  return `${((part / total) * 100).toFixed(2)}%`;
}

const client = await getDatabaseClient();

try {
  const totals = await client.query(
    `
      select
        count(*)::int as repositories,
        count(*) filter (where stars >= 1)::int as starred_repositories,
        count(*) filter (where english_check_status = 'accepted')::int as english_repositories
      from repositories
    `
  );

  const embeddings = await client.query(
    `
      select count(*)::int as embedded_repositories
      from repository_embeddings
      where embedding_model = $1
    `,
    [embeddingModel]
  );

  const rejections = await client.query(
    `
      select reason, count(*)::int as count
      from repository_semantic_rejections
      where embedding_model = $1
      group by reason
      order by count desc, reason asc
    `,
    [embeddingModel]
  );

  const lastRuns = await client.query(
    `
      select job_type, status, started_at, finished_at, metadata
      from ingestion_runs
      where job_type in ('build-semantic-index', 'backfill-semantic-index')
      order by started_at desc
      limit 5
    `
  );

  const total = totals.rows[0];
  const embedded = embeddings.rows[0].embedded_repositories;

  console.log("Semantic coverage");
  console.log(`- model: ${embeddingModel}`);
  console.log(`- repositories: ${total.repositories}`);
  console.log(`- starred repositories: ${total.starred_repositories}`);
  console.log(`- English repositories: ${total.english_repositories}`);
  console.log(`- embedded repositories: ${embedded}`);
  console.log(`- embedded / starred: ${pct(embedded, total.starred_repositories)}`);
  console.log(`- embedded / English: ${pct(embedded, total.english_repositories)}`);

  console.log("Semantic rejections");
  for (const row of rejections.rows) {
    console.log(`- ${row.reason}: ${row.count}`);
  }

  console.log("Recent semantic runs");
  for (const row of lastRuns.rows) {
    const metadata = row.metadata || {};
    console.log(
      `- ${row.job_type} ${row.status}: embeddings=${metadata.embeddingsUpdated ?? 0}, ` +
        `tokens=${metadata.embeddingTokens ?? 0}, cost=$${metadata.estimatedEmbeddingCostUsd ?? 0}`
    );
  }
} finally {
  await client.end();
}
```

- [x] **Step 2: Syntax check**

Run:

```bash
node --check scripts/report-semantic-coverage.mjs
```

Expected output: no syntax errors.

- [x] **Step 3: Run coverage report**

Run:

```bash
node scripts/report-semantic-coverage.mjs
```

Expected output includes:

```text
Semantic coverage
Semantic rejections
Recent semantic runs
```

- [ ] **Step 4: Commit**

```bash
git add scripts/report-semantic-coverage.mjs
git commit -m "chore: report semantic coverage"
```

---

## Task 5: Add Static Semantic Progress Dashboard

**Files:**
- Create: `scripts/export-semantic-dashboard-data.mjs`
- Create: `semantic-dashboard.html`
- Create: `semantic-dashboard.js`
- Create: `semantic-dashboard.css`
- Modify: `scripts/build-pages-dist.mjs`
- Modify: `package.json`

- [x] **Step 1: Add the dashboard export script**

Create `scripts/export-semantic-dashboard-data.mjs`:

```js
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDatabaseClient } from "../db.mjs";

const outputPath = process.env.STARBOARD_SEMANTIC_DASHBOARD_PATH || "data/semantic-dashboard.json";
const embeddingModel = process.env.STARBOARD_EMBEDDING_MODEL || "text-embedding-3-small";

function toNumber(value) {
  return Number(value || 0);
}

function percent(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

function durationSeconds(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  return Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000);
}

const planSteps = [
  { id: "script-entrypoint", label: "Add backfill script entry point", status: "planned" },
  { id: "job-flags", label: "Add job type and strategy flags", status: "planned" },
  { id: "candidate-ordering", label: "Prioritize backfill candidates", status: "planned" },
  { id: "coverage-reporting", label: "Add coverage reporting", status: "planned" },
  { id: "progress-dashboard", label: "Add static progress dashboard", status: "planned" },
  { id: "backfill-workflow", label: "Add dedicated backfill workflow", status: "planned" },
  { id: "deploy-decoupling", label: "Reduce deploy-time semantic indexing", status: "planned" },
  { id: "manual-test", label: "Run manual backfill test", status: "planned" },
  { id: "production-rollout", label: "Monitor production rollout", status: "planned" }
];

const knownIssues = [
  {
    title: "Oversized README embedding batch",
    status: "fixed",
    firstSeen: "2026-06-10",
    symptom: "OpenAI rejected a batch because one README pushed the request over the token limit.",
    fix: "Added individual retry and truncation fallback with STARBOARD_EMBEDDING_RETRY_CHAR_LIMIT."
  },
  {
    title: "Discovery request hanging",
    status: "fixed",
    firstSeen: "2026-06-10",
    symptom: "A GitHub discovery step could stall long enough to make the workflow look stuck.",
    fix: "Added AbortSignal timeouts for GitHub API and README fetch requests."
  }
];

const client = await getDatabaseClient();

try {
  const totals = await client.query(
    `
      select
        count(*)::int as repositories,
        count(*) filter (where stars >= 1)::int as starred_repositories,
        count(*) filter (where english_check_status = 'accepted' and stars >= 1)::int as eligible_repositories
      from repositories
    `
  );

  const embeddingCounts = await client.query(
    `
      select count(*)::int as embedded_repositories
      from repository_embeddings
      where embedding_model = $1
    `,
    [embeddingModel]
  );

  const rejections = await client.query(
    `
      select reason, count(*)::int as count
      from repository_semantic_rejections
      where embedding_model = $1
      group by reason
      order by count desc, reason asc
    `,
    [embeddingModel]
  );

  const recentRuns = await client.query(
    `
      select id, job_type, status, started_at, finished_at, github_requests, repos_discovered, metadata
      from ingestion_runs
      where job_type in ('build-semantic-index', 'backfill-semantic-index')
      order by started_at desc
      limit 12
    `
  );

  const totalsRow = totals.rows[0];
  const eligibleRepositories = toNumber(totalsRow.eligible_repositories);
  const embeddedRepositories = toNumber(embeddingCounts.rows[0].embedded_repositories);
  const remainingRepositories = Math.max(eligibleRepositories - embeddedRepositories, 0);

  const payload = {
    generatedAt: new Date().toISOString(),
    model: embeddingModel,
    coverage: {
      repositories: toNumber(totalsRow.repositories),
      starredRepositories: toNumber(totalsRow.starred_repositories),
      eligibleRepositories,
      embeddedRepositories,
      remainingRepositories,
      coveragePercent: percent(embeddedRepositories, eligibleRepositories)
    },
    recentRuns: recentRuns.rows.map((row) => {
      const metadata = row.metadata || {};
      return {
        id: row.id,
        jobType: row.job_type,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationSeconds: durationSeconds(row.started_at, row.finished_at),
        githubRequests: toNumber(row.github_requests),
        reposDiscovered: toNumber(row.repos_discovered),
        candidates: toNumber(metadata.candidates),
        documentsUpdated: toNumber(metadata.documentsUpdated),
        embeddingsUpdated: toNumber(metadata.embeddingsUpdated),
        failed: toNumber(metadata.failed),
        embeddingDropped: toNumber(metadata.embeddingDropped),
        embeddingTokens: toNumber(metadata.embeddingTokens),
        estimatedEmbeddingCostUsd: Number(metadata.estimatedEmbeddingCostUsd || 0),
        strategy: metadata.strategy || null
      };
    }),
    rejections: rejections.rows.map((row) => ({
      reason: row.reason,
      count: toNumber(row.count)
    })),
    plan: {
      source: "SEMANTIC_CRON_BACKFILL_PLAN.md",
      steps: planSteps
    },
    knownIssues
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote semantic dashboard data to ${outputPath}`);
} finally {
  await client.end();
}
```

During execution, update each `planSteps.status` value as work moves forward. Allowed values:

```text
planned
in_progress
done
blocked
error_fixed
```

Use `error_fixed` when a task hit a real implementation/runtime error and the fix has been applied. Add a matching entry to `knownIssues` so the dashboard explains what happened and how it was fixed.

- [x] **Step 2: Add npm script**

Add this script to `package.json`:

```json
"export:semantic-dashboard": "node scripts/export-semantic-dashboard-data.mjs"
```

Expected relevant scripts:

```json
{
  "report:semantic-coverage": "node scripts/report-semantic-coverage.mjs",
  "export:semantic-dashboard": "node scripts/export-semantic-dashboard-data.mjs"
}
```

If `report:semantic-coverage` does not exist yet, add it at the same time.

- [x] **Step 3: Create the dashboard HTML**

Create `semantic-dashboard.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Starboard Semantic Backfill</title>
    <link rel="stylesheet" href="./semantic-dashboard.css" />
  </head>
  <body>
    <main class="dashboard-shell">
      <header class="dashboard-header">
        <p class="eyebrow">Starboard / Semantic Backfill</p>
        <h1>Embedding Coverage</h1>
        <p class="subtitle">Track semantic search coverage, cron progress, run health, and fixes.</p>
      </header>

      <section class="coverage-panel" aria-labelledby="coverage-title">
        <div>
          <h2 id="coverage-title">Coverage</h2>
          <p id="coverage-summary">Loading coverage...</p>
        </div>
        <div class="progress-frame" aria-label="Embedding coverage">
          <div id="coverage-bar" class="progress-bar"></div>
        </div>
        <dl class="metric-grid">
          <div><dt>Embedded</dt><dd id="metric-embedded">-</dd></div>
          <div><dt>Remaining</dt><dd id="metric-remaining">-</dd></div>
          <div><dt>Eligible</dt><dd id="metric-eligible">-</dd></div>
          <div><dt>Model</dt><dd id="metric-model">-</dd></div>
        </dl>
      </section>

      <section class="dashboard-grid">
        <article>
          <h2>Plan Progress</h2>
          <ol id="plan-list" class="status-list"></ol>
        </article>

        <article>
          <h2>Recent Runs</h2>
          <div id="run-list" class="run-list"></div>
        </article>
      </section>

      <section class="dashboard-grid">
        <article>
          <h2>Errors And Fixes</h2>
          <div id="issue-list" class="issue-list"></div>
        </article>

        <article>
          <h2>Rejections</h2>
          <div id="rejection-list" class="rejection-list"></div>
        </article>
      </section>

      <footer>
        <span id="generated-at">Generated at -</span>
      </footer>
    </main>
    <script src="./semantic-dashboard.js" type="module"></script>
  </body>
</html>
```

- [x] **Step 4: Create the dashboard JavaScript**

Create `semantic-dashboard.js`:

```js
const formatter = new Intl.NumberFormat("en-US");
const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4
});

function text(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = value;
}

function statusLabel(status) {
  return status.replaceAll("_", " ");
}

function renderCoverage(data) {
  const coverage = data.coverage;
  text("#coverage-summary", `${coverage.coveragePercent}% of eligible repositories are embedded.`);
  text("#metric-embedded", formatter.format(coverage.embeddedRepositories));
  text("#metric-remaining", formatter.format(coverage.remainingRepositories));
  text("#metric-eligible", formatter.format(coverage.eligibleRepositories));
  text("#metric-model", data.model);

  const bar = document.querySelector("#coverage-bar");
  if (bar) bar.style.width = `${Math.min(coverage.coveragePercent, 100)}%`;
}

function renderPlan(data) {
  const list = document.querySelector("#plan-list");
  list.replaceChildren(
    ...data.plan.steps.map((step) => {
      const item = document.createElement("li");
      item.innerHTML = `<span>${step.label}</span><strong>${statusLabel(step.status)}</strong>`;
      item.dataset.status = step.status;
      return item;
    })
  );
}

function renderRuns(data) {
  const list = document.querySelector("#run-list");
  list.replaceChildren(
    ...data.recentRuns.map((run) => {
      const item = document.createElement("div");
      item.className = "run-card";
      item.innerHTML = `
        <div><strong>${run.jobType}</strong><span>${statusLabel(run.status)}</span></div>
        <dl>
          <div><dt>Embeddings</dt><dd>${formatter.format(run.embeddingsUpdated)}</dd></div>
          <div><dt>Failed</dt><dd>${formatter.format(run.failed + run.embeddingDropped)}</dd></div>
          <div><dt>Tokens</dt><dd>${formatter.format(run.embeddingTokens)}</dd></div>
          <div><dt>Cost</dt><dd>${moneyFormatter.format(run.estimatedEmbeddingCostUsd)}</dd></div>
        </dl>
      `;
      return item;
    })
  );
}

function renderIssues(data) {
  const list = document.querySelector("#issue-list");
  list.replaceChildren(
    ...data.knownIssues.map((issue) => {
      const item = document.createElement("div");
      item.className = "issue-card";
      item.innerHTML = `
        <div><strong>${issue.title}</strong><span>${statusLabel(issue.status)}</span></div>
        <p>${issue.symptom}</p>
        <p><b>Fix:</b> ${issue.fix}</p>
      `;
      return item;
    })
  );
}

function renderRejections(data) {
  const list = document.querySelector("#rejection-list");
  list.replaceChildren(
    ...data.rejections.map((rejection) => {
      const item = document.createElement("div");
      item.className = "rejection-row";
      item.innerHTML = `<span>${rejection.reason}</span><strong>${formatter.format(rejection.count)}</strong>`;
      return item;
    })
  );
}

async function init() {
  const response = await fetch("./data/semantic-dashboard.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Dashboard data failed to load: ${response.status}`);
  const data = await response.json();
  renderCoverage(data);
  renderPlan(data);
  renderRuns(data);
  renderIssues(data);
  renderRejections(data);
  text("#generated-at", `Generated at ${new Date(data.generatedAt).toLocaleString()}`);
}

init().catch((error) => {
  text("#coverage-summary", error.message);
});
```

- [x] **Step 5: Create dashboard CSS**

Create `semantic-dashboard.css`:

```css
:root {
  color-scheme: dark;
  --bg: #000;
  --fg: #f7f7f7;
  --muted: #a6a6a6;
  --line: #2a2a2a;
  --panel: #080808;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.dashboard-shell {
  width: min(1180px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 48px 0;
}

.dashboard-header {
  border-bottom: 1px solid var(--line);
  padding-bottom: 28px;
}

.eyebrow,
.subtitle,
footer {
  color: var(--muted);
}

h1 {
  margin: 8px 0;
  font-size: 48px;
  line-height: 1;
  letter-spacing: 0;
}

h2 {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 500;
}

.coverage-panel,
article {
  border: 1px solid var(--line);
  background: var(--panel);
}

.coverage-panel {
  margin: 28px 0;
  padding: 24px;
}

.progress-frame {
  height: 16px;
  border: 1px solid var(--fg);
  margin: 20px 0;
}

.progress-bar {
  height: 100%;
  width: 0;
  background: var(--fg);
}

.metric-grid,
.dashboard-grid {
  display: grid;
  gap: 16px;
}

.metric-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.dashboard-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-bottom: 16px;
}

article {
  padding: 20px;
}

dt {
  color: var(--muted);
  font-size: 12px;
}

dd {
  margin: 4px 0 0;
}

.status-list,
.run-list,
.issue-list,
.rejection-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
}

.status-list li,
.run-card,
.issue-card,
.rejection-row {
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.status-list li,
.run-card > div,
.issue-card > div,
.rejection-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.run-card dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

p {
  color: var(--muted);
  line-height: 1.5;
}

footer {
  padding-top: 18px;
}

@media (max-width: 760px) {
  h1 {
    font-size: 34px;
  }

  .metric-grid,
  .dashboard-grid,
  .run-card dl {
    grid-template-columns: 1fr;
  }
}
```

- [x] **Step 6: Copy dashboard files into Pages build**

Modify `scripts/build-pages-dist.mjs` from:

```js
for (const entry of ["index.html", "styles.css", "app.js"]) {
  await cp(path.join(root, entry), path.join(dist, entry));
}
```

to:

```js
for (const entry of [
  "index.html",
  "styles.css",
  "app.js",
  "semantic-dashboard.html",
  "semantic-dashboard.css",
  "semantic-dashboard.js"
]) {
  await cp(path.join(root, entry), path.join(dist, entry));
}
```

- [x] **Step 7: Generate dashboard data locally**

Run:

```bash
npm run export:semantic-dashboard
```

Expected output:

```text
Wrote semantic dashboard data to data/semantic-dashboard.json
```

- [x] **Step 8: Build Pages artifact**

Run:

```bash
npm run build:pages
```

Expected files:

```text
dist/semantic-dashboard.html
dist/semantic-dashboard.css
dist/semantic-dashboard.js
dist/data/semantic-dashboard.json
```

- [x] **Step 9: Syntax checks**

Run:

```bash
node --check scripts/export-semantic-dashboard-data.mjs
node --check semantic-dashboard.js
node --check scripts/build-pages-dist.mjs
```

Expected output: no syntax errors.

- [ ] **Step 10: Commit**

```bash
git add package.json scripts/export-semantic-dashboard-data.mjs semantic-dashboard.html semantic-dashboard.js semantic-dashboard.css scripts/build-pages-dist.mjs data/semantic-dashboard.json
git commit -m "feat: add semantic coverage dashboard"
```

---

## Task 6: Add Dedicated Backfill Workflow

**Files:**
- Create: `.github/workflows/starboard-semantic-backfill.yml`

- [x] **Step 1: Create the workflow**

Create `.github/workflows/starboard-semantic-backfill.yml`:

```yaml
name: Starboard Semantic Backfill

on:
  workflow_dispatch:
    inputs:
      limit:
        description: "Maximum repositories to embed"
        required: false
        default: "500"
      strategy:
        description: "Candidate strategy"
        required: false
        default: "backfill"
  schedule:
    - cron: "43 */6 * * *"

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: semantic-backfill
  cancel-in-progress: false

jobs:
  backfill:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    env:
      STARBOARD_SEMANTIC_LIMIT: ${{ github.event.inputs.limit || '500' }}
      STARBOARD_SEMANTIC_BATCH_SIZE: "50"
      STARBOARD_SEMANTIC_STRATEGY: ${{ github.event.inputs.strategy || 'backfill' }}
      STARBOARD_SEMANTIC_JOB_TYPE: "backfill-semantic-index"
      STARBOARD_SEMANTIC_STALE_AFTER_DAYS: "14"
      STARBOARD_SEMANTIC_REJECT_RETRY_DAYS: "30"
      STARBOARD_README_CHAR_LIMIT: "8000"
      STARBOARD_EMBEDDING_RETRY_CHAR_LIMIT: "6000"
      STARBOARD_EMBEDDING_MODEL: "text-embedding-3-small"
      STARBOARD_EMBEDDING_DIMENSIONS: "1024"
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - run: npm run setup:db
        env:
          DATABASE_URL: ${{ secrets.STARBOARD_DATABASE_URL }}
      - run: npm run backfill:semantic-index
        env:
          GITHUB_TOKEN: ${{ secrets.STARBOARD_GITHUB_TOKEN }}
          DATABASE_URL: ${{ secrets.STARBOARD_DATABASE_URL }}
          OPENAI_API_KEY: ${{ secrets.STARBOARD_OPENAI_API_KEY }}
      - run: node scripts/report-semantic-coverage.mjs
        env:
          DATABASE_URL: ${{ secrets.STARBOARD_DATABASE_URL }}
      - run: npm run export:static-data
        env:
          DATABASE_URL: ${{ secrets.STARBOARD_DATABASE_URL }}
      - run: npm run export:semantic-dashboard
        env:
          DATABASE_URL: ${{ secrets.STARBOARD_DATABASE_URL }}
      - run: npm run build:pages
      - uses: actions/configure-pages@v5
        with:
          enablement: true
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [x] **Step 2: Validate workflow YAML shape**

Run:

```bash
git diff --check
```

Expected output: no whitespace errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/starboard-semantic-backfill.yml
git commit -m "ci: add semantic backfill workflow"
```

---

## Task 7: Decouple Heavy Embedding From Deploys

**Files:**
- Modify: `.github/workflows/starboard-index.yml`

- [x] **Step 1: Keep a smaller deploy-time semantic refresh**

In `.github/workflows/starboard-index.yml`, change:

```yaml
STARBOARD_SEMANTIC_LIMIT: "500"
```

to:

```yaml
STARBOARD_SEMANTIC_LIMIT: "100"
```

Keep this step in the deploy workflow at first. It gives the deployed site a small freshness pass while the dedicated backfill job handles coverage.

- [x] **Step 2: Add explicit deploy strategy env**

Add:

```yaml
STARBOARD_SEMANTIC_STRATEGY: "balanced"
STARBOARD_SEMANTIC_JOB_TYPE: "build-semantic-index"
```

to the deploy workflow env block.

- [x] **Step 3: Verify workflow syntax by running a dry local build path**

Run:

```bash
npm run build:pages
```

Expected output: build completes and writes `dist`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/starboard-index.yml
git commit -m "ci: reduce deploy-time semantic indexing"
```

---

## Task 8: Manual Backfill And Dashboard Test

**Files:**
- No file changes expected.

- [ ] **Step 1: Push the workflow changes**

Run:

```bash
git push origin main
```

- [ ] **Step 2: Trigger the backfill manually**

Run:

```bash
gh workflow run "Starboard Semantic Backfill" --repo richling98/starboard -f limit=100 -f strategy=backfill
```

- [ ] **Step 3: Watch the run**

Run:

```bash
gh run watch --repo richling98/starboard --exit-status
```

Expected result:

- `npm run setup:db` passes
- `npm run backfill:semantic-index` passes
- `node scripts/report-semantic-coverage.mjs` prints coverage
- `npm run export:semantic-dashboard` writes dashboard JSON
- `npm run export:static-data` refreshes the public leaderboard JSON from Supabase
- `npm run build:pages` includes `semantic-dashboard.html`
- `actions/deploy-pages@v4` publishes the refreshed dashboard
- the workflow exits successfully
- GitHub Pages deployment URL remains `https://richling98.github.io/starboard/`

- [ ] **Step 4: Verify Supabase run metadata**

Run this read-only SQL:

```sql
select
  id,
  job_type,
  status,
  started_at,
  finished_at,
  metadata->>'strategy' as strategy,
  metadata->>'embeddingsUpdated' as embeddings_updated,
  metadata->>'embeddingTokens' as embedding_tokens,
  metadata->>'estimatedEmbeddingCostUsd' as estimated_cost_usd
from ingestion_runs
where job_type = 'backfill-semantic-index'
order by started_at desc
limit 5;
```

Expected result:

- latest row has `status = 'completed'`
- `strategy = 'backfill'`
- `embeddings_updated` is greater than `0` unless everything selected was already fresh or rejected
- cost is present

- [ ] **Step 5: Verify dashboard locally**

Run:

```bash
npm run export:semantic-dashboard
npm run build:pages
```

Then open:

```text
dist/semantic-dashboard.html
```

Expected result:

- coverage bar renders
- embedded/remaining/eligible counts render
- recent runs render
- errors and fixes render
- plan progress renders
- no secret values appear in page source or `data/semantic-dashboard.json`

- [ ] **Step 6: Verify deployed dashboard**

Open:

```text
https://richling98.github.io/starboard/semantic-dashboard.html
```

Expected result:

- the dashboard renders without console errors
- the generated timestamp reflects the latest successful backfill or deploy workflow
- the coverage numbers match `node scripts/report-semantic-coverage.mjs`

---

## Task 9: Production Rollout

**Files:**
- No file changes expected unless manual test reveals tuning needs.

- [ ] **Step 1: Let the backfill run for 24 hours**

Expected cadence:

```text
4 scheduled runs/day * 500 candidates/run = up to 2,000 candidates/day
```

- [ ] **Step 2: Review coverage after 24 hours**

Run:

```bash
node scripts/report-semantic-coverage.mjs
```

Expected review points:

- embedded repo count increases
- failed embeddings stay near zero
- quality rejections are understandable
- run cost remains low
- semantic search quality improves for natural-language queries

- [ ] **Step 3: Decide whether to raise volume**

If runtime and quality are healthy, change the workflow default:

```yaml
default: "1000"
STARBOARD_SEMANTIC_LIMIT: ${{ github.event.inputs.limit || '1000' }}
```

If quality is noisy, keep volume at 500 and improve quality filters before raising throughput.

- [ ] **Step 4: Commit only if tuning changes are made**

```bash
git add .github/workflows/starboard-semantic-backfill.yml
git commit -m "ci: tune semantic backfill volume"
```

---

## Monitoring Checklist

Check these after each of the first few scheduled runs:

- [ ] `ingestion_runs.status` is `completed`
- [ ] `metadata.failed` is `0` or very low
- [ ] `metadata.embeddingDropped` is `0` or very low
- [ ] `metadata.estimatedEmbeddingCostUsd` is within expected range
- [ ] `repository_embeddings` count increases over time
- [ ] `repository_semantic_rejections` reasons are mostly expected spam/empty-document cases
- [ ] GitHub Actions runtime stays under 30 minutes
- [ ] Live site search still works if the backfill workflow fails

## Search Quality Test Set

Use these queries on `https://richling98.github.io/starboard/` after coverage increases:

```text
terminal developer tools
video downloader
agentic coding projects
open source vercel alternatives
self hosted analytics
tools for managing node versions
projects for building desktop apps with web technology
postgres dashboard
open source authentication
```

Expected behavior:

- natural-language queries return conceptually relevant repos
- exact repo/owner searches still work through keyword fallback
- results differ across Today, Week, Month, and All Time
- Repos and Accounts views both continue to work
- unembedded repos are not invisible

## Rollback Plan

If the backfill workflow causes problems:

1. Disable the `Starboard Semantic Backfill` workflow in GitHub Actions.
2. Leave the existing deployed site alone; it does not depend on the backfill workflow finishing.
3. Keep keyword fallback active in `app.js`.
4. Revert only the backfill workflow if needed:

```bash
git revert <commit-that-added-starboard-semantic-backfill-yml>
git push origin main
```

The Supabase embeddings already written can remain in place. Bad or noisy embeddings should be corrected through quality filtering and re-embedding, not by dropping the whole table.

## Approval Criteria

This plan is ready to execute when you approve these product decisions:

- Backfill coverage means Starboard's discovered Supabase corpus, not all of GitHub.
- The initial cron volume is 500 candidates every 6 hours.
- The main deploy workflow should keep only a small 100-candidate semantic refresh.
- Keyword fallback remains permanent.
- We accept cost-based monitoring through `ingestion_runs.metadata` rather than adding a separate billing dashboard right now.
