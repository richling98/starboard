import {
  DEFAULT_SEED_PAGES,
  loadLocalEnv,
  refreshAllTimeAccounts
} from "../backend-cache.mjs";

loadLocalEnv();

const args = new Set(process.argv.slice(2));
const seedPagesArg = process.argv.find((arg) => arg.startsWith("--seed-pages="));
const seedPages = Number(process.env.STARBOARD_SEED_PAGES || seedPagesArg?.split("=")[1] || DEFAULT_SEED_PAGES);
const force = args.has("--force");

console.log(`Refreshing all-time account cache with ${seedPages} seed page${seedPages === 1 ? "" : "s"}...`);
if (force) console.log("Force refresh enabled.");

try {
  const summary = await refreshAllTimeAccounts({ seedPages, force });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
