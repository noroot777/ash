import { defineConfig } from "drizzle-kit";
// 跟服务同一套认库：navi.db 优先，还没改名的老目录认 ash.db，认不准就不开（scripts/db-file.mjs）。
import { dbFileIn, unclearDbReason } from "../scripts/db-file.mjs";

function defaultDb(dataDir: string): string {
  const why = unclearDbReason(dataDir);
  if (why) throw new Error(why);
  return dbFileIn(dataDir);
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.NAVI_DB ?? process.env.ASH_DB ?? process.env.HARNESS_DB ?? defaultDb("./data"),
  },
});
