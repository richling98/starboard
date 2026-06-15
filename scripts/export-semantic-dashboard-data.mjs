import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../backend-cache.mjs";
import { closePool, readSemanticCoverageSummary } from "../db.mjs";
import { embeddingModel } from "../embeddings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outputPath = process.env.STARBOARD_SEMANTIC_DASHBOARD_PATH || "data/semantic-dashboard.json";
const planPath = path.join(root, "SEMANTIC_CRON_BACKFILL_PLAN.md");

loadLocalEnv();

try {
  const summary = await readSemanticCoverageSummary({
    embeddingModel: embeddingModel(),
    staleAfterDays: Math.max(Number(process.env.STARBOARD_SEMANTIC_STALE_AFTER_DAYS || 14), 1),
    recentRunLimit: 12
  });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "scripts/export-semantic-dashboard-data.mjs",
    coverage: summary.coverage,
    embeddingModel: summary.embeddingModel,
    staleAfterDays: summary.staleAfterDays,
    recentRuns: summary.recentRuns,
    rejectionsByReason: summary.rejectionsByReason,
    knownIssues: knownIssuesFromRuns(summary.recentRuns),
    plan: {
      source: "SEMANTIC_CRON_BACKFILL_PLAN.md",
      checklist: await readPlanChecklist()
    }
  };

  const absoluteOutputPath = path.isAbsolute(outputPath) ? outputPath : path.join(root, outputPath);
  await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
  await writeFile(absoluteOutputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote semantic dashboard data to ${outputPath}`);
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await closePool();
}

async function readPlanChecklist() {
  try {
    const raw = await readFile(planPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^- \[([ xX])\]\s+(.*)$/);
        if (!match) return null;
        return {
          label: stripMarkdown(match[2]),
          status: match[1].toLowerCase() === "x" ? "complete" : "planned"
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function knownIssuesFromRuns(runs) {
  return runs
    .filter((run) => run.status === "failed" || run.status === "completed_with_errors" || run.errorMessage)
    .slice(0, 5)
    .map((run) => ({
      startedAt: run.startedAt,
      jobType: run.jobType,
      status: run.status,
      issue: run.errorMessage || `${run.metadata?.failed || 0} repository failures reported`,
      mitigation: "Check the GitHub Actions log and rerun the bounded backfill after the upstream error is fixed."
    }));
}

function stripMarkdown(value) {
  return String(value || "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}
