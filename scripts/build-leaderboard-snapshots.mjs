import {
  buildSnapshotRows,
  closePool,
  finishIngestionRun,
  refreshAccountRollupsFromRepositories,
  startIngestionRun,
  writeLeaderboardSnapshot
} from "../db.mjs";
import { loadLocalEnv } from "../backend-cache.mjs";

loadLocalEnv();

const periods = ["today", "week", "month", "all"];
const views = ["repositories", "accounts"];
let runId;
const summary = {
  snapshots: 0,
  reposDiscovered: 0,
  accountsDiscovered: 0
};

try {
  runId = await startIngestionRun("build-leaderboard-snapshots", { periods, views });
  const rolledUpAccounts = await refreshAccountRollupsFromRepositories();
  console.log(`Refreshed ${rolledUpAccounts} account rollups from indexed repositories.`);

  for (const period of periods) {
    for (const view of views) {
      const rows = await buildSnapshotRows(view, period);
      const result = await writeLeaderboardSnapshot({
        period,
        view,
        rows,
        coverageLabel: coverageLabel(period, view, rows.length),
        metadata: {
          period,
          view,
          generatedBy: "scripts/build-leaderboard-snapshots.mjs"
        }
      });
      summary.snapshots += 1;
      if (view === "repositories") summary.reposDiscovered += rows.length;
      if (view === "accounts") summary.accountsDiscovered += rows.length;
      console.log(`${result.view}/${result.period}: ${result.total} rows`);
    }
  }

  await finishIngestionRun(runId, {
    status: "completed",
    reposDiscovered: summary.reposDiscovered,
    accountsDiscovered: summary.accountsDiscovered,
    metadata: { snapshots: summary.snapshots }
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (runId) {
    await finishIngestionRun(runId, {
      status: "failed",
      errorMessage: error.message || String(error),
      metadata: summary
    });
  }
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await closePool();
}

function coverageLabel(period, view, count) {
  const subject = view === "accounts" ? "accounts" : "repositories";
  const periodLabel = {
    today: "created in the last 24 hours",
    week: "created in the last 7 days",
    month: "created in the last 30 days",
    all: "in the current Starboard index"
  }[period];
  return `Showing ${count.toLocaleString("en")} indexed ${subject} ${periodLabel}.`;
}
