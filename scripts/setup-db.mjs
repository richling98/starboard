import { closePool, ensureSchema, seedDefaultDiscoveryQueries } from "../db.mjs";
import { loadLocalEnv } from "../backend-cache.mjs";

loadLocalEnv();

try {
  await ensureSchema();
  const queryCount = await seedDefaultDiscoveryQueries();
  console.log(`Supabase schema is ready. Seeded ${queryCount} discovery queries.`);
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await closePool();
}
