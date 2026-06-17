import { loadLocalEnv } from "../src/backend-cache.mjs";
import { closePool, readSemanticCoverageSummary } from "../src/db.mjs";
import { embeddingModel } from "../src/embeddings.mjs";

loadLocalEnv();

const args = parseArgs(process.argv.slice(2));
const staleAfterDays = Math.max(Number(args["stale-after-days"] || process.env.STARBOARD_SEMANTIC_STALE_AFTER_DAYS || 14), 1);

try {
  const summary = await readSemanticCoverageSummary({
    embeddingModel: embeddingModel(),
    staleAfterDays,
    recentRunLimit: 8
  });
  const coverage = summary.coverage;

  console.log("Semantic coverage");
  console.log(`- Eligible repositories: ${formatNumber(coverage.eligibleRepositories)}`);
  console.log(`- Embedded repositories: ${formatNumber(coverage.embeddedRepositories)}`);
  console.log(`- Missing embeddings: ${formatNumber(coverage.missingEmbeddings)}`);
  console.log(`- Actionable missing embeddings: ${formatNumber(coverage.actionableMissingEmbeddings)}`);
  console.log(`- Blocked missing embeddings: ${formatNumber(coverage.blockedMissingEmbeddings)}`);
  console.log(`- Stale embeddings: ${formatNumber(coverage.staleEmbeddings)}`);
  console.log(`- Rejected repositories: ${formatNumber(coverage.rejectedRepositories)}`);
  console.log(`- Coverage: ${coverage.coveragePercent}%`);

  if (summary.recentRuns.length) {
    console.log("");
    console.log("Recent semantic runs");
    for (const run of summary.recentRuns) {
      const metadata = run.metadata || {};
      const duration = run.durationSeconds == null ? "running" : `${run.durationSeconds}s`;
      const cost = metadata.estimatedEmbeddingCostUsd == null ? "n/a" : `$${metadata.estimatedEmbeddingCostUsd}`;
      console.log(
        `- ${run.startedAt} ${run.jobType} ${run.status} duration=${duration} candidates=${metadata.candidates ?? "n/a"} embeddings=${metadata.embeddingsUpdated ?? "n/a"} failed=${metadata.failed ?? "n/a"} cost=${cost}`
      );
    }
  }
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await closePool();
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en");
}

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value];
    })
  );
}
