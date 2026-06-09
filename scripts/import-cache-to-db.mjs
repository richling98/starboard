import { readFile } from "node:fs/promises";
import { ALL_TIME_ACCOUNTS_PATH, loadLocalEnv } from "../backend-cache.mjs";
import { closePool, upsertAccountSummary } from "../db.mjs";

loadLocalEnv();

try {
  const cache = JSON.parse(await readFile(ALL_TIME_ACCOUNTS_PATH, "utf8"));
  const accounts = Object.values(cache.accounts || {});
  let imported = 0;

  for (const account of accounts) {
    if (!account.id || !account.login) continue;
    await upsertAccountSummary(account);
    imported += 1;
  }

  console.log(JSON.stringify({ imported }, null, 2));
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await closePool();
}
