import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, readLeaderboardSnapshot } from "../db.mjs";
import { loadLocalEnv } from "../backend-cache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "data", "leaderboards");
const periods = ["today", "week", "month", "all"];
const views = ["repositories", "accounts"];

loadLocalEnv();
await mkdir(outDir, { recursive: true });

try {
  for (const view of views) {
    for (const period of periods) {
      const snapshot = await readLeaderboardSnapshot({
        view,
        period,
        limit: 1000,
        offset: 0,
        sortKey: "stars",
        sortDirection: "desc"
      });

      if (!snapshot) {
        console.warn(`No snapshot found for ${view}/${period}.`);
        continue;
      }

      const filePath = path.join(outDir, `${view}-${period}.json`);
      await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`Exported ${view}/${period}: ${snapshot.rows.length} rows`);
    }
  }
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await closePool();
}
