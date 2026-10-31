// 端到端:**非 claude / codex 的真 CLI 真跑一遍,靠 ash MCP 交卷**。
//
// 为什么非要这一条:单元那几组证明的是「我们写出的配置自己读得回来」,证明不了「那家 CLI
// 真认这份配置、真把 ash 的工具交到模型手上、回合身份真进得去」。2026-10-30 的现场病正是
// 中间这几环 —— 登记看着对,任务还是全记 failed。
//
// 选 opencode:本机装着,而且**不需要任何凭证**就能跑(`opencode/glm-5.3-flash-free`)。
// gemini(没登录)、grok(没登录)、kimi(403 要订阅)当天都跑不动。
//
// 跑法(**不许碰生产库和真实 data/runs**,前两个变量都是硬要求;第三个是因为设了
// ASH_RUNS_DIR 的测试默认禁起真执行器,见 `executors/spawn.ts`,而这一条正是要起真的):
//   ASH_DB=/tmp/e2e-opencode.db ASH_RUNS_DIR=/tmp/e2e-opencode-runs ASH_ALLOW_REAL_AGENT=1 \
//     npx tsx server/scripts/e2e-opencode-ash-mcp.ts
//
// 它会真起一次 agent(烧一次免费模型的额度),所以**刻意不挂进任何聚合测试脚本**。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requireTmpDb } from "./tmp-db.js";

requireTmpDb("e2e-opencode-ash-mcp");
assert.ok(process.env.ASH_RUNS_DIR?.trim(), "先设 ASH_RUNS_DIR —— 这条会写时间线,不许落进真实 data/runs");
// 这一条就是要起真 CLI(整条链的意义全在那一次真实的 MCP 调用上),所以显式开闸。
process.env.ASH_ALLOW_REAL_AGENT = "1";

const stage = mkdtempSync(join(tmpdir(), "e2e-opencode-"));
const repo = join(stage, "repo");
const cfgDir = join(stage, "opencode");
// **这一句决定了整条验证成不成立**:opencode 认 `OPENCODE_CONFIG` 指的那份配置,而 agent
// 是 ash 这个进程的子进程、原样继承它。所以 ash 这边注册到哪、agent 就从哪读。
process.env.OPENCODE_CONFIG = join(cfgDir, "opencode.json");

const { REPO_DIR } = await import("../src/paths.js");
const MCP_ENTRY = join(REPO_DIR, "mcp", "dist", "index.js");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

try {
  // ── 1. 一个干净的仓库和一个干净的 ash 实例 ──────────────────────────────
  execFileSync("mkdir", ["-p", repo]);
  execFileSync("mkdir", ["-p", cfgDir]);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@ash.local");
  git("config", "user.name", "ash e2e");
  writeFileSync(join(repo, "README.md"), "e2e\n", "utf8");
  git("add", "-A");
  git("commit", "-qm", "init");

  const { ensureSchema, db } = await import("../src/db/index.js");
  const { projects, tasks, sessions } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { api } = await import("../src/routes.js");
  const { eq } = await import("drizzle-orm");
  await ensureSchema();

  const { serve } = await import("@hono/node-server");
  const { Hono } = await import("hono");
  const backend = serve({ fetch: new Hono().route("/api", api).fetch, hostname: "127.0.0.1", port: 0 });
  if (!backend.listening) await new Promise<void>((r) => backend.once("listening", r));
  const address = backend.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;

  // ── 2. 注册:走**安装时**那条真路(裸 Node 那份写入器)─────────────────────
  const hosts = await import(pathToFileURL(join(REPO_DIR, "scripts", "mcp-hosts.mjs")).href) as {
    registerHostMcp: (o: Record<string, unknown>) => { file: string; added: boolean; why?: string };
  };
  const written = hosts.registerHostMcp({ agentType: "opencode", mcpEntry: MCP_ENTRY, url });
  assert.equal(written.added, true, `该写进去:${written.why ?? ""}`);
  assert.equal(written.file, process.env.OPENCODE_CONFIG);
  console.log(`① 已注册 ash MCP → ${written.file}`);
  console.log(readFileSync(written.file, "utf8").trim());

  // 这家 CLI 自己认不认这份登记 —— 先问它本人,免得后面失败时分不清是谁的问题。
  const listed = execFileSync("opencode", ["mcp", "list"], { encoding: "utf8", timeout: 120_000 });
  assert.match(listed, /ash/, "opencode mcp list 要列出 ash");
  console.log(`② opencode 自己列得出 ash`);

  // ── 3. 起一条真任务 ────────────────────────────────────────────────────
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "e2e", name: "e2e", repoPath: repo, createdAt: at });
  const [task] = await createTasks([{
    id: "e2e-opencode", projectId: "e2e", title: "e2e opencode 交卷",
    body: "这是一条验证任务:什么都不用改,直接调用 ash MCP 的 complete_task 确认完成即可。"
      + "不要改任何文件、不要跑命令。",
    mode: "single", status: "backlog", createdAt: at, updatedAt: at,
    // worktree 关掉:这条验的是 MCP 通道,不是工作区机制(少一个变量)。
    useWorktree: false, workflowMode: "free",
    agentType: "opencode",
    // 免费模型,不需要任何凭证。
    model: "opencode/glm-5.3-flash-free",
  }]);
  assert.ok(task);
  const res = await api.request(`/tasks/${task.id}/run`, { method: "POST" });
  assert.ok(res.ok, `起跑要成功:${res.status} ${await res.text()}`);
  console.log(`③ 任务已起跑(opencode / ${task.model})`);

  // ── 4. 等它交卷 ───────────────────────────────────────────────────────
  const deadline = Date.now() + 10 * 60_000;
  let status = "";
  while (Date.now() < deadline) {
    const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, task.id));
    status = row?.status ?? "";
    if (["done", "failed", "canceled", "paused"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }

  const [session] = await db.select({ id: sessions.id, cwd: sessions.cwd })
    .from(sessions).where(eq(sessions.taskId, task.id));
  console.log(`④ 结算状态:${status}（会话 ${session?.id ?? "无"}）`);
  await new Promise<void>((r) => backend.close(() => r()));

  // **done 这个结论只有一条来路**:agent 通过 ash MCP 调了 `complete_task`,服务端收下了
  // 那次确认(exit 0 不算完成,见完成协议)。所以这一行断言就是整条链的证据。
  assert.equal(status, "done", "opencode 要能靠 ash MCP 交卷");
  console.log("✅ 非 claude/codex 的真 CLI 端到端通过:注册 → 起跑 → 靠 ash MCP 交卷");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
