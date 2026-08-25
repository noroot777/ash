// 自动命名跑在**真事件流**上的两条要害（纯解析那半在 test-auto-title.ts）。
//
// 都是 2026-08-21 第 1 轮审查复现出来的，两条都由「把扫描窗口从一行放宽到前几行」
// 引出——窗口一变宽，这段时间里能发生的事就多了：
//
//   ① 窗口期间任务被显式改名（用户在界面改，或 agent 自己调 patch_task），随后吐出来的
//      `标题：xxx` 不许把它盖回去。「显式改名 = 这就是标题」是这次需求里明说要保住的语义，
//      而 titleDone 只是回合开头读的快照，答不了「此刻还允不允许自动命名」——只有库能答。
//   ② 窗口期间正文被扣在缓冲里，这时候来的 tool/error/usage 事件**不许插到它前面**。
//      顺序错乱同时污染 live 和刷新后的 trace，而且 error 还会先一步写进 .md。
//
//   ③ 是 ② 的边界：缓冲是空的（一个字正文都没扣着）时，事件本来就该排在前面，直接放行、
//      窗口继续开着——库里 XQWuZZwlG_KA 就是「开场先读文件、之后才写标题」，靠这条救回来。
//
// 跑法：npm -w server run test:auto-title（这一支跟纯解析那支串在同一条命令里）
import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentEvent, ServerEvent } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-auto-title-run-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// ASH_RUNS_DIR 指到临时目录顺带打开 guardAgentSpawn：万一哪条结算钩子失手触发续跑，
// 也不会真拉起 CLI 烧额度。
assert.ok(
  process.env.ASH_ALLOW_REAL_AGENT !== "1",
  "结算钩子一旦失手触发续跑，拦截器失效就会拿用户的真额度跑 agent",
);
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});
requireTmpDb("auto-title-run");

const { db, ensureSchema } = await import("../src/db/index.js");
const { tasks, sessions } = await import("../src/db/schema.js");
const { bus } = await import("../src/bus.js");
const { RUNS_DIR } = await import("../src/paths.js");
const { parseSessionTrace } = await import("../src/transcript.js");
const { consumeSingleRun } = await import("../src/single-run.js");
await ensureSchema();

const AT = "2026-08-21T00:00:00.000Z";

/** 事件之间可以插一个动作（模拟窗口期间发生的外部改名）。 */
type Step = AgentEvent | (() => Promise<void>);

/** 跑一轮：事件流喂进 consumeSingleRun，收走 live 事件、trace、.md。 */
async function runFlow(taskId: string, steps: Step[]) {
  const sessId = `sess-${taskId}`;
  await db.insert(tasks).values({
    id: taskId,
    projectId: "proj",
    title: "建任务时的临时名",
    body: "body",
    status: "running",
    autoTitle: true,
    createdAt: AT,
    updatedAt: AT,
  });
  await db.insert(sessions).values({
    id: sessId,
    taskId,
    role: "single",
    agentType: "claude",
    executor: "claude",
    startedAt: AT,
  });
  mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
  const out = createWriteStream(join(RUNS_DIR, taskId, `${sessId}.md`));
  // consumeSingleRun 收尾时 out.end()，但落盘是异步的：不等它关就读，文件可能还没建出来。
  const closed = new Promise<void>((resolve) => out.on("close", resolve));

  const live: ServerEvent[] = [];
  let cleanupCalls = 0;
  const unsubscribe = bus.subscribe((event) => live.push(event));
  try {
    await consumeSingleRun({
      taskId,
      sessId,
      agentType: "claude",
      ex: { model: null, reasoningEffort: null, resumeFields: () => ({}) } as never,
      cwd: root,
      handle: {
        sessionId: sessId,
        commandLine: "fake",
        kill() {},
        async cleanup() { cleanupCalls += 1; },
        events: (async function* () {
          for (const step of steps) {
            if (typeof step === "function") await step();
            else yield step;
          }
        })(),
      },
      out,
      turnStart: AT,
      cliSessionId: sessId,
      autoTitle: true,
    });
  } finally {
    unsubscribe();
  }
  await closed;
  assert.equal(cleanupCalls, 1, "一次性回合收流后必须恰好清扫一次逃逸后代");

  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const traceRaw = readFileSync(join(RUNS_DIR, taskId, `${sessId}.trace.jsonl`), "utf8");
  const trace = parseSessionTrace(traceRaw);
  return {
    title: row.title,
    autoTitle: row.autoTitle,
    titleEvents: live.filter((e) => e.type === "task.title"),
    // 顺序断言只关心 text/tool 这两种，usage/done 一类噪音滤掉。
    liveShape: live.flatMap((e) =>
      e.type === "agent.event" && (e.event.kind === "text" || e.event.kind === "tool")
        ? [e.event.kind === "text" ? `text:${e.event.text}` : `tool:${e.event.name}`]
        : [],
    ),
    traceShape: trace.flatMap(({ event: e }) =>
      e.kind === "text" ? [`text:${e.text}`] : e.kind === "tool" ? [`tool:${e.name}`] : [],
    ),
    md: readFileSync(join(RUNS_DIR, taskId, `${sessId}.md`), "utf8"),
  };
}

const TOOL: AgentEvent = { kind: "tool", name: "view_image", input: "" } as never;
const DONE: AgentEvent = { kind: "done", exitStatus: 1 } as never; // 非 0 → failed，不触发派审

try {
  // ── ① 窗口期间被显式改名 → 自动标题必须让路 ──────────────────────────────
  const renamed = await runFlow("at-run-rename", [
    { kind: "text", text: "I'll look at the image first.\n" },
    async () => {
      // 等价于 PATCH /tasks/:id {title}（那条路由已经会一并关掉 autoTitle）。
      await db
        .update(tasks)
        .set({ title: "手动改的标题", autoTitle: false, updatedAt: AT })
        .where(eq(tasks.id, "at-run-rename"));
    },
    { kind: "text", text: "標題：自动起的标题\n\n正文开始。\n" },
    DONE,
  ]);
  assert.equal(renamed.title, "手动改的标题", "运行中的显式改名被自动标题盖回去了");
  assert.equal(renamed.autoTitle, false);
  assert.equal(renamed.titleEvents.length, 0, "没改成还发 task.title，前端会闪一下错的标题");
  // 改名归改名，标题行仍然是写给系统的元数据，不该留在正文里。
  assert.ok(!renamed.md.includes("標題："), "标题行漏进了正文");
  assert.ok(renamed.md.includes("正文开始。"), "正文被吞了");

  // ── ② 窗口扣着正文时，非 text 事件不许插队 ───────────────────────────────
  const ordered = await runFlow("at-run-order", [
    { kind: "text", text: "I will inspect first.\n" },
    TOOL,
    { kind: "text", text: "標題：工具后标题\n\n正文开始。\n" },
    DONE,
  ]);
  assert.deepEqual(
    ordered.liveShape,
    ["text:I will inspect first.\n", "tool:view_image", "text:標題：工具后标题\n\n正文开始。\n"],
    "live 事件顺序和真实输出对不上",
  );
  assert.deepEqual(ordered.traceShape, ordered.liveShape, "刷新后的 trace 顺序和 live 不一致");
  // 这是 ② 的代价，明写在这儿：窗口在 tool 那一刻就收了，之后的标题不再认。
  assert.equal(ordered.title, "建任务时的临时名");
  assert.equal(ordered.autoTitle, true, "没改成就该留着 autoTitle，下轮 fresh run 还有机会");

  // ── ③ 缓冲是空的 → 事件直接放行，窗口继续开着 ───────────────────────────
  const toolFirst = await runFlow("at-run-tool-first", [
    TOOL,
    { kind: "text", text: "標題：读完文件才写的标题\n\n正文开始。\n" },
    DONE,
  ]);
  assert.equal(toolFirst.title, "读完文件才写的标题", "开场 tool 不该把标题窗口关掉");
  assert.equal(toolFirst.autoTitle, false);
  assert.deepEqual(
    toolFirst.liveShape,
    ["tool:view_image", "text:正文开始。\n"],
    "开场 tool 的顺序或正文被动过",
  );

  console.log("auto title run: 显式改名不被盖 / 非 text 不插队 / 空缓冲直放，三条通过");
} finally {
  await releaseTmpDb();
}
