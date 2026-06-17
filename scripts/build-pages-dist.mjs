import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const publicDir = path.join(root, "public");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of await readdir(publicDir)) {
  await cp(path.join(publicDir, entry), path.join(dist, entry), { recursive: true });
}

await cp(path.join(root, "data"), path.join(dist, "data"), { recursive: true });

console.log(`Built GitHub Pages artifact at ${dist}`);
