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
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

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
// 比它优先级更高的两个来源(真 opencode 实测的层级:`OPENCODE_CONFIG_DIR` 那个目录、
// `OPENCODE_CONFIG_CONTENT` 里那整段 JSON)**从这个进程里摘掉**:留着它们,我们写的那条
// 可能被更高优先级的一条顶掉甚至关掉,而这条 e2e 的全部结论都建立在「agent 用的就是我们
// 刚写的那条登记」上(本轮审查 N2)。
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.OPENCODE_CONFIG_CONTENT;
/**
 * **三个消费者共用同一套来源**:注册那一步、问 CLI 本人那一步、以及真起跑的那个 agent。
 *
 * opencode 的来源不止一份:默认目录那几份也会被读。所以用真 `homedir()` 去问「要不要补」,
 * 答案会被**宿主自己那份全局配置**左右 —— 用户机器上早就接过 ash 时,安装器照规矩回
 * 「已经有生效的登记了,不动它」,`added` 就是 false,这条 e2e 在起跑前自拒(上一轮审查 N2)。
 * 判定本身没错,错在拿宿主状态当了被测对象的输入。
 *
 * 上一版只把隔离环境交给安装器一处(本轮审查 N1):`opencode mcp list` 和 agent 都继承
 * `process.env`,于是**真跑的那一侧仍然合着宿主的全局配置、插件和别的 MCP** —— 拿一个阶段
 * 的沙盘给另一个阶段背书,`done` 这个结论就不再只能由我们刚写的那条登记解释。所以这里直接
 * 改掉**本进程**的 `XDG_CONFIG_HOME`:agent 是这个进程的子进程、原样继承,一处设完三处一致。
 *
 * 只隔离配置那一层:凭证和数据(`XDG_DATA_HOME` 底下)照旧用宿主那份 —— 那是这条 e2e 能用
 * 免费模型真跑起来的前提,也不是本条要证的东西。
 */
const sandboxHome = join(stage, "host-home");
process.env.XDG_CONFIG_HOME = join(sandboxHome, ".config");
const sandboxEnv: NodeJS.ProcessEnv = process.env;

const { REPO_DIR } = await import("../src/paths.js");
const MCP_ENTRY = join(REPO_DIR, "mcp", "dist", "index.js");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

/**
 * 收尾要做的事,**出错那条路也得做**(本轮审查 N2)。
 *
 * 上一版服务只在走到结果检查时才 `close`、`finally` 里只删沙盘:中间任何一步抛出(CLI 查询
 * 失败、断言不过、起跑没成功),listener 还在听、这次起的 agent 还在跑,进程于是自然退不出来。
 * 关 HTTP listener 也不等于停 agent,所以停任务那一下要单独做、而且排在关服务之前。
 */
let backend: { close: (cb: () => void) => void } | null = null;
let stopRun: (() => Promise<void>) | null = null;

try {
  // ── 1. 一个干净的仓库和一个干净的 ash 实例 ──────────────────────────────
  execFileSync("mkdir", ["-p", repo]);
  execFileSync("mkdir", ["-p", cfgDir]);
  // 隔离出来的那套来源里,默认目录得真的在(不然「写入落点」算不出来)。
  execFileSync("mkdir", ["-p", join(sandboxHome, ".config", "opencode")]);
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
  const server = serve({ fetch: new Hono().route("/api", api).fetch, hostname: "127.0.0.1", port: 0 });
  backend = server;
  if (!server.listening) await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;

  // ── 2. 注册:走**安装时**那条真路(裸 Node 那份写入器)─────────────────────
  const hosts = await import(pathToFileURL(join(REPO_DIR, "scripts", "mcp-hosts.mjs")).href) as {
    registerHostMcp: (o: Record<string, unknown>) => { file: string; added: boolean; why?: string };
  };
  const written = hosts.registerHostMcp({
    agentType: "opencode", mcpEntry: MCP_ENTRY, url, env: sandboxEnv, home: sandboxHome,
  });
  assert.equal(written.added, true, `该写进去:${written.why ?? ""}`);
  assert.equal(written.file, process.env.OPENCODE_CONFIG);
  console.log(`① 已注册 ash MCP → ${written.file}`);
  console.log(readFileSync(written.file, "utf8").trim());

  // 这家 CLI 自己认不认这份登记 —— 先问它本人,免得后面失败时分不清是谁的问题。
  // 问的是**agent 将来那套来源**:同一份隔离环境、同一个工作目录(opencode 读配置会沿 cwd
  // 往上合并每一层的项目配置,cwd 一不一样,问到的就不是同一件事)。
  const listed = execFileSync("opencode", ["mcp", "list"],
    { cwd: repo, env: sandboxEnv, encoding: "utf8", timeout: 120_000 });
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
  // 从这一刻起,任何一条出错路径都得先把它停掉(整棵进程树由 stop 那条路杀),而且要**等它
  // 真的停下来**:`/stop` 在发出击杀之后就应答(`runs.ts` 只发 kill、`kill.ts` 的 SIGKILL
  // 兜底还要 2 秒),结算是异步的 —— 上一版只等那个 HTTP 响应就去关库、删沙盘,那会儿
  // CLI 往往还在退出中,读的正是刚被删掉的配置目录(本轮审查 N1)。
  stopRun = async () => {
    const stop = await api.request(`/tasks/${task.id}/stop`, { method: "POST" });
    if (!stop.ok) console.error(`停任务没成功:${stop.status} ${await stop.text()}`);
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, task.id));
      if (!["running", "queued"].includes(row?.status ?? "")) return;    // 结算完 = 进程树已收回
      await new Promise((r) => setTimeout(r, 500));
    }
    console.error("等了 30 秒它还在 running/queued —— 下面的清理可能撞上还活着的进程");
  };
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
  // 已经落终态就不用再停了(停一个 done 的任务只会多一条无意义的时间线)。
  if (["done", "failed", "canceled"].includes(status)) stopRun = null;

  // **done 这个结论只有一条来路**:agent 通过 ash MCP 调了 `complete_task`,服务端收下了
  // 那次确认(exit 0 不算完成,见完成协议)。所以这一行断言就是整条链的证据。
  assert.equal(status, "done", "opencode 要能靠 ash MCP 交卷");
  console.log("✅ 非 claude/codex 的真 CLI 端到端通过:注册 → 起跑 → 靠 ash MCP 交卷");
} finally {
  // 顺序是定死的:先停这次起的任务和它的 CLI、**并等它真的落终态**,再关服务,再松开库文件,
  // 最后才删沙盘(沙盘里有仓库和配置,还在跑的进程正读着它们)。每一步各自兜异常 ——
  // 一步失败不该让后面几步不做。
  if (stopRun) await stopRun().catch((e) => console.error(`停任务没成功:${String(e)}`));
  if (backend) await new Promise<void>((r) => backend!.close(() => r()));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
