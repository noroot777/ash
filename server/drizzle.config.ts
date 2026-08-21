import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.ASH_DB ?? process.env.HARNESS_DB ?? "./data/ash.db",
  },
});
