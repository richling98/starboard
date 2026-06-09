import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of ["index.html", "styles.css", "app.js"]) {
  await cp(path.join(root, entry), path.join(dist, entry));
}

await cp(path.join(root, "fonts"), path.join(dist, "fonts"), { recursive: true });
await cp(path.join(root, "data"), path.join(dist, "data"), { recursive: true });

console.log(`Built GitHub Pages artifact at ${dist}`);
