// 「审查/验证旁路回合进行中，预览照常开」回归。
//
// 起因：审查那一轮是跑在被审任务自己身上的旁路回合，任务 status 会翻成 running。而「任务
// 在跑」这一整组门禁原本是照**实现回合**写的（代码改到一半，页面既不是上一版也不是下一
// 版），于是派一次审查就顺手把用户正看着的预览关掉，接下来十几二十分钟也一个字都不许再
// 开——而那恰恰是最该自己点开看一眼的时候（审查者中途提问时更是要照着页面才答得上来）。
//
// 三处必须同时成立，缺一处这个功能就是半个：
//   ① 审查回合开跑时**不回收**已经开着的预览（status.ts）
//   ② 审查回合进行中 POST 起预览放行（free-workflow-preview.ts）
//   ③ 快照把这件运行时事实报给前端（free-workflow-state.ts 的 reviewTurn），
//      预览工作区那道门也认同一条（preview-workspace.ts）
// 并且普通回合的那道门**一点都不能松**：那才是真的在改代码。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-free-preview-review-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, projects, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { mountFreeWorkflowRoutes } = await import("../src/free-workflow-routes.js");
  const { claimTurn, releaseTurn } = await import("../src/runs.js");
  const { setTaskStatus } = await import("../src/status.js");
  const { workspacePreviewLaunch } = await import("../src/preview-workspace.js");
  await ensureSchema();

  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Ash Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");

  // 预览命令：起一个真的监听 PORT 的服务，就绪判据（端口连得上）才有东西可判。
  const script = join(root, "preview-server.mjs");
  writeFileSync(script, [
    'import http from "node:http";',
    'http.createServer((_q, res) => res.end("ok")).listen(Number(process.env.PORT));',
    "",
  ].join("\n"));
  await db.insert(projects).values({
    id: "p", name: "preview review", repoPath: repo, apiKeys: null, workflowId: null,
    previewCommand: `node ${script}`, createdAt: new Date().toISOString(),
  });
  await db.insert(agents).values({
    id: "exec", name: "codex@test", type: "codex", model: "gpt-test", extraArgs: "[]",
    reasoningEffort: "high", speed: null, providerId: null, isDefault: true,
  });

  const taskId = "free-preview-review";
  await createTasks([{
    id: taskId, projectId: "p", groupId: null, parentId: null,
    title: "preview during review", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "exec", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);

  const api = new Hono();
  mountFreeWorkflowRoutes(api);
  const snapshot = () => api.request(`/tasks/${taskId}/free-workflow`)
    .then((response) => response.json()) as Promise<{ reviewTurn: boolean; preview: { running: boolean } }>;
  const runsDir = join(root, "runs", taskId);
  const record = join(runsDir, "preview.json");
  /** 盘上放一条「预览开着」的记录（进程用 pid 0，回收那一路照样按记录走）。 */
  const fakeOpenPreview = () => {
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(record, JSON.stringify({
      taskId, cmd: "node preview", pid: 0, url: "http://localhost:1/", port: 1, life: "task",
      startedAt: new Date().toISOString(), log: join(runsDir, "preview.log"), links: [],
      state: "ready", gen: "open", installPid: null,
    }));
  };
  /** 回到「没人在跑、没有预览」的起点。 */
  const reset = async () => {
    releaseTurn(taskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
    rmSync(record, { force: true });
  };

  // ── ① 审查回合开跑：预览留着 ──
  await reset();
  fakeOpenPreview();
  assert.equal(claimTurn(taskId, "reviewer"), true, "回合锁本来就该是空的");
  await setTaskStatus(taskId, "running");
  assert.equal(
    existsSync(record), true,
    "派一轮审查就把用户正看着的预览关掉了——审查只读代码，页面不会变成别的东西",
  );

  // ── ② 审查回合进行中：起预览放行，且快照如实报出这件事 ──
  const reviewing = await snapshot();
  assert.equal(reviewing.reviewTurn, true, "快照没报出「在跑的是审查旁路回合」，前端那颗按钮只能继续灰着");
  rmSync(record, { force: true }); // 换成真起一次：上面那条是伪造的记录
  const duringReview = await api.request(`/tasks/${taskId}/free-workflow/preview`, { method: "POST" });
  assert.equal(
    duringReview.status, 200,
    `审查进行中起预览被挡了：${JSON.stringify(await duringReview.json())}`,
  );
  const launchDuringReview = await workspacePreviewLaunch(taskId);
  assert.equal(
    launchDuringReview.reason, "",
    "预览工作区那道门还按「智能体回合尚未释放」挡着——同一件事两个表面各说各话",
  );
  const stopped = await api.request(`/tasks/${taskId}/free-workflow/preview`, { method: "DELETE" });
  assert.deepEqual(await stopped.json(), { stopped: true }, "审查进行中起的预览要收得回来");

  // ── ③ 普通回合：一点都不能松 ──
  await reset();
  fakeOpenPreview();
  assert.equal(claimTurn(taskId, "single"), true, "回合锁没放干净");
  await setTaskStatus(taskId, "running");
  assert.equal(
    existsSync(record), false,
    "任务真的在改代码了，上一版的预览却留着——用户会对着旧页面验新改动",
  );
  const implementing = await snapshot();
  assert.equal(implementing.reviewTurn, false, "普通回合被当成了审查回合，放行的判据就全错了");
  const duringWork = await api.request(`/tasks/${taskId}/free-workflow/preview`, { method: "POST" });
  assert.equal(duringWork.status, 409, "任务正在改代码，预览却起起来了");
  assert.match(
    ((await duringWork.json()) as { error: string }).error, /正在修改代码/,
    "挡是挡住了，但理由不是「任务正在改代码」——别让别的错误替它交差",
  );
  const launchDuringWork = await workspacePreviewLaunch(taskId);
  assert.notEqual(launchDuringWork.reason, "", "实现回合在跑时，预览工作区那道门必须照旧挡着");
  releaseTurn(taskId);

  console.log("✓ 审查旁路回合：开跑不收预览、进行中可起预览、快照与预览工作区同一口径；实现回合三道门原样锁死");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
