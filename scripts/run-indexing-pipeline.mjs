import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const node = process.execPath;
const passthroughArgs = process.argv.slice(2);
const discoverArgs = passthroughArgs.filter((arg) => arg.startsWith("--max-") || arg.startsWith("--period="));

const steps = [
  ["setup-db", ["scripts/setup-db.mjs"]],
  ["discover-repositories", ["scripts/discover-repositories.mjs", ...discoverArgs]],
  ["refine-repository-language", ["scripts/refine-repository-language.mjs"]],
  ["refresh-all-time-accounts", ["scripts/refresh-all-time-accounts.mjs"]],
  ["build-leaderboard-snapshots", ["scripts/build-leaderboard-snapshots.mjs"]]
];

for (const [label, args] of steps) {
  console.log(`\n== ${label} ==`);
  await run(node, args);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: process.env
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${args[0]} exited with code ${code}`));
      }
    });
  });
}
