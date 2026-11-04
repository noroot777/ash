// report_stage 的 `recurs` 在 MCP 边界的形状校验（mcp/src/schemas.ts 的 `RECURS`）。
//
// 回放 2026-11-04 v9Ps5S1vbnKt 的三份真实 payload（审查者照清单旁那句「填它行首编号」交的裸编号数组，
// 原始调用参数取自那个任务的 codex-events.jsonl）：
// - 走 MCP 必须被拒，错误里带正确形状示例，且一个请求都没打到 ash；
// - 服务端 `parseCarries` 仍是第二道、语义不变：同样的 payload 直接打 HTTP，结论照收、承接按没填；
// - 正确形状 `{"1":"1.1.1"}` 走同一条路（MCP → HTTP 路由 → 结论入口）落成 carries 并计入谱系。
//
// 走的是真实 McpServer + Client（内存传输）和真实的 `/tasks/:id/stage` 路由，不是直接调 schema ——
// 「校验失败审查者看到什么」取决于 SDK 怎么包这个错误，那一层也要在测试里。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ASH_TURN_IDENTITY_ENV_KEYS, isTurnIdentityPathEntry } from "@ash/shared/mcp";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-recurs-boundary-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_LAX_DONE;
// 这个测试自己就可能跑在一条 ash 任务里：把那条任务的回合身份清干净，否则 MCP 层会带着它去打夹具服务。
for (const key of ASH_TURN_IDENTITY_ENV_KEYS) delete process.env[key];
process.env.PATH = (process.env.PATH ?? "").split(delimiter).filter((entry) => !isTurnIdentityPathEntry(entry)).join(delimiter);

/** v9Ps5S1vbnKt 三轮审查者交的原样参数。 */
const REAL_PAYLOADS: unknown[] = [["1.1.1", "1.1.6"], ["2.1.1", "2.2.1"], ["3.1.3"]];

let server: ReturnType<typeof serve> | undefined;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, projects, reviewerProfiles, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { freeReviewPrompt } = await import("../src/free-review-prompts.js");
  const { freeReviewEvidenceDir, freeReviewReportPath } = await import("../src/free-review-files.js");
  const { evidenceState } = await import("../src/regression-evidence-lifecycle.js");
  const { claimOwnTurn } = await import("../src/runs.js");
  const { mountTaskStageRoutes } = await import("../src/task-stage.js");
  const { parseCarries, recurrenceKey, taskRecurrences } = await import("../src/review-recurrence.js");
  const { RECURS_SHAPE_ERROR } = await import("@ash/shared/free-workflow");
  await ensureSchema();

  // 夹具 ash：只挂结论入口，记下每一个打进来的请求。
  const hits: string[] = [];
  const api = new Hono();
  api.use("*", async (c, next) => { hits.push(`${c.req.method} ${c.req.path}`); await next(); });
  mountTaskStageRoutes(api);
  const app = new Hono().route("/api", api);
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve(info.port));
  });
  process.env.ASH_URL = `http://127.0.0.1:${port}`;

  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerTaskTurnTools } = await import("../../mcp/src/tools/task-turn.js");
  const mcp = new McpServer({ name: "ash", version: "test" });
  registerTaskTurnTools(mcp);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "reviewer", version: "test" });
  await client.connect(clientSide);

  // 一条任务两轮审查：第 1 轮拦验收（三条发现），第 2 轮派审时清单带编号 1.1.1–1.1.3。
  const at = new Date().toISOString();
  const id = "recurs";
  await db.insert(projects).values({ id: "p", name: "recurs", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "test", type: "codex", model: "test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "reviewer", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });
  await createTasks([{
    id, projectId: "p", title: id, body: "test", mode: "single", status: "done",
    agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
    useWorktree: false, createdAt: at, updatedAt: at,
  }]);
  const report = (lines: string[]) => "## 结论\n\n**能不能验收**：不能。\n\n**必须修的问题**：\n\n" +
    lines.map((line, index) => `### ${index + 1}\n- 你会遇到：${line}\n- 为什么：机制。\n- 建议怎么修：修法。\n`).join("\n");
  const writeReport = (round: number, lines: string[]) => {
    const path = freeReviewReportPath(id, "run-a", round);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report(lines));
  };
  await db.insert(freeReviewRuns).values({
    id: "run-a", taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
    executorId: "ex", checkMode: "logic", retryLimit: 3, currentRound: 2, status: "reviewing",
    targetKind: "workspace", createdAt: at, updatedAt: at,
  });
  writeReport(1, ["后来的操作抢走原作者成品", "导出按钮无反应", "筛选丢失"]);
  await db.insert(freeReviewRounds).values([
    { id: "run-a-1", runId: "run-a", round: 1, status: "failed", conclusion: "verify_failed", startedAt: at },
    { id: "run-a-2", runId: "run-a", round: 2, status: "reviewing", startedAt: at },
  ]);
  await db.insert(sessions).values({
    id: "run-a-2-reviewer", taskId: id, role: "reviewer", agentType: "codex", executor: "test", cwd: root,
    startedAt: at, turnStartedAt: at,
  });
  const row = async () => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  await evidenceState(id, freeReviewEvidenceDir(id, "run-a", 2), await row());
  await freeReviewPrompt(await row(),
    (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "run-a")))[0]!, 2, root);
  const round2 = async () => (await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, "run-a-2")))[0]!;
  assert.deepEqual((await round2()).historyRefs, ["1.1.1", "1.1.2", "1.1.3"], "第 2 轮实际发出去的清单编号落库");
  writeReport(2, ["后来的操作仍会抢走原作者成品", "另一个页面也一样", "第三处"]);
  assert.ok(claimOwnTurn(id, "reviewer"), "审查回合占得到 turn");

  const report_stage = async (recurs: unknown) => {
    const result = await client.callTool({
      name: "report_stage",
      arguments: { taskId: id, stage: "verify_failed", directionToken: "d", ...(recurs === undefined ? {} : { recurs }) },
    });
    const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("");
    return { isError: result.isError === true, text };
  };
  // 错误文本是 SDK 包出来的 zod issue JSON，示例里的引号在那里是转义过的。
  const example = JSON.stringify(RECURS_SHAPE_ERROR).slice(1, -1);

  // ① 三份真实裸数组，以及它们被序列化成字符串、或干脆不是 JSON 的样子：MCP 边界当场拒，一个请求都不放过去。
  for (const payload of [...REAL_PAYLOADS, JSON.stringify(REAL_PAYLOADS[2]), "3.1.3",
    { "第1条": "1.1.1" }, { "0": "1.1.1" }, { "1": 111 }, [{ finding: "1", from: "1.1.1" }], [{ finding: 1 }]]) {
    const { isError, text } = await report_stage(payload);
    assert.ok(isError, `形状不对必须被拒：${JSON.stringify(payload)}`);
    assert.ok(text.includes(example), `错误里要带正确形状示例：${text}`);
    assert.ok(text.includes("report_stage"), `错误要指明是哪个工具：${text}`);
  }
  assert.deepEqual(hits, [], "被拒的调用一个都没打到 ash");
  assert.equal((await round2()).conclusion, null, "结论没被半截写进去");

  // ② 服务端是第二道，语义不变：同样的裸数组直接打 HTTP，结论照收、承接按没填。
  for (const payload of REAL_PAYLOADS) {
    assert.deepEqual(parseCarries(payload, 3, new Set(["1.1.1", "1.1.2", "1.1.3", "2.1.1", "2.2.1", "3.1.3"])), [],
      `parseCarries 读不懂的仍按没填：${JSON.stringify(payload)}`);
    const res = await fetch(`${process.env.ASH_URL}/api/tasks/${id}/stage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "verify_failed", recurs: payload }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await round2()).conclusion, "verify_failed");
    assert.equal((await round2()).carries, null, `绕过 MCP 的裸数组：承接按没填 ${JSON.stringify(payload)}`);
  }
  assert.equal((await taskRecurrences(id)).size, 0, "没有承接就没有谱系");

  // ③ 不填（省略 / null / 空串）照旧合法，走得通。
  for (const recurs of [undefined, null, ""]) {
    const { isError, text } = await report_stage(recurs);
    assert.ok(!isError, `不填不该被拒：${JSON.stringify(recurs)} → ${text}`);
  }
  assert.equal((await round2()).carries, null);

  // ④ 正确形状走同一条路：MCP → HTTP 路由 → 结论入口 → carries 落库 → 谱系计入（连续 2 轮）。
  const before = hits.length;
  for (const recurs of ['{"1":"1.1.1"}', [{ finding: 1, from: "[1.1.1]" }], { "1": "1.1.1" }]) {
    const { isError, text } = await report_stage(recurs);
    assert.ok(!isError, `正确形状要放行：${JSON.stringify(recurs)} → ${text}`);
    assert.deepEqual((await round2()).carries, [{ finding: 1, from: "1.1.1" }], `落成 carries：${JSON.stringify(recurs)}`);
  }
  assert.equal(hits.length - before, 3, "三次正确调用都打到了结论入口");
  assert.deepEqual((await taskRecurrences(id)).get(recurrenceKey("run-a", 2)),
    { length: 2, findings: [{ finding: 1, length: 2 }] }, "承接计入谱系：同一谱系连续 2 轮");

  await client.close();
  console.log("✓ recurs 边界：裸编号数组在 MCP 当场被拒并带示例；服务端第二道仍按没填；正确形状落成承接并计入谱系");
} finally {
  server?.close();
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
