import { ensureSchema } from "../src/db/index.js";
import { migrateQueues } from "../src/db/migrateQueues.js";
await ensureSchema();
await migrateQueues();
process.exit(0);
