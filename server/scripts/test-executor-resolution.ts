// 执行器解析优先级回归测试:
//   executorId 命中 → 用该 profile
//   executorId 悬空 → 按 type 默认执行器降级
//   executorId 缺省 → 按 type 默认执行器
//
// 跑法:
//   HARNESS_DB=/tmp/test-executor-resolution-$RANDOM.db npx tsx server/scripts/test-executor-resolution.ts
import { eq } from "drizzle-orm";

if (!process.env.HARNESS_DB) {
  console.error("先设 HARNESS_DB=/tmp/test-executor-resolution-<rand>.db 再跑");
  process.exit(1);
}
if (!process.env.HARNESS_DB.startsWith("/tmp/")) {
  console.error("HARNESS_DB 必须在 /tmp/ 下(防止误改真实数据)");
  process.exit(1);
}

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents } = await import("../src/db/schema.js");
const { resolveExecutorFor } = await import("../src/executors/index.js");

await ensureSchema();
await db.delete(agents);

const localTarget = JSON.stringify({ kind: "local" });
await db.insert(agents).values([
  {
    id: "codex-default",
    name: "codex@default",
    type: "codex",
    target: localTarget,
    model: "gpt-default",
    extraArgs: "[]",
    reasoningEffort: null,
    speed: null,
    providerId: null,
    isDefault: true,
  },
  {
    id: "codex-custom",
    name: "codex@custom",
    type: "codex",
    target: localTarget,
    model: "gpt-custom",
    extraArgs: "[]",
    reasoningEffort: null,
    speed: null,
    providerId: null,
    isDefault: false,
  },
]);

const specified = await resolveExecutorFor({ executorId: "codex-custom", type: "codex" });
if (specified.label !== "codex@custom" || specified.type !== "codex") {
  throw new Error(`executorId 命中应使用 codex@custom, got ${specified.label}/${specified.type}`);
}

await db.delete(agents).where(eq(agents.id, "codex-custom"));

const stale = await resolveExecutorFor({ executorId: "codex-custom", type: "codex" });
if (stale.label !== "codex@default" || stale.type !== "codex") {
  throw new Error(`executorId 悬空应降级 codex@default, got ${stale.label}/${stale.type}`);
}

const omitted = await resolveExecutorFor({ type: "codex" });
if (omitted.label !== "codex@default" || omitted.type !== "codex") {
  throw new Error(`executorId 缺省应使用 codex@default, got ${omitted.label}/${omitted.type}`);
}

console.log("executor resolution tests passed");
